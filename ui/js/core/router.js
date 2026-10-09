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
const notify = () => listeners.forEach((fn) => fn(current));

/*
 * The screens visited in this session, newest last, so the Back button knows whether there is a screen of the
 * program to go back to (otherwise it goes to the screen's parent page instead of leaving the program).
 */
const trail = [current.raw];
let goingBack = false;
window.addEventListener('hashchange', () => {
  current = parse();
  if (goingBack || (trail.length > 1 && trail[trail.length - 2] === current.raw)) trail.pop(); // went back (our button or the browser's)
  else trail.push(current.raw);
  if (trail.length > 200) trail.splice(0, trail.length - 200);
  goingBack = false;
  notify();
});

export function route() { return current; }

export function useRoute() {
  const [r, setR] = useState(current);
  useEffect(() => { listeners.add(setR); return () => listeners.delete(setR); }, []);
  return r;
}

/** opts.replace: show the page in place of the current one (e.g. a saved document instead of its empty form) */
export function navigate(path, query, opts = {}) {
  const q = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const target = '#' + path + (q.length > 1 ? q : '');
  if (location.hash === target) { current = parse(); notify(); return; }
  if (opts.replace) {
    history.replaceState(null, '', target);
    current = parse();
    trail[trail.length - 1] = current.raw;
    notify();
    return;
  }
  location.hash = target;
}

/** replace query params without adding history entries */
export function setQuery(patch) {
  const r = parse();
  const q = Object.assign({}, r.query, patch);
  for (const k of Object.keys(q)) if (q[k] === undefined || q[k] === null || q[k] === '') delete q[k];
  const s = new URLSearchParams(q).toString();
  history.replaceState(null, '', '#' + r.path + (s ? '?' + s : ''));
  current = parse();
  trail[trail.length - 1] = current.raw;
  notify();
}

/** is there an earlier screen of the program to go back to? */
export function canGoBack() { return trail.length > 1; }

/** the screen before this one ('/doc/12', '/docs/sale?...'), or null */
export function previous() { return trail.length > 1 ? trail[trail.length - 2] : null; }

/** one screen back; with nothing to go back to, the fallback page (usually the parent list) */
export function back(fallback = '/') {
  if (trail.length > 1) { goingBack = true; history.back(); } else navigate(fallback, null, { replace: true });
}
