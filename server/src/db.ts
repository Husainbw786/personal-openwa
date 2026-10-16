import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    fallback   TEXT NOT NULL DEFAULT 'there',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per (template, phone). The UNIQUE constraint is what guarantees
  -- "never send the same template twice to the same person".
  CREATE TABLE IF NOT EXISTS sends (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id),
    phone       TEXT NOT NULL,
    name        TEXT,
    group_id    TEXT,
    group_name  TEXT,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | delivered | read | failed | cancelled
    message_id  TEXT,
    text        TEXT,
    error       TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at     TEXT,
    sent_day    TEXT,
    UNIQUE (template_id, phone)
  );
  CREATE INDEX IF NOT EXISTS sends_status ON sends(status, id);
  CREATE INDEX IF NOT EXISTS sends_message ON sends(message_id);
  CREATE INDEX IF NOT EXISTS sends_day ON sends(sent_day);

  CREATE TABLE IF NOT EXISTS excluded (
    phone      TEXT PRIMARY KEY,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_names (
    phone TEXT PRIMARY KEY,
    name  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorite_groups (
    group_id TEXT PRIMARY KEY,
    name     TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Calendar day (YYYY-MM-DD) in the app's timezone, used for the daily cap. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}
