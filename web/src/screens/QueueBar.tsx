import { useEffect, useState } from 'react';
import { api, type QueueState, type WaStatus } from '../api';
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
  const wa = useLoad(() => api<WaStatus>('/api/wa/status'), [], 15_000);
  const queue = useLoad(() => api<QueueState>('/api/queue'), [], 5_000);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const connected = wa.data?.status === 'ready';
  const q = queue.data;

  async function togglePause() {
    if (!q) return;
    queue.setData(await api<QueueState>('/api/queue/pause', { method: 'POST', body: { paused: !q.paused } }));
  }

  const secondsLeft = q?.nextSendAt ? Math.max(0, Math.round((new Date(q.nextSendAt).getTime() - Date.now()) / 1000)) : 0;

  return (
    <div className="space-y-px">
      {!connected && !onConnectScreen && (
        <button onClick={() => navigate('/connect')} className="flex w-full items-center gap-2 bg-amber-100 px-4 py-2 text-left text-sm text-amber-900">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          {wa.error ? 'Cannot reach the server' : wa.data ? `WhatsApp ${STATUS_LABEL[wa.data.status] ?? wa.data.status} — tap to connect` : 'Checking WhatsApp…'}
        </button>
      )}
      {q && (q.queued > 0 || q.paused) && (
        <div className="flex items-center gap-3 bg-white px-4 py-2 text-sm">
          <span className={`h-2 w-2 rounded-full ${q.paused ? 'bg-gray-400' : 'animate-pulse bg-accent'}`} />
          <span className="flex-1">
            {q.paused ? 'Paused' : 'Sending'} · {q.queued} waiting · {q.sentToday}/{q.dailyCap} today
            {!q.paused && secondsLeft > 0 && <span className="text-gray-500"> · next in {secondsLeft}s</span>}
            {q.lastError && <span className="block text-xs text-amber-700">{q.lastError}</span>}
          </span>
          <button onClick={togglePause} className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-semibold text-brand">
            {q.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}
    </div>
  );
}
