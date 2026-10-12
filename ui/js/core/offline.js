// The phone's offline copy (the engine itself is in engine/worker.js). When the shop computer cannot be
// reached, the program keeps working from the copy on the phone: every screen reads from it, and the work
// done is kept in order. As soon as the computer answers again, that work is sent to it and the phone takes
// a fresh copy. While the computer can be reached, the copy is refreshed in the background.
import { store } from './store.js';

const CFG_KEY = 'rm_offline'; // { on, deviceId, ownerId, ownerName }
const TOKEN_KEY = 'rm_local_token'; // the session in the copy (this window only)
const PROBLEMS_KEY = 'rm_offline_problems';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return c && typeof c === 'object' && ID_RE.test(String(c.deviceId || '')) ? c : null;
  } catch (e) { return null; }
}
function writeCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) { /* storage blocked */ } }

export function newOpId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** can this browser keep a copy? (the phone app over its secure address; not the desktop program) */
export function offlineSupported() {
  return !window.desktop && window.isSecureContext && typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined' && !!navigator.storage;
}
/** only the owner (admin) may keep the shop's data on a phone */
export function isOwner(user) { return !!(user && Array.isArray(user.permissions) && user.permissions.includes('*')); }
export function offlineConfig() { return readCfg(); }
/** this phone keeps a copy, and it is this user's */
export function offlineFor(user) { const c = readCfg(); return !!(c && c.on && user && c.ownerId === user.id); }

/* ------------------------------------------------------------------ the worker */
let worker = null;
let seq = 0;
const calls = new Map();
function setState(patch) { store.set((s) => ({ offline: { ...(s.offline || {}), ...patch } })); }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/js/engine/worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'status') { setState({ copy: d.status }); return; }
    const c = calls.get(d.id);
    if (!c) return;
    calls.delete(d.id);
    if (d.ok) c.resolve(d.result);
    else c.reject(Object.assign(new Error(d.error.message), d.error));
  };
  worker.onerror = (e) => {
    // the browser could not start it (too old): no offline work on this phone
    if (e && e.preventDefault) e.preventDefault();
    for (const [id, c] of calls) { calls.delete(id); c.reject(Object.assign(new Error('offline_unsupported'), { code: 'offline_unsupported' })); }
    worker = null;
    setState({ error: { code: 'offline_unsupported' } });
  };
  return worker;
}
function rpc(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject });
    try { ensureWorker().postMessage({ id, cmd, args }); } catch (e) { calls.delete(id); reject(e); }
  });
}

/* ------------------------------------------------------------------ the shop computer */
/** does the shop computer answer? (Tailscale answers "bad gateway" for a closed program) */
export async function reachable(ms = 3000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch('/api/ping', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && j.ok);
  } catch (e) { return false; } finally { clearTimeout(tm); }
}

async function pcJson(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'recep' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((j && j.error && j.error.message) || `HTTP ${r.status}`), { code: (j && j.error && j.error.code) || (r.status >= 502 ? 'network' : 'server_error'), status: r.status, details: j && j.error && j.error.details });
  return j;
}

function deviceName() {
  const u = navigator.userAgent;
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : '';
  const app = /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : /Firefox\//.test(u) ? 'Firefox' : '';
  return [os, app].filter(Boolean).join(' · ') || 'Telefon';
}

function cachedProblems() { try { return JSON.parse(localStorage.getItem(PROBLEMS_KEY) || '[]'); } catch (e) { return []; } }

/* ------------------------------------------------------------------ the mode and its changes */
let watchTimer = null;
let lastRefresh = 0;
let reconnecting = false;

export const offline = {
  mode: 'online',
  isOffline() { return this.mode === 'offline'; },
  token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
  setToken(tk) { try { if (tk) sessionStorage.setItem(TOKEN_KEY, tk); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ } },

  /** one API call answered by the copy: { status, data } | { status, error } | { status, raw } */
  async request({ method, path, body, query, opId }) {
    const r = await rpc('request', { method, path, body, query, token: this.token(), opId });
    if (r && r.session !== undefined) this.setToken(r.session);
    return r;
  },

  /**
   * open the copy and work from it (start-up without the shop computer). adoptUser: the user already signed in
   * (the connection dropped while working): gets a session in the copy before any screen asks the copy.
   */
  async enter(adoptUser) {
    const cfg = readCfg();
    if (!cfg || !cfg.on || !offlineSupported()) return false;
    try {
      const st = await rpc('open');
      if (!st || !st.hasCopy) return false;
      if (adoptUser) this.setToken(await rpc('adopt', { userId: adoptUser.id }));
      this.mode = 'offline';
      setState({ mode: 'offline', copy: st, problems: cachedProblems() });
      this.watch();
      return true;
    } catch (e) {
      setState({ error: { code: e.code || 'offline_failed', message: e.message } });
      return false;
    }
  },

  /** the shop computer stopped answering in the middle of work: carry on from the copy, as the same user */
  takeOver({ checked = false } = {}) {
    if (this.mode === 'offline') return Promise.resolve(true);
    // several screens may notice at once: they all wait for the same switch
    if (!this._taking) this._taking = this._takeOver(checked).finally(() => { this._taking = null; });
    return this._taking;
  },
  async _takeOver(checked) {
    const user = store.state.user;
    const cfg = readCfg();
    if (!cfg || !cfg.on || (user && cfg.ownerId !== user.id)) return false;
    // a slow answer is not a switched-off computer: only carry on from the copy when it really does not answer
    if (!checked && (await reachable(3000))) return false;
    if (!(await this.enter(user))) return false;
    window.dispatchEvent(new CustomEvent('rm-offline', { detail: { mode: 'offline' } }));
    return true;
  },

  /**
   * check the computer now and then: offline, send the kept work as soon as it answers; online, keep the copy
   * fresh (a new copy only when the data changed and the copy is a quarter of an hour old, or two minutes
   * when the app comes back to the front: that is often just before the owner leaves the shop)
   */
  watch() {
    clearTimeout(watchTimer);
    const tick = async (maxAge = 15 * 60000) => {
      if (!document.hidden) {
        if (this.mode === 'offline') await this.reconnect();
        else await this.refresh({ maxAge });
      }
      watchTimer = setTimeout(tick, this.mode === 'offline' ? 20000 : 5 * 60000);
    };
    watchTimer = setTimeout(tick, this.mode === 'offline' ? 4000 : 5 * 60000);
    if (!this._vis) {
      this._vis = () => { if (!document.hidden) { clearTimeout(watchTimer); watchTimer = setTimeout(() => tick(2 * 60000), 1500); } };
      document.addEventListener('visibilitychange', this._vis);
      window.addEventListener('online', this._vis);
    }
  },

  /** offline: is the computer back? then send the work, take a fresh copy and work online again */
  async reconnect({ manual = false } = {}) {
    if (this.mode !== 'offline' || reconnecting) return false;
    reconnecting = true;
    try {
      if (!(await reachable(manual ? 6000 : 4000))) { if (manual) setState({ error: { code: 'network' } }); return false; }
      const cfg = readCfg();
      let me = null;
      try { me = (await pcJson('/api/auth/me')).user; } catch (e) { return false; }
      // the computer's own sign-in ran out: the owner signs in to it again, then the work is sent
      if (!me || !cfg || me.id !== cfg.ownerId) { setState({ needLogin: true }); return false; }
      setState({ syncing: true, needLogin: false, error: null });
      // first the kept work; then the screens go back to the computer, and the fresh copy follows in the
      // background (never replaced under a screen that is still reading from it)
      const r = await rpc('push', { deviceId: cfg.deviceId });
      setState({ lastSync: Date.now(), lastResult: r });
      if (r.pending) return false;
      this.goOnline();
      this.loadProblems().catch(() => {});
      lastRefresh = 0;
      this.refresh({ maxAge: 0 }).catch(() => {});
      return true;
    } catch (e) {
      if (e.code === 'device_revoked') { await this.revoked(); this.goOnline(); return false; }
      setState({ error: { code: e.code || 'sync_failed', message: e.message } });
      return false;
    } finally {
      reconnecting = false;
      setState({ syncing: false });
    }
  },

  /** from now on the screens talk to the shop computer again */
  goOnline() {
    this.mode = 'online';
    this.setToken(null);
    setState({ mode: 'online', needLogin: false });
    window.dispatchEvent(new CustomEvent('rm-offline', { detail: { mode: 'online' } }));
    this.watch();
  },

  /** the computer answers but its sign-in ran out: show its sign-in screen; the kept work goes after it */
  signInOnline() {
    this.mode = 'online';
    this.setToken(null);
    this._startedFor = null;
    setState({ mode: 'online', needLogin: false });
    store.set({ user: null, boot: null });
  },

  /** online: send anything left over and take a new copy when the computer's data changed (see watch) */
  async refresh({ force = false, maxAge = 15 * 60000 } = {}) {
    const user = store.state.user;
    if (this.mode !== 'online' || !offlineFor(user)) return null;
    if (!force && Date.now() - lastRefresh < 60000) return null;
    const cfg = readCfg();
    lastRefresh = Date.now();
    setState({ syncing: true });
    try {
      const r = await rpc('sync', { deviceId: cfg.deviceId, userId: user.id, refresh: force ? 'force' : 'auto', maxAge });
      setState({ lastSync: Date.now(), lastResult: r, error: null });
      await this.loadProblems().catch(() => {});
      return r;
    } catch (e) {
      if (e.code === 'device_revoked') await this.revoked();
      // the computer went away meanwhile: the next screen that asks it carries on from the copy
      else if (e.code !== 'network') setState({ error: { code: e.code || 'sync_failed', message: e.message } });
      if (force) throw e;
      return null;
    } finally { setState({ syncing: false }); }
  },

  /**
   * the owner removed this phone on the shop computer (e.g. it was lost): offline work stops and the copy
   * goes, unless it still holds work not sent: then it stays until offline work is switched on again (which
   * registers the phone anew and sends that work first)
   */
  async revoked() {
    // open the copy first (a worker that has just started has not opened it, and would count no work in it):
    // only a copy known to hold no work goes; one that still holds work, or cannot be read, stays
    const st = await rpc('open').catch(() => null);
    const keep = !st || st.pending > 0;
    if (!keep) { try { await rpc('wipe'); } catch (e) { /* nothing kept */ } }
    const cfg = readCfg();
    if (cfg) writeCfg({ ...cfg, on: false, deviceId: newOpId(), code: null });
    this.setToken(null);
    setState({ copy: keep && st ? st : null, problems: [], error: { code: 'device_revoked' } });
  },

  /**
   * At the sign-in screen: a phone removed on the shop computer (lost) was signed out too, so it cannot learn
   * that through a session. It asks the computer directly and, if removed, drops its copy (see revoked).
   */
  async checkRemoved() {
    const cfg = readCfg();
    if (!cfg || !cfg.on || !cfg.deviceId || this.mode === 'offline') return false;
    let r = null;
    try { r = await pcJson(`/api/phone/removed?device=${encodeURIComponent(cfg.deviceId)}`); } catch (e) { return false; }
    if (!r || !r.removed) return false;
    await this.revoked();
    return true;
  },

  /** switch offline work on for this phone: it gets its number series and a first copy */
  async enable() {
    const user = store.state.user;
    if (!isOwner(user)) throw Object.assign(new Error('offline_owner_only'), { code: 'offline_owner_only' });
    const old = readCfg();
    let deviceId = (old && old.deviceId) || newOpId();
    const register = (id) => pcJson('/api/phone/register', { method: 'POST', body: { device_id: id, name: deviceName() } });
    let reg;
    try {
      reg = await register(deviceId);
    } catch (e) {
      // this phone was removed on the shop computer while its offline work was off: it starts under a new id
      // (work still kept in its copy is sent first all the same, by the refresh below)
      if (e.code !== 'device_revoked') throw e;
      deviceId = newOpId();
      reg = await register(deviceId);
    }
    writeCfg({ on: true, deviceId, ownerId: user.id, ownerName: user.full_name, code: reg.code });
    // ask the browser to keep the copy even when the phone runs short of space
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* the browser decides */ }
    try {
      await this.refresh({ force: true });
    } catch (e) {
      writeCfg({ on: false, deviceId, ownerId: user.id, ownerName: user.full_name, code: reg.code }); // no copy: stays off
      throw e;
    }
    this.watch();
    return reg.code;
  },

  /** switch it off and remove the copy (refused while work is still waiting, unless forced) */
  async disable({ force = false } = {}) {
    const st = await rpc('status').catch(() => null);
    if (st && st.pending > 0 && !force) throw Object.assign(new Error('pending_work'), { code: 'pending_work', details: { n: st.pending } });
    await rpc('wipe');
    const cfg = readCfg();
    if (cfg) writeCfg({ ...cfg, on: false });
    this.setToken(null);
    try { localStorage.removeItem(PROBLEMS_KEY); } catch (e) { /* */ }
    setState({ copy: null, problems: [], lastResult: null });
  },

  async status() { return rpc('status'); },

  /** work the computer could not apply (from the computer; kept on the phone to show offline too) */
  async loadProblems() {
    const cfg = readCfg();
    if (!cfg) return [];
    const list = await pcJson(`/api/phone/problems?device=${encodeURIComponent(cfg.deviceId)}`);
    try { localStorage.setItem(PROBLEMS_KEY, JSON.stringify(list)); } catch (e) { /* */ }
    setState({ problems: list });
    return list;
  },
  async retryProblem(id, force) { const r = await pcJson(`/api/phone/problems/${id}/retry`, { method: 'POST', body: { force: !!force } }); await this.loadProblems(); return r; },
  async dismissProblem(id) { await pcJson(`/api/phone/problems/${id}/dismiss`, { method: 'POST', body: {} }); await this.loadProblems(); },

  /** after signing in online: start keeping the copy fresh (and send any work left from offline) */
  started(user) {
    if (!offlineFor(user) || this._startedFor === user.id) return; // once per sign-in, not at every reload of settings
    this._startedFor = user.id;
    setState({ problems: cachedProblems() });
    lastRefresh = 0;
    this.watch();
    setTimeout(() => { this.refresh({ maxAge: 0 }).catch(() => {}); }, 3000);
  },
};
