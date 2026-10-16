import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { normalizeRecipient as normalizePhone, isValidRecipient as isValidPhone } from '../phone.ts';

export function contactRoutes(app: FastifyInstance): void {
  app.get('/api/excluded', async () => db.prepare('SELECT * FROM excluded ORDER BY created_at DESC').all());

  app.post<{ Body: { phone: string; note?: string } }>('/api/excluded', async (req, reply) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    if (!isValidPhone(phone)) return reply.code(400).send({ message: 'Invalid phone number' });
    db.prepare('INSERT INTO excluded (phone, note) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET note = excluded.note').run(phone, req.body.note ?? null);
    // Anything still waiting in the queue for this number is cancelled right away.
    db.prepare(`UPDATE sends SET status = 'cancelled', error = 'Number is excluded' WHERE phone = ? AND status = 'queued'`).run(phone);
    return { ok: true, phone };
  });

  app.delete<{ Params: { phone: string } }>('/api/excluded/:phone', async (req) => {
    db.prepare('DELETE FROM excluded WHERE phone = ?').run(normalizePhone(req.params.phone));
    return { ok: true };
  });

  /** Save a name for a number WhatsApp didn't give us a name for. Empty name removes it. */
  app.put<{ Params: { phone: string }; Body: { name: string } }>('/api/contacts/:phone/name', async (req) => {
    const phone = normalizePhone(req.params.phone);
    const name = req.body?.name?.trim();
    if (name) db.prepare('INSERT INTO contact_names (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = excluded.name').run(phone, name);
    else db.prepare('DELETE FROM contact_names WHERE phone = ?').run(phone);
    return { ok: true };
  });
}
