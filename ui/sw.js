/*
 * Phone app helper (service worker).
 *  - Keeps a full set of the program's own files on the phone, made from the list the shop computer gives
 *    (/app-files.json), so the app opens even when the computer cannot be reached. The data then comes from
 *    the phone's offline copy, if the owner switched it on (js/core/offline.js); otherwise a page that waits
 *    for the computer is shown.
 *  - While the computer answers, the files come from it, so the phone always runs the newest program; the
 *    kept set is used only when it does not answer.
 *  - Pictures (logo, product photos) seen once are kept as well.
 *  - Business data (/api/) never passes through here.
 */
const SHELL_PREFIX = 'rm-shell-';
const META = 'rm-meta';
const PAGE = 'rm-offline-page';
const PICTURES = 'rm-files';
const OFFLINE = '/offline.html';
const PAGE_FILES = [OFFLINE, '/js/offline.js', '/img/icon.svg'];
const NAV_WAIT = 3000; // how long a page waits for the computer before the kept files are used
const FILE_WAIT = 5000;
let downUntil = 0; // after the computer did not answer, use the kept files for a while without waiting again

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGE).then((c) => c.addAll(PAGE_FILES)).catch(() => null)
    .then(() => precache().catch(() => null))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanup().then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache') event.waitUntil(precache().catch(() => null));
});

async function currentName() {
  const r = await (await caches.open(META)).match('/__rm/current');
  return r ? r.text() : null;
}

let running = null;
/** take the program's files listed by the computer (only when they changed); used once complete */
function precache() {
  if (!running) running = takeFiles().finally(() => { running = null; });
  return running;
}
async function takeFiles() {
  const res = await fetch('/app-files.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('file list');
  const list = await res.json();
  if (!list || !/^[0-9a-f]{8,64}$/.test(String(list.hash)) || !Array.isArray(list.files)) throw new Error('file list');
  const name = SHELL_PREFIX + list.hash;
  if ((await currentName()) === name) return name;
  const cache = await caches.open(name);
  const files = list.files.filter((f) => typeof f === 'string' && f.startsWith('/') && !f.startsWith('//'));
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(files.slice(i, i + 6).map(async (f) => {
      if (await cache.match(f)) return; // left from an earlier try
      const r = await fetch(f, { cache: 'no-cache' });
      if (!r.ok) throw new Error(f);
      await cache.put(f, r);
    }));
  }
  await (await caches.open(META)).put('/__rm/current', new Response(name));
  await cleanup();
  return name;
}

async function cleanup() {
  const cur = await currentName();
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => (k.startsWith(SHELL_PREFIX) && k !== cur) || k === 'rm-ui-v2').map((k) => caches.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/files/')) { event.respondWith(picture(req)); return; }
  if (url.pathname.startsWith('/api/') || url.pathname === '/app-files.json' || url.pathname === '/sw.js') return;
  event.respondWith(shell(req, url));
});

async function kept(req, url) {
  const name = await currentName();
  if (name) {
    const cache = await caches.open(name);
    const hit = (await cache.match(url.pathname === '/' ? '/index.html' : url.pathname)) || (req.mode === 'navigate' ? await cache.match('/index.html') : null);
    if (hit) return hit;
  }
  return caches.match(url.pathname); // the waiting page's own files
}

function wait(ms) { return new Promise((resolve, reject) => { setTimeout(() => reject(new Error('timeout')), ms); }); }

async function shell(req, url) {
  const nav = req.mode === 'navigate';
  if (Date.now() < downUntil) {
    const k = await kept(req, url);
    if (k) return k;
  }
  try {
    const res = await Promise.race([fetch(req), wait(nav ? NAV_WAIT : FILE_WAIT)]);
    // the program is closed on the shop computer: Tailscale answers "bad gateway" for it
    if (res.status >= 502 && res.status <= 504) throw new Error('bad gateway');
    return res;
  } catch (e) {
    downUntil = Date.now() + 15000;
    const k = await kept(req, url);
    if (k) return k;
    if (nav) { const off = await caches.match(OFFLINE); if (off) return off; }
    return Response.error();
  }
}

async function picture(req) {
  const cache = await caches.open(PICTURES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && /^image\//.test(res.headers.get('content-type') || '')) {
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      if (keys.length > 400) await Promise.all(keys.slice(0, keys.length - 400).map((k) => cache.delete(k)));
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}
