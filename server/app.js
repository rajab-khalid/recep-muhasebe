'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DB, uuid } = require('./db');
const { MIGRATIONS } = require('./schema');
const U = require('./util');

const APP_VERSION = (() => {
  try { return require('../package.json').version; } catch (e) { return '3.0.0'; }
})();

/* Numbering prefixes per document type. Numbers look like SF2026-0001. */
const DEFAULT_PREFIXES = {
  sale: 'SF', purchase: 'AF', sale_return: 'SI', purchase_return: 'AI', quote: 'TK', service: 'IE',
  purchase_order: 'SP', transfer: 'DT', adjust: 'SD', payment_in: 'TH', payment_out: 'OD',
  expense: 'GD', income: 'GL', money_transfer: 'VR', stock_count: 'SY',
};

const DEFAULT_SETTINGS = {
  company: { name: '', address: '', phone: '', phone2: '', email: '', tax_no: '', tax_office: '', logo_file_id: null, slogan: '' },
  general: { default_currency: 'IQD', display_currency: 'IQD', lang: 'tr', setup_done: false },
  numbering: { prefixes: DEFAULT_PREFIXES, pad: 4 },
  pos: {
    default_partner_id: null, default_price_list_id: null, default_warehouse_id: null,
    allow_negative_stock: true, block_below_cost: true, default_max_discount_pct: 10,
    auto_print_receipt: false, receipt_printer: '', print_mode: 'receipt', iqd_cash_rounding: 0,
    require_customer_for_credit: true,
  },
  stock: { low_stock_default: 5, dead_stock_days: 90 },
  invoice: {
    template: 'layout', customTemplate: null, headerLayout: null, itemsTableConfig: null,
    accentColor: '#1C5FA8', invDarkColor: '#14181D', invFontFamily: "'Segoe UI', Tahoma, Arial, sans-serif",
    invBaseFontSize: 12, invTitleFontSize: 15, logoSize: 56, logoLayout: 'left',
    terms: '', thanks: '', show_other_currency: true, show_warranty: true, paper: 'A4',
  },
  labels: { width_mm: 50, height_mm: 30, show_price: true, show_name: true, show_code: false, price_list_id: null },
  backup: { auto: true, keep: 30, folder: '', last_at: null, last_file: null },
  network: { lan_enabled: false, port: 8642 },
  security: { lock_on_start: false, session_days: 90, idle_lock_minutes: 0 },
  service: { default_terms: '', warranty_days_labor: 0 },
};

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  let ver = row ? Number(row.value) : 0;
  while (ver < MIGRATIONS.length) {
    const m = MIGRATIONS[ver];
    db.tx(() => {
      if (typeof m === 'function') m(db); else db.exec(m);
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(ver + 1)]);
    });
    ver++;
  }
}

function createApp(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = opts.dbFile || path.join(dataDir, 'recep-muhasebe.db');
  const restored = require('./services/backup').applyPendingRestore(dataDir, dbFile);
  const db = new DB(dbFile);
  migrate(db);

  const app = { db, dataDir, dbFile, version: APP_VERSION, uuid, U, opts, listeners: {}, restored };

  /* ----------------------------------------------------------- events */
  app.on = (evt, fn) => { (app.listeners[evt] = app.listeners[evt] || []).push(fn); };
  app.emit = (evt, payload) => { for (const fn of app.listeners[evt] || []) { try { fn(payload); } catch (e) { console.error(e); } } };

  /* ----------------------------------------------------------- sequence for ledger ordering */
  let seq = 0;
  for (const t of ['stock_moves', 'partner_moves', 'money_moves']) {
    const m = db.val(`SELECT MAX(seq) AS m FROM ${t}`);
    if (m && m > seq) seq = m;
  }
  app.nextSeq = () => ++seq;

  /* ----------------------------------------------------------- settings */
  const settingsCache = new Map();
  app.getSetting = (key) => {
    if (settingsCache.has(key)) return settingsCache.get(key);
    const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    const def = DEFAULT_SETTINGS[key];
    let val = row ? U.parseJson(row.value, def) : def;
    if (def && typeof def === 'object' && !Array.isArray(def) && val && typeof val === 'object') {
      val = Object.assign({}, def, val);
    }
    settingsCache.set(key, val);
    return val;
  };
  app.setSetting = (key, value) => {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
    settingsCache.delete(key);
    app.emit('settings', { key });
    return app.getSetting(key);
  };
  app.patchSetting = (key, patch) => {
    const cur = app.getSetting(key) || {};
    return app.setSetting(key, Object.assign({}, cur, patch));
  };
  app.allSettings = () => {
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = app.getSetting(k);
    return out;
  };

  /* ----------------------------------------------------------- audit */
  /**
   * summary: plain text, or { k, v } — a message the screen shows in the reader's language
   * (k names the message, v holds its values); the plain text is kept for searching.
   */
  app.audit = (ctx, action, entity, entityId, summary, data) => {
    const user = ctx && ctx.user;
    let msg = null;
    if (summary && typeof summary === 'object') {
      msg = JSON.stringify(summary);
      summary = Object.values(summary.v || {}).filter((x) => x !== null && x !== undefined && x !== '').join(' ');
    }
    db.insert('audit_log', {
      id: uuid(), ts: U.nowIso(), user_id: user ? user.id : null, user_name: user ? user.full_name : (ctx && ctx.system) || null,
      action, entity: entity || null, entity_id: entityId || null, summary: summary ? String(summary).slice(0, 500) : null,
      data: data === undefined ? null : JSON.stringify(data), ip: ctx && ctx.ip ? ctx.ip : null, msg,
    });
  };

  /* ----------------------------------------------------------- currencies & rates */
  let curCache = null;
  app.currencies = () => {
    if (!curCache) curCache = db.all('SELECT * FROM currencies ORDER BY sort, code');
    return curCache;
  };
  app.invalidateCurrencies = () => { curCache = null; };
  app.currency = (code) => {
    const c = app.currencies().find((x) => x.code === code);
    U.assert(c, 'unknown_currency', `Unknown currency ${code}`);
    return c;
  };
  app.rateOf = (code) => (code === 'USD' ? 1 : app.currency(code).rate);
  app.usdIqd = () => {
    const c = app.currencies().find((x) => x.code === 'IQD');
    return c ? c.rate : 1;
  };
  app.money = (amount, currency) => U.round(amount, app.currency(currency).decimals);
  /**
   * Resolve the exchange information for a row in `currency`.
   * usdIqd: the USD/IQD rate the user entered on the document (defaults to the current rate).
   * Returns { rate, usd_iqd } where rate = units of `currency` per 1 USD.
   */
  app.fx = (currency, usdIqd) => {
    const ui = Number(usdIqd) > 0 ? Number(usdIqd) : app.usdIqd();
    let rate;
    if (currency === 'USD') rate = 1;
    else if (currency === 'IQD') rate = ui;
    else rate = app.rateOf(currency);
    return { rate, usd_iqd: ui };
  };
  /** amount in `from` -> amount in `to`, using rates relative to USD */
  app.convert = (amount, from, to, fx) => {
    if (from === to) return Number(amount) || 0;
    const rf = from === 'USD' ? 1 : (from === 'IQD' && fx && fx.usd_iqd) ? fx.usd_iqd : app.rateOf(from);
    const rt = to === 'USD' ? 1 : (to === 'IQD' && fx && fx.usd_iqd) ? fx.usd_iqd : app.rateOf(to);
    return (Number(amount) || 0) / rf * rt;
  };

  /* ----------------------------------------------------------- numbering */
  app.peekNo = (type, date) => {
    const n = app.getSetting('numbering');
    const prefix = (n.prefixes && n.prefixes[type]) || DEFAULT_PREFIXES[type] || type.toUpperCase();
    const year = String(date || U.today()).slice(0, 4);
    const key = `${type}:${year}`;
    const last = db.val('SELECT last_no FROM sequences WHERE key = ?', [key]) || 0;
    return `${prefix}${year}-${String(last + 1).padStart(n.pad || 4, '0')}`;
  };
  app.nextNo = (type, date, table = 'docs') => {
    const n = app.getSetting('numbering');
    const prefix = (n.prefixes && n.prefixes[type]) || DEFAULT_PREFIXES[type] || type.toUpperCase();
    const year = String(date || U.today()).slice(0, 4);
    const key = `${type}:${year}`;
    for (let i = 0; i < 1000; i++) {
      db.run('INSERT INTO sequences (key, last_no) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET last_no = last_no + 1', [key]);
      const last = db.val('SELECT last_no FROM sequences WHERE key = ?', [key]);
      const no = `${prefix}${year}-${String(last).padStart(n.pad || 4, '0')}`;
      let exists;
      if (table === 'docs') exists = db.get('SELECT 1 FROM docs WHERE type = ? AND no = ?', [type, no]);
      else exists = db.get(`SELECT 1 FROM ${table} WHERE no = ?`, [no]);
      if (!exists) return no;
    }
    throw new U.AppError('numbering_failed', 'Could not allocate a document number');
  };
  /** make sure the sequence is at least `n` for type/year (used after importing old numbers) */
  app.bumpSequence = (type, year, n) => {
    const key = `${type}:${year}`;
    db.run('INSERT INTO sequences (key, last_no) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_no = MAX(last_no, excluded.last_no)', [key, n]);
  };

  /* ----------------------------------------------------------- services */
  app.files = require('./services/files')(app);
  app.users = require('./services/users')(app);
  app.stock = require('./services/stock')(app);
  app.products = require('./services/products')(app);
  app.partners = require('./services/partners')(app);
  app.vehicles = require('./services/vehicles')(app);
  app.cash = require('./services/cash')(app);
  app.payments = require('./services/payments')(app);
  app.docs = require('./services/docs')(app);
  app.finance = require('./services/finance')(app);
  app.counts = require('./services/counts')(app);
  app.reports = require('./services/reports')(app);
  app.setup = require('./services/setup')(app);
  app.backup = require('./services/backup')(app);
  app.importer = require('./services/import_v2')(app);

  app.close = () => db.close();
  return app;
}

module.exports = { createApp, DEFAULT_SETTINGS, DEFAULT_PREFIXES, APP_VERSION };
