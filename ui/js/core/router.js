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

/*
 * A phone's Back button closes the open sheet (dialog, menu, camera) instead of leaving the screen: each open
 * sheet adds a history entry with the same address. A sheet closed by its own buttons takes its entry back.
 * Going back in the history finishes a moment later, so screen changes and new sheets asked for meanwhile
 * wait for it (otherwise that Back would undo them).
 */
let trapSeq = 0;
const traps = []; // open sheets, newest last: { id, close }
const inflight = []; // our own history.back() calls on their way
const waiting = []; // history changes waiting for them
const trapsWanted = () => !window.desktop && window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
function runWaiting() { while (!inflight.length && waiting.length) waiting.shift()(); }
function ourBack() {
  const tok = {};
  inflight.push(tok);
  history.back();
  // nothing to go back to after all (should not happen): do not keep the waiting changes forever
  setTimeout(() => { const i = inflight.indexOf(tok); if (i >= 0) { inflight.splice(i, 1); runWaiting(); } }, 1500);
}
/** true when fn had to wait (it runs later, in order) */
function whenFree(fn) { if (inflight.length || waiting.length) { waiting.push(fn); return true; } return false; }
window.addEventListener('popstate', () => {
  if (inflight.length) {
    inflight.shift();
    setTimeout(runWaiting, 0); // after the address change of this step has been handled
    return;
  }
  const top = traps.pop();
  if (top) { top.close(); return; }
  // arrived on an entry left by a sheet that closed while another screen opened: it repeats the screen below
  if (history.state && history.state.rmTrap) ourBack();
});

/** the phone's Back closes this sheet; returns the release function to call when the sheet closes */
export function trapBack(close) {
  if (!trapsWanted()) return () => {};
  const id = ++trapSeq;
  traps.push({ id, close });
  const push = () => { if (traps.some((x) => x.id === id)) history.pushState({ rmTrap: id }, '', location.href); };
  if (!whenFree(push)) push();
  return () => {
    const i = traps.findIndex((x) => x.id === id);
    if (i < 0) return; // closed by Back: its entry is gone already
    traps.splice(i, 1);
    const take = () => { if (history.state && history.state.rmTrap === id) ourBack(); };
    if (!whenFree(take)) take();
  };
}

/*
 * The public functions wait their turn (whenFree); the waiting ones run in order once our own Back has arrived,
 * through the do* functions, which never queue again (so the queue cannot go round in circles).
 */

/** opts.replace: show the page in place of the current one (e.g. a saved document instead of its empty form) */
export function navigate(path, query, opts = {}) {
  if (!whenFree(() => doNavigate(path, query, opts))) doNavigate(path, query, opts);
}
function doNavigate(path, query, opts = {}) {
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
  if (!whenFree(() => doSetQuery(patch))) doSetQuery(patch);
}
function doSetQuery(patch) {
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
  if (!whenFree(() => doBack(fallback))) doBack(fallback);
}
function doBack(fallback) {
  if (trail.length > 1) { goingBack = true; ourBack(); } else doNavigate(fallback, null, { replace: true });
}
