// Session helpers: load bootstrap data, refresh it after settings changes, sign out.
import { api } from './api.js';
import { setSeedNames } from './names.js';
import { store, prefs } from './store.js';
import { setLang, savedLang } from './i18n.js';

export async function loadBoot(userHint) {
  const boot = await api.get('/api/bootstrap');
  setSeedNames(boot.seed_names);
  const u = boot.user || userHint;
  const dc = prefs('display_currency', null) || (boot.settings.general && boot.settings.general.display_currency) || 'IQD';
  if (u && u.lang && !savedLang()) setLang(u.lang, { persist: false });
  store.set({ boot, user: u, displayCurrency: dc });
  return boot;
}

/** reload lookups (warehouses, price lists, currencies...) after something changed */
export async function refreshBoot() {
  try { await loadBoot(store.state.user); } catch (e) { /* ignore */ }
}

export async function logout() {
  try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ }
  store.set({ user: null, boot: null, locked: false });
  location.hash = '#/';
}
