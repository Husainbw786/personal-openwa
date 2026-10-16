import { config } from './config.ts';

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

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${config.openwaUrl}${path}`, {
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
 * Each linked WhatsApp number is one OpenWA session. The one named OPENWA_SESSION ("main") is the
 * default and is created on boot; more can be added from the app. Session ids are OpenWA's ids.
 */
let defaultId: string | null = null;

export async function ensureSession(): Promise<Session> {
  const sessions = await call<Session[]>('GET', '/api/sessions');
  let session = sessions.find((s) => s.name === config.openwaSessionName);
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

const base = (sessionId: string) => `/api/sessions/${enc(sessionId)}`;

export const openwa = {
  async listSessions(): Promise<Session[]> {
    return call('GET', '/api/sessions');
  },
  async createSession(name: string): Promise<Session> {
    return call('POST', '/api/sessions', { name });
  },
  async deleteSession(sessionId: string): Promise<void> {
    await call('DELETE', base(sessionId));
  },
  async getSession(sessionId: string): Promise<Session> {
    return call<Session>('GET', base(sessionId));
  },
  async start(sessionId: string): Promise<void> {
    await call('POST', `${base(sessionId)}/start`);
  },
  async logout(sessionId: string): Promise<void> {
    await call('POST', `${base(sessionId)}/logout`);
  },
  async getQr(sessionId: string): Promise<{ qrCode: string; status: SessionStatus }> {
    return call('GET', `${base(sessionId)}/qr`);
  },
  async listGroups(sessionId: string): Promise<GroupSummary[]> {
    return call('GET', `${base(sessionId)}/groups?limit=1000`);
  },
  async getGroup(sessionId: string, groupId: string): Promise<GroupInfo> {
    return call('GET', `${base(sessionId)}/groups/${enc(groupId)}`);
  },
  async listContacts(sessionId: string): Promise<Array<{ id: string; number?: string; name?: string }>> {
    return call('GET', `${base(sessionId)}/contacts`);
  },
  async resolvePhone(sessionId: string, contactId: string): Promise<string | null> {
    const res = await call<{ phone: string | null }>('GET', `${base(sessionId)}/contacts/${enc(contactId)}/phone`);
    return res.phone;
  },
  /** idempotencyKey makes a retry after a crash safe: OpenWA replays the first result instead of sending twice. */
  async sendText(sessionId: string, chatId: string, text: string, idempotencyKey: string): Promise<{ messageId: string }> {
    return call('POST', `${base(sessionId)}/messages/send-text`, { chatId, text }, { 'Idempotency-Key': idempotencyKey });
  },
  async listWebhooks(sessionId: string): Promise<Array<{ id: string; url: string; events: string[] }>> {
    return call('GET', `${base(sessionId)}/webhooks`);
  },
  async createWebhook(sessionId: string, url: string, events: string[], secret?: string): Promise<void> {
    await call('POST', `${base(sessionId)}/webhooks`, { url, events, ...(secret ? { secret } : {}), retryCount: 3 });
  },
};
