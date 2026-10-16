import { useState } from 'react';
import { api } from '../api';
import { Button } from '../ui';

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-brand p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <img src="/icon.svg" alt="" className="mx-auto mb-3 h-14 w-14" />
        <h1 className="mb-1 text-center text-xl font-semibold">WA Sender</h1>
        <p className="mb-5 text-center text-sm text-gray-500">Enter your password to continue</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mb-3 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-brand"
        />
        {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
        <Button type="submit" disabled={busy || !password} className="w-full py-3">
          {busy ? 'Checking…' : 'Log in'}
        </Button>
      </form>
    </div>
  );
}
