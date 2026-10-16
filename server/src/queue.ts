import { config } from './config.ts';
import { db, getSetting, setSetting, today } from './db.ts';
import { openwa, OpenWAError } from './openwa.ts';
import { toChatId } from './phone.ts';

interface QueuedSend {
  id: number;
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

export function sentToday(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sends WHERE sent_day = ?').get(today()) as { n: number };
  return row.n;
}

/** When the worker may send next; exposed so the UI can show a countdown. */
let nextSendAt = 0;
let lastError: string | null = null;

export function queueState() {
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM sends WHERE status IN ('queued','sending') GROUP BY status`).all() as Array<{ status: string; n: number }>;
  return {
    paused: isPaused(),
    queued: counts.reduce((sum, c) => sum + c.n, 0),
    sentToday: sentToday(),
    dailyCap: config.dailyCap,
    nextSendAt: nextSendAt > Date.now() ? new Date(nextSendAt).toISOString() : null,
    lastError,
  };
}

function randomDelayMs(): number {
  const min = config.minDelaySec * 1000;
  const max = Math.max(config.maxDelaySec * 1000, min);
  return min + Math.floor(Math.random() * (max - min));
}

function nextQueued(): QueuedSend | undefined {
  return db.prepare(`
    SELECT s.id, s.phone, s.name, s.attempts, t.body, t.fallback
    FROM sends s JOIN templates t ON t.id = s.template_id
    WHERE s.status IN ('queued', 'sending')
    ORDER BY s.id
    LIMIT 1
  `).get() as QueuedSend | undefined;
}

async function sendOne(job: QueuedSend): Promise<void> {
  const excluded = db.prepare('SELECT 1 FROM excluded WHERE phone = ?').get(job.phone);
  if (excluded) {
    db.prepare(`UPDATE sends SET status = 'cancelled', error = 'Number is excluded' WHERE id = ?`).run(job.id);
    return;
  }

  const text = renderTemplate(job.body, job.name, job.fallback);
  db.prepare(`UPDATE sends SET status = 'sending', attempts = attempts + 1, text = ? WHERE id = ?`).run(text, job.id);

  try {
    // The same idempotency key on every attempt: if we crashed after OpenWA sent it, the retry won't send again.
    const res = await openwa.sendText(toChatId(job.phone), text, `wa-sender-${job.id}`);
    db.prepare(`UPDATE sends SET status = 'sent', message_id = ?, sent_at = datetime('now'), sent_day = ?, error = NULL WHERE id = ?`)
      .run(res.messageId, today(), job.id);
    lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OpenWAError ? err.status : 0;
    // 409 = WhatsApp not connected yet, 429 = OpenWA pacing said slow down: leave queued and retry later.
    if (status === 409 || status === 429 || status === 0 || status >= 500) {
      lastError = message;
      const giveUp = job.attempts + 1 >= MAX_ATTEMPTS && status !== 409 && status !== 429;
      db.prepare(`UPDATE sends SET status = ?, error = ? WHERE id = ?`).run(giveUp ? 'failed' : 'queued', message, job.id);
      throw err;
    }
    // 400 etc. = this recipient can't be sent to (e.g. number not on WhatsApp). Mark failed and move on.
    db.prepare(`UPDATE sends SET status = 'failed', error = ? WHERE id = ?`).run(message, job.id);
  }
}

let running = false;

export function startWorker(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): void {
  if (running) return;
  running = true;

  const tick = async () => {
    try {
      if (isPaused() || Date.now() < nextSendAt) return;
      const job = nextQueued();
      if (!job) return;
      if (sentToday() >= config.dailyCap) {
        lastError = `Daily limit of ${config.dailyCap} reached; the rest will go tomorrow.`;
        return;
      }
      try {
        await sendOne(job);
        log.info({ sendId: job.id }, 'message sent');
        nextSendAt = Date.now() + randomDelayMs();
      } catch (err) {
        log.warn({ sendId: job.id, err: String(err) }, 'send failed, will retry');
        nextSendAt = Date.now() + 60_000;
      }
    } finally {
      setTimeout(tick, 2_000);
    }
  };
  void tick();
}
