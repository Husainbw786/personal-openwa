import { useMemo, useState } from 'react';
import { api, formatPhone, renderPreview, type GroupDetail as Detail, type Member, type Template } from '../api';
import { Button, Empty, ErrorBox, Header, Sheet, Spinner, StatusChip, toast, useLoad } from '../ui';

const MAX_BATCH = 10;

/** A WhatsApp group, or an uploaded contact list: both work the same way. */
export type Source = { kind: 'group'; id: string } | { kind: 'list'; id: number };

export default function GroupDetail({ source, navigate }: { source: Source; navigate: (to: string) => void }) {
  const templates = useLoad(() => api<Template[]>('/api/templates'), []);
  const active = (templates.data ?? []).filter((t) => !t.archived);
  const [templateId, setTemplateId] = useState<number | null>(() => Number(localStorage.getItem('lastTemplateId')) || null);
  const template = active.find((t) => t.id === templateId) ?? null;

  const basePath = source.kind === 'group' ? `/api/groups/${encodeURIComponent(source.id)}` : `/api/lists/${source.id}`;
  const group = useLoad(() => api<Detail>(`${basePath}${template ? `?templateId=${template.id}` : ''}`), [basePath, template?.id]);
  const [menuOpen, setMenuOpen] = useState(false);

  async function deleteList() {
    if (!confirm('Delete this uploaded list? Send history is kept, so nobody gets the same template twice.')) return;
    await api(basePath, { method: 'DELETE' });
    toast('List deleted');
    navigate('/groups');
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'available' | 'all' | 'sent' | 'excluded'>('available');
  const [query, setQuery] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [sending, setSending] = useState(false);

  const members = group.data?.members ?? [];
  const counts = useMemo(() => ({
    available: members.filter((m) => m.selectable).length,
    sent: members.filter((m) => !m.excluded && !m.selectable).length,
    excluded: members.filter((m) => m.excluded).length,
  }), [members]);

  const visible = members
    .filter((m) => {
      if (filter === 'available') return m.selectable;
      if (filter === 'sent') return !m.excluded && !m.selectable;
      if (filter === 'excluded') return m.excluded;
      return true;
    })
    .filter((m) => `${m.name ?? ''} ${m.phone}`.toLowerCase().includes(query.toLowerCase()));

  function pickTemplate(id: number) {
    setTemplateId(id);
    localStorage.setItem('lastTemplateId', String(id));
    setSelected(new Set());
  }

  function toggle(m: Member) {
    if (!m.selectable) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.phone)) next.delete(m.phone);
      else if (next.size >= MAX_BATCH) toast(`You can send to ${MAX_BATCH} people at a time`);
      else next.add(m.phone);
      return next;
    });
  }

  function selectNext() {
    const next = new Set(selected);
    for (const m of visible) {
      if (next.size >= MAX_BATCH) break;
      if (m.selectable) next.add(m.phone);
    }
    setSelected(next);
  }

  async function exclude(m: Member, excluded: boolean) {
    if (excluded) await api('/api/excluded', { method: 'POST', body: { phone: m.phone, note: `From ${group.data?.name ?? 'group'}` } });
    else await api(`/api/excluded/${encodeURIComponent(m.phone)}`, { method: 'DELETE' });
    setSelected((prev) => { const n = new Set(prev); n.delete(m.phone); return n; });
    toast(excluded ? 'Hidden. They will never be messaged.' : 'Shown again');
    setEditing(null);
    await group.reload();
  }

  async function saveName(m: Member, name: string) {
    await api(`/api/contacts/${encodeURIComponent(m.phone)}/name`, { method: 'PUT', body: { name } });
    setEditing(null);
    await group.reload();
  }

  async function send() {
    if (!template || !group.data) return;
    setSending(true);
    try {
      const recipients = members.filter((m) => selected.has(m.phone)).map((m) => ({ phone: m.phone, name: m.name }));
      const res = await api<{ queued: number; skippedAlreadySent: number; skippedExcluded: number }>('/api/sends', {
        method: 'POST',
        body: { templateId: template.id, groupId: group.data.id, groupName: group.data.name, recipients },
      });
      const skipped = res.skippedAlreadySent + res.skippedExcluded;
      toast(`${res.queued} message${res.queued === 1 ? '' : 's'} queued${skipped ? `, ${skipped} skipped` : ''}. Sending slowly in the background.`);
      setSelected(new Set());
      setConfirmOpen(false);
      await group.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not queue messages');
    } finally {
      setSending(false);
    }
  }

  const selectedMembers = members.filter((m) => selected.has(m.phone));

  return (
    <div className="pb-28">
      <Header
        title={group.data?.name ?? (source.kind === 'list' ? 'List' : 'Group')}
        back={() => navigate('/groups')}
        right={
          <button onClick={() => setMenuOpen(true)} className="rounded-full px-3 py-2 text-xl leading-none hover:bg-white/10" aria-label="More options">⋮</button>
        }
      />
      {group.data && (
        <p className="bg-white px-4 pt-2 text-xs text-gray-500">
          {members.length} {source.kind === 'list' ? 'contacts · uploaded list' : 'members'}
          {members.some((m) => m.phone.endsWith('@lid')) && ` · ${members.filter((m) => m.phone.endsWith('@lid')).length} with hidden numbers`}
        </p>
      )}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={group.data?.name ?? 'Options'}>
        <div className="space-y-2">
          <a href={`${basePath}/export.pdf`} download onClick={() => setMenuOpen(false)} className="block rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-brand">
            Download contacts (PDF)
          </a>
          <a href={`${basePath}/export.csv`} download onClick={() => setMenuOpen(false)} className="block rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-brand">
            Download contacts (CSV, for uploading)
          </a>
          {source.kind === 'list' && (
            <button onClick={deleteList} className="block w-full rounded-xl border border-red-200 px-4 py-3 text-left text-sm font-semibold text-red-700">
              Delete this list
            </button>
          )}
          <p className="pt-1 text-xs text-gray-500">The CSV can be uploaded back (Home → Upload CSV) to message these people from another number.</p>
        </div>
      </Sheet>

      <div className="space-y-3 bg-white p-3 shadow-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">Template</span>
          <select
            value={template?.id ?? ''}
            onChange={(e) => pickTemplate(Number(e.target.value))}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
          >
            <option value="" disabled>{active.length ? 'Choose a template…' : 'No templates yet'}</option>
            {active.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {!active.length && templates.data && (
          <button onClick={() => navigate('/templates')} className="text-sm font-semibold text-brand underline">Create your first template</button>
        )}
        {template && (
          <p className="line-clamp-2 rounded-lg bg-[#dcf8c6] px-3 py-2 text-sm text-gray-800">{renderPreview(template.body, 'Rahul', template.fallback)}</p>
        )}
        <div className="flex gap-1.5 overflow-x-auto text-xs">
          {([
            ['available', `Can send (${counts.available})`],
            ['sent', `Already got it (${counts.sent})`],
            ['excluded', `Hidden (${counts.excluded})`],
            ['all', 'All'],
          ] as const).map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} className={`shrink-0 rounded-full border px-3 py-1.5 ${filter === key ? 'border-brand bg-brand text-white' : 'border-gray-200 text-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or number" className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
          <Button variant="ghost" onClick={selectNext} disabled={!template || selected.size >= MAX_BATCH}>Pick next {MAX_BATCH}</Button>
        </div>
      </div>

      {group.loading && !group.data && <Spinner />}
      {group.error && <ErrorBox message={group.error} retry={group.reload} />}
      {group.data && !template && <Empty>Choose a template first. People who already got that template will be greyed out.</Empty>}
      {group.data && template && visible.length === 0 && <Empty>Nobody here.</Empty>}

      {template && (
        <ul className="mt-2 divide-y divide-gray-100 bg-white">
          {visible.map((m) => {
            const checked = selected.has(m.phone);
            return (
              <li key={m.phone} className={`flex items-center ${m.selectable ? '' : 'opacity-60'}`}>
                <button onClick={() => toggle(m)} disabled={!m.selectable} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${checked ? 'border-brand bg-brand text-white' : 'border-gray-300'} ${m.selectable ? '' : 'invisible'}`}>
                    {checked && '✓'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name ?? <span className="text-gray-400">No name</span>}{m.isAdmin && <span className="ml-1 text-xs text-gray-400">admin</span>}</span>
                    <span className="block text-xs text-gray-500">{formatPhone(m.phone)}</span>
                  </span>
                  {m.excluded ? <span className="text-xs text-gray-500">Hidden</span> : m.sendStatus && !m.selectable ? <StatusChip status={m.sendStatus} /> : m.sendStatus === 'failed' ? <StatusChip status="failed" /> : null}
                </button>
                <button onClick={() => setEditing(m)} className="px-3 py-3 text-gray-400" aria-label="Options">⋮</button>
              </li>
            );
          })}
        </ul>
      )}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <span className="flex-1 text-sm"><b>{selected.size}</b> of {MAX_BATCH} selected</span>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            <Button onClick={() => setConfirmOpen(true)}>Review & send</Button>
          </div>
        </div>
      )}

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Send "${template?.name}" to ${selected.size}`}>
        <ul className="mb-4 space-y-2">
          {selectedMembers.map((m) => (
            <li key={m.phone} className="rounded-xl bg-gray-50 p-3">
              <p className="mb-1 text-xs font-medium text-gray-500">{m.name ?? 'No name'} · {formatPhone(m.phone)}</p>
              <p className="whitespace-pre-wrap rounded-lg bg-[#dcf8c6] px-3 py-2 text-sm">{template && renderPreview(template.body, m.name, template.fallback)}</p>
            </li>
          ))}
        </ul>
        <p className="mb-4 text-xs text-gray-500">Messages go out one by one with a random gap of about 1–2 minutes, so WhatsApp doesn't flag your number. You can close the app.</p>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setConfirmOpen(false)}>Back</Button>
          <Button className="flex-1" disabled={sending} onClick={send}>{sending ? 'Queueing…' : 'Send'}</Button>
        </div>
      </Sheet>

      <MemberSheet member={editing} onClose={() => setEditing(null)} onSaveName={saveName} onExclude={exclude} />
    </div>
  );
}

function MemberSheet({ member, onClose, onSaveName, onExclude }: {
  member: Member | null;
  onClose: () => void;
  onSaveName: (m: Member, name: string) => Promise<void>;
  onExclude: (m: Member, excluded: boolean) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [lastPhone, setLastPhone] = useState<string | null>(null);
  if (member && member.phone !== lastPhone) {
    setLastPhone(member.phone);
    setName(member.name ?? '');
  }
  if (!member) return null;
  return (
    <Sheet open onClose={onClose} title={formatPhone(member.phone)}>
      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-gray-500">Name used in messages</span>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={member.whatsappName ?? 'e.g. Rahul'} className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
          <Button onClick={() => onSaveName(member, name)}>Save</Button>
        </div>
      </label>
      {member.excluded ? (
        <Button variant="ghost" className="w-full" onClick={() => onExclude(member, false)}>Show this person again</Button>
      ) : (
        <Button variant="danger" className="w-full" onClick={() => onExclude(member, true)}>Hide — never message this number</Button>
      )}
    </Sheet>
  );
}
