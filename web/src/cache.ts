/**
 * Last-seen API data, kept on the phone so screens open instantly (like WhatsApp showing your
 * chats before it reconnects) and then refresh. Cleared on logout.
 */
const PREFIX = 'wa-cache:';
const MAX_CHARS = 1_500_000; // skip very large entries (localStorage holds ~5 MB in total)

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCache(key: string, value: unknown): void {
  try {
    const raw = JSON.stringify(value);
    if (raw.length > MAX_CHARS) return;
    localStorage.setItem(PREFIX + key, raw);
  } catch {
    // Storage full or blocked: drop older entries once and give up quietly.
    try { clearCache(); } catch { /* ignore */ }
  }
}

export function clearCache(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* ignore */ }
}
