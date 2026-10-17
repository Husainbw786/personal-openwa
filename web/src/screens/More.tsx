import { useState } from 'react';
import { api, formatPhone, formatTime, type Excluded, type QueueState } from '../api';
import { clearCache } from '../cache';
import { loadSessions, sessionTitle } from '../sessions';
import { Button, Header, Icon, inputClass, toast, useLoad } from '../ui';

export default function More({ navigate, onLogout }: { navigate: (to: string) => void; onLogout: () => void }) {
  const excluded = useLoad(() => api<Excluded[]>('/api/excluded'), [], { cache: 'excluded' });
  const queue = useLoad(() => api<QueueState>('/api/queue'), [], { cache: 'queue' });
  const sessions = useLoad(loadSessions, [], { cache: 'sessions' });
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  async function add() {
    if (!phone.trim()) return toast('Enter a phone number');
    try {
      await api('/api/excluded', { method: 'POST', body: { phone, note } });
      setPhone('');
      setNote('');
      toast('Number hidden');
      await excluded.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(p: string) {
    await api(`/api/excluded/${encodeURIComponent(p)}`, { method: 'DELETE' });
    await excluded.reload();
  }

  async function cancelQueue() {
    if (!queue.data?.queued) return toast('Nothing is waiting');
    if (!confirm('Cancel all messages that are still waiting to be sent?')) return;
    const res = await api<{ cancelled: number }>('/api/queue/cancel', { method: 'POST' });
    toast(`${res.cancelled} cancelled`);
    await queue.reload();
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    clearCache();
    onLogout();
  }

  const q = queue.data;

  return (
    <div className="bg-panel">
      <Header title="Settings" back={() => navigate('/groups')} />

      <button onClick={() => navigate('/connect')} className="mt-2 flex w-full items-center gap-4 bg-white px-4 py-4 text-left hover:bg-panel">
        <Icon name="phone" className="text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-[16px]">WhatsApp numbers</span>
          {sessions.data && (
            <span className="block text-sm text-muted">
              {sessions.data.filter((s) => s.status === 'ready').length} of {sessions.data.length} connected
            </span>
          )}
        </span>
        <Icon name="chevron" size={18} className="text-muted" />
      </button>

      <section className="mt-2 bg-white px-4 py-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-send">Sending</h2>
        {q && (
          <p className="mt-2 text-[15px]">
            {q.sentToday} sent today · {q.queued} waiting{q.paused ? ' · paused' : ''}
            <span className="block text-sm text-muted">Daily limit is {q.dailyCap} per number</span>
          </p>
        )}
        {q && (sessions.data?.length ?? 0) > 1 && (
          <ul className="mt-3 space-y-2">
            {sessions.data!.map((s) => {
              const n = q.numbers.find((x) => x.sessionId === s.id);
              const pct = Math.min(100, Math.round(((n?.sentToday ?? 0) / q.dailyCap) * 100));
              return (
                <li key={s.id} className="text-sm">
                  <div className="flex justify-between"><span>{s.pushName || sessionTitle(s)}</span><span className="text-muted">{n?.sentToday ?? 0}/{q.dailyCap} · {n?.queued ?? 0} waiting</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-panel"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
        )}
        <Button variant="danger" className="mt-4" onClick={cancelQueue}>Cancel waiting messages</Button>
      </section>

      <section className="mt-2 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-send"><Icon name="eyeOff" size={16} /> Hidden numbers</h2>
        <p className="mb-3 mt-1 text-sm text-muted">Never shown for selection and never messaged, in any group or list.</p>
        <div className="mb-2 flex flex-col gap-2 sm:flex-row">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="98123 45678" aria-label="Phone number" className={inputClass} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" className={inputClass} />
          <Button onClick={add}>Hide</Button>
        </div>
        <ul>
          {excluded.data?.map((e) => (
            <li key={e.phone} className="flex items-center gap-2 border-b border-gray-100 py-3 text-sm last:border-0">
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{formatPhone(e.phone)}</span>
                <span className="block truncate text-xs text-muted">{[e.note, formatTime(e.created_at)].filter(Boolean).join(' · ')}</span>
              </span>
              <button onClick={() => remove(e.phone)} className="rounded-full px-3 py-1.5 text-[13px] font-semibold text-send hover:bg-panel">Show again</button>
            </li>
          ))}
          {excluded.data?.length === 0 && <li className="py-2 text-sm text-muted">No hidden numbers.</li>}
        </ul>
      </section>

      <button onClick={logout} className="mt-2 flex w-full items-center gap-4 bg-white px-4 py-4 text-left text-red-600 hover:bg-red-50">
        <Icon name="logout" /> Log out of this app
      </button>
    </div>
  );
}
