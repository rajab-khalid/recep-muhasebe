// Tiny global store with a hook. Holds boot data (settings, lookups), the signed-in user, UI prefs.
import { useState, useEffect } from './h.js';
import { getLang } from './i18n.js';
import { dn } from './names.js';

const listeners = new Set();

export const store = {
  state: {
    boot: null,          // /api/bootstrap payload
    user: null,
    displayCurrency: 'IQD',
    sidebarCollapsed: false,
    locked: false,
    notifications: [],
  },
  set(patch) {
    this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch);
    listeners.forEach((fn) => fn(this.state));
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/** re-render when the selected slice changes */
export function useStore(selector = (s) => s) {
  const [val, setVal] = useState(() => selector(store.state));
  useEffect(() => store.subscribe((s) => {
    const next = selector(s);
    setVal((prev) => (Object.is(prev, next) ? prev : next));
  }), []);
  return val;
}

// start-up data with the default names (warehouse, cash boxes, price lists, categories) in the reader's language
const NAMED = ['warehouses', 'price_lists', 'categories', 'money_accounts', 'finance_categories'];
let bootCache = { src: null, lang: null, val: null };
export function boot() {
  const b = store.state.boot;
  if (!b) return {};
  const lang = getLang();
  if (bootCache.src === b && bootCache.lang === lang) return bootCache.val;
  const v = { ...b };
  for (const k of NAMED) if (Array.isArray(b[k])) v[k] = b[k].map((x) => (x && x.name ? { ...x, name: dn(x.name) } : x));
  bootCache = { src: b, lang, val: v };
  return v;
}
export function user() { return store.state.user; }
export function setting(key) { const b = boot(); return (b.settings && b.settings[key]) || {}; }

export function can(perm) {
  const u = store.state.user;
  if (!u || !u.permissions) return false;
  if (u.permissions.includes('*')) return true;
  if (Array.isArray(perm)) return perm.some((p) => u.permissions.includes(p));
  return u.permissions.includes(perm);
}

export function lookup(name, id) {
  const list = boot()[name] || [];
  return list.find((x) => x.id === id) || null;
}

export function prefs(key, def) {
  try { const v = localStorage.getItem(`rm_pref_${key}`); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
}
export function setPrefs(key, val) {
  try { localStorage.setItem(`rm_pref_${key}`, JSON.stringify(val)); } catch (e) { /* ignore */ }
}
