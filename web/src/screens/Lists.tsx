import { useState } from 'react';
import { api, formatTime, type ContactList } from '../api';
import { Avatar, Button, Empty, ErrorBox, Fab, Field, Icon, MainHeader, Sheet, Spinner, inputClass, toast, useLoad } from '../ui';

/** Uploaded CSV lists: they work like a group and can be sent from any number. */
export default function Lists({ route, navigate }: { route: string; navigate: (to: string) => void }) {
  const lists = useLoad(() => api<ContactList[]>('/api/lists'), []);
  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <>
      <MainHeader route={route} navigate={navigate} />
      {lists.loading && !lists.data && <Spinner />}
      {lists.error && <ErrorBox message={lists.error} retry={lists.reload} />}
      {lists.data?.length === 0 && (
        <Empty>
          <span className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-700"><Icon name="upload" size={28} /></span>
          <span className="block text-base font-medium text-ink">Upload a contact list</span>
          A CSV with phone numbers works like a group. Use it to message people from a group you're in on another number.
          <span className="mt-4 block"><button onClick={() => setUploadOpen(true)} className="rounded-full bg-send px-5 py-2.5 text-sm font-semibold text-white">Upload CSV</button></span>
        </Empty>
      )}
      <ul>
        {lists.data?.map((l) => (
          <li key={l.id}>
            <button onClick={() => navigate(`/lists/${l.id}`)} className="flex w-full items-center gap-4 py-2.5 pl-4 text-left hover:bg-panel">
              <Avatar label={l.name} kind="list" />
              <span className="min-w-0 flex-1 border-b border-gray-100 py-2 pr-4">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{l.name}</span>
                  <span className="shrink-0 text-xs text-muted">{formatTime(l.created_at)}</span>
                </span>
                <span className="block text-sm text-muted">{l.member_count} contacts · send from any number</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {lists.data && lists.data.length > 0 && (
        <p className="px-6 py-6 text-center text-xs text-muted">Tip: open any group, tap ⋮ → Download CSV, then upload it here.</p>
      )}
      <Fab icon="upload" label="Upload CSV" onClick={() => setUploadOpen(true)} />
      <UploadSheet
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={(id) => { setUploadOpen(false); void lists.reload(); navigate(`/lists/${id}`); }}
      />
    </>
  );
}

function UploadSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) return toast('Choose a CSV file first');
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
      <div className="space-y-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-gray-300 px-4 py-6 text-center hover:border-send">
          <Icon name="upload" size={28} className="text-send" />
          <span className="text-sm font-medium">{file ? file.name : 'Choose a CSV file'}</span>
          <span className="text-xs text-muted">Needs a phone column; a name column is optional</span>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="sr-only" />
        </label>
        <Field label="List name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cyclists from number 1" className={inputClass} />
        </Field>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" disabled={busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</Button>
        </div>
      </div>
    </Sheet>
  );
}
