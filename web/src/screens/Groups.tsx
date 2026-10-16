import { useEffect, useState } from 'react';
import { api, type ContactList, type Group } from '../api';
import { getViewSession, loadSessions, resolveSession, sessionTitle, setViewSession } from '../sessions';
import { Button, Empty, ErrorBox, Header, Sheet, Spinner, toast, useLoad } from '../ui';

const MAX_SEARCH_RESULTS = 30;

export default function Groups({ navigate }: { navigate: (to: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  // Groups come from one number at a time; uploaded lists work with any number.
  const sessions = useLoad(loadSessions, []);
  const [stored, setStored] = useState(getViewSession);
  const view = resolveSession(sessions.data, stored);
  const viewId = view?.id ?? stored ?? '';
  const sessionQs = viewId ? `session=${encodeURIComponent(viewId)}` : '';
  const groups = useLoad(
    () => api<Group[]>(`/api/groups?${[sessionQs, refresh ? 'refresh=1' : ''].filter(Boolean).join('&')}`),
    [refresh, viewId],
  );
  const lists = useLoad(() => api<ContactList[]>('/api/lists'), []);
  const [query, setQuery] = useState('');
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [uploadOpen, setUploadOpen] = useState(false);

  function pickNumber(id: string) {
    setViewSession(id);
    setStored(id);
    setCounts({});
  }

  const all = groups.data ?? [];
  const searching = query.trim().length > 0;
  const starred = all.filter((g) => g.favorite);
  const results = searching ? all.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, MAX_SEARCH_RESULTS) : [];
  const visible = searching ? results : starred;

  // Fetch member counts only for the groups on screen.
  const visibleKey = visible.map((g) => g.id).join('|');
  useEffect(() => {
    const missing = visible.map((g) => g.id).filter((id) => !(id in counts));
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
    toast(g.favorite ? 'Removed from home' : 'Added to home');
  }

  const notConnected = groups.error && /not (connected|ready)/i.test(groups.error);

  return (
    <>
      <Header
        title="WA Sender"
        right={
          <button onClick={() => setRefresh((n) => n + 1)} className="rounded-full p-2 hover:bg-white/10" aria-label="Refresh groups">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 17M18.4 9A8 8 0 005 7" /></svg>
          </button>
        }
      />
      <div className="sticky top-14 z-10 space-y-2 bg-surface p-3">
        {sessions.data && sessions.data.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto text-xs" role="tablist" aria-label="Show groups of">
            {sessions.data.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === view?.id}
                onClick={() => pickNumber(s.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 ${s.id === view?.id ? 'border-brand bg-brand text-white' : 'border-gray-200 bg-white text-gray-700'}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'ready' ? 'bg-accent' : 'bg-amber-500'}`} />
                {sessionTitle(s)}
              </button>
            ))}
          </div>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={all.length ? `Search all ${all.length} groups` : 'Search groups'}
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand"
        />
      </div>

      {searching ? (
        <>
          <SectionTitle>Search results</SectionTitle>
          {results.length === 0 && groups.data && <Empty>No group matches “{query}”.</Empty>}
          <GroupList groups={results} counts={counts} navigate={navigate} onStar={toggleFavorite} />
          {results.length === MAX_SEARCH_RESULTS && <p className="px-4 py-2 text-xs text-gray-500">Showing the first {MAX_SEARCH_RESULTS}. Type more to narrow it down.</p>}
        </>
      ) : (
        <>
          <SectionTitle action={<button onClick={() => setUploadOpen(true)} className="text-sm font-semibold text-brand">+ Upload CSV</button>}>
            Uploaded lists
          </SectionTitle>
          {lists.data?.length === 0 && (
            <p className="bg-white px-4 py-3 text-sm text-gray-500">Upload contacts (CSV) to use them like a group, e.g. members of a group on your other number.</p>
          )}
          <ul className="divide-y divide-gray-100 bg-white">
            {lists.data?.map((l) => (
              <li key={l.id}>
                <button onClick={() => navigate(`/lists/${l.id}`)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-gray-50">
                  <Avatar label={l.name} list />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{l.name}</span>
                    <span className="block text-xs text-gray-500">{l.member_count} contacts · uploaded list</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <SectionTitle>Starred groups</SectionTitle>
          {groups.loading && !groups.data && <Spinner />}
          {notConnected && (
            <Empty>
              Connect WhatsApp to see your groups.{' '}
              <button onClick={() => navigate('/connect')} className="font-semibold text-brand underline">Connect now</button>
            </Empty>
          )}
          {groups.error && !notConnected && <ErrorBox message={groups.error} retry={groups.reload} />}
          {groups.data && starred.length === 0 && (
            <p className="bg-white px-4 py-3 text-sm text-gray-500">Search for a group above and tap ☆ to keep it here.</p>
          )}
          <GroupList groups={starred} counts={counts} navigate={navigate} onStar={toggleFavorite} />
        </>
      )}

      <UploadSheet
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={(id) => { setUploadOpen(false); void lists.reload(); navigate(`/lists/${id}`); }}
      />
    </>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-1.5 pt-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{children}</h2>
      {action}
    </div>
  );
}

function Avatar({ label, list }: { label: string; list?: boolean }) {
  return (
    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-semibold ${list ? 'bg-amber-100 text-amber-800' : 'bg-brand/10 text-brand'}`}>
      {list ? '☰' : label.trim().charAt(0).toUpperCase() || '#'}
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
    <ul className="divide-y divide-gray-100 bg-white">
      {groups.map((g) => (
        <li key={g.id} className="flex items-center">
          <button onClick={() => navigate(`/groups/${encodeURIComponent(g.id)}`)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-gray-50">
            <Avatar label={g.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{g.name}</span>
              <span className="block text-xs text-gray-500">
                {g.id in counts ? (counts[g.id] === null ? '—' : `${counts[g.id]} members`) : 'counting…'}
              </span>
            </span>
          </button>
          <button onClick={() => onStar(g)} className={`px-4 py-3 text-xl ${g.favorite ? 'text-amber-500' : 'text-gray-300'}`} aria-label={g.favorite ? 'Unstar' : 'Star'}>
            {g.favorite ? '★' : '☆'}
          </button>
        </li>
      ))}
    </ul>
  );
}

function UploadSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const res = await api<{ id: number; added: number; duplicates: number; invalid: number }>('/api/lists', {
        method: 'POST',
        body: { name: name.trim() || file.name.replace(/\.[^.]+$/, ''), csv },
      });
      toast(`${res.added} contacts added${res.duplicates ? `, ${res.duplicates} duplicates skipped` : ''}${res.invalid ? `, ${res.invalid} invalid` : ''}`);
      setName('');
      setFile(null);
      onDone(res.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Upload contacts">
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          A CSV with a <b>phone</b> column (and optionally <b>name</b>). The CSV you download from any group here works as-is.
        </p>
        <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="List name (e.g. Group A from number 1)" className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" disabled={!file || busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</Button>
        </div>
      </div>
    </Sheet>
  );
}
