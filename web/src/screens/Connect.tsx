import { useState } from 'react';
import { api, formatPhone, type WaSession } from '../api';
import { loadSessions } from '../sessions';
import { Avatar, Button, ErrorBox, Field, Header, Icon, Sheet, Spinner, inputClass, toast, useLoad } from '../ui';

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
      <Header title="WhatsApp numbers" subtitle={data ? `${data.filter((s) => s.status === 'ready').length} of ${data.length} connected` : undefined} back={() => navigate('/groups')} />
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
        <button disabled={busy} onClick={() => setAddOpen(true)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-panel">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-send text-white"><Icon name="plus" /></span>
          <span>
            <span className="block text-[16px] font-medium">Link another number</span>
            <span className="block text-sm text-muted">Scan a QR code from the other phone</span>
          </span>
        </button>
      )}
      <p className="mx-6 mt-4 text-xs leading-relaxed text-muted">
        Use numbers you can afford to lose. This app uses an unofficial WhatsApp connection, so WhatsApp may restrict accounts that message many strangers.
        The daily limit and the gap between messages apply to each number separately.
      </p>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Link another number">
        <div className="space-y-3">
          <Field label="Name for this number">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work phone" className={inputClass} />
          </Field>
          <p className="text-xs text-muted">A QR code appears on a new card. Scan it from the other phone.</p>
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
    <div className="border-b-8 border-panel">
      <div className="flex items-center gap-4 px-4 py-3">
        <Avatar label={s.pushName || s.name} kind="person" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-medium">{s.pushName || s.name}{s.isDefault && <span className="ml-2 rounded bg-bubble px-1.5 py-0.5 text-[11px] font-medium text-send">Main</span>}</p>
          <p className="truncate text-sm text-muted">{s.phone ? formatPhone(s.phone) : s.name}</p>
        </div>
        <span className={`shrink-0 text-xs font-medium ${s.status === 'ready' ? 'text-send' : 'text-amber-700'}`}>● {s.status === 'ready' ? 'Connected' : 'Not connected'}</span>
      </div>
      <div className="px-4 pb-4 text-center">
      {s.status === 'ready' && (
        <div className="flex justify-end">
          <Button variant="danger" disabled={busy} onClick={onLogout}>Log out</Button>
        </div>
      )}

      {s.status === 'qr_ready' && s.qrCode && (
        <>
          <p className="mb-1 font-semibold">Scan with WhatsApp</p>
          <p className="mb-4 text-sm text-muted">On that phone: WhatsApp → Settings → Linked devices → Link a device</p>
          <img src={s.qrCode} alt={`WhatsApp QR code for ${s.name}`} className="mx-auto w-64 max-w-full rounded-lg border" />
          <p className="mt-3 text-xs text-muted">The code refreshes automatically.</p>
        </>
      )}

      {(s.status === 'initializing' || s.status === 'authenticating' || (s.status === 'qr_ready' && !s.qrCode)) && (
        <>
          <Spinner />
          <p className="text-sm text-muted">{s.status === 'authenticating' ? 'Linking the phone…' : 'Starting WhatsApp…'}</p>
        </>
      )}

      {(s.status === 'created' || s.status === 'disconnected' || s.status === 'failed' || s.status === 'action_required') && (
        <>
          {s.lastError && <p className="mb-3 text-sm text-red-700">{s.lastError}</p>}
          <Button className="w-full py-3" disabled={busy} onClick={onStart}>Connect this number</Button>
        </>
      )}

      {!s.isDefault && (
        <button disabled={busy} onClick={onRemove} className="mt-4 block w-full text-xs font-semibold text-red-600">Remove this number</button>
      )}
      </div>
    </div>
  );
}
