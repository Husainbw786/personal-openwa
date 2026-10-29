import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.ts';
import { annotate, loadGroupMembers } from './members.ts';
import { getMyGroups, type MyGroup } from './mygroups.ts';
import { csvText, toRows } from './export.ts';

/**
 * Watches "my groups" closely: who joined, who left, and when. Every refresh is diffed against
 * member_log. Refreshes happen every minute, and right away (a few seconds later) when WhatsApp
 * reports a join or leave through OpenWA's webhook. Also keeps an hourly CSV backup of each group.
 */
const CHECK_EVERY_MS = 60_000;
const BACKUP_EVERY_MS = 60 * 60 * 1000;
const KEEP_BACKUPS_DAYS = 90;
/** If this folder exists (mounted on the server), each backup is also written there as plain files; the server pushes it to a private GitHub repo. */
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/app/backups';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
let log: Log = { info: () => {}, warn: () => {} };

const now = () => new Date().toISOString();

/** Refresh one of my groups from WhatsApp and record joins/leaves. */
export async function trackGroup(g: MyGroup): Promise<{ joined: number; left: number; members: number }> {
  const data = await loadGroupMembers(g.sessionId, g.groupId, true);
  const at = now();
  const existing = new Map(
    (db.prepare('SELECT phone, left_at FROM member_log WHERE group_id = ?').all(g.groupId) as Array<{ phone: string; left_at: string | null }>)
      .map((r) => [r.phone, r.left_at]),
  );
  const firstRun = existing.size === 0;
  const insert = db.prepare(`INSERT INTO member_log (group_id, phone, name, is_admin, first_seen, last_seen, initial) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const stillHere = db.prepare(`UPDATE member_log SET last_seen = ?, name = COALESCE(?, name), is_admin = ? WHERE group_id = ? AND phone = ?`);
  const rejoined = db.prepare(`UPDATE member_log SET first_seen = ?, last_seen = ?, left_at = NULL, initial = 0, name = COALESCE(?, name), is_admin = ? WHERE group_id = ? AND phone = ?`);
  const gone = db.prepare(`UPDATE member_log SET left_at = ? WHERE group_id = ? AND phone = ? AND left_at IS NULL`);

  let joined = 0;
  let left = 0;
  const present = new Set<string>();
  db.exec('BEGIN');
  try {
    for (const m of data.members) {
      present.add(m.phone);
      const admin = m.isAdmin ? 1 : 0;
      if (!existing.has(m.phone)) {
        insert.run(g.groupId, m.phone, m.whatsappName, admin, at, at, firstRun ? 1 : 0);
        if (!firstRun) joined++;
      } else if (existing.get(m.phone)) {
        rejoined.run(at, at, m.whatsappName, admin, g.groupId, m.phone);
        joined++;
      } else {
        stillHere.run(at, m.whatsappName, admin, g.groupId, m.phone);
      }
    }
    for (const [phone, leftAt] of existing) {
      if (!present.has(phone) && !leftAt) {
        gone.run(at, g.groupId, phone);
        left++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (joined || left) log.info({ group: g.name, joined, left }, 'my group changed');
  return { joined, left, members: data.members.length };
}

/** phone → when they joined one of my groups (only real joins, not people who were there from the start). */
export function recentJoins(sinceDays = 30, exceptGroupId?: string): Map<string, string> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT phone, MAX(first_seen) AS at FROM member_log
    WHERE initial = 0 AND left_at IS NULL AND first_seen >= ? AND group_id IN (SELECT value FROM json_each(?)) AND group_id != ?
    GROUP BY phone
  `).all(since, JSON.stringify(getMyGroups().map((g) => g.groupId)), exceptGroupId ?? '') as Array<{ phone: string; at: string }>;
  return new Map(rows.map((r) => [r.phone, r.at]));
}

/** Joins and leaves of one group, newest first. */
export function groupActivity(groupId: string, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const joined = db.prepare(`SELECT phone, name, first_seen AS at FROM member_log WHERE group_id = ? AND initial = 0 AND first_seen >= ? ORDER BY first_seen DESC`).all(groupId, since);
  const left = db.prepare(`SELECT phone, name, left_at AS at FROM member_log WHERE group_id = ? AND left_at IS NOT NULL AND left_at >= ? ORDER BY left_at DESC`).all(groupId, since);
  const tracking = db.prepare(`SELECT MIN(first_seen) AS since FROM member_log WHERE group_id = ?`).get(groupId) as { since: string | null };
  return { trackingSince: tracking.since, joined, left };
}

/** Save a CSV snapshot of a group, with how many joined/left since the previous backup. */
export async function backupGroup(g: MyGroup): Promise<number> {
  const data = await loadGroupMembers(g.sessionId, g.groupId);
  const prev = db.prepare('SELECT taken_at FROM group_backups WHERE group_id = ? ORDER BY taken_at DESC LIMIT 1').get(g.groupId) as { taken_at: string } | undefined;
  const since = prev?.taken_at ?? '';
  const joined = (db.prepare('SELECT COUNT(*) AS n FROM member_log WHERE group_id = ? AND initial = 0 AND first_seen > ?').get(g.groupId, since) as { n: number }).n;
  const left = (db.prepare('SELECT COUNT(*) AS n FROM member_log WHERE group_id = ? AND left_at > ?').get(g.groupId, since) as { n: number }).n;
  const csv = csvText(toRows(annotate(data.members, null)));
  const res = db.prepare('INSERT INTO group_backups (group_id, group_name, taken_at, member_count, joined, left_count, csv) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(g.groupId, data.name || g.name, now(), data.members.length, prev ? joined : 0, prev ? left : 0, csv);
  db.prepare('DELETE FROM group_backups WHERE taken_at < ?').run(new Date(Date.now() - KEEP_BACKUPS_DAYS * 86_400_000).toISOString());
  writeBackupFiles(g, data.name || g.name, csv, { members: data.members.length, joined: prev ? joined : 0, left: prev ? left : 0, first: !prev });
  return Number(res.lastInsertRowid);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** <BACKUP_DIR>/<group>/members.csv (current list) and joins-leaves.csv (every join/leave so far). */
function writeBackupFiles(g: MyGroup, name: string, membersCsv: string, stats: { members: number; joined: number; left: number; first: boolean }): void {
  if (!existsSync(BACKUP_DIR)) return;
  try {
    const slug = name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || g.groupId;
    const dir = join(BACKUP_DIR, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'members.csv'), membersCsv);
    const events = db.prepare(`
      SELECT first_seen AS at, 'joined' AS event, name, phone FROM member_log WHERE group_id = ? AND initial = 0
      UNION ALL
      SELECT left_at AS at, 'left' AS event, name, phone FROM member_log WHERE group_id = ? AND left_at IS NOT NULL
      ORDER BY at
    `).all(g.groupId, g.groupId) as Array<{ at: string; event: string; name: string | null; phone: string }>;
    const ist = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const lines = ['time_ist,event,name,phone', ...events.map((e) => [ist(e.at), e.event, csvCell(e.name ?? ''), e.phone.endsWith('@lid') ? e.phone : `+${e.phone}`].join(','))];
    writeFileSync(join(dir, 'joins-leaves.csv'), `\ufeff${lines.join('\r\n')}\r\n`);

    // Changes every hour, so every backup shows up as a commit, even when nobody joined or left.
    const change = stats.first ? 'first backup' : stats.joined || stats.left
      ? [stats.joined && `+${stats.joined} joined`, stats.left && `-${stats.left} left`].filter(Boolean).join(', ')
      : 'no change';
    const nowIst = ist(new Date().toISOString());
    writeFileSync(join(dir, 'status.md'), [
      `# ${name}`,
      '',
      `- **Last checked:** ${nowIst} IST`,
      `- **Members:** ${stats.members}`,
      `- **Since the previous hourly backup:** ${change}`,
      `- **Joins / leaves recorded so far:** ${events.filter((e) => e.event === 'joined').length} / ${events.filter((e) => e.event === 'left').length}`,
      '',
      'Checked every minute (and instantly on WhatsApp join/leave events); backed up every hour.',
      '',
    ].join('\n'));
    // One line per group for the commit message.
    writeFileSync(join(dir, '.summary'), `${name}: ${stats.members} members, ${change}`);
  } catch (err) {
    log.warn({ err: String(err) }, 'could not write backup files');
  }
}

async function checkAll(): Promise<void> {
  for (const g of getMyGroups()) {
    try {
      await trackGroup(g);
    } catch (err) {
      log.warn({ group: g.name, err: String(err) }, 'could not refresh my group');
    }
  }
}

async function backupAll(): Promise<void> {
  for (const g of getMyGroups()) {
    const last = db.prepare('SELECT taken_at FROM group_backups WHERE group_id = ? ORDER BY taken_at DESC LIMIT 1').get(g.groupId) as { taken_at: string } | undefined;
    if (last && Date.now() - Date.parse(last.taken_at) < BACKUP_EVERY_MS - 60_000) continue;
    try {
      await backupGroup(g);
      log.info({ group: g.name }, 'hourly backup saved');
    } catch (err) {
      log.warn({ group: g.name, err: String(err) }, 'backup failed');
    }
  }
}

/** A join/leave webhook arrived: refresh that group a few seconds later (lets WhatsApp settle, merges bursts). */
const pending = new Map<string, NodeJS.Timeout>();
export function onGroupMembershipEvent(groupId: string): void {
  const g = getMyGroups().find((x) => x.groupId === groupId);
  if (!g) return;
  clearTimeout(pending.get(groupId));
  pending.set(groupId, setTimeout(() => {
    pending.delete(groupId);
    trackGroup(g).catch((err) => log.warn({ err: String(err) }, 'refresh after join/leave failed'));
  }, 4_000));
}

export function startTracker(logger: Log): void {
  log = logger;
  setTimeout(() => void checkAll().then(backupAll), 8_000);
  setInterval(() => void checkAll(), CHECK_EVERY_MS);
  setInterval(() => void backupAll(), 5 * 60_000); // checks every 5 min whether an hour has passed
}
