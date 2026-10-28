import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { defaultSessionId, forgetDefaultSession, openwa, OpenWAError, setDefaultSession, type Session } from '../openwa.ts';
import { annotate, cachedCount, forgetSession, getGroupList, groupCount, loadGroupMembers, mapLimit } from '../members.ts';
import { sendCsv, sendPdf, toRows } from '../export.ts';
import { getMyGroups, myGroupMembership, setMyGroup } from '../mygroups.ts';
import { backupGroup, groupActivity, recentJoins, trackGroup } from '../tracker.ts';
import { registerWebhook } from './hooks.ts';
import { sessionLabel } from '../queue.ts';
import { normalizePhone, isValidPhone } from '../phone.ts';


/** Which linked number a request is about: `?session=<id>`, or the default number. */
async function pickSession(query: { session?: string }): Promise<string> {
  return query.session || defaultSessionId();
}

async function describe(session: Session, defaultId: string) {
  let qrCode: string | null = null;
  if (session.status === 'qr_ready') {
    qrCode = (await openwa.getQr(session.id).catch(() => null))?.qrCode ?? null;
  }
  return {
    id: session.id,
    name: session.name,
    label: session.status === 'ready' ? sessionLabel(session) : session.name,
    isDefault: session.id === defaultId,
    status: session.status,
    phone: session.phone,
    pushName: session.pushName,
    lastError: session.lastError ?? null,
    qrCode,
  };
}

/** OpenWA session names: 3-50 chars, letters, digits and hyphens. */
function sessionName(label: string, taken: Set<string>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'number';
  let name = slug.length >= 3 ? slug : `number-${slug}`;
  for (let i = 2; taken.has(name); i++) name = `${slug}-${i}`;
  return name;
}

type Log = { info: (m: string) => void; warn: (o: object, m: string) => void };

export function waRoutes(app: FastifyInstance): void {
  const log: Log = { info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) };

  /** Every linked (or linking) number, default first, with a QR code when one is waiting to be scanned. */
  app.get('/api/wa/sessions', async () => {
    const [sessions, defaultId] = await Promise.all([openwa.listSessions(), defaultSessionId()]);
    sessions.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || a.name.localeCompare(b.name));
    return Promise.all(sessions.map((s) => describe(s, defaultId)));
  });

  app.post<{ Body: { label?: string } }>('/api/wa/sessions', async (req) => {
    const sessions = await openwa.listSessions();
    const name = sessionName(req.body?.label?.trim() || `number-${sessions.length + 1}`, new Set(sessions.map((s) => s.name)));
    const session = await openwa.createSession(name);
    await registerWebhook(session.id, log);
    await openwa.start(session.id);
    return describe(await openwa.getSession(session.id), await defaultSessionId());
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/start', async (req) => {
    await openwa.start(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/logout', async (req) => {
    await openwa.logout(req.params.id);
    forgetSession(req.params.id);
    return { ok: true };
  });

  /** Phone-number linking, for when the QR code is on the same phone and can't be scanned. */
  app.post<{ Params: { id: string }; Body: { phone?: string } }>('/api/wa/sessions/:id/pairing-code', async (req, reply) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    if (!isValidPhone(phone)) return reply.code(400).send({ message: 'Enter the WhatsApp number you are linking, with country code (e.g. 91 98123 45678)' });
    const session = await openwa.getSession(req.params.id);
    if (session.status !== 'qr_ready') {
      return reply.code(409).send({ message: 'This number is not waiting to be linked yet. Wait a few seconds and try again.' });
    }
    const { pairingCode } = await openwa.requestPairingCode(req.params.id, phone);
    return { pairingCode };
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/restart', async (req) => {
    await openwa.restart(req.params.id);
    forgetSession(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/wa/sessions/:id/default', async (req) => {
    await openwa.getSession(req.params.id); // 404s if it doesn't exist
    setDefaultSession(req.params.id);
    return { ok: true };
  });

  /**
   * Remove a number entirely, including the main one. Its waiting messages are cancelled; its send
   * history is kept. If it was main, another linked number becomes main (or a fresh one is created).
   */
  app.delete<{ Params: { id: string } }>('/api/wa/sessions/:id', async (req) => {
    const id = req.params.id;
    await openwa.logout(id).catch(() => {});
    await openwa.deleteSession(id).catch((err) => {
      if (!(err instanceof OpenWAError && err.status === 404)) throw err;
    });
    db.prepare(`UPDATE sends SET status = 'cancelled', error = 'The sending number was removed' WHERE session_id = ? AND status = 'queued'`).run(id);
    forgetSession(id);
    forgetDefaultSession(id);
    const newDefault = await defaultSessionId();
    const fresh = await openwa.getSession(newDefault);
    if (fresh.status === 'created') {
      await registerWebhook(newDefault, log);
      await openwa.start(newDefault).catch(() => {});
    }
    return { ok: true, defaultSessionId: newDefault };
  });

  /** The default number, kept for older clients. */
  app.get('/api/wa/status', async () => {
    const d = await describe(await openwa.getSession(await defaultSessionId()), await defaultSessionId());
    return { status: d.status, phone: d.phone, pushName: d.pushName, lastError: d.lastError, qrCode: d.qrCode };
  });

  app.get<{ Querystring: { refresh?: string; session?: string } }>('/api/groups', async (req) => {
    const sessionId = await pickSession(req.query);
    const groups = await getGroupList(sessionId, req.query.refresh === '1');
    const favorites = new Set((db.prepare('SELECT group_id FROM favorite_groups').all() as Array<{ group_id: string }>).map((r) => r.group_id));
    // Counts come straight from the warm cache, so the home screen needs no second request.
    return groups
      .map((g) => ({ id: g.id, name: g.name, favorite: favorites.has(g.id), count: cachedCount(sessionId, g.id) }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  });

  /** Member counts for the groups currently on screen (the list itself has no counts). */
  app.post<{ Body: { ids: string[] }; Querystring: { session?: string } }>('/api/groups/counts', async (req) => {
    const sessionId = await pickSession(req.query);
    const ids = (req.body?.ids ?? []).slice(0, 50);
    const counts = await mapLimit(ids, 6, (id) => groupCount(sessionId, id).catch(() => null));
    return Object.fromEntries(ids.map((id, i) => [id, counts[i]]));
  });

  app.put<{ Params: { id: string }; Body: { favorite: boolean; name?: string } }>('/api/groups/:id/favorite', async (req) => {
    if (req.body.favorite) {
      db.prepare('INSERT OR REPLACE INTO favorite_groups (group_id, name) VALUES (?, ?)').run(req.params.id, req.body.name ?? null);
    } else {
      db.prepare('DELETE FROM favorite_groups WHERE group_id = ?').run(req.params.id);
    }
    return { ok: true };
  });

  /** Group members, annotated for the selected template: hidden, already got it, or selectable. */
  app.get<{ Params: { id: string }; Querystring: { templateId?: string; fresh?: string; session?: string } }>('/api/groups/:id', async (req) => {
    const group = await loadGroupMembers(await pickSession(req.query), req.params.id, req.query.fresh === '1');
    const templateId = req.query.templateId ? Number(req.query.templateId) : null;
    const membership = await myGroupMembership(req.params.id);
    const isMine = getMyGroups().some((g) => g.groupId === req.params.id);
    return {
      id: req.params.id, kind: 'group', name: group.name, description: group.description, isMine,
      myGroups: getMyGroups().filter((g) => g.groupId !== req.params.id).map((g) => g.name),
      members: annotate(group.members, templateId, membership, recentJoins(30)),
    };
  });

  app.get('/api/my-groups', async () => getMyGroups());

  /** Who joined / left one of my groups recently. */
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/my-groups/:id/activity', async (req) => {
    return groupActivity(req.params.id, Math.min(Number(req.query.days) || 30, 365));
  });

  /** Hourly backups of one of my groups (without the CSV body). */
  app.get<{ Params: { id: string } }>('/api/my-groups/:id/backups', async (req) => {
    return db.prepare('SELECT id, group_name, taken_at, member_count, joined, left_count FROM group_backups WHERE group_id = ? ORDER BY taken_at DESC LIMIT 500').all(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/my-groups/:id/backup-now', async (req, reply) => {
    const g = getMyGroups().find((x) => x.groupId === req.params.id);
    if (!g) return reply.code(404).send({ message: 'Not one of your groups' });
    await trackGroup(g);
    return { id: await backupGroup(g) };
  });

  app.get<{ Params: { id: string } }>('/api/backups/:id/csv', async (req, reply) => {
    const row = db.prepare('SELECT group_name, taken_at, csv FROM group_backups WHERE id = ?').get(Number(req.params.id)) as { group_name: string; taken_at: string; csv: string } | undefined;
    if (!row) return reply.code(404).send({ message: 'Backup not found' });
    const stamp = new Date(row.taken_at).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16).replace(/[: ]/g, '-');
    const safe = row.group_name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'group';
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(`${safe}-${stamp}.csv`)}"`)
      .send(row.csv);
  });

  /** Mark or unmark a group as one of yours. */
  app.put<{ Params: { id: string }; Body: { mine: boolean; name?: string }; Querystring: { session?: string } }>('/api/my-groups/:id', async (req) => {
    const sessionId = await pickSession(req.query);
    const name = req.body?.name || (await loadGroupMembers(sessionId, req.params.id)).name;
    const groups = setMyGroup({ sessionId, groupId: req.params.id, name }, !!req.body?.mine);
    // Start tracking (and take a first backup) right away.
    if (req.body?.mine) {
      const g = { sessionId, groupId: req.params.id, name };
      void trackGroup(g).then(() => backupGroup(g)).catch(() => {});
    }
    return groups;
  });

  app.get<{ Params: { id: string; format: string }; Querystring: { session?: string } }>('/api/groups/:id/export.:format', async (req, reply) => {
    const group = await loadGroupMembers(await pickSession(req.query), req.params.id);
    const rows = toRows(annotate(group.members, null));
    if (req.params.format === 'pdf') return sendPdf(reply, group.name, rows);
    if (req.params.format === 'csv') return sendCsv(reply, group.name, rows);
    return reply.code(404).send({ message: 'Use .csv or .pdf' });
  });
}
