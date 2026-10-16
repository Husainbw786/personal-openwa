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

/** Our app uses exactly one WhatsApp session. We look it up by name and create it if missing. */
let sessionId: string | null = null;

export async function ensureSession(): Promise<Session> {
  const sessions = await call<Session[]>('GET', '/api/sessions');
  let session = sessions.find((s) => s.name === config.openwaSessionName);
  if (!session) {
    session = await call<Session>('POST', '/api/sessions', { name: config.openwaSessionName });
  }
  sessionId = session.id;
  return session;
}

async function sid(): Promise<string> {
  if (!sessionId) await ensureSession();
  return sessionId!;
}

export const openwa = {
  async getSession(): Promise<Session> {
    return call<Session>('GET', `/api/sessions/${enc(await sid())}`);
  },
  async start(): Promise<void> {
    await call('POST', `/api/sessions/${enc(await sid())}/start`);
  },
  async logout(): Promise<void> {
    await call('POST', `/api/sessions/${enc(await sid())}/logout`);
  },
  async getQr(): Promise<{ qrCode: string; status: SessionStatus }> {
    return call('GET', `/api/sessions/${enc(await sid())}/qr`);
  },
  async listGroups(): Promise<GroupSummary[]> {
    return call('GET', `/api/sessions/${enc(await sid())}/groups?limit=1000`);
  },
  async getGroup(groupId: string): Promise<GroupInfo> {
    return call('GET', `/api/sessions/${enc(await sid())}/groups/${enc(groupId)}`);
  },
  async listContacts(): Promise<Array<{ id: string; number?: string; name?: string }>> {
    return call('GET', `/api/sessions/${enc(await sid())}/contacts`);
  },
  async resolvePhone(contactId: string): Promise<string | null> {
    const res = await call<{ phone: string | null }>('GET', `/api/sessions/${enc(await sid())}/contacts/${enc(contactId)}/phone`);
    return res.phone;
  },
  /** idempotencyKey makes a retry after a crash safe: OpenWA replays the first result instead of sending twice. */
  async sendText(chatId: string, text: string, idempotencyKey: string): Promise<{ messageId: string }> {
    return call('POST', `/api/sessions/${enc(await sid())}/messages/send-text`, { chatId, text }, { 'Idempotency-Key': idempotencyKey });
  },
  async listWebhooks(): Promise<Array<{ id: string; url: string; events: string[] }>> {
    return call('GET', `/api/sessions/${enc(await sid())}/webhooks`);
  },
  async createWebhook(url: string, events: string[], secret?: string): Promise<void> {
    await call('POST', `/api/sessions/${enc(await sid())}/webhooks`, { url, events, ...(secret ? { secret } : {}), retryCount: 3 });
  },
};
