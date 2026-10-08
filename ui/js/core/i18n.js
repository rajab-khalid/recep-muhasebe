// Interface language: dictionaries per language, `t(key, vars)` with {placeholders}.
import tr from '../../i18n/tr.js';
import en from '../../i18n/en.js';
import ar from '../../i18n/ar.js';
import ku from '../../i18n/ku.js';

const DICTS = { tr, en, ar, ku };
export const LANGS = [
  { code: 'tr', name: 'Türkçe', dir: 'ltr' },
  { code: 'ku', name: 'Kurdî (Badînî)', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'en', name: 'English', dir: 'ltr' },
];

let lang = 'tr';
const listeners = new Set();
const missing = new Set();

export function getLang() { return lang; }
export function isRtl() { return lang === 'ar'; }

export function setLang(l, { persist = true } = {}) {
  if (!DICTS[l]) l = 'tr';
  lang = l;
  const meta = LANGS.find((x) => x.code === l);
  document.documentElement.lang = l;
  document.documentElement.dir = meta ? meta.dir : 'ltr';
  if (persist) { try { localStorage.setItem('rm_lang', l); } catch (e) { /* storage may be unavailable */ } }
  listeners.forEach((fn) => fn(l));
}

export function savedLang() {
  try { return localStorage.getItem('rm_lang'); } catch (e) { return null; }
}

export function onLang(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function t(key, vars) {
  let s = DICTS[lang] && DICTS[lang][key];
  if (s == null) s = DICTS.tr[key];
  if (s == null) s = DICTS.en[key];
  if (s == null) {
    if (!missing.has(key)) { missing.add(key); if (window.__RM_DEBUG) console.warn('[i18n] missing', key); }
    s = key;
  }
  if (vars) {
    if (s.includes(', plural,')) s = plurals(s, vars);
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? (Array.isArray(vars[k]) ? vars[k].join(', ') : vars[k]) : m));
  }
  return s;
}

/**
 * ICU-style plurals inside a translation, for languages whose nouns change with the count (Arabic, English):
 * "{n, plural, one {# item} two {two items} few {# items} many {# items} other {# items}}" — "#" is the number,
 * "=0 {…}" matches an exact value. Categories come from Intl.PluralRules for the interface language.
 */
const rulesCache = {};
function pluralCategory(n) {
  if (!rulesCache[lang]) {
    try { rulesCache[lang] = new Intl.PluralRules(lang === 'ku' ? 'en' : lang); } catch (e) { rulesCache[lang] = new Intl.PluralRules('en'); }
  }
  return rulesCache[lang].select(n);
}
function plurals(s, vars) {
  let out = '';
  let i = 0;
  for (;;) {
    const m = /\{(\w+), plural,/g;
    m.lastIndex = i;
    const hit = m.exec(s);
    if (!hit) { out += s.slice(i); return out; }
    out += s.slice(i, hit.index);
    // read "key {text}" options up to the matching closing brace
    let j = hit.index + hit[0].length;
    const opts = {};
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}') { j++; break; }
      const km = /^(=?\w+)\s*\{/.exec(s.slice(j));
      if (!km) { j = s.length; break; }
      j += km[0].length;
      let depth = 1;
      const start = j;
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      opts[km[1]] = s.slice(start, j - 1);
    }
    const raw = vars[hit[1]];
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.-]/g, ''));
    const text = opts[`=${n}`] ?? opts[pluralCategory(n)] ?? opts.other ?? '';
    out += text.replace(/#/g, raw !== undefined && raw !== null ? String(raw) : '');
    i = j;
  }
}

/** true when a key exists (used for optional labels such as server error codes) */
export function has(key) { return !!((DICTS[lang] && DICTS[lang][key]) || DICTS.tr[key]); }

export function missingKeys() { return [...missing]; }

/** number/date locale: Turkish formatting for tr, western digits with commas for the others */
export function numLocale() { return lang === 'tr' ? 'tr-TR' : 'en-US'; }
