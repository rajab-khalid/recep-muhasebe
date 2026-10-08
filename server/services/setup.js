'use strict';
const { ROLE_DEFAULTS, hashSecret } = require('../auth');
const SEED = require('../seed');

const ROLE_NAMES = {
  admin: { tr: 'Yönetici (Admin)', en: 'Administrator', ar: 'مدير النظام', ku: 'Rêvebir (Admin)' },
  manager: { tr: 'Müdür', en: 'Manager', ar: 'مدير', ku: 'Mudîr' },
  accounting: { tr: 'Muhasebe', en: 'Accounting', ar: 'محاسبة', ku: 'Hesabdarî' },
  sales: { tr: 'Satış Personeli', en: 'Sales Staff', ar: 'موظف مبيعات', ku: 'Karmendê Firotinê' },
  warehouse: { tr: 'Depo Sorumlusu', en: 'Warehouse', ar: 'أمين المخزن', ku: 'Berpirsê Embarê' },
  technician: { tr: 'Usta / Teknisyen', en: 'Technician', ar: 'فني', ku: 'Hosta / Teknîsyen' },
};

module.exports = (app) => {
  const { db, uuid, U } = app;

  function isSeeded() { return !!db.get('SELECT 1 FROM roles LIMIT 1'); }
  function isDone() { return !!app.getSetting('general').setup_done && !!db.get('SELECT 1 FROM users LIMIT 1'); }

  /** write default reference data in the chosen language (idempotent) */
  function seedDefaults(lang = 'tr', { usd_iqd = 1310, default_currency = 'IQD' } = {}) {
    if (isSeeded()) return;
    const L = (m) => SEED.pickLang(m, lang);
    const now = U.nowIso();
    db.tx(() => {
      for (const r of ROLE_DEFAULTS) {
        db.insert('roles', { id: uuid(), code: r.code, name: SEED.pickLang(ROLE_NAMES[r.code], lang), permissions: JSON.stringify(r.permissions), builtin: 1, sort: r.sort });
      }
      db.insert('currencies', { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2, rate: 1, active: 1, sort: 1, updated_at: now });
      db.insert('currencies', { code: 'IQD', name: 'Iraqi Dinar', symbol: 'IQD', decimals: 0, rate: Number(usd_iqd) || 1310, active: 1, sort: 2, updated_at: now });
      db.insert('currencies', { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, rate: 0.92, active: 0, sort: 3, updated_at: now });
      db.insert('rate_history', { id: uuid(), ts: now, currency: 'IQD', rate: Number(usd_iqd) || 1310, source: 'setup' });

      const whId = uuid();
      db.insert('warehouses', { id: whId, code: 'MAIN', name: L(SEED.NAMES.warehouse_main), is_default: 1, active: 1, sort: 1, created_at: now });
      const pls = [['retail', SEED.NAMES.pl_retail, 1], ['wholesale', SEED.NAMES.pl_wholesale, 0], ['special', SEED.NAMES.pl_special, 0], ['service', SEED.NAMES.pl_service, 0]];
      let retailId = null;
      pls.forEach(([code, names, def], i) => {
        const id = uuid();
        if (def) retailId = id;
        db.insert('price_lists', { id, code, name: L(names), sort: i + 1, active: 1, is_default: def });
      });
      db.insert('money_accounts', { id: uuid(), type: 'cash', name: L(SEED.NAMES.cash_usd), currency: 'USD', opening_balance: 0, is_default: 1, active: 1, sort: 1, created_at: now });
      db.insert('money_accounts', { id: uuid(), type: 'cash', name: L(SEED.NAMES.cash_iqd), currency: 'IQD', opening_balance: 0, is_default: 1, active: 1, sort: 2, created_at: now });
      const walkinId = uuid();
      db.insert('partners', {
        id: walkinId, no: 1, kind: 'customer', name: L(SEED.NAMES.walkin), is_walkin: 1, active: 1,
        search: U.searchBlob(L(SEED.NAMES.walkin)), created_at: now, updated_at: now,
      });
      SEED.FINANCE_CATEGORIES.forEach(([code, kind, inPl, names], i) => {
        db.insert('finance_categories', { id: uuid(), kind, code, name: L(names), in_pl: inPl, active: 1, sort: i + 1 });
      });
      SEED.PRODUCT_CATEGORIES.forEach((names, i) => db.insert('categories', { id: uuid(), name: L(names), sort: i + 1, active: 1 }));
      for (const [make, models] of Object.entries(SEED.VEHICLES)) {
        const mid = uuid();
        db.insert('vehicle_makes', { id: mid, name: make });
        for (const m of models) db.insert('vehicle_models', { id: uuid(), make_id: mid, name: m });
      }
      app.setSetting('general', Object.assign({}, app.getSetting('general'), { lang, default_currency, display_currency: default_currency }));
      app.setSetting('pos', Object.assign({}, app.getSetting('pos'), { default_partner_id: walkinId, default_price_list_id: retailId, default_warehouse_id: whId }));
      app.setSetting('stock', app.getSetting('stock'));
    });
    app.invalidateCurrencies();
  }

  /**
   * Finish the setup wizard.
   * d: { lang, usd_iqd, default_currency, company: {...}, admin: { full_name, username, password, pin } }
   */
  function complete(d) {
    U.assert(!isDone(), 'setup_done', 'Setup is already completed', 409);
    const lang = ['tr', 'en', 'ar', 'ku'].includes(d.lang) ? d.lang : 'tr';
    seedDefaults(lang, { usd_iqd: U.num(d.usd_iqd) || 1310, default_currency: d.default_currency || 'IQD' });
    const admin = d.admin || {};
    const fullName = U.str(admin.full_name, 120) || 'Admin';
    return db.tx(() => {
      if (d.company) app.setSetting('company', Object.assign({}, app.getSetting('company'), sanitizeCompany(d.company)));
      if (U.num(d.usd_iqd) > 0) {
        db.run("UPDATE currencies SET rate = ?, updated_at = ? WHERE code = 'IQD'", [U.num(d.usd_iqd), U.nowIso()]);
        app.invalidateCurrencies();
      }
      const roleId = db.val("SELECT id FROM roles WHERE code = 'admin'");
      let userId = db.val("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' LIMIT 1");
      const fields = {
        full_name: fullName, username: (U.str(admin.username, 60) || 'admin').toLowerCase(), role_id: roleId,
        password_hash: admin.password ? hashSecret(admin.password) : null,
        pin_hash: admin.pin && /^\d{4,8}$/.test(String(admin.pin)) ? hashSecret(admin.pin) : null,
        can_login: 1, active: 1, lang, updated_at: U.nowIso(),
      };
      if (userId) db.update('users', userId, fields);
      else { userId = uuid(); db.insert('users', { id: userId, ...fields, created_at: U.nowIso() }); }
      app.patchSetting('general', { setup_done: true, lang, default_currency: d.default_currency || app.getSetting('general').default_currency });
      app.audit({ system: 'setup' }, 'setup', 'system', null, { k: 'setup', v: {} });
      return { user_id: userId };
    });
  }

  function sanitizeCompany(c) {
    const out = {};
    for (const k of ['name', 'address', 'phone', 'phone2', 'email', 'tax_no', 'tax_office', 'slogan']) if (c[k] !== undefined) out[k] = U.str(c[k], 500) || '';
    if (c.logo && String(c.logo).startsWith('data:')) out.logo_file_id = app.files.saveDataUrl(c.logo, 'logo');
    if (c.logo_remove) out.logo_file_id = null;
    return out;
  }

  return { isSeeded, isDone, seedDefaults, complete, sanitizeCompany, ROLE_NAMES };
};
