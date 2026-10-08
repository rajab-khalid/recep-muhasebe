// Page helpers: set the top-bar title / breadcrumbs from inside a page.
import { useEffect } from './h.js';
import { store } from './store.js';

export function useTitle(title, crumbs) {
  useEffect(() => { store.set({ pageTitle: title, crumbs: crumbs || null }); }, [title, JSON.stringify(crumbs || null)]);
}
