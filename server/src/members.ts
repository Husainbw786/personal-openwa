import { db } from './db.ts';
import { openwa } from './openwa.ts';
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
}

const CACHE_MS = 5 * 60 * 1000;

/** Names from each number's WhatsApp address book, keyed by phone digits and by raw id. */
const contactCache = new Map<string, { at: number; names: Map<string, string> }>();
async function getContactNames(sessionId: string): Promise<Map<string, string>> {
  const cached = contactCache.get(sessionId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.names;
  const names = new Map<string, string>();
  for (const c of await openwa.listContacts(sessionId).catch(() => [])) {
    if (!c.name) continue;
    names.set(c.id, c.name);
    if (c.id.endsWith('@c.us') && c.number) names.set(normalizePhone(c.number), c.name);
  }
  contactCache.set(sessionId, { at: Date.now(), names });
  return names;
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
    const resolved = await openwa.resolvePhone(sessionId, id).catch(() => null);
    lidCache.set(id, resolved ? normalizePhone(resolved) : null);
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

const selfCache = new Map<string, { at: number; phone: string | null }>();
async function selfPhone(sessionId: string): Promise<string | null> {
  const cached = selfCache.get(sessionId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.phone;
  const session = await openwa.getSession(sessionId);
  const phone = session.phone ? normalizePhone(session.phone) : null;
  selfCache.set(sessionId, { at: Date.now(), phone });
  return phone;
}

/** Group data is per number: the same group looks the same, but a number only sees groups it is in. */
const cacheKey = (sessionId: string, groupId: string) => `${sessionId}|${groupId}`;

/** Member count per group, filled whenever we load a group. */
export const groupCounts = new Map<string, { at: number; count: number }>();

const groupMemberCache = new Map<string, { at: number; name: string; description: string; members: RawMember[] }>();

/** Forget everything cached for a number (after it logs out or is removed). */
export function forgetSession(sessionId: string): void {
  contactCache.delete(sessionId);
  selfCache.delete(sessionId);
  for (const map of [groupCounts, groupMemberCache]) {
    for (const key of map.keys()) if (key.startsWith(`${sessionId}|`)) map.delete(key);
  }
}

export async function loadGroupMembers(sessionId: string, groupId: string, fresh = false) {
  const key = cacheKey(sessionId, groupId);
  const cached = groupMemberCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;

  const [group, self, contactNames] = await Promise.all([openwa.getGroup(sessionId, groupId), selfPhone(sessionId), getContactNames(sessionId)]);
  const keys = await mapLimit(group.participants, 16, (p) => recipientKey(sessionId, p.id, p.number));
  const members: RawMember[] = [];
  for (const [i, p] of group.participants.entries()) {
    const phone = keys[i];
    if (!phone || phone === self) continue;
    members.push({ phone, whatsappName: p.name ?? contactNames.get(phone) ?? contactNames.get(p.id) ?? null, isAdmin: p.isAdmin });
  }
  const entry = { at: Date.now(), name: group.name, description: group.description ?? '', members };
  groupMemberCache.set(key, entry);
  groupCounts.set(key, { at: Date.now(), count: members.length });
  return entry;
}

/** Just the member count, without resolving hidden numbers (cheap, used by the groups list). */
export async function groupCount(sessionId: string, groupId: string): Promise<number> {
  const key = cacheKey(sessionId, groupId);
  const cached = groupCounts.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.count;
  const group = await openwa.getGroup(sessionId, groupId);
  const count = Math.max(0, group.participants.length - 1); // minus you
  groupCounts.set(key, { at: Date.now(), count });
  return count;
}

/** Mark who is hidden, who already got the selected template, and who can be picked. */
export function annotate(raw: RawMember[], templateId: number | null): Member[] {
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
      // failed/cancelled sends can be retried; anything else counts as "already got this template".
      selectable: !isExcluded && (status === null || status === 'failed' || status === 'cancelled'),
    };
  });
  members.sort((a, b) => Number(b.selectable) - Number(a.selectable) || (a.name ?? a.phone).localeCompare(b.name ?? b.phone));
  return members;
}
