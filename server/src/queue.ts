import { config } from './config.ts';
import { db, getSetting, setSetting, today } from './db.ts';
import { openwa, OpenWAError, type Session } from './openwa.ts';
import { normalizePhone, toChatId } from './phone.ts';

interface QueuedSend {
  id: number;
  session_id: string;
  phone: string;
  name: string | null;
  body: string;
  fallback: string;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export function renderTemplate(body: string, name: string | null, fallback: string): string {
  const full = name?.trim() || fallback;
  const first = name?.trim().split(/\s+/)[0] || fallback;
  return body.replace(/\{name\}/gi, full).replace(/\{first\}/gi, first);
}

export function isPaused(): boolean {
  return getSetting('paused', '0') === '1';
}

export function setPaused(paused: boolean): void {
  setSetting('paused', paused ? '1' : '0');
}

/** Sent today by one number (the daily cap is per number). */
export function sentToday(sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sends WHERE sent_day = ? AND session_id = ?').get(today(), sessionId) as { n: number };
  return row.n;
}

export function sessionLabel(s: Pick<Session, 'name' | 'phone' | 'pushName'>): string {
  if (s.phone) return `+${normalizePhone(s.phone)}`;
  return s.pushName || s.name;
}

/** Each number sends on its own lane: its own random gap, its own daily cap, its own last error. */
interface Lane {
  nextSendAt: number;
  busy: boolean;
  lastError: string | null;
}
const lanes = new Map<string, Lane>();
function lane(sessionId: string): Lane {
  let l = lanes.get(sessionId);
  if (!l) lanes.set(sessionId, (l = { nextSendAt: 0, busy: false, lastError: null }));
  return l;
}

/** Overall totals (what the bar shows) plus a breakdown per sending number. */
export function queueState() {
  const queuedRows = db.prepare(`SELECT session_id, COUNT(*) AS n FROM sends WHERE status IN ('queued','sending') GROUP BY session_id`).all() as Array<{ session_id: string | null; n: number }>;
  const sentRows = db.prepare('SELECT session_id, COUNT(*) AS n FROM sends WHERE sent_day = ? GROUP BY session_id').all(today()) as Array<{ session_id: string | null; n: number }>;
  const ids = new Set([...queuedRows, ...sentRows].map((r) => r.session_id).filter((id): id is string => !!id));
  const now = Date.now();
  const numbers = [...ids].map((id) => {
    const l = lanes.get(id);
    return {
      sessionId: id,
      queued: queuedRows.find((r) => r.session_id === id)?.n ?? 0,
      sentToday: sentRows.find((r) => r.session_id === id)?.n ?? 0,
      nextSendAt: l && l.nextSendAt > now ? new Date(l.nextSendAt).toISOString() : null,
      lastError: l?.lastError ?? null,
    };
  });
  const waiting = numbers.filter((n) => n.queued > 0);
  return {
    paused: isPaused(),
    queued: queuedRows.reduce((sum, r) => sum + r.n, 0),
    sentToday: sentRows.reduce((sum, r) => sum + r.n, 0),
    dailyCap: config.dailyCap, // per number
    nextSendAt: waiting.map((n) => n.nextSendAt).filter((t): t is string => !!t).sort()[0] ?? null,
    lastError: waiting.map((n) => n.lastError).find(Boolean) ?? null,
    numbers,
  };
}

function randomDelayMs(): number {
  const min = config.minDelaySec * 1000;
  const max = Math.max(config.maxDelaySec * 1000, min);
  return min + Math.floor(Math.random() * (max - min));
}

function nextQueued(sessionId: string): QueuedSend | undefined {
  return db.prepare(`
    SELECT s.id, s.session_id, s.phone, s.name, s.attempts, t.body, t.fallback
    FROM sends s JOIN templates t ON t.id = s.template_id
    WHERE s.status IN ('queued', 'sending') AND s.session_id = ?
    ORDER BY s.id
    LIMIT 1
  `).get(sessionId) as QueuedSend | undefined;
}

function sessionsWithWork(): string[] {
  return (db.prepare(`SELECT DISTINCT session_id FROM sends WHERE status IN ('queued', 'sending') AND session_id IS NOT NULL`).all() as Array<{ session_id: string }>)
    .map((r) => r.session_id);
}

async function sendOne(job: QueuedSend): Promise<void> {
  const excluded = db.prepare('SELECT 1 FROM excluded WHERE phone = ?').get(job.phone);
  if (excluded) {
    db.prepare(`UPDATE sends SET status = 'cancelled', error = 'Number is excluded' WHERE id = ?`).run(job.id);
    return;
  }

  let session: Session;
  try {
    session = await openwa.getSession(job.session_id);
  } catch (err) {
    if (err instanceof OpenWAError && err.status === 404) {
      db.prepare(`UPDATE sends SET status = 'cancelled', error = 'The sending number was removed' WHERE session_id = ? AND status IN ('queued', 'sending')`).run(job.session_id);
      return;
    }
    throw err;
  }
  // Not linked right now: leave it queued without using up an attempt.
  if (session.status !== 'ready') throw new Error(`${sessionLabel(session)} is not connected (${session.status}); its messages are waiting.`);

  const text = renderTemplate(job.body, job.name, job.fallback);
  db.prepare(`UPDATE sends SET status = 'sending', attempts = attempts + 1, text = ? WHERE id = ?`).run(text, job.id);

  try {
    // The same idempotency key on every attempt: if we crashed after OpenWA sent it, the retry won't send again.
    const res = await openwa.sendText(job.session_id, toChatId(job.phone), text, `wa-sender-${job.id}`);
    db.prepare(`UPDATE sends SET status = 'sent', message_id = ?, sent_at = datetime('now'), sent_day = ?, from_phone = ?, error = NULL WHERE id = ?`)
      .run(res.messageId, today(), session.phone ? normalizePhone(session.phone) : null, job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OpenWAError ? err.status : 0;
    // 409 = WhatsApp not connected yet, 429 = OpenWA pacing said slow down: leave queued and retry later.
    if (status === 409 || status === 429 || status === 0 || status >= 500) {
      const giveUp = job.attempts + 1 >= MAX_ATTEMPTS && status !== 409 && status !== 429;
      db.prepare(`UPDATE sends SET status = ?, error = ? WHERE id = ?`).run(giveUp ? 'failed' : 'queued', message, job.id);
      throw err;
    }
    // 400 etc. = this recipient can't be sent to (e.g. number not on WhatsApp). Mark failed and move on.
    db.prepare(`UPDATE sends SET status = 'failed', error = ? WHERE id = ?`).run(message, job.id);
  }
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

async function runLane(sessionId: string, log: Log): Promise<void> {
  const l = lane(sessionId);
  if (l.busy || Date.now() < l.nextSendAt) return;
  const job = nextQueued(sessionId);
  if (!job) return;
  if (sentToday(sessionId) >= config.dailyCap) {
    l.lastError = `Daily limit of ${config.dailyCap} reached for this number; the rest will go tomorrow.`;
    return;
  }
  l.busy = true;
  try {
    await sendOne(job);
    log.info({ sendId: job.id, sessionId }, 'message sent');
    l.lastError = null;
    l.nextSendAt = Date.now() + randomDelayMs();
  } catch (err) {
    l.lastError = err instanceof Error ? err.message : String(err);
    log.warn({ sendId: job.id, sessionId, err: String(err) }, 'send failed, will retry');
    l.nextSendAt = Date.now() + 60_000;
  } finally {
    l.busy = false;
  }
}

let running = false;

export function startWorker(log: Log): void {
  if (running) return;
  running = true;

  const tick = () => {
    try {
      // Lanes run independently, so a slow or disconnected number doesn't hold up the others.
      if (!isPaused()) for (const id of sessionsWithWork()) void runLane(id, log);
    } catch (err) {
      log.warn({ err: String(err) }, 'queue tick failed');
    } finally {
      setTimeout(tick, 2_000);
    }
  };
  tick();
}
