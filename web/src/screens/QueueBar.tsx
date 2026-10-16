import { useEffect, useState } from 'react';
import { api, type QueueState } from '../api';
import { loadSessions, sessionTitle } from '../sessions';
import { useLoad } from '../ui';

/** Always-visible strip: WhatsApp connection + what the sender is doing right now. */
const STATUS_LABEL: Record<string, string> = {
  created: 'not started',
  initializing: 'starting…',
  qr_ready: 'waiting for QR scan',
  authenticating: 'linking…',
  disconnected: 'disconnected',
  action_required: 'needs attention',
  failed: 'failed',
};

export default function QueueBar({ navigate, onConnectScreen }: { navigate: (to: string) => void; onConnectScreen: boolean }) {
  const wa = useLoad(loadSessions, [], 15_000);
  const queue = useLoad(() => api<QueueState>('/api/queue'), [], 5_000);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

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

  const secondsLeft = q?.nextSendAt ? Math.max(0, Math.round((new Date(q.nextSendAt).getTime() - Date.now()) / 1000)) : 0;

  return (
    <div className="space-y-px">
      {(wa.error || (wa.data && warnAbout)) && !onConnectScreen && (
        <button onClick={() => navigate('/connect')} className="flex w-full items-center gap-2 bg-amber-100 px-4 py-2 text-left text-sm text-amber-900">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          {wa.error ? 'Cannot reach the server' : warnAbout
            ? `${sessions.length > 1 ? sessionTitle(warnAbout) : 'WhatsApp'} ${STATUS_LABEL[warnAbout.status] ?? warnAbout.status}${stuck ? ' — messages waiting' : ''} — tap to connect`
            : ''}
        </button>
      )}
      {q && (q.queued > 0 || q.paused) && (
        <div className="flex items-center gap-3 bg-white px-4 py-2 text-sm">
          <span className={`h-2 w-2 rounded-full ${q.paused ? 'bg-gray-400' : 'animate-pulse bg-accent'}`} />
          <span className="flex-1">
            {waiting.length > 1 ? (
              <>
                {q.paused ? 'Paused' : 'Sending'} · {q.queued} waiting
                {waiting.map((n) => {
                  const left = n.nextSendAt ? Math.max(0, Math.round((new Date(n.nextSendAt).getTime() - Date.now()) / 1000)) : 0;
                  return (
                    <span key={n.sessionId} className="block text-xs text-gray-600">
                      {nameOf(n.sessionId)}: {n.queued} waiting · {n.sentToday}/{q.dailyCap} today
                      {!q.paused && left > 0 && ` · next in ${left}s`}
                      {n.lastError && <span className="block text-amber-700">{n.lastError}</span>}
                    </span>
                  );
                })}
              </>
            ) : (
              <>
                {q.paused ? 'Paused' : 'Sending'} · {q.queued} waiting · {waiting[0]?.sentToday ?? q.sentToday}/{q.dailyCap} today
                {sessions.length > 1 && waiting[0] && <span className="text-gray-500"> · from {nameOf(waiting[0].sessionId)}</span>}
                {!q.paused && secondsLeft > 0 && <span className="text-gray-500"> · next in {secondsLeft}s</span>}
                {q.lastError && <span className="block text-xs text-amber-700">{q.lastError}</span>}
              </>
            )}
          </span>
          <button onClick={togglePause} className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-semibold text-brand">
            {q.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}
    </div>
  );
}
