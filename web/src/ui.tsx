import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import QueueBar from './screens/QueueBar';
import { readCache, writeCache } from './cache';

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

/**
 * Load data, with a reload function and optional polling. With `cache`, the last result is shown
 * straight away from the phone's storage and quietly replaced once the network answers.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], options?: number | { poll?: number; cache?: string | null }) {
  const pollMs = typeof options === 'number' ? options : options?.poll;
  const cacheKey = typeof options === 'object' ? options.cache ?? null : null;
  const [data, setData] = useState<T | null>(() => (cacheKey ? readCache<T>(cacheKey) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(cacheKey && readCache(cacheKey) !== null));
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;

  const reload = useCallback(async () => {
    const key = keyRef.current;
    try {
      const fresh = await loadRef.current();
      if (key !== keyRef.current) return; // the screen moved on (e.g. switched number) meanwhile
      setData(fresh);
      setError(null);
      if (key) writeCache(key, fresh);
    } catch (err) {
      if (key !== keyRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (key === keyRef.current) setLoading(false);
    }
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    // On a change of what we load (not the first render), show that thing's cached copy, if any.
    if (!firstRun.current) {
      const cached = cacheKey ? readCache<T>(cacheKey) : null;
      setData(cached);
      setLoading(cached === null);
      setError(null);
    }
    firstRun.current = false;
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, cacheKey]);

  const set = useCallback((update: T | null | ((prev: T | null) => T | null)) => {
    setData((prev) => {
      const next = typeof update === 'function' ? (update as (p: T | null) => T | null)(prev) : update;
      if (keyRef.current && next !== null) writeCache(keyRef.current, next);
      return next;
    });
  }, []);

  return { data, error, loading, reload, setData: set };
}

const ICONS = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-3.5-3.5',
  menu: 'M12 5h.01M12 12h.01M12 19h.01',
  close: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  phone: 'M7 3h10a1 1 0 011 1v16a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  refresh: 'M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 17M18.4 9A8 8 0 005 7',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  users: 'M17 20h5v-2a4 4 0 00-5-3.9M9 20H2v-2a4 4 0 015-3.9m10-4.1a3 3 0 11-6 0 3 3 0 016 0zM7 10a3 3 0 11-6 0 3 3 0 016 0z',
  message: 'M8 10h8M8 14h5M5 4h14a1 1 0 011 1v11a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 5 9 7a11 11 0 01-2.7 3.6M6.6 6.6C4.4 8 3 10.4 3 12c0 2 4 7 9 7a9.5 9.5 0 004.4-1.1',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, className = '', filled = false }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={name === 'menu' ? 3.2 : 2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function IconButton({ icon, label, onClick, className = '' }: { icon: IconName; label: string; onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 ${className}`}>
      <Icon name={icon} />
    </button>
  );
}

export function Avatar({ label, kind = 'group', size = 'md' }: { label: string; kind?: 'group' | 'list' | 'person' | 'template'; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'h-9 w-9 text-sm' : 'h-12 w-12 text-lg';
  const styles = {
    group: 'bg-[#dfe5e7] text-[#54656f]',
    person: 'bg-[#dfe5e7] text-[#54656f]',
    list: 'bg-amber-100 text-amber-700',
    template: 'bg-bubble text-brand',
  }[kind];
  const icon = kind === 'list' ? 'list' : kind === 'template' ? 'message' : null;
  return (
    <div className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${dims} ${styles}`}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 18 : 22} /> : label.trim().charAt(0).toUpperCase() || '#'}
    </div>
  );
}

/** Green header for inner screens: back arrow, optional avatar, title and subtitle. */
export function Header({ title, subtitle, back, right, avatar }: { title: string; subtitle?: ReactNode; back?: () => void; right?: ReactNode; avatar?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20">
      <header className="bg-brand pt-[env(safe-area-inset-top)] text-white">
        <div className="flex h-16 items-center gap-1 px-2">
          {back && <IconButton icon="back" label="Back" onClick={back} />}
          {avatar && <div className="mr-2">{avatar}</div>}
          <div className={`min-w-0 flex-1 ${back ? '' : 'pl-2'}`}>
            <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
            {subtitle && <p className="truncate text-xs text-white/80">{subtitle}</p>}
          </div>
          {right}
        </div>
      </header>
      <QueueBar />
    </div>
  );
}

export const MAIN_TABS = [
  { path: '/groups', label: 'Groups' },
  { path: '/lists', label: 'Lists' },
  { path: '/templates', label: 'Messages' },
  { path: '/history', label: 'Sent' },
] as const;

/**
 * Header for the four main tabs, WhatsApp style: title row (or a search bar while searching),
 * an optional extra row (the number switcher), then the tabs.
 */
export function MainHeader({ route, navigate, extra, search, onSearch, actions }: {
  route: string;
  navigate: (to: string) => void;
  extra?: ReactNode;
  search?: { value: string; onChange: (v: string) => void; onClose: () => void; placeholder: string };
  onSearch?: () => void;
  actions?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="sticky top-0 z-20">
      <header className="bg-brand pt-[env(safe-area-inset-top)] text-white">
        {search ? (
          <div className="flex h-14 items-center gap-1 bg-white px-2 text-ink">
            <button onClick={search.onClose} aria-label="Close search" className="flex h-10 w-10 items-center justify-center rounded-full text-send hover:bg-gray-100">
              <Icon name="back" />
            </button>
            <input
              autoFocus
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              className="min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted"
            />
            {search.value && <IconButton icon="close" label="Clear" onClick={() => search.onChange('')} className="text-muted hover:bg-gray-100" />}
          </div>
        ) : (
          <div className="relative flex h-14 items-center gap-1 pl-4 pr-1">
            <h1 className="flex-1 text-[22px] font-semibold tracking-tight">WA Sender</h1>
            {actions}
            {onSearch && <IconButton icon="search" label="Search" onClick={onSearch} />}
            <IconButton icon="menu" label="Menu" onClick={() => setMenuOpen(true)} />
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-2 top-12 z-40 w-56 overflow-hidden rounded-xl bg-white py-1.5 text-sm text-ink shadow-xl">
                  {([['/connect', 'phone', 'WhatsApp numbers'], ['/more', 'settings', 'Settings and hidden numbers']] as const).map(([to, icon, label]) => (
                    <button key={to} onClick={() => { setMenuOpen(false); navigate(to); }} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-panel">
                      <Icon name={icon} size={20} className="text-muted" />
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {extra}
        <nav className="flex" role="tablist">
          {MAIN_TABS.map((t) => {
            const active = route === t.path || (t.path === '/groups' && route === '/');
            return (
              <button
                key={t.path}
                role="tab"
                aria-selected={active}
                onClick={() => navigate(t.path)}
                className={`flex-1 border-b-[3px] py-3 text-sm font-semibold ${active ? 'border-white text-white' : 'border-transparent text-white/70'}`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>
      <QueueBar />
    </div>
  );
}

/** Round floating action button, bottom right. */
export function Fab({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] right-[max(1.25rem,calc(50%-21rem+1.25rem))] z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-white shadow-lg shadow-black/20 active:scale-95"
    >
      <Icon name={icon} size={26} />
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between bg-white px-4 pb-1 pt-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-send">{children}</h2>
      {action}
    </div>
  );
}

export function Spinner() {
  return <div className="mx-auto my-10 h-8 w-8 animate-spin rounded-full border-4 border-send/20 border-t-send" />;
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
  return <div className="px-8 py-14 text-center text-sm leading-relaxed text-muted">{children}</div>;
}

export function Button({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-send text-white hover:bg-[#008f72] disabled:bg-gray-300',
    ghost: 'bg-white text-send border border-gray-200 hover:bg-panel disabled:text-gray-400',
    danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
  }[variant];
  return (
    <button {...props} className={`rounded-full px-5 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed ${styles} ${className}`}>
      {children}
    </button>
  );
}

/** Filter pill, like WhatsApp's "All / Unread / Groups" chips. */
export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium ${active ? 'bg-[#d9fdd3] text-[#0a5c4c]' : 'bg-panel text-[#54656f]'}`}>
      {children}
    </button>
  );
}

/** Message status the WhatsApp way: clock, one tick, two ticks, blue ticks. */
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    queued: ['🕓 Waiting', 'text-amber-700'],
    sending: ['🕓 Sending', 'text-amber-700'],
    sent: ['✓ Sent', 'text-muted'],
    delivered: ['✓✓ Delivered', 'text-muted'],
    read: ['✓✓ Read', 'text-[#53bdeb]'],
    failed: ['! Failed', 'text-red-600'],
    cancelled: ['Cancelled', 'text-gray-400'],
  };
  const [label, cls] = map[status] ?? [status, 'text-muted'];
  return <span className={`shrink-0 text-xs font-medium ${cls}`}>{label}</span>;
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
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-50 flex justify-center px-4">
      <div role="status" className="max-w-md rounded-full bg-[#323739] px-5 py-3 text-sm text-white shadow-lg">{message}</div>
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-label={title} className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto -mt-2 mb-3 h-1 w-10 rounded-full bg-gray-300 sm:hidden" />
        <div className="mb-4 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-panel"><Icon name="close" size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-send">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = 'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-[15px] outline-none focus:border-send focus:ring-2 focus:ring-send/15';
