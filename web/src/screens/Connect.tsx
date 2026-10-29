import { useEffect, useState } from 'react';
import { api, formatPhone, type WaSession } from '../api';
import { loadSessions } from '../sessions';
import { Avatar, Button, ErrorBox, Field, Header, Icon, Sheet, Spinner, inputClass, toast, useLoad } from '../ui';

/** One card per linked WhatsApp number, plus a way to link another. */
export default function Connect({ navigate }: { navigate: (to: string) => void }) {
  const { data, error, reload } = useLoad(loadSessions, [], { poll: 3_000, cache: 'sessions' });
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
          onRemove={() =>
            confirm(
              `Remove ${s.phone ? formatPhone(s.phone) : s.name}? Its waiting messages are cancelled; history, templates and lists are kept.` +
                (s.isDefault ? (data.length > 1 ? '\n\nAnother linked number becomes the main one.' : '\n\nA new empty number slot is created so you can scan a QR code again.') : ''),
            ) && run(`/api/wa/sessions/${encodeURIComponent(s.id)}`, 'Number removed', 'DELETE')
          }
          onRestart={() => run(`/api/wa/sessions/${encodeURIComponent(s.id)}/restart`, 'Restarting…')}
          onMakeMain={() => run(`/api/wa/sessions/${encodeURIComponent(s.id)}/default`, 'Now the main number')}
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

function SessionCard({ session: s, busy, onStart, onLogout, onRemove, onRestart, onMakeMain }: {
  session: WaSession;
  busy: boolean;
  onStart: () => void;
  onLogout: () => void;
  onRemove: () => void;
  onRestart: () => void;
  onMakeMain: () => void;
}) {
  // Getting a phone-number code restarts the connection, so the status blinks to "initializing";
  // keep the link box (and the code in it) on screen through that.
  const [linking, setLinking] = useState(s.status === 'qr_ready');
  useEffect(() => {
    if (s.status === 'qr_ready') setLinking(true);
    else if (s.status !== 'initializing') setLinking(false);
  }, [s.status]);
  const showLink = s.status === 'qr_ready' || (linking && s.status === 'initializing');
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

      {showLink && <LinkChooser session={s} />}

      {((s.status === 'initializing' && !showLink) || s.status === 'authenticating') && (
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

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {s.status !== 'ready' && (
          <Button variant="ghost" disabled={busy} onClick={onRestart}>Restart connection</Button>
        )}
        {!s.isDefault && s.status === 'ready' && (
          <Button variant="ghost" disabled={busy} onClick={onMakeMain}>Make main</Button>
        )}
        <Button variant="danger" disabled={busy} onClick={onRemove}>Remove this number</Button>
      </div>
      {s.status !== 'ready' && s.status !== 'qr_ready' && (
        <p className="mt-2 text-xs text-muted">Stuck here? Try Restart. If it then asks for a QR code, WhatsApp unlinked this device: scan again or remove the number.</p>
      )}
      </div>
    </div>
  );
}

/** On a phone the QR code can't be scanned by the same phone, so default to the phone-number code there. */
const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

function LinkChooser({ session: s }: { session: WaSession }) {
  const [mode, setMode] = useState<'qr' | 'code'>(() => (isTouchDevice() ? 'code' : 'qr'));
  return (
    <>
      <div className="mx-auto mb-4 flex w-full max-w-xs rounded-full bg-panel p-1 text-sm font-medium" role="tablist">
        {([['qr', 'Scan QR code'], ['code', 'Use phone number']] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`flex-1 rounded-full px-3 py-2 ${mode === key ? 'bg-white text-send shadow-sm' : 'text-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'qr' ? (
        s.qrCode ? (
          <>
            <p className="mb-1 font-semibold">Scan with WhatsApp</p>
            <p className="mb-4 text-sm text-muted">On that phone: WhatsApp → Settings → Linked devices → Link a device</p>
            <img src={s.qrCode} alt={`WhatsApp QR code for ${s.name}`} className="mx-auto w-64 max-w-full rounded-lg border" />
            <p className="mt-3 text-xs text-muted">The code refreshes automatically. Using this phone? Switch to “Use phone number”.</p>
          </>
        ) : (
          <>
            <Spinner />
            <p className="text-sm text-muted">Getting a QR code…</p>
          </>
        )
      ) : (
        <PairingCode sessionId={s.id} />
      )}
    </>
  );
}

function PairingCode({ sessionId }: { sessionId: string }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  const secondsLeft = Math.max(0, Math.round((expiresAt - now) / 1000));

  async function getCode() {
    setBusy(true);
    try {
      const res = await api<{ pairingCode: string; validForSec?: number }>(`/api/wa/sessions/${encodeURIComponent(sessionId)}/pairing-code`, { method: 'POST', body: { phone } });
      setCode(res.pairingCode);
      setExpiresAt(Date.now() + (res.validForSec ?? 120) * 1000);
      setNow(Date.now());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not get a code. Try again in a few seconds.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copied');
    } catch {
      toast('Copy failed: type the code instead');
    }
  }

  const pretty = code ? (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code) : '';

  return (
    <div className="mx-auto max-w-sm text-left">
      {!code ? (
        <>
          <p className="mb-1 text-center font-semibold">Link with your phone number</p>
          <p className="mb-3 text-center text-sm text-muted">Enter the WhatsApp number you are linking. You'll get an 8-character code to type into WhatsApp.</p>
          <div className="flex gap-2">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              placeholder="+91 98123 45678"
              aria-label="WhatsApp number to link"
              className={inputClass}
              onKeyDown={(e) => e.key === 'Enter' && phone.trim() && void getCode()}
            />
            <Button disabled={busy || !phone.trim()} onClick={getCode}>{busy ? 'Getting…' : 'Get code'}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-center font-semibold">Your code</p>
          <button onClick={copy} disabled={secondsLeft === 0} className={`mx-auto mb-1 block rounded-xl bg-panel px-5 py-3 font-mono text-3xl font-semibold tracking-[0.2em] ${secondsLeft === 0 ? 'text-muted line-through' : ''}`} aria-label={`Pairing code ${pretty}, tap to copy`}>
            {pretty}
          </button>
          {secondsLeft > 0 ? (
            <p className={`mb-4 text-center text-xs ${secondsLeft <= 30 ? 'font-semibold text-red-700' : 'text-muted'}`}>
              Tap to copy · works for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          ) : (
            <div className="mb-4 text-center">
              <p className="mb-2 text-sm font-semibold text-red-700">This code has expired.</p>
              <Button disabled={busy} onClick={getCode}>{busy ? 'Getting…' : 'Get a fresh code'}</Button>
            </div>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Open <b>WhatsApp</b> on the phone with this number.</li>
            <li>Go to <b>Settings → Linked devices → Link a device</b>.</li>
            <li>Tap <b>Link with phone number instead</b>.</li>
            <li>Type the code above <b>before the timer runs out</b>. Check the number is <b>{phone}</b>: the code only works on that WhatsApp account.</li>
          </ol>
          <button onClick={() => setCode(null)} className="mt-4 block w-full text-center text-sm font-semibold text-send">Use a different number</button>
        </>
      )}
    </div>
  );
}
