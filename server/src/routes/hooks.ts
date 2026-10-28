import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { openwa } from '../openwa.ts';
import { onGroupMembershipEvent } from '../tracker.ts';

/** Delivery ticks, connection state, and joins/leaves (to track "my groups" in real time). */
const EVENTS = ['message.ack', 'message.failed', 'session.status', 'group.join', 'group.leave'];

// Statuses only move forward: a late "delivered" must not overwrite "read".
const RANK: Record<string, number> = { sending: 1, sent: 2, delivered: 3, read: 4 };

function validSignature(req: FastifyRequest): boolean {
  if (!config.webhookSecret) return true;
  const header = String(req.headers['x-openwa-signature'] ?? '');
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  const expected = `sha256=${createHmac('sha256', config.webhookSecret).update(raw).digest('hex')}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function hookRoutes(app: FastifyInstance): void {
  app.post('/hooks/openwa', async (req, reply) => {
    if (!validSignature(req)) return reply.code(401).send({ message: 'Bad signature' });
    const body = req.body as { event?: string; data?: Record<string, unknown>; payload?: Record<string, unknown> };
    const data = body.data ?? body.payload ?? {};

    if (body.event === 'message.ack' || body.event === 'message.failed') {
      const messageId = String(data.messageId ?? data.id ?? '');
      const status = body.event === 'message.failed' ? 'failed' : String(data.status ?? '').toLowerCase();
      const row = db.prepare('SELECT id, status FROM sends WHERE message_id = ?').get(messageId) as { id: number; status: string } | undefined;
      if (row) {
        if (status === 'failed') {
          db.prepare(`UPDATE sends SET status = 'failed', error = 'WhatsApp reported the message failed' WHERE id = ?`).run(row.id);
        } else if ((RANK[status] ?? 0) > (RANK[row.status] ?? 0)) {
          db.prepare('UPDATE sends SET status = ? WHERE id = ?').run(status, row.id);
        }
      }
    }
    if (body.event === 'group.join' || body.event === 'group.leave') {
      const groupId = String(data.groupId ?? data.chatId ?? '');
      if (groupId) onGroupMembershipEvent(groupId);
    }
    return { ok: true };
  });
}

/** Make sure OpenWA knows where to send delivery/read updates for a number. Webhooks are per session; safe to call on every boot. */
export async function registerWebhook(sessionId: string, log: { info: (m: string) => void; warn: (o: object, m: string) => void }): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    const hooks = await openwa.listWebhooks(sessionId);
    const ours = hooks.find((h) => h.url === config.webhookUrl);
    if (ours) {
      // Older installs subscribed to fewer events; add the missing ones.
      if (!EVENTS.every((e) => ours.events.includes(e) || ours.events.includes('*'))) await openwa.updateWebhook(sessionId, ours.id, EVENTS);
      return;
    }
    await openwa.createWebhook(sessionId, config.webhookUrl, EVENTS, config.webhookSecret || undefined);
    log.info(`registered OpenWA webhook for ${sessionId} -> ${config.webhookUrl}`);
  } catch (err) {
    log.warn({ err: String(err) }, 'could not register OpenWA webhook (delivery ticks will not update)');
  }
}
