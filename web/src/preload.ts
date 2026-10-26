import { api, type ContactList, type Group, type Template, type WaSession } from './api';
import { writeCache } from './cache';
import { getViewSession, resolveSession } from './sessions';

/**
 * Right after the app opens, fetch everything you're likely to tap next and keep it in the phone's
 * cache: numbers, templates, lists, the group list, and the members of your starred groups and
 * uploaded lists (with your last-used template). Screens then open with data already there.
 * Uses the same cache keys as the screens, so nothing is fetched twice.
 */
const MAX_PRELOADED = 12;

export async function preloadEverything(): Promise<void> {
  try {
    const [sessions, templates, lists] = await Promise.all([
      api<WaSession[]>('/api/wa/sessions'),
      api<Template[]>('/api/templates'),
      api<ContactList[]>('/api/lists'),
    ]);
    writeCache('sessions', sessions);
    writeCache('templates', templates);
    writeCache('lists', lists);

    const view = resolveSession(sessions, getViewSession());
    const viewId = view?.id ?? '';
    const templateId = Number(localStorage.getItem('lastTemplateId')) || null;
    const template = templates.find((t) => t.id === templateId && !t.archived) ?? null;
    const tq = template ? `templateId=${template.id}` : '';

    let starred: Group[] = [];
    if (viewId && view?.status === 'ready') {
      const groups = await api<Group[]>(`/api/groups?session=${encodeURIComponent(viewId)}`);
      writeCache(`groups:${viewId}`, groups);
      starred = groups.filter((g) => g.favorite);
    }

    const jobs: Array<() => Promise<void>> = [
      ...starred.slice(0, MAX_PRELOADED).map((g) => async () => {
        const basePath = `/api/groups/${encodeURIComponent(g.id)}`;
        const qs = [`session=${encodeURIComponent(viewId)}`, tq].filter(Boolean).join('&');
        writeCache(`members:${basePath}|${viewId}|${template?.id ?? ''}`, await api(`${basePath}?${qs}`));
      }),
      ...lists.slice(0, MAX_PRELOADED).map((l) => async () => {
        const basePath = `/api/lists/${l.id}`;
        writeCache(`members:${basePath}||${template?.id ?? ''}`, await api(`${basePath}${tq ? `?${tq}` : ''}`));
      }),
    ];
    // A few at a time, so the screen you're actually on stays snappy.
    for (let i = 0; i < jobs.length; i += 3) {
      await Promise.all(jobs.slice(i, i + 3).map((job) => job().catch(() => {})));
    }
  } catch {
    // Offline or logged out: the screens load on their own.
  }
}
