import { api, formatPhone, type WaSession } from './api';

/** The number whose groups the home screen shows (and the default "Send from"). */
const VIEW_KEY = 'viewSession';
/** The number last picked under "Send from" for uploaded lists. */
const SEND_KEY = 'sendSession';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export const getViewSession = () => read(VIEW_KEY);
export const setViewSession = (id: string) => write(VIEW_KEY, id);
export const getSendSession = () => read(SEND_KEY);
export const setSendSession = (id: string) => write(SEND_KEY, id);

export const loadSessions = () => api<WaSession[]>('/api/wa/sessions');

/** The stored choice if that number still exists, else the main number. */
export function resolveSession(sessions: WaSession[] | null, stored: string | null): WaSession | null {
  if (!sessions?.length) return null;
  return sessions.find((s) => s.id === stored) ?? sessions.find((s) => s.isDefault) ?? sessions[0];
}

export function sessionTitle(s: WaSession): string {
  if (s.status === 'ready') return [s.pushName, s.phone && formatPhone(s.phone)].filter(Boolean).join(' · ') || s.label;
  return s.name;
}

/** Short label for history and the queue strip: the phone it sent from, else the session's label. */
export function fromLabel(sessions: WaSession[] | null, sessionId: string | null, fromPhone: string | null): string | null {
  if (fromPhone) return formatPhone(fromPhone);
  const s = sessions?.find((x) => x.id === sessionId);
  return s ? (s.phone ? formatPhone(s.phone) : s.name) : null;
}
