// Boot: language, setup state, session, then render the app.
import { html, render } from './core/h.js';
import { setLang, savedLang } from './core/i18n.js';
import { store, prefs } from './core/store.js';
import { api } from './core/api.js';
import { App } from './app.js';
import { loadBoot } from './core/session.js';

async function start() {
  setLang(savedLang() || 'tr', { persist: false });
  store.set({ displayCurrency: prefs('display_currency', 'IQD'), sidebarCollapsed: prefs('sidebar_collapsed', false) });
  let status = null;
  try {
    status = await api.get('/api/setup/status');
  } catch (e) {
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

window.addEventListener('unhandledrejection', (e) => { if (window.__RM_DEBUG) console.error(e.reason); });
start();
