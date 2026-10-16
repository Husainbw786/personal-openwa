import { useState } from 'react';
import { api, renderPreview, type Template } from '../api';
import { Avatar, Button, Empty, ErrorBox, Fab, Field, Icon, MainHeader, Sheet, Spinner, inputClass, toast, useLoad } from '../ui';

interface Draft {
  id?: number;
  name: string;
  body: string;
  fallback: string;
  archived: boolean;
}

const EMPTY: Draft = { name: '', body: 'Hi {first}, ', fallback: 'there', archived: false };

export default function Templates({ route, navigate }: { route: string; navigate: (to: string) => void }) {
  const { data, error, loading, reload } = useLoad(() => api<Template[]>('/api/templates'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.body.trim()) return toast('Give the message a name and some text');
    setSaving(true);
    try {
      await api(draft.id ? `/api/templates/${draft.id}` : '/api/templates', { method: draft.id ? 'PUT' : 'POST', body: draft });
      toast('Message saved');
      setDraft(null);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const active = data?.filter((t) => !t.archived) ?? [];
  const archived = data?.filter((t) => t.archived) ?? [];
  const open = (t: Template) => setDraft({ id: t.id, name: t.name, body: t.body, fallback: t.fallback, archived: !!t.archived });

  return (
    <>
      <MainHeader route={route} navigate={navigate} />
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} retry={reload} />}
      {data && data.length === 0 && (
        <Empty>
          <span className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-bubble text-send"><Icon name="message" size={28} /></span>
          <span className="block text-base font-medium text-ink">Write your first message</span>
          Use {'{first}'} and each person sees their own name.
          <span className="mt-4 block"><button onClick={() => setDraft({ ...EMPTY })} className="rounded-full bg-send px-5 py-2.5 text-sm font-semibold text-white">New message</button></span>
        </Empty>
      )}
      <TemplateRows items={active} onOpen={open} />
      {archived.length > 0 && (
        <>
          <p className="px-4 pb-1 pt-5 text-[13px] font-semibold uppercase tracking-wide text-muted">Archived</p>
          <div className="opacity-60"><TemplateRows items={archived} onOpen={open} /></div>
        </>
      )}
      <Fab icon="plus" label="New message" onClick={() => setDraft({ ...EMPTY })} />

      <Sheet open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit message' : 'New message'}>
        {draft && (
          <div className="space-y-4">
            <Field label="Name (only you see this)">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Intro — Q4 event" className={inputClass} />
            </Field>
            <Field label="Message">
              <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={5} className={inputClass} />
            </Field>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              Insert:
              {(['{first}', '{name}'] as const).map((tag) => (
                <button key={tag} onClick={() => setDraft({ ...draft, body: `${draft.body}${tag}` })} className="rounded-full bg-panel px-3 py-1 font-mono text-[12px] text-ink">{tag}</button>
              ))}
              <span>first name or full name</span>
            </div>
            <Field label="If there's no name, say">
              <input value={draft.fallback} onChange={(e) => setDraft({ ...draft, fallback: e.target.value })} className={inputClass} />
            </Field>
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-send">Preview</span>
              <div className="space-y-2 rounded-2xl bg-wallpaper p-3">
                <Bubble>{renderPreview(draft.body, 'Rahul Sharma', draft.fallback)}</Bubble>
                <Bubble muted>{renderPreview(draft.body, null, draft.fallback)}</Bubble>
              </div>
            </div>
            {draft.id && (
              <label className="flex items-center gap-3 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-[#00a884]" checked={draft.archived} onChange={(e) => setDraft({ ...draft, archived: e.target.checked })} />
                Archive (hide when choosing a message)
              </label>
            )}
            {draft.id && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">Editing doesn't re-send. People who already got this message stay marked. For a new campaign, create a new message.</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" className="flex-1" onClick={() => setDraft(null)}>Cancel</Button>
              <Button className="flex-1" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}

function TemplateRows({ items, onOpen }: { items: Template[]; onOpen: (t: Template) => void }) {
  return (
    <ul>
      {items.map((t) => (
        <li key={t.id}>
          <button onClick={() => onOpen(t)} className="flex w-full items-center gap-4 py-2.5 pl-4 text-left hover:bg-panel">
            <Avatar label={t.name} kind="template" />
            <span className="min-w-0 flex-1 border-b border-gray-100 py-2 pr-4">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{t.name}</span>
                <span className="shrink-0 text-xs text-muted">{t.sent_count ? `sent to ${t.sent_count}` : 'not sent yet'}</span>
              </span>
              <span className="block truncate text-sm text-muted">{t.body}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Bubble({ children, muted, label, clamp }: { children: React.ReactNode; muted?: boolean; label?: string; clamp?: boolean }) {
  return (
    <div className={`relative max-w-[92%] rounded-xl rounded-tr-sm px-3 py-2 text-[15px] shadow-sm ${muted ? 'bg-bubble/70 text-gray-600' : 'bg-bubble'} ml-auto`}>
      {label && <p className="mb-0.5 text-xs font-semibold text-send">{label}</p>}
      <p className={clamp ? 'line-clamp-2' : 'whitespace-pre-wrap'}>{children}</p>
    </div>
  );
}
