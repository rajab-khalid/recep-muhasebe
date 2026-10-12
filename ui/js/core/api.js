// JSON API client. Errors become ApiError with a translated message when the server code is known.
import { t, has } from './i18n.js';
import { store } from './store.js';
import { dn } from './names.js';
import { offline, offlineFor, offlineConfig, newOpId, reachable } from './offline.js';

/*
 * Default names created at setup (cash boxes, warehouse, price lists, categories, roles, the walk-in customer,
 * the "pcs" unit) come back from the server in the setup language; show them in the reader's language.
 * Only these name fields are touched — product and customer names stay exactly as typed.
 */
const NAME_FIELDS = new Set(['account_name', 'warehouse_name', 'to_warehouse_name', 'price_list_name', 'category_name', 'role_name', 'partner_name', 'unit', 'product_unit', 'from_account_name', 'to_account_name', 'finance_category_name']);
const NAMED_LISTS = /^\/api\/(money\/accounts|warehouses|price-lists|categories|finance\/categories|roles)(\/|$|\?)/;
function localizeNames(x, nameToo, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 6) return x;
  if (Array.isArray(x)) { for (const v of x) localizeNames(v, nameToo, depth + 1); return x; }
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (typeof v === 'string') { if (NAME_FIELDS.has(k) || (nameToo && depth <= 1 && k === 'name')) x[k] = dn(v); } else if (v && typeof v === 'object') localizeNames(v, nameToo, depth + 1);
  }
  return x;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function qs(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function errorOf(status, e) {
  const key = `err.${e.code}`;
  const msg = has(key) ? t(key, e.details || {}) : (e.message || t('err.generic'));
  return new ApiError(status, e.code || 'error', msg, e.details);
}

/*
 * The phone's offline copy answers instead of the shop computer (see offline.js). The call is shaped as it
 * would travel to the computer (query values as text, the body as JSON), so the program's code sees the same.
 */
async function local(method, path, body, query, opId) {
  const [pathName, inline] = String(path).split('?');
  const q = {};
  for (const [k, v] of new URLSearchParams(inline || '')) q[k] = v;
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') q[k] = String(v);
  let r;
  try {
    r = await offline.request({ method, path: pathName, query: q, body: body === undefined ? {} : JSON.parse(JSON.stringify(body)), opId });
  } catch (e) {
    throw errorOf(0, { code: e.code || 'offline_failed', message: e.message });
  }
  if (r.raw) return new Response(new Blob([r.raw.bytes], { type: r.raw.type }), { headers: { 'Content-Type': r.raw.type } });
  if (r.error) {
    if (r.status === 401 && r.error.code === 'unauthorized' && store.state.user) store.set({ user: null });
    throw errorOf(r.status, r.error);
  }
  return method === 'GET' && pathName !== '/api/bootstrap' ? localizeNames(r.data, NAMED_LISTS.test(pathName)) : r.data;
}

async function request(method, path, body, query) {
  if (offline.isOffline()) return local(method, path, body, query);
  const keeps = offlineFor(store.state.user);
  // a write from a phone that keeps a copy carries its own id: sent again after a lost answer (or done on the
  // copy and sent later), the shop computer recognises it and never applies it twice
  const cfg = method !== 'GET' && keeps && !/^\/api\/(auth|phone|setup)\//.test(path) ? offlineConfig() : null;
  const opId = cfg ? newOpId() : null;
  // a phone that keeps a copy names itself when signing in: removing it on the shop computer signs it out
  const device = method === 'POST' && path === '/api/auth/login' ? (offlineConfig() || {}).deviceId || null : null;
  /*
   * A switched-off shop computer may not answer at all (the request would hang for a minute). For a read, a
   * phone with a copy checks after a while whether the computer still answers: a slow answer is waited for;
   * a computer that does not answer twice in a row is given up on, and the screen reads from the copy.
   * Writes are never given up on halfway: the computer may be in the middle of doing them.
   */
  const ctl = keeps && method === 'GET' ? new AbortController() : null;
  let watchdog = null;
  let gaveUp = false;
  let done = false;
  if (ctl) {
    const check = async (misses = 0) => {
      if (done) return;
      const up = await reachable(5000);
      if (done) return;
      if (up) { watchdog = setTimeout(check, 10000); return; }
      if (misses < 1) { watchdog = setTimeout(() => check(misses + 1), 2000); return; }
      gaveUp = true;
      ctl.abort();
    };
    watchdog = setTimeout(check, 8000);
  }
  const send = () => fetch(path + qs(query), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'recep', ...(opId ? { 'X-Op-Id': opId, 'X-Device-Id': cfg.deviceId } : {}), ...(device ? { 'X-Device-Id': device } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal: ctl ? ctl.signal : undefined,
  });
  let res = null;
  try {
    res = await send();
  } catch (e) {
    // a write whose answer did not come: if the computer still answers, ask it again with the same id
    if (opId && (await reachable(5000))) { try { res = await send(); } catch (e2) { res = null; } }
    if (!res) {
      if (await offline.takeOver({ checked: gaveUp || !!opId })) return local(method, path, body, query, opId);
      throw new ApiError(0, 'network', t('err.network'));
    }
  } finally { done = true; clearTimeout(watchdog); }
  // the shop computer is off or the program is closed: the phone's secure address answers for it
  if (res.status >= 502 && res.status <= 504 && !(res.headers.get('content-type') || '').includes('application/json')) {
    if (await offline.takeOver()) return local(method, path, body, query, opId);
    throw new ApiError(0, 'network', t('err.network'));
  }
  const type = res.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) data = await res.json().catch(() => null);
  else if (!res.ok) data = { error: { code: 'server_error', message: await res.text() } };
  else return res;
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && e.code === 'unauthorized' && store.state.user) store.set({ user: null });
    throw errorOf(res.status, e);
  }
  return method === 'GET' && path !== '/api/bootstrap' ? localizeNames(data, NAMED_LISTS.test(path)) : data;
}

export const api = {
  get: (path, query) => request('GET', path, undefined, query),
  post: (path, body) => request('POST', path, body || {}),
  del: (path) => request('DELETE', path, {}),
  /** download a binary endpoint as a file */
  async download(path, filename) {
    let res;
    if (offline.isOffline()) res = await local('GET', path);
    else {
      try { res = await fetch(path, { credentials: 'same-origin' }); } catch (e) { res = null; }
      if ((!res || (res.status >= 502 && res.status <= 504)) && await offline.takeOver()) res = await local('GET', path);
      if (!res) throw new ApiError(0, 'network', t('err.network'));
    }
    if (!(res instanceof Response) || !res.ok) throw new ApiError(res && res.status, 'download', t('err.generic'));
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  },
};
