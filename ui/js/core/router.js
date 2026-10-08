// Hash router: #/path/segments?query
import { useState, useEffect } from './h.js';

function parse() {
  const raw = (location.hash || '#/').slice(1) || '/';
  const [path, q] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(q || '').entries());
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: '/' + parts.join('/'), parts, query, raw };
}

let current = parse();
const listeners = new Set();
window.addEventListener('hashchange', () => {
  current = parse();
  listeners.forEach((fn) => fn(current));
});

export function route() { return current; }

export function useRoute() {
  const [r, setR] = useState(current);
  useEffect(() => { listeners.add(setR); return () => listeners.delete(setR); }, []);
  return r;
}

export function navigate(path, query) {
  const q = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const target = '#' + path + (q.length > 1 ? q : '');
  if (location.hash === target) { current = parse(); listeners.forEach((fn) => fn(current)); }
  else location.hash = target;
}

/** replace query params without adding history entries */
export function setQuery(patch) {
  const r = parse();
  const q = Object.assign({}, r.query, patch);
  for (const k of Object.keys(q)) if (q[k] === undefined || q[k] === null || q[k] === '') delete q[k];
  const s = new URLSearchParams(q).toString();
  history.replaceState(null, '', '#' + r.path + (s ? '?' + s : ''));
  current = parse();
  listeners.forEach((fn) => fn(current));
}

export function back(fallback = '/') {
  if (history.length > 1) history.back();
  else navigate(fallback);
}
