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

/** Names from the WhatsApp address book, keyed by phone digits and by raw id. */
let contactCache: { at: number; names: Map<string, string> } | null = null;
async function getContactNames(): Promise<Map<string, string>> {
  if (contactCache && Date.now() - contactCache.at < CACHE_MS) return contactCache.names;
  const names = new Map<string, string>();
  for (const c of await openwa.listContacts().catch(() => [])) {
    if (!c.name) continue;
    names.set(c.id, c.name);
    if (c.id.endsWith('@c.us') && c.number) names.set(normalizePhone(c.number), c.name);
  }
  contactCache = { at: Date.now(), names };
  return names;
}

/**
 * WhatsApp hides some members' numbers behind a privacy id (@lid). For those, OpenWA's `number`
 * is the lid digits, not a phone. Try to map it to a real phone; otherwise keep "<lid>@lid",
 * which we can still message directly. Lookups are cached because big groups have thousands.
 */
const lidCache = new Map<string, string | null>();
async function recipientKey(id: string, number: string): Promise<string | null> {
  if (!id.endsWith('@lid')) {
    const phone = normalizePhone(number || id);
    return isValidPhone(phone) ? phone : null;
  }
  if (!lidCache.has(id)) {
    const resolved = await openwa.resolvePhone(id).catch(() => null);
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

let selfCache: { at: number; phone: string | null } | null = null;
async function selfPhone(): Promise<string | null> {
  if (selfCache && Date.now() - selfCache.at < CACHE_MS) return selfCache.phone;
  const session = await openwa.getSession();
  selfCache = { at: Date.now(), phone: session.phone ? normalizePhone(session.phone) : null };
  return selfCache.phone;
}

/** Member count per group, filled whenever we load a group. */
export const groupCounts = new Map<string, { at: number; count: number }>();

const groupMemberCache = new Map<string, { at: number; name: string; description: string; members: RawMember[] }>();

export async function loadGroupMembers(groupId: string, fresh = false) {
  const cached = groupMemberCache.get(groupId);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;

  const [group, self, contactNames] = await Promise.all([openwa.getGroup(groupId), selfPhone(), getContactNames()]);
  const keys = await mapLimit(group.participants, 16, (p) => recipientKey(p.id, p.number));
  const members: RawMember[] = [];
  for (const [i, p] of group.participants.entries()) {
    const phone = keys[i];
    if (!phone || phone === self) continue;
    members.push({ phone, whatsappName: p.name ?? contactNames.get(phone) ?? contactNames.get(p.id) ?? null, isAdmin: p.isAdmin });
  }
  const entry = { at: Date.now(), name: group.name, description: group.description ?? '', members };
  groupMemberCache.set(groupId, entry);
  groupCounts.set(groupId, { at: Date.now(), count: members.length });
  return entry;
}

/** Just the member count, without resolving hidden numbers (cheap, used by the groups list). */
export async function groupCount(groupId: string): Promise<number> {
  const cached = groupCounts.get(groupId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.count;
  const group = await openwa.getGroup(groupId);
  const count = Math.max(0, group.participants.length - 1); // minus you
  groupCounts.set(groupId, { at: Date.now(), count });
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
