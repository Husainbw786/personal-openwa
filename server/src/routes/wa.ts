import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { defaultSessionId, openwa, OpenWAError, type GroupSummary, type Session } from '../openwa.ts';
import { annotate, forgetSession, groupCount, loadGroupMembers, mapLimit } from '../members.ts';
import { sendCsv, sendPdf, toRows } from '../export.ts';
import { registerWebhook } from './hooks.ts';
import { sessionLabel } from '../queue.ts';

const groupCache = new Map<string, { at: number; groups: GroupSummary[] }>();
const GROUP_CACHE_MS = 5 * 60 * 1000;

/** Which linked number a request is about: `?session=<id>`, or the default number. */
async function pickSession(query: { session?: string }): Promise<string> {
  return query.session || defaultSessionId();
}

async function describe(session: Session, defaultId: string) {
  let qrCode: string | null = null;
  if (session.status === 'qr_ready') {
    qrCode = (await openwa.getQr(session.id).catch(() => null))?.qrCode ?? null;
  }
  return {
    id: session.id,
    name: session.name,
    label: session.status === 'ready' ? sessionLabel(session) : session.name,
    isDefault: session.id === defaultId,
    status: session.status,
    phone: session.phone,
    pushName: session.pushName,
    lastError: session.lastError ?? null,
    qrCode,
  };
}

/** OpenWA session names: 3-50 chars, letters, digits and hyphens. */
function sessionName(label: string, taken: Set<string>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'number';
  let name = slug.length >= 3 ? slug : `number-${slug}`;
  for (let i = 2; taken.has(name); i++) name = `${slug}-${i}`;
  return name;
}

type Log = { info: (m: string) => void; warn: (o: object, m: string) => void };

export function waRoutes(app: FastifyInstance): void {
  const log: Log = { info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) };

  /** Every linked (or linking) number, default first, with a QR code when one is waiting to be scanned. */
  app.get('/api/wa/sessions', async () => {
    const [sessions, defaultId] = await Promise.all([openwa.listSessions(), defaultSessionId()]);
    sessions.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || a.name.localeCompare(b.name));
    return Promise.all(sessions.map((s) => describe(s, defaultId)));
  });

  app.post<{ Body: { label?: string } }>('/api/wa/sessions', async (req) => {
    const sessions = await openwa.listSessions();
    const name = sessionName(req.body?.label?.trim() || `number-${sessions.length + 1}`, new Set(sessions.map((s) => s.name)));
    const session = await openwa.createSession(name);
    await registerWebhook(session.id, log);
    await openwa.start(session.id);
    return describe(await openwa.getSession(session.id), await defaultSessionId());
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/start', async (req) => {
    await openwa.start(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/logout', async (req) => {
    await openwa.logout(req.params.id);
    groupCache.delete(req.params.id);
    forgetSession(req.params.id);
    return { ok: true };
  });

  /** Remove a number entirely. Its waiting messages are cancelled; its send history is kept. */
  app.delete<{ Params: { id: string } }>('/api/wa/sessions/:id', async (req, reply) => {
    const id = req.params.id;
    if (id === (await defaultSessionId())) return reply.code(400).send({ message: 'The main number can be logged out, but not removed.' });
    await openwa.logout(id).catch(() => {});
    await openwa.deleteSession(id).catch((err) => {
      if (!(err instanceof OpenWAError && err.status === 404)) throw err;
    });
    db.prepare(`UPDATE sends SET status = 'cancelled', error = 'The sending number was removed' WHERE session_id = ? AND status = 'queued'`).run(id);
    groupCache.delete(id);
    forgetSession(id);
    return { ok: true };
  });

  /** The default number, kept for older clients. */
  app.get('/api/wa/status', async () => {
    const d = await describe(await openwa.getSession(await defaultSessionId()), await defaultSessionId());
    return { status: d.status, phone: d.phone, pushName: d.pushName, lastError: d.lastError, qrCode: d.qrCode };
  });

  app.get<{ Querystring: { refresh?: string; session?: string } }>('/api/groups', async (req) => {
    const sessionId = await pickSession(req.query);
    let cached = groupCache.get(sessionId);
    if (!cached || req.query.refresh === '1' || Date.now() - cached.at > GROUP_CACHE_MS) {
      cached = { at: Date.now(), groups: await openwa.listGroups(sessionId) };
      groupCache.set(sessionId, cached);
    }
    const favorites = new Set((db.prepare('SELECT group_id FROM favorite_groups').all() as Array<{ group_id: string }>).map((r) => r.group_id));
    return cached.groups
      .map((g) => ({ id: g.id, name: g.name, favorite: favorites.has(g.id) }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  });

  /** Member counts for the groups currently on screen (the list itself has no counts). */
  app.post<{ Body: { ids: string[] }; Querystring: { session?: string } }>('/api/groups/counts', async (req) => {
    const sessionId = await pickSession(req.query);
    const ids = (req.body?.ids ?? []).slice(0, 50);
    const counts = await mapLimit(ids, 6, (id) => groupCount(sessionId, id).catch(() => null));
    return Object.fromEntries(ids.map((id, i) => [id, counts[i]]));
  });

  app.put<{ Params: { id: string }; Body: { favorite: boolean; name?: string } }>('/api/groups/:id/favorite', async (req) => {
    if (req.body.favorite) {
      db.prepare('INSERT OR REPLACE INTO favorite_groups (group_id, name) VALUES (?, ?)').run(req.params.id, req.body.name ?? null);
    } else {
      db.prepare('DELETE FROM favorite_groups WHERE group_id = ?').run(req.params.id);
    }
    return { ok: true };
  });

  /** Group members, annotated for the selected template: hidden, already got it, or selectable. */
  app.get<{ Params: { id: string }; Querystring: { templateId?: string; fresh?: string; session?: string } }>('/api/groups/:id', async (req) => {
    const group = await loadGroupMembers(await pickSession(req.query), req.params.id, req.query.fresh === '1');
    const templateId = req.query.templateId ? Number(req.query.templateId) : null;
    return { id: req.params.id, kind: 'group', name: group.name, description: group.description, members: annotate(group.members, templateId) };
  });

  app.get<{ Params: { id: string; format: string }; Querystring: { session?: string } }>('/api/groups/:id/export.:format', async (req, reply) => {
    const group = await loadGroupMembers(await pickSession(req.query), req.params.id);
    const rows = toRows(annotate(group.members, null));
    if (req.params.format === 'pdf') return sendPdf(reply, group.name, rows);
    if (req.params.format === 'csv') return sendCsv(reply, group.name, rows);
    return reply.code(404).send({ message: 'Use .csv or .pdf' });
  });
}
