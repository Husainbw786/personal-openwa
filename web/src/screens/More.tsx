import { useState } from 'react';
import { api, formatPhone, formatTime, type Excluded, type QueueState } from '../api';
import { Button, Header, toast, useLoad } from '../ui';

export default function More({ navigate, onLogout }: { navigate: (to: string) => void; onLogout: () => void }) {
  const excluded = useLoad(() => api<Excluded[]>('/api/excluded'), []);
  const queue = useLoad(() => api<QueueState>('/api/queue'), []);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  async function add() {
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
    if (!confirm('Cancel all messages that are still waiting to be sent?')) return;
    const res = await api<{ cancelled: number }>('/api/queue/cancel', { method: 'POST' });
    toast(`${res.cancelled} cancelled`);
    await queue.reload();
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    onLogout();
  }

  return (
    <>
      <Header title="More" />
      <div className="space-y-3 p-3">
        <button onClick={() => navigate('/connect')} className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left shadow-sm">
          <span className="font-semibold">WhatsApp connection</span>
          <span className="text-gray-400">›</span>
        </button>

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Sending</h2>
          {queue.data && (
            <p className="mt-1 text-sm text-gray-600">
              {queue.data.sentToday} sent today (limit {queue.data.dailyCap}) · {queue.data.queued} waiting{queue.data.paused ? ' · paused' : ''}
            </p>
          )}
          <Button variant="danger" className="mt-3" onClick={cancelQueue} disabled={!queue.data?.queued}>Cancel waiting messages</Button>
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Hidden numbers</h2>
          <p className="mb-3 text-sm text-gray-600">These people are never shown for selection and never messaged, in any group.</p>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Phone number" className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
            <Button onClick={add} disabled={!phone.trim()}>Hide</Button>
          </div>
          <ul className="divide-y divide-gray-100">
            {excluded.data?.map((e) => (
              <li key={e.phone} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block">{formatPhone(e.phone)}</span>
                  <span className="block truncate text-xs text-gray-500">{e.note ?? ''} · {formatTime(e.created_at)}</span>
                </span>
                <button onClick={() => remove(e.phone)} className="text-xs font-semibold text-brand">Show again</button>
              </li>
            ))}
            {excluded.data?.length === 0 && <li className="py-2 text-sm text-gray-500">No hidden numbers.</li>}
          </ul>
        </section>

        <Button variant="ghost" className="w-full" onClick={logout}>Log out of this app</Button>
      </div>
    </>
  );
}
