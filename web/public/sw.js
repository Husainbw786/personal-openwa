// Opens the app instantly from cache, like an installed app, and updates it in the background.
//
// - The page (index.html) is served from cache right away. Meanwhile we fetch the latest one;
//   if it points at new files, we download all of them first and only then swap the cached page,
//   so the cached page always has every file it needs. The open app is told an update is ready.
// - Built files under /assets/ have a hash in their name, so they never change: cache forever.
// - /api/ and /hooks/ always go to the network. The app keeps its own copy of the last data.

const SHELL = 'shell-v1';
const ASSETS = 'assets-v1';
const PAGE = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== ASSETS) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'check-update') event.waitUntil(checkForUpdate());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/') || url.pathname === '/healthz') return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match(PAGE, { cacheName: SHELL });
      if (cached) {
        event.waitUntil(checkForUpdate());
        return cached;
      }
      try {
        const res = await fetch(req);
        event.waitUntil(refreshShell().catch(() => {}));
        return res;
      } catch {
        return new Response('You are offline. Open the app again when you have internet.', { headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSETS));
    return;
  }

  // Icons, manifest: show the cached copy, refresh it for next time.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
    return cached ?? fresh;
  })());
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/** Files the page needs: its scripts, styles and preloads. */
function assetsIn(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
}

/** Download the latest page and everything it references; swap it in only when all of it is cached. */
async function refreshShell() {
  const res = await fetch(PAGE, { cache: 'no-cache' });
  if (!res.ok) return false;
  const html = await res.clone().text();
  const shell = await caches.open(SHELL);
  const before = await shell.match(PAGE);
  const beforeHtml = before ? await before.text() : null;
  if (beforeHtml === html) return false;

  const assets = await caches.open(ASSETS);
  const needed = assetsIn(html);
  await Promise.all(needed.map(async (path) => {
    if (await assets.match(path)) return;
    const r = await fetch(path);
    if (!r.ok) throw new Error(`could not fetch ${path}`);
    await assets.put(path, r);
  }));
  await shell.put(PAGE, res);

  // Keep only the files the current page uses (plus the previous one's, still open in a tab).
  const keep = new Set([...needed, ...(beforeHtml ? assetsIn(beforeHtml) : [])].map((p) => new URL(p, self.location.origin).href));
  for (const req of await assets.keys()) if (!keep.has(req.url)) await assets.delete(req);
  return beforeHtml !== null;
}

let checking = null;
function checkForUpdate() {
  checking ??= refreshShell()
    .then(async (updated) => {
      if (!updated) return;
      for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage('update-ready');
    })
    .catch(() => {})
    .finally(() => { checking = null; });
  return checking;
}
