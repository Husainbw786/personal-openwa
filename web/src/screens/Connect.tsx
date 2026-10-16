import { useState } from 'react';
import { api, formatPhone, type WaStatus } from '../api';
import { Button, ErrorBox, Header, Spinner, toast, useLoad } from '../ui';

export default function Connect({ navigate }: { navigate: (to: string) => void }) {
  const { data, error, reload } = useLoad(() => api<WaStatus>('/api/wa/status'), [], 3_000);
  const [busy, setBusy] = useState(false);

  async function run(path: string, done: string) {
    setBusy(true);
    try {
      await api(path, { method: 'POST' });
      toast(done);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="WhatsApp connection" back={() => navigate('/more')} />
      {error && <ErrorBox message={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data && (
        <div className="m-4 rounded-2xl bg-white p-5 text-center shadow-sm">
          {data.status === 'ready' && (
            <>
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-2xl">✓</div>
              <p className="text-lg font-semibold">Connected</p>
              <p className="text-sm text-gray-600">{data.pushName} {data.phone && `· ${formatPhone(data.phone)}`}</p>
              <Button variant="danger" className="mt-6" disabled={busy} onClick={() => confirm('Unlink this WhatsApp number from the app?') && run('/api/wa/logout', 'Logged out')}>
                Log out WhatsApp
              </Button>
            </>
          )}

          {data.status === 'qr_ready' && data.qrCode && (
            <>
              <p className="mb-1 font-semibold">Scan with WhatsApp</p>
              <p className="mb-4 text-sm text-gray-600">On your phone: WhatsApp → Settings → Linked devices → Link a device</p>
              <img src={data.qrCode} alt="WhatsApp QR code" className="mx-auto w-64 max-w-full rounded-lg border" />
              <p className="mt-3 text-xs text-gray-500">The code refreshes automatically.</p>
            </>
          )}

          {(data.status === 'initializing' || data.status === 'authenticating' || (data.status === 'qr_ready' && !data.qrCode)) && (
            <>
              <Spinner />
              <p className="text-sm text-gray-600">{data.status === 'authenticating' ? 'Linking your phone…' : 'Starting WhatsApp…'}</p>
            </>
          )}

          {(data.status === 'created' || data.status === 'disconnected' || data.status === 'failed' || data.status === 'action_required') && (
            <>
              <p className="mb-1 font-semibold">Not connected</p>
              {data.lastError && <p className="mb-3 text-sm text-red-700">{data.lastError}</p>}
              <Button disabled={busy} onClick={() => run('/api/wa/start', 'Starting…')}>Connect WhatsApp</Button>
            </>
          )}
        </div>
      )}
      <p className="mx-6 text-xs text-gray-500">
        Use a number you can afford to lose. This app uses an unofficial WhatsApp connection, so WhatsApp may restrict accounts that message many strangers.
      </p>
    </>
  );
}
