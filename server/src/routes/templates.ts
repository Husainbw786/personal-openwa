import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { renderTemplate } from '../queue.ts';

interface TemplateBody {
  name?: string;
  body?: string;
  fallback?: string;
  archived?: boolean;
}

function validate(b: TemplateBody): string | null {
  if (!b.name?.trim()) return 'Template name is required';
  if (!b.body?.trim()) return 'Message text is required';
  if (b.body.length > 4000) return 'Message is too long (max 4000 characters)';
  return null;
}

export function templateRoutes(app: FastifyInstance): void {
  app.get('/api/templates', async () => {
    return db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM sends s WHERE s.template_id = t.id AND s.status IN ('sent','delivered','read')) AS sent_count
      FROM templates t ORDER BY t.archived, t.updated_at DESC
    `).all();
  });

  app.post<{ Body: TemplateBody }>('/api/templates', async (req, reply) => {
    const error = validate(req.body);
    if (error) return reply.code(400).send({ message: error });
    const { name, body, fallback } = req.body;
    const res = db.prepare('INSERT INTO templates (name, body, fallback) VALUES (?, ?, ?)').run(name!.trim(), body!, fallback?.trim() || 'there');
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(res.lastInsertRowid);
  });

  app.put<{ Params: { id: string }; Body: TemplateBody }>('/api/templates/:id', async (req, reply) => {
    const error = validate(req.body);
    if (error) return reply.code(400).send({ message: error });
    const { name, body, fallback, archived } = req.body;
    db.prepare(`UPDATE templates SET name = ?, body = ?, fallback = ?, archived = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name!.trim(), body!, fallback?.trim() || 'there', archived ? 1 : 0, Number(req.params.id));
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  });

  app.post<{ Body: { body: string; fallback?: string; name?: string } }>('/api/templates/preview', async (req) => {
    return { text: renderTemplate(req.body.body ?? '', req.body.name ?? null, req.body.fallback || 'there') };
  });
}
