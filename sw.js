// Caches the app's own files so it opens with no connection. It never sees
// statement data: files are read in the page and stored in localStorage.
// It also shows the monthly reminder, from settings the page copies into
// REMIND_CACHE (just the day, hour and when a statement was last loaded).
importScripts('remind.js');

const CACHE = 'statement-check-v8';
const REMIND_CACHE = 'statement-check-remind';
const REMIND_URL = './__remind.json';
const FILES = ['./', 'index.html', 'app.js', 'analyse.js', 'categorise.js', 'pdfstatement.js', 'lock.js', 'remind.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== REMIND_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates arrive when online; cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});

// Chrome wakes installed apps now and then (about twice a day at most, and
// only on a network you've used before). If the reminder has come due and no
// statement has been loaded yet, show it once for that month.
self.addEventListener('periodicsync', (e) => {
  if (e.tag !== 'statement-reminder') return;
  e.waitUntil((async () => {
    const cache = await caches.open(REMIND_CACHE);
    const res = await cache.match(REMIND_URL);
    const r = res ? await res.json() : null;
    const now = Date.now();
    if (!r || !self.REMIND.shouldNotify(r, now)) return;
    await self.registration.showNotification('Time to load your bank statement', {
      body: "Download this month's statement from your bank, then open Statement Check to load it.",
      icon: 'icon-192.png',
      tag: 'statement-reminder',
    });
    r.notified = self.REMIND.monthKey(self.REMIND.lastDue(r, now));
    await cache.put(REMIND_URL, new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === location.origin);
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
