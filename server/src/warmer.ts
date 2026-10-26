import { openwa } from './openwa.ts';
import { getContactNames, getGroupList, loadGroupMembers, mapLimit, saveSnapshot } from './members.ts';

/**
 * Keeps every connected number's data loaded around the clock: its group list, every group's
 * members (with hidden numbers resolved) and its address-book names. Opening anything in the app
 * is then served straight from memory. Runs one pass at a time, every few minutes.
 */
const INTERVAL_MS = 3 * 60 * 1000;
const GROUP_CONCURRENCY = 4;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

let running = false;
export const warmState = { lastRunAt: null as string | null, lastRunMs: 0, groups: 0, numbers: 0 };

async function warmOnce(log: Log): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  let groupsWarmed = 0;
  let numbers = 0;
  try {
    const sessions = (await openwa.listSessions()).filter((s) => s.status === 'ready');
    for (const s of sessions) {
      try {
        const [groups] = await Promise.all([getGroupList(s.id, true), getContactNames(s.id, true)]);
        await mapLimit(groups, GROUP_CONCURRENCY, async (g) => {
          await loadGroupMembers(s.id, g.id, true).then(() => groupsWarmed++).catch(() => {});
        });
        saveSnapshot(s.id);
        numbers++;
      } catch (err) {
        log.warn({ sessionId: s.id, err: String(err) }, 'warm-up failed for number');
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'warm-up pass failed');
  } finally {
    running = false;
    Object.assign(warmState, { lastRunAt: new Date().toISOString(), lastRunMs: Date.now() - started, groups: groupsWarmed, numbers });
    if (numbers) log.info({ numbers, groups: groupsWarmed, ms: Date.now() - started }, 'warm-up pass done');
  }
}

export function startWarmer(log: Log): void {
  setTimeout(() => void warmOnce(log), 5_000);
  setInterval(() => void warmOnce(log), INTERVAL_MS);
}

/** Run a pass now (e.g. right after a number connects), without waiting for it. */
export function warmSoon(log: Log): void {
  setTimeout(() => void warmOnce(log), 2_000);
}
