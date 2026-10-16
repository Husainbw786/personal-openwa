import { useState } from 'react';
import { api, formatPhone, formatTime, type SendRow } from '../api';
import { fromLabel, loadSessions, sessionTitle } from '../sessions';
import { Avatar, Chip, Empty, ErrorBox, MainHeader, Spinner, StatusChip, useLoad } from '../ui';
import { Bubble } from './Templates';

const FILTERS = [
  ['', 'All'],
  ['queued', 'Waiting'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['read', 'Read'],
  ['failed', 'Failed'],
] as const;

export default function History({ route, navigate }: { route: string; navigate: (to: string) => void }) {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [session, setSession] = useState('');
  const sessions = useLoad(loadSessions, []);
  const params = new URLSearchParams({ limit: '100', ...(status ? { status } : {}), ...(query ? { q: query } : {}), ...(session ? { session } : {}) });
  const { data, error, loading, reload } = useLoad(() => api<SendRow[]>(`/api/sends?${params}`), [status, query, session], 10_000);
  const multi = (sessions.data?.length ?? 0) > 1;

  return (
    <>
      <MainHeader
        route={route}
        navigate={navigate}
        onSearch={() => setSearchOpen(true)}
        search={searchOpen ? { value: query, onChange: setQuery, onClose: () => { setSearchOpen(false); setQuery(''); }, placeholder: 'Search name, number or group…' } : undefined}
      />
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-2.5">
        {FILTERS.map(([key, label]) => (
          <Chip key={key} active={status === key} onClick={() => setStatus(key)}>{label}</Chip>
        ))}
      </div>
      {multi && (
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2.5">
          <Chip active={session === ''} onClick={() => setSession('')}>All numbers</Chip>
          {sessions.data!.map((s) => (
            <Chip key={s.id} active={session === s.id} onClick={() => setSession(s.id)}>From {s.pushName || sessionTitle(s)}</Chip>
          ))}
        </div>
      )}
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} retry={reload} />}
      {data && data.length === 0 && <Empty>Nothing here yet. Messages you send show up here with their delivery ticks.</Empty>}
      <ul>
        {data?.map((s) => {
          const from = fromLabel(sessions.data, s.session_id, s.from_phone);
          return (
            <li key={s.id}>
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full items-start gap-4 py-2.5 pl-4 text-left hover:bg-panel" aria-expanded={open === s.id}>
                <div className="pt-1"><Avatar label={s.name ?? '#'} kind="person" /></div>
                <span className="min-w-0 flex-1 border-b border-gray-100 py-2 pr-4">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{s.name ?? formatPhone(s.phone)}</span>
                    <span className="shrink-0 text-xs text-muted">{formatTime(s.sent_at ?? s.created_at)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-muted">
                      {s.template_name}{s.group_name ? ` · ${s.group_name}` : ''}{multi && from ? ` · from ${from}` : ''}
                    </span>
                    <StatusChip status={s.status} />
                  </span>
                  {open === s.id && (
                    <span className="mt-2 block space-y-2 rounded-xl bg-wallpaper p-3">
                      <span className="block text-xs text-muted">To {formatPhone(s.phone)}{from && ` · from ${from}`}</span>
                      {s.text && <Bubble>{s.text}</Bubble>}
                      {s.error && <span className="block text-xs text-red-700">{s.error}</span>}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
