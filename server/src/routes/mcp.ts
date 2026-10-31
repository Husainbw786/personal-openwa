import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { samePassword } from '../auth.ts';

/**
 * AI agents (MCP). /mcp forwards to OpenWA's built-in MCP server on the Chromium gateway.
 *
 * Some clients (Gemini) only connect to MCP servers that have an OAuth login, so the app is also a
 * small OAuth 2.1 server: dynamic client registration, authorization code + PKCE (S256), refresh
 * tokens. Signing in means typing the app password. Agents holding one of our access tokens reach
 * OpenWA with MCP_AGENT_KEY (operator, main number only). Any other bearer token is passed through
 * untouched, so plain OpenWA API keys keep working.
 */

const ACCESS_TTL_SEC = 60 * 60 * 24 * 7;
const REFRESH_TTL_SEC = 60 * 60 * 24 * 365;
const CODE_TTL_MS = 5 * 60_000;
const TOKEN_PREFIX = 'wao_';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');
const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
const now = () => Date.now();

type Client = { client_id: string; secret_hash: string | null; name: string | null; redirect_uris: string };

function getClient(id: string | undefined): Client | undefined {
  if (!id) return undefined;
  return db.prepare('SELECT client_id, secret_hash, name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id) as Client | undefined;
}

function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

function issueTokens(clientId: string) {
  const access = `${TOKEN_PREFIX}${newSecret()}`;
  const refresh = `${TOKEN_PREFIX}r_${newSecret()}`;
  const insert = db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, expires_at) VALUES (?, ?, ?, ?)');
  insert.run(sha256(access), 'access', clientId, now() + ACCESS_TTL_SEC * 1000);
  insert.run(sha256(refresh), 'refresh', clientId, now() + REFRESH_TTL_SEC * 1000);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now());
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh };
}

function validAccessToken(token: string): boolean {
  const row = db.prepare("SELECT expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token)) as { expires_at: number } | undefined;
  return !!row && row.expires_at > now();
}

/** Client authentication at the token endpoint: HTTP Basic or client_secret in the body; none for public clients. */
function clientFromTokenRequest(req: FastifyRequest, body: Record<string, string>): Client | null {
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':');
    id = decodeURIComponent(u ?? '');
    secret = decodeURIComponent(p ?? '');
  }
  const client = getClient(id);
  if (!client) return null;
  if (client.secret_hash && (!secret || sha256(secret) !== client.secret_hash)) return null;
  return client;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(params: Record<string, string>, clientName: string, error = ''): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to WhatsApp</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f2; --card:#fff; --text:#1d2420; --muted:#5c6660; --accent:#128c4a; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111513; --card:#1b201d; --text:#e8ece9; --muted:#9aa49e; --accent:#3ccf7d; --err:#ff8a7a; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, sans-serif; padding:16px; box-sizing:border-box; }
  form { background:var(--card); border-radius:16px; padding:28px; width:100%; max-width:380px; box-shadow:0 1px 3px #0002; }
  h1 { font-size:20px; margin:0 0 8px; } p { color:var(--muted); margin:0 0 20px; } b { color:var(--text); }
  input[type=password] { width:100%; box-sizing:border-box; font:inherit; padding:12px; border-radius:10px; border:1px solid #8884; background:transparent; color:inherit; }
  .row { display:flex; gap:10px; margin-top:16px; } button { flex:1; font:inherit; font-weight:600; padding:12px; border-radius:10px; border:0; cursor:pointer; }
  .allow { background:var(--accent); color:#fff; } .deny { background:#8882; color:inherit; } .err { color:var(--err); margin:0 0 12px; }
</style></head><body>
<form method="post" action="/oauth/authorize">
  <h1>Allow access to your WhatsApp?</h1>
  <p><b>${esc(clientName)}</b> wants to read your chats and send messages from your number. Enter your WA Sender password to allow it.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  ${hidden}
  <input type="password" name="password" placeholder="WA Sender password" autocomplete="current-password" autofocus>
  <div class="row"><button class="deny" name="decision" value="deny">Deny</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form></body></html>`;
}

const AUTHORIZE_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

let failedAttempts = 0;

export function mcpRoutes(app: FastifyInstance): void {
  const resourceMetadata = (req: FastifyRequest) => ({
    resource: `${origin(req)}/mcp`,
    authorization_servers: [origin(req)],
    bearer_methods_supported: ['header'],
    resource_name: 'WhatsApp (WA Sender)',
  });
  app.get('/.well-known/oauth-protected-resource', async (req) => resourceMetadata(req));
  app.get('/.well-known/oauth-protected-resource/mcp', async (req) => resourceMetadata(req));

  const serverMetadata = (req: FastifyRequest) => {
    const o = origin(req);
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['whatsapp'],
    };
  };
  app.get('/.well-known/oauth-authorization-server', async (req) => serverMetadata(req));
  app.get('/.well-known/openid-configuration', async (req) => serverMetadata(req));

  // Dynamic client registration (RFC 7591).
  app.post<{ Body: { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string } }>('/oauth/register', async (req, reply) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && allowedRedirect(u))) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http on localhost)' });
    }
    const method = req.body?.token_endpoint_auth_method ?? 'none';
    const clientId = `wac_${randomBytes(16).toString('base64url')}`;
    const secret = method === 'none' ? null : newSecret();
    const name = (req.body?.client_name ?? '').slice(0, 100) || null;
    db.prepare('INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris) VALUES (?, ?, ?, ?)')
      .run(clientId, secret ? sha256(secret) : null, name, JSON.stringify(uris));
    return reply.code(201).header('Cache-Control', 'no-store').send({
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name ?? undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: secret ? method : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  /** Checks an authorize request; returns the client or a message for an error page (never redirect to an unchecked URI). */
  function checkAuthorize(p: Record<string, string>): { client: Client } | { error: string } {
    const client = getClient(p.client_id);
    if (!client) return { error: 'Unknown app. Remove the connection and add it again.' };
    if (!(JSON.parse(client.redirect_uris) as string[]).includes(p.redirect_uri)) return { error: 'This app sent a return address it did not register.' };
    if (p.response_type !== 'code') return { error: 'Unsupported response_type.' };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { error: 'This app must use PKCE (S256).' };
    return { client };
  }

  const pick = (src: Record<string, unknown> | undefined) =>
    Object.fromEntries(AUTHORIZE_PARAMS.filter((k) => typeof src?.[k] === 'string').map((k) => [k, src![k] as string]));

  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (req, reply) => {
    const params = pick(req.query);
    const checked = checkAuthorize(params);
    if ('error' in checked) return reply.code(400).type('text/plain').send(checked.error);
    return reply.type('text/html').header('Cache-Control', 'no-store').send(consentPage(params, checked.client.name ?? 'An AI app'));
  });

  app.post<{ Body: Record<string, string> }>('/oauth/authorize', async (req, reply) => {
    const params = pick(req.body);
    const checked = checkAuthorize(params);
    if ('error' in checked) return reply.code(400).type('text/plain').send(checked.error);
    const back = new URL(params.redirect_uri);
    if (params.state) back.searchParams.set('state', params.state);
    back.searchParams.set('iss', origin(req));

    if (req.body?.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied');
      return reply.redirect(back.toString(), 302);
    }
    // Slow down guessing: each consecutive failure adds a second, up to 10.
    if (failedAttempts > 0) await new Promise((r) => setTimeout(r, Math.min(failedAttempts, 10) * 1000));
    if (!samePassword(req.body?.password ?? '', config.appPassword)) {
      failedAttempts++;
      return reply.code(401).type('text/html').send(consentPage(params, checked.client.name ?? 'An AI app', 'Wrong password'));
    }
    failedAttempts = 0;

    const code = newSecret();
    db.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(code), checked.client.client_id, params.redirect_uri, params.code_challenge, now() + CODE_TTL_MS);
    back.searchParams.set('code', code);
    return reply.redirect(back.toString(), 302);
  });

  app.post<{ Body: Record<string, string> }>('/oauth/token', async (req, reply) => {
    const body = req.body ?? {};
    const fail = (error: string, status = 400) => reply.code(status).header('Cache-Control', 'no-store').send({ error });
    const client = clientFromTokenRequest(req, body);
    if (!client) return fail('invalid_client', 401);

    if (body.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT client_id, redirect_uri, challenge, expires_at FROM oauth_codes WHERE code_hash = ?').get(sha256(body.code ?? '')) as
        | { client_id: string; redirect_uri: string; challenge: string; expires_at: number }
        | undefined;
      db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?').run(sha256(body.code ?? ''), now()); // single use
      if (!row || row.expires_at < now() || row.client_id !== client.client_id) return fail('invalid_grant');
      if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return fail('invalid_grant');
      const verifier = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (verifier !== row.challenge) return fail('invalid_grant');
      return reply.header('Cache-Control', 'no-store').send(issueTokens(client.client_id));
    }

    if (body.grant_type === 'refresh_token') {
      const hash = sha256(body.refresh_token ?? '');
      const row = db.prepare("SELECT client_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash) as
        | { client_id: string; expires_at: number }
        | undefined;
      if (!row || row.expires_at < now() || row.client_id !== client.client_id) return fail('invalid_grant');
      db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash); // rotate
      return reply.header('Cache-Control', 'no-store').send(issueTokens(client.client_id));
    }

    return fail('unsupported_grant_type');
  });

  // The MCP endpoint itself: check the caller, then stream OpenWA's answer back.
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    compress: false,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      let upstreamAuth: string;
      if (bearer && !bearer.startsWith(TOKEN_PREFIX)) {
        upstreamAuth = `Bearer ${bearer}`; // an OpenWA API key: OpenWA checks it
      } else if (bearer && validAccessToken(bearer)) {
        if (!config.mcpAgentKey) return reply.code(503).send({ message: 'MCP_AGENT_KEY is not set on the server' });
        upstreamAuth = `Bearer ${config.mcpAgentKey}`;
      } else {
        const challenge = `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource"${bearer ? ', error="invalid_token"' : ''}`;
        return reply.code(401).header('WWW-Authenticate', challenge).send({ message: bearer ? 'Token expired or revoked' : 'Sign in required' });
      }

      const headers: Record<string, string> = {
        authorization: upstreamAuth,
        // OpenWA answers 406 unless the client also accepts text/event-stream; some clients (Gemini) only ask for JSON.
        accept: 'application/json, text/event-stream',
      };
      for (const h of ['content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const upstream = await fetch(`${config.openwaWebUrl || config.openwaUrl}/mcp`, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      });
      reply.code(upstream.status).header('Cache-Control', 'no-cache');
      for (const h of ['content-type', 'mcp-session-id', 'allow']) {
        const v = upstream.headers.get(h);
        if (v) reply.header(h, v);
      }
      return reply.send(upstream.body ? Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream) : undefined);
    },
  });
}
