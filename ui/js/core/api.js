// JSON API client. Errors become ApiError with a translated message when the server code is known.
import { t, has } from './i18n.js';
import { store } from './store.js';
import { dn } from './names.js';

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

async function request(method, path, body, query) {
  let res;
  try {
    res = await fetch(path + qs(query), {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'recep' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
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
    const key = `err.${e.code}`;
    const msg = has(key) ? t(key, e.details || {}) : (e.message || t('err.generic'));
    throw new ApiError(res.status, e.code || 'error', msg, e.details);
  }
  return method === 'GET' && path !== '/api/bootstrap' ? localizeNames(data, NAMED_LISTS.test(path)) : data;
}

export const api = {
  get: (path, query) => request('GET', path, undefined, query),
  post: (path, body) => request('POST', path, body || {}),
  del: (path) => request('DELETE', path, {}),
  /** download a binary endpoint as a file */
  async download(path, filename) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'download', t('err.generic'));
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  },
};
