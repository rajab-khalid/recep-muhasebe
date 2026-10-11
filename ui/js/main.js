// Boot: language, setup state, session, then render the app.
import { html, render } from './core/h.js';
import { setLang, savedLang } from './core/i18n.js';
import { store, prefs } from './core/store.js';
import { api } from './core/api.js';
import { App } from './app.js';
import { loadBoot } from './core/session.js';
import { offline, offlineConfig, reachable } from './core/offline.js';

async function start() {
  setLang(savedLang() || 'tr', { persist: false });
  store.set({ displayCurrency: prefs('display_currency', 'IQD'), sidebarCollapsed: prefs('sidebar_collapsed', false) });
  // a phone that keeps an offline copy opens from it when the shop computer does not answer
  const cfg = offlineConfig();
  if (cfg && cfg.on && !window.desktop && !(await reachable(2500))) await offline.enter();
  let status = null;
  try {
    status = await api.get('/api/setup/status');
  } catch (e) {
    // cannot reach the shop computer and no copy on this phone: the page that waits for the computer
    if (e.code === 'network' && !window.desktop && 'serviceWorker' in navigator) { location.replace('/offline.html'); return; }
    render(html`<div class="loading-block" style="height:100vh"><div class="notice err">${e.message}</div></div>`, document.getElementById('app'));
    return;
  }
  if (!savedLang() && status.lang) setLang(status.lang, { persist: false });
  store.set({ setup: status });
  if (status.done) {
    try {
      const me = await api.get('/api/auth/me');
      if (me.user) await loadBoot(me.user);
    } catch (e) { /* show login */ }
  }
  document.getElementById('app').innerHTML = '';
  render(html`<${App} />`, document.getElementById('app'));
}

/*
 * Phone app: the helper that keeps the program's files on the phone (so it opens without the shop computer)
 * and shows a "cannot reach the shop computer" page when there is no copy to work from; and the browser's
 * offer to install the program on the home screen (shown in the phone menu). Not used in the desktop program.
 */
if (!window.desktop && window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then((reg) => {
      // take the program's newest files while the shop computer answers (done in the background)
      if (!offline.isOffline() && reg.active) reg.active.postMessage({ type: 'precache' });
    }).catch(() => {});
  });
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); store.set({ installPrompt: e }); });
window.addEventListener('appinstalled', () => store.set({ installPrompt: null }));

window.addEventListener('unhandledrejection', (e) => { if (window.__RM_DEBUG) console.error(e.reason); });
start();
