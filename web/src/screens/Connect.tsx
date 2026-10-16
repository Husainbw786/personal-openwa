import { useState } from 'react';
import { api, formatPhone, type WaSession } from '../api';
import { loadSessions } from '../sessions';
import { Button, ErrorBox, Header, Sheet, Spinner, toast, useLoad } from '../ui';

/** One card per linked WhatsApp number, plus a way to link another. */
export default function Connect({ navigate }: { navigate: (to: string) => void }) {
  const { data, error, reload } = useLoad(loadSessions, [], 3_000);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState('');

  async function run(path: string, done: string, method = 'POST') {
    setBusy(true);
    try {
      await api(path, { method });
      toast(done);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    try {
      await api<WaSession>('/api/wa/sessions', { method: 'POST', body: { label: label.trim() || undefined } });
      setAddOpen(false);
      setLabel('');
      toast('Starting… scan the QR code with the other phone');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add number');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="WhatsApp connection" back={() => navigate('/more')} />
      {error && <ErrorBox message={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          busy={busy}
          onStart={() => run(`/api/wa/sessions/${encodeURIComponent(s.id)}/start`, 'Starting…')}
          onLogout={() => confirm(`Unlink ${s.phone ? formatPhone(s.phone) : s.name} from the app?`) && run(`/api/wa/sessions/${encodeURIComponent(s.id)}/logout`, 'Logged out')}
          onRemove={() => confirm(`Remove ${s.phone ? formatPhone(s.phone) : s.name}? Its waiting messages are cancelled; history is kept.`) && run(`/api/wa/sessions/${encodeURIComponent(s.id)}`, 'Number removed', 'DELETE')}
        />
      ))}
      {data && (
        <div className="mx-4 mb-4">
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => setAddOpen(true)}>+ Link another number</Button>
        </div>
      )}
      <p className="mx-6 text-xs text-gray-500">
        Use numbers you can afford to lose. This app uses an unofficial WhatsApp connection, so WhatsApp may restrict accounts that message many strangers.
        The daily limit and the gap between messages apply to each number separately.
      </p>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Link another number">
        <div className="space-y-3">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. work phone)" className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
          <p className="text-xs text-gray-500">A QR code appears on a new card. Scan it from the other phone.</p>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="flex-1" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add'}</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function SessionCard({ session: s, busy, onStart, onLogout, onRemove }: {
  session: WaSession;
  busy: boolean;
  onStart: () => void;
  onLogout: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="m-4 rounded-2xl bg-white p-5 text-center shadow-sm">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">
        {s.name}{s.isDefault && ' · main'}
      </p>
      {s.status === 'ready' && (
        <>
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-2xl">✓</div>
          <p className="text-lg font-semibold">Connected</p>
          <p className="text-sm text-gray-600">{s.pushName} {s.phone && `· ${formatPhone(s.phone)}`}</p>
          <Button variant="danger" className="mt-6" disabled={busy} onClick={onLogout}>Log out WhatsApp</Button>
        </>
      )}

      {s.status === 'qr_ready' && s.qrCode && (
        <>
          <p className="mb-1 font-semibold">Scan with WhatsApp</p>
          <p className="mb-4 text-sm text-gray-600">On the phone: WhatsApp → Settings → Linked devices → Link a device</p>
          <img src={s.qrCode} alt={`WhatsApp QR code for ${s.name}`} className="mx-auto w-64 max-w-full rounded-lg border" />
          <p className="mt-3 text-xs text-gray-500">The code refreshes automatically.</p>
        </>
      )}

      {(s.status === 'initializing' || s.status === 'authenticating' || (s.status === 'qr_ready' && !s.qrCode)) && (
        <>
          <Spinner />
          <p className="text-sm text-gray-600">{s.status === 'authenticating' ? 'Linking the phone…' : 'Starting WhatsApp…'}</p>
        </>
      )}

      {(s.status === 'created' || s.status === 'disconnected' || s.status === 'failed' || s.status === 'action_required') && (
        <>
          <p className="mb-1 font-semibold">Not connected</p>
          {s.lastError && <p className="mb-3 text-sm text-red-700">{s.lastError}</p>}
          <Button disabled={busy} onClick={onStart}>Connect WhatsApp</Button>
        </>
      )}

      {!s.isDefault && (
        <button disabled={busy} onClick={onRemove} className="mt-4 block w-full text-xs font-semibold text-red-700">Remove this number</button>
      )}
    </div>
  );
}
