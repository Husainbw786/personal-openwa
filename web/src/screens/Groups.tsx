import { useState } from 'react';
import { api, type Group } from '../api';
import { Empty, ErrorBox, Header, Spinner, useLoad } from '../ui';

export default function Groups({ navigate }: { navigate: (to: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading, reload, setData } = useLoad(() => api<Group[]>(`/api/groups${refresh ? '?refresh=1' : ''}`), [refresh]);
  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  async function toggleFavorite(g: Group) {
    setData((list) => list?.map((x) => (x.id === g.id ? { ...x, favorite: !x.favorite } : x)) ?? null);
    await api(`/api/groups/${encodeURIComponent(g.id)}/favorite`, { method: 'PUT', body: { favorite: !g.favorite, name: g.name } });
  }

  const groups = (data ?? [])
    .filter((g) => !onlyFavorites || g.favorite)
    .filter((g) => g.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <Header
        title="Groups"
        right={
          <button onClick={() => setRefresh((n) => n + 1)} className="rounded-full p-2 hover:bg-white/10" aria-label="Refresh groups">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 17M18.4 9A8 8 0 005 7" /></svg>
          </button>
        }
      />
      <div className="sticky top-14 z-10 flex gap-2 bg-surface p-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search groups" className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand" />
        <button onClick={() => setOnlyFavorites((v) => !v)} className={`rounded-xl border px-3 text-sm ${onlyFavorites ? 'border-brand bg-brand text-white' : 'border-gray-200 bg-white text-gray-700'}`}>
          ★ Starred
        </button>
      </div>
      {loading && !data && <Spinner />}
      {error && /not (connected|ready)/i.test(error) && (
        <Empty>
          Connect WhatsApp to see your groups.{' '}
          <button onClick={() => navigate('/connect')} className="font-semibold text-brand underline">Connect now</button>
        </Empty>
      )}
      {error && !/not (connected|ready)/i.test(error) && <ErrorBox message={error} retry={reload} />}
      {data && groups.length === 0 && <Empty>{onlyFavorites ? 'No starred groups yet. Tap ☆ next to a group to star it.' : 'No groups found.'}</Empty>}
      <ul className="divide-y divide-gray-100 bg-white">
        {groups.map((g) => (
          <li key={g.id} className="flex items-center">
            <button onClick={() => navigate(`/groups/${encodeURIComponent(g.id)}`)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-gray-50">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand/10 font-semibold text-brand">
                {g.name.trim().charAt(0).toUpperCase() || '#'}
              </div>
              <span className="truncate font-medium">{g.name}</span>
            </button>
            <button onClick={() => toggleFavorite(g)} className={`px-4 py-3 text-xl ${g.favorite ? 'text-amber-500' : 'text-gray-300'}`} aria-label={g.favorite ? 'Unstar' : 'Star'}>
              {g.favorite ? '★' : '☆'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
