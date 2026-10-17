import { useEffect, useState } from 'react';
import { api, type QueueState } from '../api';
import { loadSessions, sessionTitle } from '../sessions';
import { useLoad } from '../ui';

/** Strip under every header: a disconnected number, and what the sender is doing right now. */
const STATUS_LABEL: Record<string, string> = {
  created: 'not started',
  initializing: 'starting…',
  qr_ready: 'waiting for QR scan',
  authenticating: 'linking…',
  disconnected: 'disconnected',
  action_required: 'needs attention',
  failed: 'failed',
};

const secondsUntil = (iso: string | null) => (iso ? Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)) : 0);

function formatWait(s: number) {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export default function QueueBar() {
  const wa = useLoad(loadSessions, [], { poll: 15_000, cache: 'sessions' });
  const queue = useLoad(() => api<QueueState>('/api/queue'), [], { poll: 5_000, cache: 'queue' });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const onConnectScreen = window.location.hash === '#/connect';
  const q = queue.data;
  const sessions = wa.data ?? [];
  const main = sessions.find((s) => s.isDefault) ?? sessions[0];
  // Warn when nothing is linked, or when a number has messages waiting but isn't connected.
  const stuck = sessions.find((s) => s.status !== 'ready' && q?.numbers.some((n) => n.sessionId === s.id && n.queued > 0));
  const warnAbout = stuck ?? (sessions.some((s) => s.status === 'ready') ? undefined : main);
  const waiting = (q?.numbers ?? []).filter((n) => n.queued > 0);
  const nameOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return s ? sessionTitle(s) : 'Removed number';
  };

  async function togglePause() {
    if (!q) return;
    queue.setData(await api<QueueState>('/api/queue/pause', { method: 'POST', body: { paused: !q.paused } }));
  }

  return (
    <div>
      {(wa.error || (wa.data && warnAbout)) && !onConnectScreen && (
        <button onClick={() => { window.location.hash = '/connect'; }} className="flex w-full items-center gap-2.5 bg-[#fff3c4] px-4 py-2.5 text-left text-[13px] text-[#6b5200]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <span className="flex-1">
            {wa.error ? 'Cannot reach the server' : warnAbout
              ? `${sessions.length > 1 ? sessionTitle(warnAbout) : 'WhatsApp'} ${STATUS_LABEL[warnAbout.status] ?? warnAbout.status}${stuck ? ', messages are waiting' : ''}`
              : ''}
          </span>
          {!wa.error && <span className="font-semibold">Connect</span>}
        </button>
      )}
      {q && (q.queued > 0 || q.paused) && (
        <div className="flex items-center gap-3 bg-[#e7fce3] px-4 py-2 text-[13px] text-[#0a5c4c]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${q.paused ? 'bg-gray-400' : 'animate-pulse bg-accent'}`} />
          <span className="min-w-0 flex-1">
            {waiting.length > 1 ? (
              <>
                <span className="font-medium">{q.paused ? 'Paused' : 'Sending'} · {q.queued} waiting</span>
                {waiting.map((n) => {
                  const left = secondsUntil(n.nextSendAt);
                  return (
                    <span key={n.sessionId} className="block truncate text-xs text-[#0a5c4c]/80">
                      {nameOf(n.sessionId)}: {n.queued} left · {n.sentToday}/{q.dailyCap} today{!q.paused && left > 0 && ` · next in ${formatWait(left)}`}
                      {n.lastError && <span className="block text-amber-800">{n.lastError}</span>}
                    </span>
                  );
                })}
              </>
            ) : (
              <>
                <span className="font-medium">{q.paused ? 'Paused' : 'Sending'} · {q.queued} waiting</span>
                <span className="text-[#0a5c4c]/80">
                  {' '}· {waiting[0]?.sentToday ?? q.sentToday}/{q.dailyCap} today
                  {!q.paused && secondsUntil(q.nextSendAt) > 0 && ` · next in ${formatWait(secondsUntil(q.nextSendAt))}`}
                </span>
                {sessions.length > 1 && waiting[0] && <span className="block text-xs text-[#0a5c4c]/80">from {nameOf(waiting[0].sessionId)}</span>}
                {q.lastError && <span className="block text-xs text-amber-800">{q.lastError}</span>}
              </>
            )}
          </span>
          <button onClick={togglePause} className="shrink-0 rounded-full px-2 py-1 text-[13px] font-semibold text-send hover:bg-white/60">
            {q.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}
    </div>
  );
}
