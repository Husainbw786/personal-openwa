import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Tiny hash router: #/groups, #/groups/<id>, #/templates ... works on any static host. */
export function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/groups');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/groups');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [route, navigate];
}

/** Load data, with a reload function and optional polling. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

export function Header({ title, back, right }: { title: string; back?: () => void; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 bg-brand px-3 text-white shadow">
      {back && (
        <button onClick={back} className="-ml-1 rounded-full p-2 hover:bg-white/10" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      {right}
    </header>
  );
}

export function Spinner() {
  return <div className="mx-auto my-10 h-8 w-8 animate-spin rounded-full border-4 border-brand/20 border-t-brand" />;
}

export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p>{message}</p>
      {retry && <button onClick={retry} className="mt-2 font-semibold underline">Try again</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-6 py-12 text-center text-sm text-gray-500">{children}</p>;
}

export function Button({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-gray-300',
    ghost: 'bg-white text-brand border border-gray-200 hover:bg-gray-50 disabled:text-gray-400',
    danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50',
  }[variant];
  return (
    <button {...props} className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    queued: ['Waiting', 'bg-amber-100 text-amber-800'],
    sending: ['Sending', 'bg-amber-100 text-amber-800'],
    sent: ['Sent ✓', 'bg-gray-100 text-gray-700'],
    delivered: ['Delivered ✓✓', 'bg-gray-100 text-gray-700'],
    read: ['Read ✓✓', 'bg-sky-100 text-sky-800'],
    failed: ['Failed', 'bg-red-100 text-red-800'],
    cancelled: ['Cancelled', 'bg-gray-100 text-gray-500'],
  };
  const [label, cls] = map[status] ?? [status, 'bg-gray-100 text-gray-700'];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

let toastSetter: ((t: string | null) => void) | null = null;
export function toast(message: string) {
  toastSetter?.(message);
}
export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMessage;
    return () => { toastSetter = null; };
  }, []);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return (
    <div className="fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      <div className="max-w-md rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">{message}</div>
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
