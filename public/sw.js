// App-shell cache for installability + faster repeat loads. Deliberately does
// NOT cache /socket.io/ traffic or API responses — this app is real-time and
// server-state-driven, so stale game data would be worse than no cache.
const CACHE_NAME = 'shorot-shell-v5';
const SHELL_URLS = ['/', '/index.html', '/style.css', '/theme-afterglow.css', '/js/main.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io/')) return;
  // Per-player account data must never be served stale from the cache.
  if (url.pathname === '/api/me' || url.pathname.startsWith('/api/auth/')) return;

  // `no-cache` makes even this network fetch skip any copy the browser's HTTP cache still
  // thinks is fresh (it revalidates with the server instead). Navigations can't take
  // fetch options in older browsers, and get `no-cache` headers from the server anyway.
  const fromNetwork = () =>
    fetch(request, request.mode === 'navigate' ? undefined : { cache: 'no-cache' }).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    });

  // Images and fonts rarely change: stale-while-revalidate, serve cached instantly.
  if (/^\/(images|icons|fonts|backgrounds)\//.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fromNetwork().catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Code, pages and API: network-first so a deploy takes effect on the next load
  // (stale-while-revalidate kept serving old JS for a load after every deploy).
  // The cache is only an offline fallback.
  event.respondWith(fromNetwork().catch(() => caches.match(request).then((r) => r || Response.error())));
});
