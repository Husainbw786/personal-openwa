import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { openwa, type GroupSummary } from '../openwa.ts';
import { annotate, groupCount, loadGroupMembers, mapLimit } from '../members.ts';
import { sendCsv, sendPdf, toRows } from '../export.ts';

let groupCache: { at: number; groups: GroupSummary[] } | null = null;
const GROUP_CACHE_MS = 5 * 60 * 1000;

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

  /** Member counts for the groups currently on screen (the list itself has no counts). */
  app.post<{ Body: { ids: string[] } }>('/api/groups/counts', async (req) => {
    const ids = (req.body?.ids ?? []).slice(0, 50);
    const counts = await mapLimit(ids, 6, (id) => groupCount(id).catch(() => null));
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
  app.get<{ Params: { id: string }; Querystring: { templateId?: string; fresh?: string } }>('/api/groups/:id', async (req) => {
    const group = await loadGroupMembers(req.params.id, req.query.fresh === '1');
    const templateId = req.query.templateId ? Number(req.query.templateId) : null;
    return { id: req.params.id, kind: 'group', name: group.name, description: group.description, members: annotate(group.members, templateId) };
  });

  app.get<{ Params: { id: string; format: string } }>('/api/groups/:id/export.:format', async (req, reply) => {
    const group = await loadGroupMembers(req.params.id);
    const rows = toRows(annotate(group.members, null));
    if (req.params.format === 'pdf') return sendPdf(reply, group.name, rows);
    if (req.params.format === 'csv') return sendCsv(reply, group.name, rows);
    return reply.code(404).send({ message: 'Use .csv or .pdf' });
  });
}
