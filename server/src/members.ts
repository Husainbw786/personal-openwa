import { db } from './db.ts';
import { openwa, type GroupSummary } from './openwa.ts';
import { normalizePhone, isValidPhone, normalizeRecipient, isValidRecipient } from './phone.ts';

/** A person we can message, before annotating with send status. Shared by WhatsApp groups and uploaded lists. */
export interface RawMember {
  phone: string; // recipient key: phone digits or "<lid>@lid"
  whatsappName: string | null;
  isAdmin: boolean;
}

export interface Member extends RawMember {
  name: string | null;
  excluded: boolean;
  sendStatus: string | null;
  selectable: boolean;
  /** Names of "my groups" this person is already in (empty if none). */
  inMyGroups: string[];
  /** When they joined one of my groups (ISO), if that happened while we were tracking. */
  joinedMyGroupAt: string | null;
}

/**
 * Everything WhatsApp-side is cached and served instantly ("stale while revalidate"): a request gets
 * whatever is in memory right away, and if it's older than REFRESH_MS a background refresh starts.
 * Only data that has never been loaded makes a request wait. The warmer (warmer.ts) keeps every
 * number's groups, members and contacts fresh around the clock, and snapshots survive restarts.
 */
export const REFRESH_MS = 2 * 60 * 1000;
/** Group members change rarely and WhatsApp rate-limits group queries, so they refresh less often. */
export const MEMBERS_REFRESH_MS = 30 * 60 * 1000;

const inflight = new Map<string, Promise<unknown>>();
/** Run `fn` once per key at a time; concurrent callers share the same promise. */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

interface Cached<T> { at: number; value: T }

/** Serve from cache; refresh in the background when stale; wait only when nothing is cached (or `fresh`). */
async function swr<T>(name: string, cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>, fresh = false, maxAge = REFRESH_MS): Promise<T> {
  const hit = cache.get(key);
  const refresh = () => once(`${name}:${key}`, async () => {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  });
  if (hit && !fresh) {
    if (Date.now() - hit.at > maxAge) refresh().catch(() => {});
    return hit.value;
  }
  return refresh();
}

/** Names from each number's WhatsApp address book, keyed by phone digits and by raw id. */
const contactCache = new Map<string, Cached<Map<string, string>>>();
export function getContactNames(sessionId: string, fresh = false): Promise<Map<string, string>> {
  return swr('contacts', contactCache, sessionId, async () => {
    const names = new Map<string, string>();
    for (const c of await openwa.listContacts(sessionId)) {
      if (!c.name) continue;
      names.set(c.id, c.name);
      if (c.id.endsWith('@c.us') && c.number) names.set(normalizePhone(c.number), c.name);
    }
    return names;
  }, fresh).catch(() => new Map<string, string>());
}

/**
 * WhatsApp hides some members' numbers behind a privacy id (@lid). For those, OpenWA's `number`
 * is the lid digits, not a phone. Try to map it to a real phone; otherwise keep "<lid>@lid",
 * which we can still message directly. Lookups are cached because big groups have thousands.
 */
const lidCache = new Map<string, string | null>();
async function recipientKey(sessionId: string, id: string, number: string): Promise<string | null> {
  if (!id.endsWith('@lid')) {
    const phone = normalizePhone(number || id);
    return isValidPhone(phone) ? phone : null;
  }
  if (!lidCache.has(id)) {
    // Remember a real answer (a phone or "not known"); after an error (e.g. throttled) just try again next time.
    const resolved = await openwa.resolvePhone(sessionId, id).catch(() => undefined);
    if (resolved !== undefined) lidCache.set(id, resolved ? normalizePhone(resolved) : null);
  }
  const phone = lidCache.get(id);
  if (phone && isValidPhone(phone)) return phone;
  const key = normalizeRecipient(id);
  return isValidRecipient(key) ? key : null;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const selfCache = new Map<string, Cached<string | null>>();
function selfPhone(sessionId: string): Promise<string | null> {
  return swr('self', selfCache, sessionId, async () => {
    const session = await openwa.getSession(sessionId);
    return session.phone ? normalizePhone(session.phone) : null;
  });
}

/** Group data is per number: the same group looks the same, but a number only sees groups it is in. */
const cacheKey = (sessionId: string, groupId: string) => `${sessionId}|${groupId}`;

/** Each number's list of groups. */
const groupListCache = new Map<string, Cached<GroupSummary[]>>();
export function getGroupList(sessionId: string, fresh = false): Promise<GroupSummary[]> {
  return swr('groups', groupListCache, sessionId, () => openwa.listGroups(sessionId), fresh);
}

export interface GroupData { name: string; description: string; members: RawMember[] }
const groupMemberCache = new Map<string, Cached<GroupData>>();

/** Member count per group, from the last member load (or a cheap participant count). */
export const groupCounts = new Map<string, Cached<number>>();

/** Forget everything cached for a number (after it logs out or is removed). */
export function forgetSession(sessionId: string): void {
  for (const map of [contactCache, selfCache, groupListCache] as Array<Map<string, unknown>>) map.delete(sessionId);
  for (const map of [groupCounts, groupMemberCache] as Array<Map<string, unknown>>) {
    for (const key of map.keys()) if (key.startsWith(`${sessionId}|`)) map.delete(key);
  }
  db.prepare('DELETE FROM cache_snapshot WHERE key LIKE ?').run(`%:${sessionId}%`);
}

async function fetchGroup(sessionId: string, groupId: string): Promise<GroupData> {
  const [group, self, contactNames] = await Promise.all([openwa.getGroup(sessionId, groupId), selfPhone(sessionId), getContactNames(sessionId)]);
  const keys = await mapLimit(group.participants, 16, (p) => recipientKey(sessionId, p.id, p.number));
  const members: RawMember[] = [];
  for (const [i, p] of group.participants.entries()) {
    const phone = keys[i];
    if (!phone || phone === self) continue;
    members.push({ phone, whatsappName: p.name ?? contactNames.get(phone) ?? contactNames.get(p.id) ?? null, isAdmin: p.isAdmin });
  }
  groupCounts.set(cacheKey(sessionId, groupId), { at: Date.now(), value: members.length });
  return { name: group.name, description: group.description ?? '', members };
}

export function loadGroupMembers(sessionId: string, groupId: string, fresh = false): Promise<GroupData> {
  return swr('members', groupMemberCache, cacheKey(sessionId, groupId), () => fetchGroup(sessionId, groupId), fresh, MEMBERS_REFRESH_MS);
}

/** When a group's members were last loaded (0 if never). */
export function membersLoadedAt(sessionId: string, groupId: string): number {
  return groupMemberCache.get(cacheKey(sessionId, groupId))?.at ?? 0;
}

/** Member count without waiting: from cache, else a cheap participant count. */
export async function groupCount(sessionId: string, groupId: string): Promise<number> {
  const cached = groupCounts.get(cacheKey(sessionId, groupId));
  if (cached) return cached.value;
  const group = await openwa.getGroup(sessionId, groupId);
  const count = Math.max(0, group.participants.length - 1); // minus you
  groupCounts.set(cacheKey(sessionId, groupId), { at: Date.now(), value: count });
  return count;
}

export function cachedCount(sessionId: string, groupId: string): number | null {
  return groupCounts.get(cacheKey(sessionId, groupId))?.value ?? null;
}

/** Is this number's data fully loaded (used by the warmer and the status endpoint)? */
export function warmedGroups(sessionId: string): number {
  let n = 0;
  for (const key of groupMemberCache.keys()) if (key.startsWith(`${sessionId}|`)) n++;
  return n;
}

// --- Snapshots: keep the warm cache across restarts, so the first open after a deploy is instant too.

export function saveSnapshot(sessionId: string): void {
  const groups = groupListCache.get(sessionId);
  if (!groups) return;
  const members: Record<string, Cached<GroupData>> = {};
  for (const [key, value] of groupMemberCache) if (key.startsWith(`${sessionId}|`)) members[key] = value;
  const upsert = db.prepare('INSERT INTO cache_snapshot (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at');
  upsert.run(`groups:${sessionId}`, JSON.stringify(groups), Date.now());
  upsert.run(`members:${sessionId}`, JSON.stringify(members), Date.now());
}

export function loadSnapshots(): number {
  let loaded = 0;
  for (const row of db.prepare('SELECT key, value FROM cache_snapshot').all() as Array<{ key: string; value: string }>) {
    try {
      if (row.key.startsWith('groups:')) {
        groupListCache.set(row.key.slice('groups:'.length), JSON.parse(row.value));
      } else if (row.key.startsWith('members:')) {
        for (const [key, entry] of Object.entries(JSON.parse(row.value) as Record<string, Cached<GroupData>>)) {
          groupMemberCache.set(key, entry);
          groupCounts.set(key, { at: entry.at, value: entry.value.members.length });
          loaded++;
        }
      }
    } catch { /* corrupt snapshot: ignore, the warmer refills it */ }
  }
  return loaded;
}

/** Mark who is hidden, who already got the selected template, and who can be picked. */
export function annotate(raw: RawMember[], templateId: number | null, myGroups: Map<string, string[]> = new Map(), joins: Map<string, string> = new Map()): Member[] {
  const excluded = new Set((db.prepare('SELECT phone FROM excluded').all() as Array<{ phone: string }>).map((r) => r.phone));
  const names = new Map((db.prepare('SELECT phone, name FROM contact_names').all() as Array<{ phone: string; name: string }>).map((r) => [r.phone, r.name]));
  const sendStatus = new Map<string, string>();
  if (templateId) {
    for (const r of db.prepare('SELECT phone, status FROM sends WHERE template_id = ?').all(templateId) as Array<{ phone: string; status: string }>) {
      sendStatus.set(r.phone, r.status);
    }
  }
  const members = raw.map((m) => {
    const status = sendStatus.get(m.phone) ?? null;
    const isExcluded = excluded.has(m.phone);
    return {
      ...m,
      name: names.get(m.phone) ?? m.whatsappName,
      excluded: isExcluded,
      sendStatus: status,
      inMyGroups: myGroups.get(m.phone) ?? [],
      joinedMyGroupAt: joins.get(m.phone) ?? null,
      // failed/cancelled sends can be retried; anything else counts as "already got this template".
      selectable: !isExcluded && (status === null || status === 'failed' || status === 'cancelled'),
    };
  });
  members.sort((a, b) => Number(b.selectable) - Number(a.selectable) || (a.name ?? a.phone).localeCompare(b.name ?? b.phone));
  return members;
}
