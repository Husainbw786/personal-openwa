import { openwa } from './openwa.ts';
import { getContactNames, getGroupList, loadGroupMembers, MEMBERS_REFRESH_MS, membersLoadedAt, saveSnapshot } from './members.ts';

/**
 * Keeps every connected number's data loaded around the clock, so the app answers from memory.
 *
 * WhatsApp rate-limits group queries (and bursts look like a bot), so this trickles instead of
 * bursting: one group every few seconds, oldest first, each group refreshed about every 30 minutes,
 * and a long pause whenever WhatsApp says slow down. Group lists and contacts are cheap and
 * refresh every few minutes. Progress is snapshotted, so restarts keep the warm data.
 */
const GAP_MS = 2_500;
const BACKOFF_MS = 90_000;
const IDLE_MS = 30_000;
const LISTS_EVERY_MS = 3 * 60 * 1000;
const SNAPSHOT_EVERY = 10;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export const warmState = { lastGroupAt: null as string | null, warmedSinceStart: 0, backoffs: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (err: unknown) => /429|rate.?limit|too many/i.test(String(err));

async function loop(log: Log): Promise<never> {
  let listsAt = 0;
  let sinceSnapshot = new Map<string, number>();
  for (;;) {
    try {
      const sessions = (await openwa.listSessions()).filter((s) => s.status === 'ready');

      // Cheap things first: each number's group list and address book.
      const refreshLists = Date.now() - listsAt > LISTS_EVERY_MS;
      const work: Array<{ sessionId: string; groupId: string; at: number }> = [];
      for (const s of sessions) {
        const groups = await getGroupList(s.id, refreshLists).catch(() => []);
        if (refreshLists) await getContactNames(s.id, true);
        for (const g of groups) {
          const at = membersLoadedAt(s.id, g.id);
          if (Date.now() - at > MEMBERS_REFRESH_MS) work.push({ sessionId: s.id, groupId: g.id, at });
        }
      }
      if (refreshLists) listsAt = Date.now();

      if (work.length === 0) {
        for (const s of sessions) if (sinceSnapshot.get(s.id)) { saveSnapshot(s.id); sinceSnapshot.set(s.id, 0); }
        await sleep(IDLE_MS);
        continue;
      }

      // Never-loaded groups first, then the stalest. Re-plan every few groups so new numbers get a turn.
      work.sort((a, b) => a.at - b.at);
      for (const item of work.slice(0, 20)) {
        try {
          await loadGroupMembers(item.sessionId, item.groupId, true);
          warmState.warmedSinceStart++;
          warmState.lastGroupAt = new Date().toISOString();
          const n = (sinceSnapshot.get(item.sessionId) ?? 0) + 1;
          sinceSnapshot.set(item.sessionId, n);
          if (n >= SNAPSHOT_EVERY) { saveSnapshot(item.sessionId); sinceSnapshot.set(item.sessionId, 0); }
          await sleep(GAP_MS);
        } catch (err) {
          if (isRateLimit(err)) {
            warmState.backoffs++;
            log.warn({ err: String(err) }, `WhatsApp asked to slow down; pausing warm-up for ${BACKOFF_MS / 1000}s`);
            await sleep(BACKOFF_MS);
          } else {
            await sleep(GAP_MS);
          }
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'warm-up loop error');
      sinceSnapshot = new Map();
      await sleep(IDLE_MS);
    }
  }
}

export function startWarmer(log: Log): void {
  setTimeout(() => void loop(log), 5_000);
}
