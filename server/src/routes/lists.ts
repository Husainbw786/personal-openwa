import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { annotate, type RawMember } from '../members.ts';
import { getMyGroups, myGroupMembership } from '../mygroups.ts';
import { recentJoins } from '../tracker.ts';
import { parseContactsCsv, sendCsv, sendPdf, toRows } from '../export.ts';
import { normalizeRecipient, isValidRecipient } from '../phone.ts';

/**
 * Uploaded lists: a CSV of contacts that behaves exactly like a WhatsApp group in the app,
 * e.g. members of a group you are in on another number.
 */
export function listRoutes(app: FastifyInstance): void {
  app.get('/api/lists', async () => {
    return db.prepare(`
      SELECT l.id, l.name, l.created_at, COUNT(m.phone) AS member_count
      FROM lists l LEFT JOIN list_members m ON m.list_id = l.id
      GROUP BY l.id ORDER BY l.created_at DESC
    `).all();
  });

  app.post<{ Body: { name?: string; csv?: string } }>('/api/lists', { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: 'Give the list a name' });
    const parsed = parseContactsCsv(req.body?.csv ?? '');
    if (parsed.length === 0) return reply.code(400).send({ message: 'No phone numbers found. The file needs a column like "phone" or "number".' });

    const seen = new Map<string, string | null>();
    const admins = new Set<string>();
    let invalid = 0;
    for (const row of parsed) {
      const key = normalizeRecipient(row.phone);
      if (!isValidRecipient(key)) { invalid++; continue; }
      if (!seen.has(key) || (!seen.get(key) && row.name)) seen.set(key, row.name);
      if (row.isAdmin) admins.add(key);
    }
    if (seen.size === 0) return reply.code(400).send({ message: `None of the ${parsed.length} rows had a valid phone number.` });

    const insertMember = db.prepare('INSERT INTO list_members (list_id, phone, name, is_admin) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      const listId = Number(db.prepare('INSERT INTO lists (name) VALUES (?)').run(name).lastInsertRowid);
      for (const [phone, memberName] of seen) insertMember.run(listId, phone, memberName, admins.has(phone) ? 1 : 0);
      db.exec('COMMIT');
      return { id: listId, name, added: seen.size, duplicates: parsed.length - invalid - seen.size, invalid };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  app.put<{ Params: { id: string }; Body: { name?: string } }>('/api/lists/:id', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: 'Name is required' });
    db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    return { ok: true };
  });

  /** Deleting a list keeps send history, so people who already got a template still won't get it twice. */
  app.delete<{ Params: { id: string } }>('/api/lists/:id', async (req) => {
    db.prepare('DELETE FROM lists WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  function loadList(id: number) {
    const list = db.prepare('SELECT id, name FROM lists WHERE id = ?').get(id) as { id: number; name: string } | undefined;
    if (!list) return null;
    const rows = db.prepare('SELECT phone, name, is_admin FROM list_members WHERE list_id = ?').all(id) as Array<{ phone: string; name: string | null; is_admin: number }>;
    const members: RawMember[] = rows.map((r) => ({ phone: r.phone, whatsappName: r.name, isAdmin: !!r.is_admin }));
    return { list, members };
  }

  app.get<{ Params: { id: string }; Querystring: { templateId?: string } }>('/api/lists/:id', async (req, reply) => {
    const data = loadList(Number(req.params.id));
    if (!data) return reply.code(404).send({ message: 'List not found' });
    const templateId = req.query.templateId ? Number(req.query.templateId) : null;
    const membership = await myGroupMembership();
    return {
      id: `list:${data.list.id}`, kind: 'list', name: data.list.name, description: '', isMine: false,
      myGroups: getMyGroups().map((g) => g.name),
      members: annotate(data.members, templateId, membership, recentJoins(30)),
    };
  });

  app.get<{ Params: { id: string; format: string } }>('/api/lists/:id/export.:format', async (req, reply) => {
    const data = loadList(Number(req.params.id));
    if (!data) return reply.code(404).send({ message: 'List not found' });
    const rows = toRows(annotate(data.members, null));
    if (req.params.format === 'pdf') return sendPdf(reply, data.list.name, rows);
    if (req.params.format === 'csv') return sendCsv(reply, data.list.name, rows);
    return reply.code(404).send({ message: 'Use .csv or .pdf' });
  });
}
