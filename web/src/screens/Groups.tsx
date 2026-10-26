import { useEffect, useState } from 'react';
import { api, type Group, type WaSession } from '../api';
import { readCache, writeCache } from '../cache';
import { getViewSession, loadSessions, resolveSession, sessionTitle, setViewSession } from '../sessions';
import { Avatar, Empty, ErrorBox, Fab, Icon, IconButton, MainHeader, SectionTitle, Spinner, toast, useLoad } from '../ui';

export default function Groups({ route, navigate }: { route: string; navigate: (to: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  // Groups come from one number at a time; uploaded lists work with any number.
  const sessions = useLoad(loadSessions, [], { cache: 'sessions' });
  const [stored, setStored] = useState(getViewSession);
  const view = resolveSession(sessions.data, stored);
  const viewId = view?.id ?? stored ?? '';
  const sessionQs = viewId ? `session=${encodeURIComponent(viewId)}` : '';
  const groups = useLoad(
    () => api<Group[]>(`/api/groups?${[sessionQs, refresh ? 'refresh=1' : ''].filter(Boolean).join('&')}`),
    [refresh, viewId],
    { cache: viewId ? `groups:${viewId}` : null },
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [counts, setCountsState] = useState<Record<string, number | null>>(() => readCache(`counts:${viewId}`) ?? {});
  const setCounts = (update: Record<string, number | null> | ((prev: Record<string, number | null>) => Record<string, number | null>)) =>
    setCountsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      writeCache(`counts:${viewId}`, next);
      return next;
    });

  function pickNumber(id: string) {
    setViewSession(id);
    setStored(id);
    setCountsState(readCache(`counts:${id}`) ?? {});
  }

  const all = groups.data ?? [];
  const searching = searchOpen && query.trim().length > 0;
  const starred = all.filter((g) => g.favorite);
  const results = searching ? all.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase())) : [];
  // Default view: starred first, then every other group A-Z.
  const others = all.filter((g) => !g.favorite).sort((a, b) => a.name.localeCompare(b.name));
  const visible = searching ? results : [...starred, ...others];

  // Counts normally arrive with the group list (server keeps them warm); fetch only any still missing.
  useEffect(() => {
    const fromList = Object.fromEntries(all.filter((g) => g.count != null).map((g) => [g.id, g.count as number]));
    if (Object.keys(fromList).some((id) => counts[id] !== fromList[id])) setCounts((prev) => ({ ...prev, ...fromList }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.data]);

  const visibleKey = visible.map((g) => g.id).join('|');
  useEffect(() => {
    const missing = visible.filter((g) => g.count == null).map((g) => g.id).filter((id) => !(id in counts));
    if (missing.length === 0) return;
    const timer = setTimeout(() => {
      api<Record<string, number | null>>(`/api/groups/counts?${sessionQs}`, { method: 'POST', body: { ids: missing } })
        .then((c) => setCounts((prev) => ({ ...prev, ...c })))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, viewId]);

  async function toggleFavorite(g: Group) {
    groups.setData((list) => list?.map((x) => (x.id === g.id ? { ...x, favorite: !x.favorite } : x)) ?? null);
    await api(`/api/groups/${encodeURIComponent(g.id)}/favorite`, { method: 'PUT', body: { favorite: !g.favorite, name: g.name } });
    toast(g.favorite ? 'Removed from starred' : 'Starred');
  }

  const notConnected = groups.error && /not (connected|ready)/i.test(groups.error);
  const openSearch = () => setSearchOpen(true);

  return (
    <>
      <MainHeader
        route={route}
        navigate={navigate}
        onSearch={openSearch}
        actions={<IconButton icon="refresh" label="Refresh groups" onClick={() => { setRefresh((n) => n + 1); toast('Refreshing groups…'); }} />}
        search={searchOpen ? { value: query, onChange: setQuery, onClose: () => { setSearchOpen(false); setQuery(''); }, placeholder: all.length ? `Search ${all.length} groups…` : 'Search groups…' } : undefined}
        extra={sessions.data && <NumberSwitcher sessions={sessions.data} activeId={view?.id} onPick={pickNumber} navigate={navigate} />}
      />

      {searching ? (
        <>
          {results.length === 0 && groups.data && <Empty>No group matches “{query}”.</Empty>}
          <GroupList groups={results} counts={counts} navigate={navigate} onStar={toggleFavorite} />
        </>
      ) : (
        <>
          {groups.loading && !groups.data && <Spinner />}
          {notConnected && (
            <Empty>
              <span className="block text-base font-medium text-ink">{view ? sessionTitle(view) : 'WhatsApp'} isn't connected</span>
              Link it to see its groups.
              <span className="mt-4 block"><button onClick={() => navigate('/connect')} className="rounded-full bg-send px-5 py-2.5 text-sm font-semibold text-white">Connect now</button></span>
            </Empty>
          )}
          {groups.error && !notConnected && <ErrorBox message={groups.error} retry={groups.reload} />}
          {groups.data && all.length === 0 && <Empty>No groups on this number yet.</Empty>}
          {starred.length > 0 && (
            <>
              <SectionTitle>Starred · {starred.length}</SectionTitle>
              <GroupList groups={starred} counts={counts} navigate={navigate} onStar={toggleFavorite} />
            </>
          )}
          {others.length > 0 && (
            <>
              <SectionTitle>{starred.length ? 'All other groups' : 'All groups'} · {others.length}</SectionTitle>
              <GroupList groups={others} counts={counts} navigate={navigate} onStar={toggleFavorite} />
            </>
          )}
        </>
      )}

      {!searchOpen && groups.data && <Fab icon="search" label="Find a group" onClick={openSearch} />}
    </>
  );
}

/** Which number's groups to show. Only drawn when there is more than one number. */
function NumberSwitcher({ sessions, activeId, onPick, navigate }: { sessions: WaSession[]; activeId?: string; onPick: (id: string) => void; navigate: (to: string) => void }) {
  if (sessions.length < 2) return null;
  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2.5 pt-0.5" role="radiogroup" aria-label="Show groups of">
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <button
            key={s.id}
            role="radio"
            aria-checked={active}
            onClick={() => onPick(s.id)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium ${active ? 'bg-white text-brand' : 'bg-white/15 text-white'}`}
          >
            <span className={`h-2 w-2 rounded-full ${s.status === 'ready' ? 'bg-accent' : 'bg-amber-400'}`} />
            {s.pushName || sessionTitle(s)}
          </button>
        );
      })}
      <button onClick={() => navigate('/connect')} aria-label="Link another number" className="flex shrink-0 items-center rounded-full bg-white/15 px-2.5 text-white"><Icon name="plus" size={18} /></button>
    </div>
  );
}

function GroupList({ groups, counts, navigate, onStar }: {
  groups: Group[];
  counts: Record<string, number | null>;
  navigate: (to: string) => void;
  onStar: (g: Group) => void;
}) {
  return (
    <ul>
      {groups.map((g) => {
        const open = () => navigate(`/groups/${encodeURIComponent(g.id)}`);
        return (
          <li key={g.id} className="flex items-center gap-4 pl-4 hover:bg-panel">
            <button onClick={open} tabIndex={-1} aria-hidden="true"><Avatar label={g.name} /></button>
            <div className="flex min-w-0 flex-1 items-center border-b border-gray-100">
              <button onClick={open} className="min-w-0 flex-1 py-4 text-left">
                <span className="block truncate text-[16px] font-medium">{g.name}</span>
                <span className="block text-sm text-muted">
                  {g.id in counts ? (counts[g.id] === null ? 'Members unavailable' : `${counts[g.id]} members`) : 'Counting members…'}
                </span>
              </button>
              <button onClick={() => onStar(g)} className={`self-stretch px-4 text-xl ${g.favorite ? 'text-amber-500' : 'text-gray-300'}`} aria-label={g.favorite ? `Unstar ${g.name}` : `Star ${g.name}`}>
                {g.favorite ? '★' : '☆'}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
