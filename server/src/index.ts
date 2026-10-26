import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from './config.ts';
import { db } from './db.ts';
import { authRoutes, requireLogin } from './auth.ts';
import { ensureSession, openwa, OpenWAError } from './openwa.ts';
import { startWorker } from './queue.ts';
import { startWarmer } from './warmer.ts';
import { loadSnapshots } from './members.ts';
import { waRoutes } from './routes/wa.ts';
import { templateRoutes } from './routes/templates.ts';
import { sendRoutes } from './routes/sends.ts';
import { contactRoutes } from './routes/contacts.ts';
import { hookRoutes, registerWebhook } from './routes/hooks.ts';
import { listRoutes } from './routes/lists.ts';

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
// Phones on mobile data: the app bundle and big group lists shrink ~4x.
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip'] });

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
listRoutes(app);

app.get('/healthz', async () => ({ ok: true }));

// Serve the built frontend (single-page app) when it exists.
const webDist = resolve(config.webDist);
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    // Built files have a content hash in their name and never change; the page and the
    // service worker must always be re-checked so updates reach phones.
    cacheControl: false,
    setHeaders: (res, path) => {
      if (path.includes(`${sep}assets${sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (path.endsWith('.html') || path.endsWith('sw.js')) res.header('Cache-Control', 'no-cache');
      else res.header('Cache-Control', 'public, max-age=86400');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/')) return reply.code(404).send({ message: 'Not found' });
    return reply.sendFile('index.html');
  });
}

// Restore the warm cache from the last run before accepting requests, so the first open is instant.
app.log.info(`restored ${loadSnapshots()} cached groups from snapshot`);

await app.listen({ port: config.port, host: config.host });

// Connect to OpenWA in the background; retry until it's up so boot order doesn't matter.
(async function connect(attempt = 1): Promise<void> {
  try {
    const main = await ensureSession();
    // Sends from before multi-number support all went from the main number.
    db.prepare('UPDATE sends SET session_id = ? WHERE session_id IS NULL').run(main.id);
    if (main.status === 'created' || main.status === 'disconnected' || main.status === 'failed') {
      await openwa.start(main.id).catch((err) => app.log.warn({ err: String(err) }, 'session start failed'));
    }
    for (const session of await openwa.listSessions()) {
      app.log.info(`OpenWA session "${session.name}" is ${session.status}`);
      await registerWebhook(session.id, { info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) });
    }
    startWorker({ info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) });
    startWarmer({ info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) });
  } catch (err) {
    const delay = Math.min(attempt * 2000, 30_000);
    app.log.warn({ err: String(err) }, `OpenWA not ready, retrying in ${delay / 1000}s`);
    setTimeout(() => void connect(attempt + 1), delay);
  }
})();
