// App-shell cache for installability + faster repeat loads. Deliberately does
// NOT cache /socket.io/ traffic or API responses — this app is real-time and
// server-state-driven, so stale game data would be worse than no cache.
const CACHE_NAME = 'shorot-shell-v2';
const SHELL_URLS = ['/', '/index.html', '/style.css', '/js/main.js', '/manifest.webmanifest'];

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

  // Stale-while-revalidate: serve cached shell instantly, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
