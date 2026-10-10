'use strict';

// Caches the app shell so it opens instantly and installs as an app.
// Plans themselves always come live from the server.
const CACHE = 'rieger-house-v2';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isFont) return;

  if (req.mode === 'navigate') {
    // Network first, so updates show up straight away.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }

  // Stale-while-revalidate for everything else.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req);
    const fresh = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
