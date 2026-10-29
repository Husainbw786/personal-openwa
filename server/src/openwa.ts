import { config } from './config.ts';
import { getSetting, setSetting } from './db.ts';

export type SessionStatus =
  | 'created' | 'initializing' | 'qr_ready' | 'authenticating'
  | 'ready' | 'disconnected' | 'action_required' | 'failed';

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  lastError?: string | null;
}

export interface GroupSummary {
  id: string;
  name: string;
  linkedParentJID?: string | null;
}

export interface GroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo extends GroupSummary {
  description?: string;
  participants: GroupParticipant[];
  isReadOnly?: boolean;
}

export class OpenWAError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, gateway = config.openwaUrl): Promise<T> {
  const res = await fetch(`${gateway}${path}`, {
    method,
    headers: {
      'X-API-Key': config.openwaApiKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = (data as { message?: string | string[] } | null)?.message;
    throw new OpenWAError(
      res.status,
      Array.isArray(message) ? message.join('; ') : message ?? `OpenWA ${method} ${path} failed with ${res.status}`,
      (data as { code?: string } | null)?.code,
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

const enc = encodeURIComponent;

/**
 * Each linked WhatsApp number is one OpenWA session; one of them is the "main" (default) number.
 * Main is the one saved in settings, else the one named OPENWA_SESSION, else the first connected one.
 * If no session exists at all, a fresh "main" is created, ready for a QR scan.
 */
let defaultId: string | null = null;

export async function ensureSession(): Promise<Session> {
  const sessions = await openwa.listSessions();
  const saved = getSetting('default_session', '');
  let session =
    sessions.find((s) => s.id === saved) ??
    sessions.find((s) => s.name === config.openwaSessionName) ??
    sessions.find((s) => s.status === 'ready') ??
    sessions[0];
  if (!session) {
    session = await call<Session>('POST', '/api/sessions', { name: config.openwaSessionName });
  }
  defaultId = session.id;
  return session;
}

export async function defaultSessionId(): Promise<string> {
  if (!defaultId) await ensureSession();
  return defaultId!;
}

export function setDefaultSession(sessionId: string): void {
  setSetting('default_session', sessionId);
  defaultId = sessionId;
}

/** Forget the cached main number (after it was removed); the next lookup picks a new one. */
export function forgetDefaultSession(removedId: string): void {
  if (getSetting('default_session', '') === removedId) setSetting('default_session', '');
  if (defaultId === removedId) defaultId = null;
}

const base = (sessionId: string) => `/api/sessions/${enc(sessionId)}`;

/**
 * Two gateways can run side by side: the original one (Baileys engine) and, if OPENWA_WEB_URL is set,
 * one with the Chromium engine (whatsapp-web.js). The engine is per gateway, so each number lives on
 * one of them; calls for a number go to the gateway that has it.
 */
const gateways = () => [config.openwaUrl, ...(config.openwaWebUrl ? [config.openwaWebUrl] : [])];
const gatewayOf = new Map<string, string>();

async function listAll(): Promise<Session[]> {
  const lists = await Promise.all(gateways().map(async (gw, i) => {
    try {
      const sessions = await call<Session[]>('GET', '/api/sessions', undefined, {}, gw);
      for (const s of sessions) gatewayOf.set(s.id, gw);
      return sessions;
    } catch (err) {
      if (i === 0) throw err; // the main gateway must answer; a down Chromium gateway just hides its numbers
      return [];
    }
  }));
  return lists.flat();
}

async function gatewayFor(sessionId: string): Promise<string> {
  if (!gatewayOf.has(sessionId)) await listAll();
  return gatewayOf.get(sessionId) ?? config.openwaUrl;
}

/** True when this number runs on the Chromium (whatsapp-web.js) gateway. */
export async function isChromium(sessionId: string): Promise<boolean> {
  return !!config.openwaWebUrl && (await gatewayFor(sessionId)) === config.openwaWebUrl;
}

/** A call about one number, sent to the gateway that holds it. */
async function scall<T>(sessionId: string, method: string, sub: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  return call<T>(method, `${base(sessionId)}${sub}`, body, headers, await gatewayFor(sessionId));
}

export const openwa = {
  async listSessions(): Promise<Session[]> {
    return listAll();
  },
  /** New numbers go on the Chromium gateway when there is one. */
  async createSession(name: string): Promise<Session> {
    const gw = config.openwaWebUrl || config.openwaUrl;
    const session = await call<Session>('POST', '/api/sessions', { name }, {}, gw);
    gatewayOf.set(session.id, gw);
    return session;
  },
  async deleteSession(sessionId: string): Promise<void> {
    await scall(sessionId, 'DELETE', '');
  },
  async getSession(sessionId: string): Promise<Session> {
    return scall(sessionId, 'GET', '');
  },
  async start(sessionId: string): Promise<void> {
    await scall(sessionId, 'POST', `/start`);
  },
  /** Stop and start again; for a connection stuck on "reconnecting". Force-kills if a normal stop hangs. */
  async restart(sessionId: string): Promise<void> {
    await scall(sessionId, 'POST', `/stop`).catch(() => scall(sessionId, 'POST', `/force-kill`));
    await new Promise((r) => setTimeout(r, 2000));
    await scall(sessionId, 'POST', `/start`);
  },
  async logout(sessionId: string): Promise<void> {
    await scall(sessionId, 'POST', `/logout`);
  },
  async getQr(sessionId: string): Promise<{ qrCode: string; status: SessionStatus }> {
    return scall(sessionId, 'GET', `/qr`);
  },
  /** Link without scanning: WhatsApp → Linked devices → Link with phone number instead, then type this code. */
  async requestPairingCode(sessionId: string, phoneNumber: string): Promise<{ pairingCode: string; status: SessionStatus }> {
    return scall(sessionId, 'POST', `/pairing-code`, { phoneNumber });
  },
  async listGroups(sessionId: string): Promise<GroupSummary[]> {
    return scall(sessionId, 'GET', `/groups?limit=1000`);
  },
  async getGroup(sessionId: string, groupId: string): Promise<GroupInfo> {
    return scall(sessionId, 'GET', `/groups/${enc(groupId)}`);
  },
  async listContacts(sessionId: string): Promise<Array<{ id: string; number?: string; name?: string }>> {
    return scall(sessionId, 'GET', `/contacts`);
  },
  async resolvePhone(sessionId: string, contactId: string): Promise<string | null> {
    const res = await scall<{ phone: string | null }>(sessionId, 'GET', `/contacts/${enc(contactId)}/phone`);
    return res.phone;
  },
  /** idempotencyKey makes a retry after a crash safe: OpenWA replays the first result instead of sending twice. */
  async sendText(sessionId: string, chatId: string, text: string, idempotencyKey: string): Promise<{ messageId: string }> {
    return scall(sessionId, 'POST', `/messages/send-text`, { chatId, text }, { 'Idempotency-Key': idempotencyKey });
  },
  async listWebhooks(sessionId: string): Promise<Array<{ id: string; url: string; events: string[] }>> {
    return scall(sessionId, 'GET', `/webhooks`);
  },
  async updateWebhook(sessionId: string, webhookId: string, events: string[]): Promise<void> {
    await scall(sessionId, 'PUT', `/webhooks/${enc(webhookId)}`, { events });
  },
  async createWebhook(sessionId: string, url: string, events: string[], secret?: string): Promise<void> {
    await scall(sessionId, 'POST', `/webhooks`, { url, events, ...(secret ? { secret } : {}), retryCount: 3 });
  },
};
