// Names the program created at setup (main warehouse, cash boxes, walk-in customer, price lists, categories, the
// default unit) are written in the setup language. People working in another language see them translated,
// as long as the record still carries one of those default names; anything renamed is shown as typed.
import { getLang } from './i18n.js';

let index = new Map();
const norm = (s) => String(s || '').trim().toLocaleLowerCase();

/** list of {tr, en, ar, ku} name sets, sent by the server with the start-up data */
export function setSeedNames(list) {
  index = new Map();
  for (const m of list || []) for (const v of Object.values(m)) if (v) index.set(norm(v), m);
}

/** display name: a default name in the reader's language, anything else unchanged */
export function dn(name) {
  if (!name) return name;
  const m = index.get(norm(name));
  return m ? m[getLang()] || m.tr || name : name;
}
