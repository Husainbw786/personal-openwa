import { useState } from 'react';
import { api, formatPhone, formatTime, type SendRow } from '../api';
import { Empty, ErrorBox, Header, Spinner, StatusChip, useLoad } from '../ui';

const FILTERS = [
  ['', 'All'],
  ['queued', 'Waiting'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['read', 'Read'],
  ['failed', 'Failed'],
] as const;

export default function History() {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const params = new URLSearchParams({ limit: '100', ...(status ? { status } : {}), ...(query ? { q: query } : {}) });
  const { data, error, loading, reload } = useLoad(() => api<SendRow[]>(`/api/sends?${params}`), [status, query], 10_000);

  return (
    <>
      <Header title="History" />
      <div className="sticky top-14 z-10 space-y-2 bg-surface p-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, number or group" className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand" />
        <div className="flex gap-1.5 overflow-x-auto text-xs">
          {FILTERS.map(([key, label]) => (
            <button key={key} onClick={() => setStatus(key)} className={`shrink-0 rounded-full border px-3 py-1.5 ${status === key ? 'border-brand bg-brand text-white' : 'border-gray-200 bg-white text-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} retry={reload} />}
      {data && data.length === 0 && <Empty>Nothing here yet.</Empty>}
      <ul className="divide-y divide-gray-100 bg-white">
        {data?.map((s) => (
          <li key={s.id}>
            <button onClick={() => setOpen(open === s.id ? null : s.id)} className="w-full px-4 py-3 text-left">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{s.name ?? formatPhone(s.phone)}</span>
                <StatusChip status={s.status} />
              </div>
              <p className="truncate text-xs text-gray-500">
                {s.template_name}{s.group_name ? ` · ${s.group_name}` : ''} · {formatTime(s.sent_at ?? s.created_at)}
              </p>
              {open === s.id && (
                <div className="mt-2 space-y-1 text-sm">
                  <p className="text-xs text-gray-500">{formatPhone(s.phone)}</p>
                  {s.text && <p className="whitespace-pre-wrap rounded-lg bg-[#dcf8c6] px-3 py-2">{s.text}</p>}
                  {s.error && <p className="text-xs text-red-700">{s.error}</p>}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
