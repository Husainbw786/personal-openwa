import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { openwa, type GroupSummary } from '../openwa.ts';
import { normalizePhone, isValidPhone, normalizeRecipient, isValidRecipient } from '../phone.ts';

let groupCache: { at: number; groups: GroupSummary[] } | null = null;
const GROUP_CACHE_MS = 5 * 60 * 1000;

/** Names from the WhatsApp address book, keyed by phone digits and by raw id. */
let contactCache: { at: number; names: Map<string, string> } | null = null;
async function getContactNames(): Promise<Map<string, string>> {
  if (contactCache && Date.now() - contactCache.at < GROUP_CACHE_MS) return contactCache.names;
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export function waRoutes(app: FastifyInstance): void {
  app.get('/api/wa/status', async () => {
    const session = await openwa.getSession();
    let qrCode: string | null = null;
    if (session.status === 'qr_ready') {
      qrCode = (await openwa.getQr().catch(() => null))?.qrCode ?? null;
    }
    return { status: session.status, phone: session.phone, pushName: session.pushName, lastError: session.lastError ?? null, qrCode };
  });

  app.post('/api/wa/start', async () => {
    await openwa.start();
    return { ok: true };
  });

  app.post('/api/wa/logout', async () => {
    await openwa.logout();
    groupCache = null;
    return { ok: true };
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/groups', async (req) => {
    if (!groupCache || req.query.refresh === '1' || Date.now() - groupCache.at > GROUP_CACHE_MS) {
      groupCache = { at: Date.now(), groups: await openwa.listGroups() };
    }
    const favorites = new Set((db.prepare('SELECT group_id FROM favorite_groups').all() as Array<{ group_id: string }>).map((r) => r.group_id));
    return groupCache.groups
      .map((g) => ({ id: g.id, name: g.name, favorite: favorites.has(g.id) }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  });

  app.put<{ Params: { id: string }; Body: { favorite: boolean; name?: string } }>('/api/groups/:id/favorite', async (req) => {
    if (req.body.favorite) {
      db.prepare('INSERT OR REPLACE INTO favorite_groups (group_id, name) VALUES (?, ?)').run(req.params.id, req.body.name ?? null);
    } else {
      db.prepare('DELETE FROM favorite_groups WHERE group_id = ?').run(req.params.id);
    }
    return { ok: true };
  });

  /**
   * Group members, annotated for the selected template:
   * excluded (hidden by default), alreadySent (greyed out), queued (in progress).
   */
  app.get<{ Params: { id: string }; Querystring: { templateId?: string } }>('/api/groups/:id', async (req) => {
    const [group, session] = await Promise.all([openwa.getGroup(req.params.id), openwa.getSession()]);
    const self = session.phone ? normalizePhone(session.phone) : null;
    const templateId = req.query.templateId ? Number(req.query.templateId) : null;

    const excluded = new Set((db.prepare('SELECT phone FROM excluded').all() as Array<{ phone: string }>).map((r) => r.phone));
    const names = new Map((db.prepare('SELECT phone, name FROM contact_names').all() as Array<{ phone: string; name: string }>).map((r) => [r.phone, r.name]));
    const sendStatus = new Map<string, string>();
    if (templateId) {
      for (const r of db.prepare(`SELECT phone, status FROM sends WHERE template_id = ?`).all(templateId) as Array<{ phone: string; status: string }>) {
        sendStatus.set(r.phone, r.status);
      }
    }

    const contactNames = await getContactNames();
    const keys = await mapLimit(group.participants, 16, (p) => recipientKey(p.id, p.number));

    const members = [];
    for (const [i, p] of group.participants.entries()) {
      const phone = keys[i];
      if (!phone || phone === self) continue;
      const status = sendStatus.get(phone) ?? null;
      const whatsappName = p.name ?? contactNames.get(phone) ?? contactNames.get(p.id) ?? null;
      members.push({
        phone,
        name: names.get(phone) ?? whatsappName,
        whatsappName,
        isAdmin: p.isAdmin,
        excluded: excluded.has(phone),
        sendStatus: status,
        // failed/cancelled sends can be retried; anything else counts as "already got this template".
        selectable: !excluded.has(phone) && (status === null || status === 'failed' || status === 'cancelled'),
      });
    }
    members.sort((a, b) => Number(b.selectable) - Number(a.selectable) || (a.name ?? a.phone).localeCompare(b.name ?? b.phone));

    return { id: group.id, name: group.name, description: group.description ?? '', members };
  });
}
