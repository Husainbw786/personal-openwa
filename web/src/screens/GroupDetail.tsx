import { useMemo, useRef, useState } from 'react';
import { api, formatPhone, renderPreview, type GroupDetail as Detail, type Member, type Template } from '../api';
import { getSendSession, getViewSession, loadSessions, resolveSession, sessionTitle, setSendSession } from '../sessions';
import { Avatar, Button, Chip, Empty, ErrorBox, Field, Header, Icon, IconButton, Sheet, Spinner, StatusChip, inputClass, toast, useLoad } from '../ui';
import { Bubble } from './Templates';

const MAX_BATCH = 10;

/** A WhatsApp group, or an uploaded contact list: both work the same way. */
export type Source = { kind: 'group'; id: string } | { kind: 'list'; id: number };

export default function GroupDetail({ source, navigate }: { source: Source; navigate: (to: string) => void }) {
  const templates = useLoad(() => api<Template[]>('/api/templates'), [], { cache: 'templates' });
  const active = (templates.data ?? []).filter((t) => !t.archived);
  const [templateId, setTemplateId] = useState<number | null>(() => Number(localStorage.getItem('lastTemplateId')) || null);
  const template = active.find((t) => t.id === templateId) ?? null;

  // A group is read through the number it was opened from (home screen); a list needs no number.
  // Either can be sent from any linked number.
  const sessions = useLoad(loadSessions, [], { cache: 'sessions' });
  const [viewStored] = useState(getViewSession);
  const viewId = resolveSession(sessions.data, viewStored)?.id ?? viewStored ?? '';
  const [sendStored, setSendStored] = useState(() => (source.kind === 'list' ? getSendSession() ?? viewStored : viewStored));
  const sendFrom = resolveSession(sessions.data, sendStored);
  const multi = (sessions.data?.length ?? 0) > 1;

  function pickSender(id: string) {
    setSendStored(id);
    if (source.kind === 'list') setSendSession(id);
  }

  const basePath = source.kind === 'group' ? `/api/groups/${encodeURIComponent(source.id)}` : `/api/lists/${source.id}`;
  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ ...(source.kind === 'group' && viewId ? { session: viewId } : {}), ...extra });
    const str = p.toString();
    return str ? `?${str}` : '';
  };
  const group = useLoad(
    () => api<Detail>(`${basePath}${qs(template ? { templateId: String(template.id) } : {})}`),
    [basePath, template?.id, source.kind === 'group' ? viewId : ''],
    { cache: `members:${basePath}|${source.kind === 'group' ? viewId : ''}|${template?.id ?? ''}` },
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'available' | 'all' | 'sent' | 'excluded' | 'admins' | 'notMine'>('available');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [sending, setSending] = useState(false);

  async function toggleMine() {
    if (source.kind !== 'group' || !group.data) return;
    const mine = !group.data.isMine;
    await api(`/api/my-groups/${encodeURIComponent(source.id)}${qs()}`, { method: 'PUT', body: { mine, name: group.data.name } });
    setMenuOpen(false);
    toast(mine ? 'Marked as your group. Its members are now tagged in other groups.' : 'No longer your group');
    await group.reload();
  }

  async function deleteList() {
    if (!confirm('Delete this uploaded list? Send history is kept, so nobody gets the same message twice.')) return;
    await api(basePath, { method: 'DELETE' });
    toast('List deleted');
    navigate('/lists');
  }

  const members = group.data?.members ?? [];
  const counts = useMemo(() => ({
    available: members.filter((m) => m.selectable).length,
    sent: members.filter((m) => !m.excluded && !m.selectable).length,
    excluded: members.filter((m) => m.excluded).length,
    admins: members.filter((m) => m.isAdmin).length,
    notMine: members.filter((m) => !m.inMyGroups?.length && !m.excluded).length,
  }), [members]);

  // Admins first (easy to spot), then people with a name: their messages read better ("Hi Rahul" not "Hi there").
  const sorted = useMemo(() => [...members].sort((a, b) =>
    Number(b.selectable) - Number(a.selectable) || Number(b.isAdmin) - Number(a.isAdmin) || Number(!!b.name) - Number(!!a.name)), [members]);
  // While searching, look through the whole group (not just the selected chip).
  const searching = query.trim().length > 0;
  const visible = sorted
    .filter((m) => {
      if (searching) return true;
      if (filter === 'available') return m.selectable;
      if (filter === 'sent') return !m.excluded && !m.selectable;
      if (filter === 'excluded') return m.excluded;
      if (filter === 'admins') return m.isAdmin;
      if (filter === 'notMine') return !m.inMyGroups?.length && !m.excluded;
      return true;
    })
    .filter((m) => matchesSearch(m, query));

  function pickTemplate(id: number) {
    setTemplateId(id);
    localStorage.setItem('lastTemplateId', String(id));
    setSelected(new Set());
  }

  function toggle(m: Member) {
    if (!template) return setSetupOpen(true); // pick the message first, then people
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
    if (!template) return setSetupOpen(true);
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

  function review() {
    if (!template) return setSetupOpen(true);
    if (selected.size === 0) return toast('Tap people to select them, or use "Pick 10"');
    setConfirmOpen(true);
  }

  async function send() {
    if (!template || !group.data || !sendFrom) return;
    setSending(true);
    try {
      const recipients = members.filter((m) => selected.has(m.phone)).map((m) => ({ phone: m.phone, name: m.name }));
      const res = await api<{ queued: number; skippedAlreadySent: number; skippedExcluded: number }>('/api/sends', {
        method: 'POST',
        body: { templateId: template.id, sessionId: sendFrom.id, groupId: group.data.id, groupName: group.data.name, recipients },
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

  const selectedMembers = sorted.filter((m) => selected.has(m.phone));
  const title = group.data?.name ?? (source.kind === 'list' ? 'List' : 'Group');
  const hiddenCount = members.filter((m) => m.phone.endsWith('@lid')).length;
  const subtitle = group.data
    ? template
      ? `${counts.available} can get "${template.name}" · ${counts.sent} already did`
      : `${members.length} ${source.kind === 'list' ? 'contacts · uploaded list' : 'members'}`
    : 'Loading…';

  return (
    <div className="pb-44">
      <Header
        title={title}
        subtitle={subtitle}
        back={() => navigate(source.kind === 'list' ? '/lists' : '/groups')}
        avatar={<Avatar label={title} kind={source.kind === 'list' ? 'list' : 'group'} size="sm" />}
        right={
          <>
            <IconButton icon="search" label="Search members" onClick={() => searchRef.current?.focus()} />
            <IconButton icon="menu" label="More options" onClick={() => setMenuOpen(true)} />
          </>
        }
      />

      <div className="border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-2 rounded-full bg-panel px-4 py-2">
          <Icon name="search" size={18} className="text-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            inputMode="search"
            placeholder="Search name or number (e.g. 98123 45678)"
            aria-label="Search members by name or number"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
          {query && <button onClick={() => setQuery('')} aria-label="Clear search" className="text-muted"><Icon name="close" size={18} /></button>}
        </div>
        {searching && (
          <p className="px-2 pt-1.5 text-xs text-muted">
            {visible.length} {visible.length === 1 ? 'match' : 'matches'} in the whole group{filter !== 'all' ? ' (ignoring the filter)' : ''}.
            {/^\D*\d/.test(query) && hiddenCount > 0 ? ` People who hide their number can only be found by name.` : ''}
          </p>
        )}
      </div>

      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-3 py-2.5">
        <Chip active={filter === 'available'} onClick={() => setFilter('available')}>Can send {template ? counts.available : ''}</Chip>
        <Chip active={filter === 'sent'} onClick={() => setFilter('sent')}>Already got it {template ? counts.sent : ''}</Chip>
        {(group.data?.myGroups?.length ?? 0) > 0 && (
          <Chip active={filter === 'notMine'} onClick={() => setFilter('notMine')}>Not in my group {counts.notMine}</Chip>
        )}
        {counts.admins > 0 && <Chip active={filter === 'admins'} onClick={() => setFilter('admins')}>Admins {counts.admins}</Chip>}
        <Chip active={filter === 'excluded'} onClick={() => setFilter('excluded')}>Hidden {counts.excluded}</Chip>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All {members.length || ''}</Chip>
      </div>
      {hiddenCount > 0 && <p className="px-4 pb-1 text-xs text-muted">{hiddenCount} members hide their number. You can still message them.</p>}

      {group.loading && !group.data && <Spinner />}
      {group.error && <ErrorBox message={group.error} retry={group.reload} />}
      {group.data && !template && (
        <button onClick={() => (active.length ? setSetupOpen(true) : navigate('/templates'))} className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl bg-bubble px-4 py-3 text-left text-sm text-send">
          <Icon name="message" size={20} />
          <span className="flex-1"><b>{active.length ? 'Choose a message' : 'Write your first message'}</b> to start picking people. Anyone who already got it is greyed out.</span>
        </button>
      )}
      {group.data && visible.length === 0 && <Empty>{query ? `Nobody matches “${query}”.` : filter === 'available' ? 'Everyone here already got this message.' : 'Nobody here.'}</Empty>}

      {group.data && (
        <ul>
          {visible.map((m) => {
            const checked = selected.has(m.phone);
            return (
              <li key={m.phone} className={`flex items-center ${checked ? 'bg-[#f0fdf4]' : ''}`}>
                <button onClick={() => toggle(m)} disabled={!m.selectable} aria-pressed={checked} className="flex min-w-0 flex-1 items-center gap-3.5 py-1 pl-4 text-left">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-sm text-white ${checked ? 'border-send bg-send' : 'border-gray-300'} ${m.selectable && template ? '' : 'invisible'}`}>
                    {checked && '✓'}
                  </span>
                  <span className={`min-w-0 flex-1 border-b border-gray-100 py-2.5 ${m.selectable ? '' : 'opacity-55'}`}>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{m.name ?? <span className="font-normal text-muted">No name</span>}</span>
                      {m.inMyGroups?.length ? (
                        <span title={`Already in ${m.inMyGroups.join(', ')}`} className="max-w-[9rem] shrink-0 truncate rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
                          In {m.inMyGroups[0]}{m.inMyGroups.length > 1 ? ` +${m.inMyGroups.length - 1}` : ''}
                        </span>
                      ) : null}
                      {m.isAdmin && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">Admin</span>}
                      {m.excluded ? <span className="text-xs text-muted">Hidden</span> : m.sendStatus ? <StatusChip status={m.sendStatus} /> : null}
                    </span>
                    <span className="block text-[13px] text-muted">{formatPhone(m.phone)}</span>
                  </span>
                </button>
                <button onClick={() => setEditing(m)} className="self-stretch border-b border-gray-100 px-3 text-muted" aria-label={`Options for ${m.name ?? formatPhone(m.phone)}`}><Icon name="menu" size={18} /></button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Composer, like WhatsApp's message bar: what you're sending, from where, and the send button. */}
      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-2xl bg-panel/95 px-2.5 pb-[calc(0.6rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        {template && selected.size > 0 && (
          <div className="mb-2 px-1">
            <button onClick={() => setConfirmOpen(true)} className="block w-full text-left">
              <Bubble label={`Preview · ${selectedMembers[0]?.name ?? 'no name'}`} clamp>{renderPreview(template.body, selectedMembers[0]?.name ?? null, template.fallback)}</Bubble>
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button onClick={() => setSetupOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-4 py-3 text-left text-sm shadow-sm">
            <Icon name="message" size={18} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {template ? <b className="font-semibold">{template.name}</b> : <span className="text-muted">Choose a message</span>}
              {multi && sendFrom && <span className="text-muted"> · from <b className="font-semibold text-ink">{sendFrom.pushName || sessionTitle(sendFrom)}</b></span>}
            </span>
            <Icon name="down" size={18} className="shrink-0 text-muted" />
          </button>
          <button
            onClick={review}
            aria-label={selected.size ? `Review and send to ${selected.size}` : 'Send'}
            className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white shadow-sm ${selected.size && template ? 'bg-send' : 'bg-gray-400'}`}
          >
            <Icon name="send" size={22} />
            {selected.size > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold">{selected.size}</span>}
          </button>
        </div>
        {template && (
          <div className="flex items-center gap-3 px-3 pt-1.5 text-[13px] text-muted">
            <span className="flex-1">{selected.size} of {MAX_BATCH} selected</span>
            {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="font-semibold text-muted">Clear</button>}
            {selected.size < MAX_BATCH && counts.available > selected.size && (
              <button onClick={selectNext} className="font-semibold text-send">{selected.size ? 'Fill up to 10' : `Pick ${Math.min(MAX_BATCH, counts.available)}`}</button>
            )}
          </div>
        )}
      </div>

      <Sheet open={setupOpen} onClose={() => setSetupOpen(false)} title="What to send">
        <div className="space-y-5">
          <div>
            <span className="mb-2 block text-[13px] font-medium text-send">Message</span>
            {active.length === 0 && <button onClick={() => navigate('/templates')} className="text-sm font-semibold text-send underline">Write your first message</button>}
            <div className="space-y-2">
              {active.map((t) => (
                <button key={t.id} onClick={() => pickTemplate(t.id)} className={`flex w-full items-start gap-3 rounded-2xl border-2 p-3 text-left ${t.id === template?.id ? 'border-send bg-[#f0fdf4]' : 'border-gray-100'}`}>
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${t.id === template?.id ? 'border-send' : 'border-gray-300'}`}>{t.id === template?.id && <span className="h-2.5 w-2.5 rounded-full bg-send" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t.name}</span>
                    <span className="line-clamp-2 text-sm text-muted">{renderPreview(t.body, 'Rahul', t.fallback)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {multi && (
            <div>
              <span className="mb-2 block text-[13px] font-medium text-send">Send from</span>
              <div className="space-y-2">
                {sessions.data!.map((s) => (
                  <button key={s.id} onClick={() => pickSender(s.id)} className={`flex w-full items-center gap-3 rounded-2xl border-2 p-3 text-left ${s.id === sendFrom?.id ? 'border-send bg-[#f0fdf4]' : 'border-gray-100'}`}>
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${s.id === sendFrom?.id ? 'border-send' : 'border-gray-300'}`}>{s.id === sendFrom?.id && <span className="h-2.5 w-2.5 rounded-full bg-send" />}</span>
                    <span className="min-w-0 flex-1 font-medium">{sessionTitle(s)}</span>
                    <span className={`text-xs ${s.status === 'ready' ? 'text-send' : 'text-amber-700'}`}>{s.status === 'ready' ? '● connected' : '● not connected'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <Button className="w-full py-3" onClick={() => setSetupOpen(false)}>Done</Button>
        </div>
      </Sheet>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={title}>
        <div className="-mx-2">
          <a href={`${basePath}/export.pdf${qs()}`} download onClick={() => setMenuOpen(false)} className="flex items-center gap-4 rounded-xl px-3 py-3 text-[15px] hover:bg-panel">
            <Icon name="download" className="text-muted" /> Download contacts (PDF)
          </a>
          <a href={`${basePath}/export.csv${qs()}`} download onClick={() => setMenuOpen(false)} className="flex items-center gap-4 rounded-xl px-3 py-3 text-[15px] hover:bg-panel">
            <Icon name="download" className="text-muted" /> Download contacts (CSV)
          </a>
          {source.kind === 'group' && group.data && (
            <button onClick={toggleMine} className="flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left text-[15px] hover:bg-panel">
              <Icon name="star" className="text-muted" />
              <span className="flex-1">
                {group.data.isMine ? 'Unmark as my group' : 'This is my group'}
                <span className="block text-xs text-muted">
                  {group.data.isMine ? 'Stop tagging its members in other groups.' : 'Tag its members as “In this group” everywhere else.'}
                </span>
              </span>
            </button>
          )}
          {source.kind === 'list' && (
            <button onClick={deleteList} className="flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left text-[15px] text-red-600 hover:bg-red-50">
              <Icon name="trash" /> Delete this list
            </button>
          )}
          <p className="px-3 pt-2 text-xs text-muted">Upload the CSV in the Lists tab to message these people from another number.</p>
        </div>
      </Sheet>

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Send to ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`}>
        {sendFrom && (
          <p className={`mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${sendFrom.status === 'ready' ? 'bg-panel' : 'bg-amber-50 text-amber-800'}`}>
            <Icon name="phone" size={18} />
            <span>From <b>{sessionTitle(sendFrom)}</b>{sendFrom.status !== 'ready' && ': not connected, messages wait until it is'}</span>
          </p>
        )}
        <div className="mb-4 space-y-2 rounded-2xl bg-wallpaper p-3">
          {selectedMembers.map((m) => (
            <Bubble key={m.phone} label={`${m.name ?? 'No name'} · ${formatPhone(m.phone)}`}>{template && renderPreview(template.body, m.name, template.fallback)}</Bubble>
          ))}
        </div>
        <p className="mb-2 text-xs text-muted">They go out one by one, about 1–2 minutes apart, so WhatsApp doesn't flag your number. You can close the app.</p>
        <div className="sticky -bottom-5 -mx-5 -mb-5 flex gap-2 border-t border-gray-100 bg-white px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button variant="ghost" className="flex-1" onClick={() => setConfirmOpen(false)}>Back</Button>
          <Button className="flex-[2] py-3" disabled={sending || !sendFrom} onClick={send}>{sending ? 'Queueing…' : `Send ${selected.size} message${selected.size === 1 ? '' : 's'}`}</Button>
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
    <Sheet open onClose={onClose} title={member.name ?? formatPhone(member.phone)}>
      <p className="-mt-2 mb-4 text-sm text-muted">{formatPhone(member.phone)}</p>
      <div className="mb-5">
        <Field label="Name used in messages">
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={member.whatsappName ?? 'Rahul'} className={inputClass} />
            <Button onClick={() => onSaveName(member, name)}>Save</Button>
          </div>
        </Field>
      </div>
      {member.excluded ? (
        <Button variant="ghost" className="w-full py-3" onClick={() => onExclude(member, false)}>Show this person again</Button>
      ) : (
        <Button variant="danger" className="w-full py-3" onClick={() => onExclude(member, true)}>Never message this number</Button>
      )}
    </Sheet>
  );
}

/**
 * Match by name, or by number in any format: "98123 45678", "+91 98123-45678", "098123…" all
 * find 919812345678. Three or more digits are enough for a partial number.
 */
function matchesSearch(m: Member, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((m.name ?? '').toLowerCase().includes(q) || (m.whatsappName ?? '').toLowerCase().includes(q)) return true;
  const digits = q.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 3 || m.phone.endsWith('@lid')) return false;
  return m.phone.includes(digits);
}
