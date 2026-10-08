'use strict';

/** Round to n decimals (half away from zero), avoiding binary float artefacts. */
function round(x, n = 2) {
  const v = Number(x) || 0;
  const f = Math.pow(10, n);
  const r = Math.round((Math.abs(v) * f) + 1e-9) / f;
  return v < 0 ? -r : r;
}

/** Local calendar date (YYYY-MM-DD) of the machine running the server. */
function today(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nowIso() { return new Date().toISOString(); }

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + Number(n || 0));
  return today(dt);
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1 + Number(n || 0), d);
  return today(dt);
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/*
 * Search normalisation for Kurdish (Sorani/Badini, Arabic script), Arabic, Turkish and Latin text.
 * People type the same word with different keyboards (ك/ک, ي/ی/ى, ه/ە/ھ/ة ...), with tatweel,
 * diacritics, ZWNJ, or even spaces between letters ("كه ڤه ر" vs "کەڤەر"). We map all variants
 * to one canonical form and also keep a space-less variant so both match.
 */
const CHAR_MAP = {
  'ك': 'ک', 'ڪ': 'ک', 'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ې': 'ی', 'ێ': 'ی',
  'ه': 'ە', 'ھ': 'ە', 'ة': 'ە', 'ۀ': 'ە', 'ہ': 'ە',
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و', 'ۆ': 'و', 'ۇ': 'و', 'ۊ': 'و',
  'ڵ': 'ل', 'ڕ': 'ر', 'ڤ': 'ف', 'ڨ': 'ف', 'گ': 'گ', 'ػ': 'گ', 'چ': 'چ', 'ژ': 'ژ', 'پ': 'پ',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o',
  'ç': 'c', 'Ç': 'c', 'ê': 'e', 'Ê': 'e', 'î': 'i', 'Î': 'i', 'û': 'u', 'Û': 'u', 'â': 'a',
};
// tatweel, harakat, small marks, ZWNJ/ZWJ, bidi marks
const STRIP_RE = /[ـً-ٰٟۖ-ۭ​-‏‪-‮⁦-⁩]/g;

function normalize(s) {
  if (s == null) return '';
  let out = '';
  const str = String(s).toLowerCase().replace(STRIP_RE, '');
  for (const ch of str) out += CHAR_MAP[ch] || ch;
  return out.replace(/[\s\-_.,/\\()]+/g, ' ').trim();
}

/** Build a search blob: normalised text plus a no-space copy (so "كه ڤه ر" finds "کەڤەر"). */
function searchBlob(...parts) {
  const n = normalize(parts.filter((p) => p != null && p !== '').join(' '));
  return n + ' | ' + n.replace(/ /g, '');
}

/** Turn a user query into LIKE patterns that all have to match (AND), each against the blob. */
function searchTerms(q) {
  const n = normalize(q);
  if (!n) return [];
  return n.split(' ').filter(Boolean).slice(0, 8);
}

function normPlate(p) {
  return normalize(p).replace(/ /g, '').toUpperCase();
}

class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assert(cond, code, message, status = 400, details) {
  if (!cond) throw new AppError(code, message, status, details);
}

function num(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v, max = 2000) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function parseJson(s, def) {
  if (s == null || s === '') return def;
  try { return JSON.parse(s); } catch (e) { return def; }
}

module.exports = {
  round, today, nowIso, addDays, addMonths, daysBetween, isDate,
  normalize, searchBlob, searchTerms, normPlate,
  AppError, assert, num, str, pick, parseJson,
};
