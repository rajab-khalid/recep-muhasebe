/*
 * Phone app helper (service worker). Everything is asked from the shop computer, so the phone always shows
 * exactly what the computer has. Only a small "cannot reach the shop computer" page is kept on the phone: it
 * is shown when the computer cannot be reached, and it retries by itself.
 * Business data (/api/) never passes through here and is never stored on the phone.
 */
const CACHE = 'rm-ui-v2';
const OFFLINE = '/offline.html';
const KEEP = [OFFLINE, '/js/offline.js', '/img/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(KEEP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const kept = KEEP.includes(url.pathname);
  event.respondWith(fetch(req).then(async (res) => {
    // the program is closed on the shop computer: Tailscale answers "bad gateway" for it
    if (res.status >= 502 && res.status <= 504) {
      if (req.mode === 'navigate') return (await caches.match(OFFLINE)) || res;
      if (kept) return (await caches.match(req)) || res; // the offline page's own script and picture
    }
    return res;
  }, async (err) => {
    const hit = await caches.match(req.mode === 'navigate' ? OFFLINE : req);
    if (hit) return hit;
    throw err;
  }));
});
