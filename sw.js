// Keeps MiDrives working offline. Bump CACHE when you change any file.
const CACHE = 'midrives-v8';
const FILES = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: network first (so updates arrive), cache when offline.
// Weather requests go to another site and are never cached here.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});


// Reminders sent by the MiDrives server
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MiDrives', {
    body: d.body || 'Are you riding today?',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'midrives-' + (d.leg || 'ask'),
    data: { url: './?ask=' + (d.leg || '') }
  }));
});

// Tapping a reminder opens MiDrives on Today
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { c.postMessage({ type: 'ask' }); if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
