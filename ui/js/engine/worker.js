// The phone app's offline engine. Runs in a worker (the screens never wait for it): keeps the phone's copy
// of the shop's data in the phone's own storage, answers the program's API calls from it when the shop
// computer cannot be reached, and sends the work done meanwhile to the computer when it can be reached again.
//
// Storage: SQLite (WebAssembly) on the browser's private file system (OPFS). Phones whose browser lacks it
// keep the copy in IndexedDB instead and write it back after each change.
import sqlite3InitModule from '../../vendor/sqlite/sqlite3.mjs';
import { createCore, writeMeta, readMeta, ensureQueue } from './core.js';

const DB_FILE = '/rm-copy.db';
const IDB_NAME = 'rm-offline';

let sqlite3 = null;
let store = null; // { kind, has(), open(), replace(bytes), persist(raw), remove() }
let raw = null; // the open copy
let core = null;
let engineCache = { hash: null, mod: null };
let lastError = null;

/* one job at a time: the copy is never read while it is being replaced */
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

class WorkerError extends Error {
  constructor(code, message, status = 0, details) { super(message || code); this.code = code; this.status = status; this.details = details; }
}

/* ------------------------------------------------------------------ storage */
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      let value;
      if (req) req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { d.close(); }
}

function memoryDb(bytes) {
  const db = new sqlite3.oo1.DB(':memory:');
  if (bytes && bytes.length) {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length, flags);
    if (rc) { db.close(); throw new WorkerError('copy_broken', `The copy could not be opened (${rc})`); }
  }
  return db;
}

const lockError = (e) => /lock|NoModificationAllowed|InvalidState|access handle/i.test(String(e && `${e.name} ${e.message}`));

async function installPool() {
  // right after a reload the closing page may still hold the files for a moment: try a few times
  for (let i = 0; ; i++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'rm-offline', directory: '.rm-offline', initialCapacity: 4, forceReinitIfPreviouslyFailed: true });
    } catch (e) {
      if (!lockError(e) || i >= 6) throw e;
      await new Promise((r) => { setTimeout(r, 250 * (i + 1)); });
    }
  }
}

async function makeStore() {
  try {
    const pool = await installPool();
    return {
      kind: 'opfs',
      has: () => pool.getFileNames().includes(DB_FILE),
      open: () => new pool.OpfsSAHPoolDb(DB_FILE),
      replace: (bytes) => { pool.importDb(DB_FILE, bytes); },
      persist: () => {},
      remove: () => { pool.unlink(DB_FILE); },
    };
  } catch (e) {
    // the same app open in another window holds the storage, or the browser has no OPFS
    if (lockError(e)) throw new WorkerError('offline_busy', 'The app is open in another window');
    // the copy lives in this window's memory and is written back whole: only one window may use it at a time
    if (navigator.locks && navigator.locks.request) {
      const got = await new Promise((resolve) => {
        navigator.locks.request('rm-offline-idb', { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise(() => {}) : undefined; // held for the life of this worker
        }).catch(() => resolve(true));
      });
      if (!got) throw new WorkerError('offline_busy', 'The app is open in another window');
    }
    let bytes = null;
    return {
      kind: 'idb',
      has: async () => !!(await idbDo('readonly', (s) => s.get('copy'))),
      open: async () => { bytes = await idbDo('readonly', (s) => s.get('copy')); return memoryDb(bytes ? new Uint8Array(bytes) : null); },
      replace: async (b) => { await idbDo('readwrite', (s) => s.put(b, 'copy')); },
      persist: async (db) => { const out = sqlite3.capi.sqlite3_js_db_export(db); await idbDo('readwrite', (s) => s.put(out, 'copy')); },
      remove: async () => { await idbDo('readwrite', (s) => s.delete('copy')); },
    };
  }
}

async function init() {
  if (store) return;
  if (!sqlite3) {
    globalThis.sqlite3ApiConfig = { ...(globalThis.sqlite3ApiConfig || {}), disable: { vfs: { opfs: true } }, warn: () => {}, log: () => {}, debug: () => {} };
    sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  }
  store = await makeStore();
}

/* ------------------------------------------------------------------ the engine (the program's server code) */
async function engineFor(hash) {
  if (engineCache.mod && (!hash || engineCache.hash === hash)) return engineCache.mod;
  const mod = await import(`/phone/engine.js?v=${encodeURIComponent(hash || 'current')}`);
  engineCache = { hash: mod.hash || hash, mod };
  return mod;
}

function closeCopy() {
  core = null;
  if (raw) { try { raw.close(); } catch (e) { /* already closed */ } }
  raw = null;
}

async function openCopy() {
  await init();
  if (core) return core;
  if (!(await store.has())) return null;
  const db = await store.open();
  try {
    ensureQueue(db);
    const meta = readMeta(db);
    let mod;
    // the engine this copy was made with; if the phone cannot get it, the one it has (they stay compatible)
    try { mod = await engineFor(meta.phone_engine); } catch (e) { mod = await engineFor(null); }
    raw = db;
    core = createCore({ engineModule: mod, raw: db, agent: navigator.userAgent });
    return core;
  } catch (e) {
    try { db.close(); } catch (x) { /* */ }
    raw = null;
    throw e;
  }
}

async function persist() { if (raw && store) await store.persist(raw); }

function status() {
  const meta = core ? core.meta : null;
  return {
    storage: store ? store.kind : null,
    hasCopy: !!core,
    pending: core ? core.pendingCount() : 0,
    series: core ? core.series : null,
    owner: core ? core.ownerId : null,
    token: core ? readMeta(raw).phone_token || null : null,
    snapshotAt: core ? readMeta(raw).phone_snapshot_at || null : null,
    version: meta ? meta.phone_version || null : null,
    engineMatch: core ? !meta.phone_engine || !engineCache.hash || meta.phone_engine === engineCache.hash : true,
    size: core && raw ? copySize() : 0,
    error: lastError,
  };
}

function copySize() {
  try { return (raw.selectValue('PRAGMA page_count') || 0) * (raw.selectValue('PRAGMA page_size') || 0); } catch (e) { return 0; }
}

function announce() { try { self.postMessage({ type: 'status', status: status() }); } catch (e) { /* closing */ } }

/* ------------------------------------------------------------------ talking to the shop computer */
async function pc(pathName, { method = 'GET', body, timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(pathName, {
      method, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'recep' } : { 'X-Requested-With': 'recep' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new WorkerError('network', 'The shop computer cannot be reached');
  } finally { clearTimeout(timer); }
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let err = null;
    if (type.includes('application/json')) err = (await res.json().catch(() => ({}))).error;
    if (!err && res.status >= 502 && res.status <= 504) throw new WorkerError('network', 'The shop computer cannot be reached');
    throw new WorkerError((err && err.code) || 'server_error', (err && err.message) || `HTTP ${res.status}`, res.status, err && err.details);
  }
  return res;
}

/**
 * Work still waiting in the stored copy when it is not open (e.g. its engine could not be started): 0, a
 * number, or null when the copy cannot even be read (then it is not replaced either: the work may be in it).
 */
async function storedPending() {
  let db = null;
  try {
    db = await store.open();
    const has = db.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_rm_queue'");
    return has ? Number(db.selectValue('SELECT COUNT(*) FROM _rm_queue')) || 0 : 0;
  } catch (e) {
    return null;
  } finally {
    if (db) { try { db.close(); } catch (e) { /* */ } }
  }
}

/** take a fresh copy from the shop computer (only when the phone has no work left to send) */
async function install({ deviceId, userId }) {
  await init();
  const res = await pc(`/api/phone/snapshot?device=${encodeURIComponent(deviceId)}`, { timeout: 180000 });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const head = (k) => res.headers.get(k);
  const mod = await engineFor(head('X-RM-Engine'));
  await exclusive(async () => {
    if (core && core.pendingCount() > 0) throw new WorkerError('pending_work', 'Work done offline must reach the shop computer first');
    if (!core && (await store.has()) && (await storedPending()) !== 0) {
      throw new WorkerError('pending_work', 'Work done offline must reach the shop computer first');
    }
    // sessions in the copy (the owner may be working from it right now) go over to the new copy
    let sessions = [];
    if (raw) {
      try { sessions = raw.exec({ sql: 'SELECT token, user_id, created_at, last_seen, expires_at, ip, agent, remember FROM sessions', rowMode: 'array', returnValue: 'resultRows' }); } catch (e) { sessions = []; }
    }
    closeCopy();
    await store.replace(bytes);
    const db = await store.open();
    try {
      ensureQueue(db);
      for (const row of sessions) {
        try { db.exec({ sql: 'INSERT OR IGNORE INTO sessions (token, user_id, created_at, last_seen, expires_at, ip, agent, remember) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: row }); } catch (e) { /* user gone from the new copy */ }
      }
      writeMeta(db, {
        phone_series: head('X-RM-Series'), phone_owner: userId, phone_token: head('X-RM-Token'), phone_snapshot_at: new Date().toISOString(),
        phone_version: head('X-RM-Version'), phone_device: deviceId, phone_engine: head('X-RM-Engine'),
      });
      raw = db;
      await store.persist(db);
      core = createCore({ engineModule: mod, raw: db, agent: navigator.userAgent });
    } catch (e) {
      try { db.close(); } catch (x) { /* */ }
      raw = null;
      core = null;
      throw e;
    }
  });
}

/** send the work done offline, oldest first, until none is left (or the computer stops taking it) */
async function push({ deviceId }) {
  const total = { applied: 0, problems: 0 };
  for (let round = 0; round < 100; round++) {
    const ops = await exclusive(async () => (core ? core.pending(50) : []));
    if (!ops.length) break;
    const res = await pc('/api/phone/sync', { method: 'POST', body: { device_id: deviceId, ops }, timeout: 120000 });
    const out = await res.json();
    const r = await exclusive(async () => { const x = core.settle(out.results); await persist(); return x; });
    total.applied += r.applied;
    total.problems += r.problems;
    if (!r.applied && !r.problems) break;
  }
  return total;
}

/** push the work, then take a new copy if the computer's data changed (or when asked to) */
async function sync({ deviceId, userId, refresh = 'auto', maxAge = 0 }) {
  await init();
  // a copy that is there but cannot be opened may hold work not sent yet: never go on and replace it
  if ((await store.has()) && !(await exclusive(openCopy))) throw new WorkerError('offline_failed', 'The copy on the phone could not be opened');
  const pushed = await push({ deviceId });
  const state = await (await pc(`/api/phone/state?device=${encodeURIComponent(deviceId)}`, { timeout: 15000 })).json();
  let refreshed = false;
  const mine = core ? readMeta(raw) : {};
  const engineChanged = !!(mine.phone_engine && mine.phone_engine !== state.engine);
  const changed = !core || mine.phone_token !== state.token || engineChanged;
  // a full copy is taken when the computer's data changed and this copy is old enough (mobile data matters)
  const age = mine.phone_snapshot_at ? Date.now() - Date.parse(mine.phone_snapshot_at) : Infinity;
  if (refresh === 'force' || (refresh === 'auto' && changed && (!core || engineChanged || !(age < maxAge)))) {
    await install({ deviceId, userId });
    refreshed = true;
  }
  return { applied: pushed.applied, failed: pushed.problems, refreshed, problems: state.problems, pending: core ? core.pendingCount() : 0 };
}

async function wipe() {
  await init();
  await exclusive(async () => {
    closeCopy();
    try { await store.remove(); } catch (e) { /* nothing kept */ }
  });
}

/* ------------------------------------------------------------------ messages from the app */
const handlers = {
  async open() { await exclusive(openCopy); return status(); },
  status: async () => status(),
  async request(args) {
    return exclusive(async () => {
      if (!core) await openCopy();
      if (!core) throw new WorkerError('no_copy', 'There is no offline copy on this phone');
      const r = await core.request(args);
      if (args.method && args.method !== 'GET' && r.status === 200) await persist();
      return r;
    });
  },
  async adopt({ userId }) {
    return exclusive(async () => {
      if (!core) await openCopy();
      if (!core) throw new WorkerError('no_copy', 'There is no offline copy on this phone');
      const token = core.adopt(userId);
      await persist();
      return token;
    });
  },
  install: (a) => install(a),
  async push(a) {
    await init();
    if ((await store.has()) && !(await exclusive(openCopy))) throw new WorkerError('offline_failed', 'The copy on the phone could not be opened');
    const r = await push(a);
    return { ...r, pending: core ? core.pendingCount() : 0 };
  },
  sync: (a) => sync(a),
  wipe: () => wipe(),
};

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data || {};
  const fn = handlers[cmd];
  if (!fn) { self.postMessage({ id, ok: false, error: { code: 'bad_command', message: String(cmd) } }); return; }
  try {
    const result = await fn(args || {});
    lastError = null;
    let transfer = [];
    if (result && result.raw && result.raw.bytes) transfer = [result.raw.bytes.buffer];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const error = { code: (err && err.code) || 'server_error', message: (err && err.message) || String(err), status: (err && err.status) || 0, details: err && err.details };
    if (cmd !== 'request') lastError = error;
    self.postMessage({ id, ok: false, error });
  }
  if (cmd !== 'status') announce();
};
