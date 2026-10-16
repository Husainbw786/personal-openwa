import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { defaultSessionId, openwa, OpenWAError } from '../openwa.ts';
import { normalizeRecipient as normalizePhone, isValidRecipient as isValidPhone } from '../phone.ts';
import { queueState, setPaused } from '../queue.ts';

interface SendRequest {
  templateId: number;
  sessionId?: string; // the number that sends; defaults to the main one
  groupId?: string;
  groupName?: string;
  recipients: Array<{ phone: string; name?: string | null }>;
}

export function sendRoutes(app: FastifyInstance): void {
  /**
   * Queue a batch from one number. Recipients who already got this template (from any number)
   * or are excluded are skipped, never re-sent.
   */
  app.post<{ Body: SendRequest }>('/api/sends', async (req, reply) => {
    const { templateId, groupId, groupName, recipients } = req.body ?? ({} as SendRequest);
    const sessionId = req.body?.sessionId || (await defaultSessionId());
    try {
      await openwa.getSession(sessionId);
    } catch (err) {
      if (err instanceof OpenWAError && err.status === 404) return reply.code(400).send({ message: 'That sending number no longer exists' });
      throw err;
    }
    const template = db.prepare('SELECT id, archived FROM templates WHERE id = ?').get(Number(templateId)) as { id: number; archived: number } | undefined;
    if (!template || template.archived) return reply.code(400).send({ message: 'Pick an active template' });
    if (!Array.isArray(recipients) || recipients.length === 0) return reply.code(400).send({ message: 'Select at least one person' });
    if (recipients.length > config.maxBatch) return reply.code(400).send({ message: `Select at most ${config.maxBatch} people per batch` });

    const isExcluded = db.prepare('SELECT 1 FROM excluded WHERE phone = ?');
    const existing = db.prepare('SELECT id, status FROM sends WHERE template_id = ? AND phone = ?');
    const insert = db.prepare(`INSERT INTO sends (template_id, phone, name, group_id, group_name, session_id) VALUES (?, ?, ?, ?, ?, ?)`);
    const requeue = db.prepare(`UPDATE sends SET status = 'queued', error = NULL, attempts = 0, name = ?, group_id = ?, group_name = ?, session_id = ?, from_phone = NULL, created_at = datetime('now') WHERE id = ?`);

    const result = { queued: 0, skippedAlreadySent: 0, skippedExcluded: 0, invalid: 0 };
    db.exec('BEGIN');
    try {
      for (const r of recipients) {
        const phone = normalizePhone(String(r.phone ?? ''));
        if (!isValidPhone(phone)) { result.invalid++; continue; }
        if (isExcluded.get(phone)) { result.skippedExcluded++; continue; }
        const prior = existing.get(template.id, phone) as { id: number; status: string } | undefined;
        if (!prior) {
          insert.run(template.id, phone, r.name ?? null, groupId ?? null, groupName ?? null, sessionId);
          result.queued++;
        } else if (prior.status === 'failed' || prior.status === 'cancelled') {
          requeue.run(r.name ?? null, groupId ?? null, groupName ?? null, sessionId, prior.id);
          result.queued++;
        } else {
          result.skippedAlreadySent++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return result;
  });

  app.get('/api/queue', async () => queueState());

  app.post<{ Body: { paused: boolean } }>('/api/queue/pause', async (req) => {
    setPaused(Boolean(req.body?.paused));
    return queueState();
  });

  app.post('/api/queue/cancel', async () => {
    const res = db.prepare(`UPDATE sends SET status = 'cancelled', error = 'Cancelled by you' WHERE status = 'queued'`).run();
    return { cancelled: res.changes };
  });

  app.get<{ Querystring: { status?: string; templateId?: string; session?: string; q?: string; limit?: string; offset?: string } }>('/api/sends', async (req) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (req.query.status) { where.push('s.status = ?'); params.push(req.query.status); }
    if (req.query.session) { where.push('s.session_id = ?'); params.push(req.query.session); }
    if (req.query.templateId) { where.push('s.template_id = ?'); params.push(Number(req.query.templateId)); }
    if (req.query.q) {
      where.push('(s.phone LIKE ? OR s.name LIKE ? OR s.group_name LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const sql = `
      SELECT s.id, s.phone, s.name, s.group_name, s.status, s.error, s.text, s.created_at, s.sent_at, s.session_id, s.from_phone, t.name AS template_name
      FROM sends s JOIN templates t ON t.id = s.template_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...params, limit, offset);
  });
}
