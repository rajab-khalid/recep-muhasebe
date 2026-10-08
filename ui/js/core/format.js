// Money, number and date formatting. Numbers always use western digits; Turkish uses 1.234,56 style.
import { numLocale, getLang, t } from './i18n.js';
import { store } from './store.js';

const nfCache = new Map();
function nf(minD, maxD) {
  const key = `${numLocale()}|${minD}|${maxD}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(numLocale(), { minimumFractionDigits: minD, maximumFractionDigits: maxD });
    nfCache.set(key, f);
  }
  return f;
}

export function currency(code) {
  const list = (store.state.boot && store.state.boot.currencies) || [];
  return list.find((c) => c.code === code) || { code, symbol: code, decimals: code === 'IQD' ? 0 : 2, rate: 1 };
}

export function decimals(code) { return currency(code).decimals; }

export function round(x, n = 2) {
  const v = Number(x) || 0;
  const f = 10 ** n;
  const r = Math.round(Math.abs(v) * f + 1e-9) / f;
  return v < 0 ? -r : r;
}

/** plain number with grouping */
export function num(x, maxD = 2, minD = 0) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '';
  return nf(minD, maxD).format(Number(x));
}

export function qty(x) { return num(x, 3); }

/** "$1,250.50" / "1.520.000 IQD" */
export function money(amount, code, { sign = false, plain = false, dec } = {}) {
  if (amount === null || amount === undefined || amount === '') return '';
  const c = currency(code || 'USD');
  const d = dec !== undefined ? dec : c.decimals;
  const v = Number(amount) || 0;
  const abs = nf(d, d).format(Math.abs(round(v, d)));
  const neg = v < 0 && Math.abs(round(v, d)) > 0;
  const pre = neg ? '−' : sign && v > 0 ? '+' : '';
  if (plain) return `${pre}${abs}`;
  if (c.code === 'USD') return ltr(`${pre}$${abs}`);
  if (c.code === 'EUR') return ltr(`${pre}€${abs}`);
  return ltr(`${pre}${abs} ${getLang() === 'ar' && c.code === 'IQD' ? 'د.ع' : c.symbol || c.code}`);
}

/**
 * In right-to-left text an amount such as "−$4,312.71" or "1,520 د.ع" would be reordered by the bidi rules
 * (minus sign or symbol jumping to the other side). Isolating it as a left-to-right run keeps it intact.
 */
export function ltr(s) { return getLang() === 'ar' && s ? `\u2066${s}\u2069` : s; }

/** short axis numbers: "800 B" (tr), "800 ألف" (ar), "800K" — the unit is said elsewhere */
const cmpCache = {};
export function compact(v) {
  const lang = getLang();
  if (!cmpCache[lang]) {
    const loc = lang === 'tr' ? 'tr-TR' : lang === 'ar' ? 'ar-u-nu-latn' : 'en-US';
    try { cmpCache[lang] = new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }); } catch (e) { cmpCache[lang] = { format: (x) => num(x, 0) }; }
  }
  return ltr(cmpCache[lang].format(Number(v) || 0));
}

/** "$1 = 1.520 IQD" */
export function rateText(rate) { return ltr(`$1 = ${num(rate, 2)} IQD`); }

/** "4,3 MB" */
export function fileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return ltr(`${b} B`);
  if (b < 1024 * 1024) return ltr(`${num(b / 1024, 0)} KB`);
  return ltr(`${num(b / 1024 / 1024, 1)} MB`);
}

/** convert using current rates (1 USD = rate) or an explicit USD/IQD rate */
export function convert(amount, from, to, usdIqd) {
  if (from === to) return Number(amount) || 0;
  const rate = (code) => (code === 'USD' ? 1 : code === 'IQD' && usdIqd ? Number(usdIqd) : currency(code).rate);
  return (Number(amount) || 0) / rate(from) * rate(to);
}

export function usdIqd() { return currency('IQD').rate || 1; }

/** amount shown in the user's display currency (USD or IQD) */
export function display(amountUsd, opts) {
  const code = (store.state.displayCurrency) || 'IQD';
  return money(convert(amountUsd, 'USD', code), code, opts);
}

/**
 * Parse what a person typed. Accepts "1.520.000", "1,520,000", "12,5", "12.50", "1 500".
 * Rule: if both separators appear, the last one is the decimal mark; a single "." followed by
 * exactly 3 digits groups thousands ("15.000" = 15000).
 */
export function parseNum(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim().replace(/[\s  ']/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[−–]/g, '-');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    s = s.split(grp).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s) && getLang() !== 'tr') s = s.replace(/,/g, '');
    else if ((s.match(/,/g) || []).length > 1) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------------------------------------------------------------- dates */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function monthStart(iso = today()) { return `${iso.slice(0, 7)}-01`; }
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function date(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!d) return s;
  return getLang() === 'tr' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
}

export function dateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  const ds = date(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  return ltr(`${ds} ${p(d.getHours())}:${p(d.getMinutes())}`);
}

export function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  const key = `month.${m}`;
  const name = t(key);
  return `${name} ${y}`;
}

export function shortMonth(ym) {
  const m = Number(ym.slice(5, 7));
  return `${t(`month.short.${m}`)} ${ym.slice(2, 4)}`;
}

export function pct(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '';
  return getLang() === 'tr' ? `%${num(x, d, 0)}` : ltr(`${num(x, d, 0)}%`);
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Iraqi mobile numbers to international format for WhatsApp links */
export function waPhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '964' + p.slice(1);
  if (p.length === 10 && p.startsWith('7')) p = '964' + p;
  return p;
}
