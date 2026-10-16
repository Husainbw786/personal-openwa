// Minimal service worker so Chrome offers "Install app". Always goes to the network:
// this app shows live data, so we never serve stale API responses from a cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => new Response('You are offline.', { headers: { 'Content-Type': 'text/plain' } })));
  }
});
