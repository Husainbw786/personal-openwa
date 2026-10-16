import { useState } from 'react';
import { api, renderPreview, type Template } from '../api';
import { Button, Empty, ErrorBox, Header, Sheet, Spinner, toast, useLoad } from '../ui';

interface Draft {
  id?: number;
  name: string;
  body: string;
  fallback: string;
  archived: boolean;
}

const EMPTY: Draft = { name: '', body: 'Hi {first}, ', fallback: 'there', archived: false };

export default function Templates() {
  const { data, error, loading, reload } = useLoad(() => api<Template[]>('/api/templates'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api(draft.id ? `/api/templates/${draft.id}` : '/api/templates', { method: draft.id ? 'PUT' : 'POST', body: draft });
      toast('Template saved');
      setDraft(null);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Header title="Templates" right={<button onClick={() => setDraft({ ...EMPTY })} className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-semibold">+ New</button>} />
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} retry={reload} />}
      {data && data.length === 0 && <Empty>No templates yet. Tap “+ New” to write your first message.</Empty>}
      <ul className="space-y-2 p-3">
        {data?.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => setDraft({ id: t.id, name: t.name, body: t.body, fallback: t.fallback, archived: !!t.archived })}
              className={`w-full rounded-2xl bg-white p-4 text-left shadow-sm ${t.archived ? 'opacity-50' : ''}`}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="flex-1 truncate font-semibold">{t.name}</span>
                {t.archived ? <span className="text-xs text-gray-500">Archived</span> : null}
                <span className="text-xs text-gray-500">Sent to {t.sent_count}</span>
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap text-sm text-gray-600">{t.body}</p>
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit template' : 'New template'}>
        {draft && (
          <div className="space-y-3">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Template name (only you see this)" className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={6} placeholder="Message text" className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            <p className="text-xs text-gray-500">
              Use <code className="rounded bg-gray-100 px-1">{'{first}'}</code> for first name or <code className="rounded bg-gray-100 px-1">{'{name}'}</code> for full name.
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">If we don't know their name, use</span>
              <input value={draft.fallback} onChange={(e) => setDraft({ ...draft, fallback: e.target.value })} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
            </label>
            <div>
              <span className="mb-1 block text-xs font-medium text-gray-500">Preview</span>
              <p className="whitespace-pre-wrap rounded-lg bg-[#dcf8c6] px-3 py-2 text-sm">{renderPreview(draft.body, 'Rahul Sharma', draft.fallback)}</p>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-[#dcf8c6]/60 px-3 py-2 text-sm text-gray-600">{renderPreview(draft.body, null, draft.fallback)}</p>
            </div>
            {draft.id && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.archived} onChange={(e) => setDraft({ ...draft, archived: e.target.checked })} />
                Archive (hide from the template picker)
              </label>
            )}
            {draft.id && <p className="text-xs text-amber-700">Editing doesn't re-send: people who already got this template stay marked as sent. For a new campaign, create a new template.</p>}
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
