import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import './db.ts';
import { authRoutes, requireLogin } from './auth.ts';
import { ensureSession, openwa, OpenWAError } from './openwa.ts';
import { startWorker } from './queue.ts';
import { waRoutes } from './routes/wa.ts';
import { templateRoutes } from './routes/templates.ts';
import { sendRoutes } from './routes/sends.ts';
import { contactRoutes } from './routes/contacts.ts';
import { hookRoutes, registerWebhook } from './routes/hooks.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

// Keep the raw JSON body around so the webhook receiver can verify OpenWA's HMAC signature.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

await app.register(cookie, { secret: config.cookieSecret });

app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/') || url === '/api/login' || url === '/api/me') return;
  await requireLogin(req, reply);
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof OpenWAError) {
    const status = err.status === 401 || err.status === 403 ? 502 : err.status;
    return reply.code(status >= 400 && status < 600 ? status : 502).send({ message: `WhatsApp gateway: ${err.message}`, code: err.code });
  }
  if (err instanceof TypeError && String(err.message).includes('fetch failed')) {
    return reply.code(503).send({ message: 'WhatsApp gateway (OpenWA) is not reachable. Is it running?' });
  }
  app.log.error(err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ message: status === 500 ? 'Something went wrong' : (err as Error).message });
});

authRoutes(app);
waRoutes(app);
templateRoutes(app);
sendRoutes(app);
contactRoutes(app);
hookRoutes(app);

app.get('/healthz', async () => ({ ok: true }));

// Serve the built frontend (single-page app) when it exists.
const webDist = resolve(config.webDist);
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/')) return reply.code(404).send({ message: 'Not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host });

// Connect to OpenWA in the background; retry until it's up so boot order doesn't matter.
(async function connect(attempt = 1): Promise<void> {
  try {
    const session = await ensureSession();
    if (session.status === 'created' || session.status === 'disconnected' || session.status === 'failed') {
      await openwa.start().catch((err) => app.log.warn({ err: String(err) }, 'session start failed'));
    }
    app.log.info(`OpenWA session "${session.name}" is ${session.status}`);
    await registerWebhook({ info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) });
    startWorker({ info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) });
  } catch (err) {
    const delay = Math.min(attempt * 2000, 30_000);
    app.log.warn({ err: String(err) }, `OpenWA not ready, retrying in ${delay / 1000}s`);
    setTimeout(() => void connect(attempt + 1), delay);
  }
})();
