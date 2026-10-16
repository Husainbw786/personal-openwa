import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';

const COOKIE = 'wa_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // stay logged in for 30 days

function samePassword(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isLoggedIn(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  return Number(unsigned.value) > Date.now();
}

export async function requireLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isLoggedIn(req)) {
    await reply.code(401).send({ message: 'Not logged in' });
  }
}

let failedAttempts = 0;

export function authRoutes(app: FastifyInstance): void {
  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    // Slow down guessing: each consecutive failure adds a second, up to 10.
    if (failedAttempts > 0) await new Promise((r) => setTimeout(r, Math.min(failedAttempts, 10) * 1000));
    if (!samePassword(req.body?.password ?? '', config.appPassword)) {
      failedAttempts++;
      return reply.code(401).send({ message: 'Wrong password' });
    }
    failedAttempts = 0;
    const expires = Date.now() + MAX_AGE_SEC * 1000;
    reply.setCookie(COOKIE, String(expires), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      signed: true,
      maxAge: MAX_AGE_SEC,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ loggedIn: isLoggedIn(req) }));
}
