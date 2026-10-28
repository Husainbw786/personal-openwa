export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status})`);
  return data as T;
}

export type SessionStatus =
  | 'created' | 'initializing' | 'qr_ready' | 'authenticating'
  | 'ready' | 'disconnected' | 'action_required' | 'failed';

export interface WaStatus {
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  lastError: string | null;
  qrCode: string | null;
}

/** One linked (or linking) WhatsApp number. */
export interface WaSession {
  id: string;
  name: string;
  label: string; // "+91…" once linked, otherwise the session name
  isDefault: boolean;
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  lastError: string | null;
  qrCode: string | null;
}

export interface Group {
  id: string;
  name: string;
  favorite: boolean;
  /** Member count from the server's warm cache (null until it has loaded that group). */
  count?: number | null;
}

export interface Member {
  phone: string;
  name: string | null;
  whatsappName: string | null;
  isAdmin: boolean;
  excluded: boolean;
  sendStatus: string | null;
  selectable: boolean;
  /** Names of your own groups this person is already in. */
  inMyGroups?: string[];
  /** When they joined one of your groups (ISO), if it happened while the app was watching. */
  joinedMyGroupAt?: string | null;
}

export interface ContactList {
  id: number;
  name: string;
  created_at: string;
  member_count: number;
}

export interface GroupDetail {
  id: string;
  kind: 'group' | 'list';
  name: string;
  description: string;
  /** You marked this group as one of yours. */
  isMine?: boolean;
  /** Names of your groups used for the "already in" tag (excluding this one). */
  myGroups?: string[];
  members: Member[];
}

export interface Template {
  id: number;
  name: string;
  body: string;
  fallback: string;
  archived: number;
  sent_count: number;
  updated_at: string;
}

export interface SendRow {
  id: number;
  phone: string;
  name: string | null;
  group_name: string | null;
  status: string;
  error: string | null;
  text: string | null;
  created_at: string;
  sent_at: string | null;
  template_name: string;
  session_id: string | null;
  from_phone: string | null;
}

export interface QueueState {
  paused: boolean;
  queued: number;
  sentToday: number;
  dailyCap: number;
  nextSendAt: string | null;
  lastError: string | null;
  numbers: Array<{ sessionId: string; queued: number; sentToday: number; nextSendAt: string | null; lastError: string | null }>;
}

export interface Excluded {
  phone: string;
  note: string | null;
  created_at: string;
}

export function renderPreview(body: string, name: string | null, fallback: string): string {
  const full = name?.trim() || fallback;
  const first = name?.trim().split(/\s+/)[0] || fallback;
  return body.replace(/\{name\}/gi, full).replace(/\{first\}/gi, first);
}

export function formatPhone(phone: string): string {
  if (phone.endsWith('@lid')) return 'Number hidden by WhatsApp';
  if (phone.startsWith('91') && phone.length === 12) return `+91 ${phone.slice(2, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

/** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; show it in local time. */
/** "just now", "5m ago", "3h ago", "2d ago" for an ISO time. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Local date+time for an ISO time, e.g. "28 Oct, 2:05 pm". */
export function formatIso(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function formatTime(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
