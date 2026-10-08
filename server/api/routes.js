'use strict';
const os = require('node:os');
const { PERMISSIONS } = require('../auth');
const SEED = require('../seed');

// default names in every language, so each reader sees the setup-created records in their own language
const SEED_NAMES = [...Object.values(SEED.NAMES), ...SEED.FINANCE_CATEGORIES.map((c) => c[3]), ...SEED.PRODUCT_CATEGORIES];
let ROLE_SEED = null; // filled from the setup service once the app exists

/*
 * All JSON endpoints. Each handler gets ctx = { app, user, params, query, body, ip, req, res, token }.
 * Permissions are enforced here (and again in services where it matters).
 */
module.exports = function registerRoutes(router, app) {
  const { U } = app;
  const can = (ctx, p) => app.users.can(ctx.user, p);
  const need = (ctx, ...perms) => {
    U.assert(ctx.user, 'unauthorized', 'Please sign in', 401);
    if (!perms.length) return;
    U.assert(perms.some((p) => can(ctx, p)), 'forbidden', 'You do not have permission for this action', 403, { permission: perms.join('|') });
  };

  const COST_KEYS = new Set(['avg_cost_usd', 'cost_price', 'unit_cost_usd', 'cost_usd', 'profit_usd', 'extra_usd', 'recent_purchases', 'last_supplier_name', 'last_supplier_id']);
  function stripCost(ctx, obj) {
    if (can(ctx, 'products.cost')) return obj;
    const walk = (o) => {
      if (Array.isArray(o)) return o.map(walk);
      if (o && typeof o === 'object' && !(o instanceof Buffer)) {
        const out = {};
        for (const [k, v] of Object.entries(o)) if (!COST_KEYS.has(k)) out[k] = walk(v);
        return out;
      }
      return o;
    };
    return walk(obj);
  }

  /* ================================================================ public / setup / auth */
  router.get('/api/ping', () => ({ ok: true, version: app.version, setup_done: app.setup.isDone(), time: U.nowIso() }), { public: true });

  router.get('/api/setup/status', () => ({
    done: app.setup.isDone(), seeded: app.setup.isSeeded(),
    empty: !app.db.get('SELECT 1 FROM docs LIMIT 1') && !app.db.get('SELECT 1 FROM products LIMIT 1'),
    lang: app.getSetting('general').lang, version: app.version,
  }), { public: true });

  const setupGuard = () => U.assert(!app.setup.isDone(), 'setup_done', 'Setup is already completed', 409);
  router.post('/api/setup/import-preview', (ctx) => { setupGuard(); return app.importer.preview(ctx.body.data); }, { public: true, bigBody: true, pre: setupGuard });
  router.post('/api/setup/import', (ctx) => {
    setupGuard();
    const report = app.importer.run(ctx.body.data, { usd_iqd: ctx.body.usd_iqd, lang: ctx.body.lang });
    return report;
  }, { public: true, bigBody: true, pre: setupGuard });
  router.post('/api/setup/complete', (ctx) => {
    setupGuard();
    const b = ctx.body || {};
    const r = app.setup.complete(b);
    const login = app.users.login({ user_id: r.user_id, password: (b.admin && (b.admin.password || b.admin.pin)) || undefined, remember: true, ip: ctx.ip, agent: ctx.req.headers['user-agent'] });
    ctx.setSession(login.token, true, login.days);
    return { user: login.user };
  }, { public: true });

  router.get('/api/auth/users', () => {
    if (!app.setup.isDone()) return [];
    return app.users.loginUsers();
  }, { public: true });
  router.post('/api/auth/login', (ctx) => {
    const b = ctx.body || {};
    const r = app.users.login({ user_id: b.user_id, username: b.username, password: b.password, pin: b.pin, remember: b.remember !== false, ip: ctx.ip, agent: ctx.req.headers['user-agent'] });
    ctx.setSession(r.token, r.remember, r.days);
    return { user: r.user };
  }, { public: true, smallBody: true });
  router.post('/api/auth/logout', (ctx) => { app.users.logout(ctx.token); ctx.setSession(null); return { ok: true }; }, { public: true });
  router.get('/api/auth/me', (ctx) => ({ user: ctx.user || null }), { public: true });
  router.post('/api/auth/verify', (ctx) => {
    need(ctx);
    const ok = app.users.verifyUserSecret(ctx.user.id, ctx.body.secret, ctx.ip);
    U.assert(ok, 'wrong_credentials', 'Wrong password or PIN', 401);
    return { ok: true };
  }, { smallBody: true });
  router.post('/api/auth/change-secret', (ctx) => { need(ctx); app.users.changeOwnSecret(ctx.user.id, ctx.body, ctx.ip); return { ok: true }; }, { smallBody: true });

  /* ================================================================ bootstrap */
  function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
    return out;
  }
  router.get('/api/bootstrap', (ctx) => {
    need(ctx);
    const db = app.db;
    const s = app.allSettings();
    const company = { ...s.company, logo_url: s.company.logo_file_id ? `/api/files/${s.company.logo_file_id}` : null };
    return {
      user: ctx.user, version: app.version, company,
      settings: {
        general: s.general, pos: s.pos, stock: s.stock, invoice: s.invoice, labels: s.labels, numbering: s.numbering,
        network: s.network, security: s.security, service: s.service, backup: can(ctx, 'backup.manage') ? s.backup : { last_at: s.backup.last_at },
      },
      currencies: app.currencies(),
      warehouses: db.all('SELECT * FROM warehouses ORDER BY is_default DESC, sort, name'),
      price_lists: db.all('SELECT * FROM price_lists ORDER BY sort, name'),
      categories: db.all('SELECT * FROM categories WHERE active = 1 ORDER BY sort, name'),
      brands: db.all('SELECT id, name FROM brands WHERE active = 1 ORDER BY name COLLATE NOCASE'),
      money_accounts: db.all('SELECT id, type, name, currency, is_default, active, bank_name FROM money_accounts ORDER BY type, sort, name'),
      finance_categories: app.finance.categories({ include_inactive: true }),
      staff: db.all("SELECT u.id, u.full_name, u.active, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.full_name"),
      vehicle_makes: db.all('SELECT id, name FROM vehicle_makes ORDER BY name COLLATE NOCASE'),
      walkin_id: app.partners.walkinId(),
      seed_names: ROLE_SEED || (ROLE_SEED = [...SEED_NAMES, ...Object.values(app.setup.ROLE_NAMES || {})]),
      permissions_catalog: PERMISSIONS,
      server: { port: ctx.port, lan: lanAddresses(), lan_enabled: !!s.network.lan_enabled, desktop: !!app.opts.desktop, data_dir: can(ctx, 'settings.manage') ? app.dataDir : undefined },
      today: U.today(),
    };
  });

  /* ================================================================ files */
  router.get('/api/files/:id', (ctx) => {
    // the shop logo may be shown before signing in; product photos need a signed-in user
    if (!ctx.user) {
      const logo = (app.getSetting('company') || {}).logo_file_id;
      U.assert(logo && logo === ctx.params.id, 'unauthorized', 'Please sign in', 401);
    }
    const f = app.files.get(ctx.params.id);
    U.assert(f, 'not_found', 'File not found', 404);
    // shown as pictures only: a file opened on its own (e.g. an SVG) can never run scripts in the program
    return {
      __raw: Buffer.from(f.data), type: f.mime, cache: 'private, max-age=31536000, immutable',
      headers: { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox", 'Content-Disposition': 'inline' },
    };
  }, { public: true });

  /* ================================================================ products */
  router.get('/api/products', (ctx) => { need(ctx, 'products.view', 'pos.use', 'sales.create', 'purchases.create', 'stock.view'); return stripCost(ctx, app.products.list(ctx.query)); });
  router.get('/api/products/by-code/:code', (ctx) => {
    need(ctx, 'products.view', 'pos.use', 'sales.create', 'purchases.create', 'stock.view');
    const id = app.products.byCode(ctx.params.code);
    if (!id) return { product: null };
    return stripCost(ctx, { product: app.products.forSale([id], ctx.query)[0] });
  });
  router.post('/api/products/for-sale', (ctx) => { need(ctx); return stripCost(ctx, app.products.forSale(ctx.body.ids || [], ctx.body)); });
  /** most sold products of the last 90 days (POS start screen) */
  router.get('/api/products/popular', (ctx) => {
    need(ctx, 'products.view', 'pos.use', 'sales.create');
    const limit = Math.min(Number(ctx.query.limit) || 40, 200);
    const where = ["d.type = 'sale'", "d.status = 'posted'", 'd.date >= ?', 'l.product_id IS NOT NULL'];
    const params = [U.addDays(U.today(), -90)];
    if (ctx.query.category_id) { where.push('p.category_id = ?'); params.push(ctx.query.category_id); }
    const ids = app.db.all(`SELECT l.product_id AS id, SUM(l.qty) AS q FROM doc_lines l JOIN docs d ON d.id = l.doc_id JOIN products p ON p.id = l.product_id
      WHERE ${where.join(' AND ')} AND p.active = 1 GROUP BY l.product_id ORDER BY q DESC LIMIT ?`, [...params, limit]).map((r) => r.id);
    if (!ids.length) return stripCost(ctx, app.products.list({ ...ctx.query, limit, sort: 'newest' }));
    const r = app.products.list({ ids, limit: ids.length, price_list_id: ctx.query.price_list_id, warehouse_id: ctx.query.warehouse_id });
    const order = new Map(ids.map((id, i) => [id, i]));
    r.rows.sort((a, b) => order.get(a.id) - order.get(b.id));
    return stripCost(ctx, r);
  });
  router.get('/api/products/:id', (ctx) => { need(ctx, 'products.view', 'pos.use', 'stock.view'); return stripCost(ctx, app.products.get(ctx.params.id)); });
  router.get('/api/products/:id/moves', (ctx) => { need(ctx, 'stock.view'); return stripCost(ctx, app.stock.movesOf(ctx.params.id, ctx.query)); });
  router.post('/api/products', (ctx) => {
    need(ctx, 'products.manage');
    const id = app.products.save(ctx.body, ctx);
    return stripCost(ctx, app.products.get(id));
  });
  router.del('/api/products/:id', (ctx) => { need(ctx, 'products.manage'); return app.products.remove(ctx.params.id, ctx); });
  router.post('/api/products/bulk-price', (ctx) => { need(ctx, 'products.prices'); return app.products.bulkPrice(ctx.body, ctx); });
  router.post('/api/products/import', (ctx) => { need(ctx, 'products.manage'); return app.products.importRows(ctx.body.rows || [], ctx.body.mode, ctx); }, { bigBody: true });
  router.post('/api/products/recalc-cost', (ctx) => {
    need(ctx, 'settings.manage');
    const ids = app.db.all('SELECT id FROM products').map((r) => r.id);
    app.db.tx(() => ids.forEach((id) => app.stock.recalc(id)));
    app.audit(ctx, 'recalc_cost', 'product', null, { k: 'products_n', v: { n: ids.length } });
    return { products: ids.length };
  });

  router.get('/api/categories', (ctx) => { need(ctx); return app.products.categories(); });
  router.post('/api/categories', (ctx) => { need(ctx, 'products.manage'); return { id: app.products.saveCategory(ctx.body, ctx) }; });
  router.del('/api/categories/:id', (ctx) => { need(ctx, 'products.manage'); app.products.deleteCategory(ctx.params.id, ctx); return { ok: true }; });
  router.get('/api/brands', (ctx) => { need(ctx); return app.products.brands(); });
  router.post('/api/brands', (ctx) => { need(ctx, 'products.manage'); return { id: app.products.saveBrand(ctx.body, ctx) }; });
  router.del('/api/brands/:id', (ctx) => { need(ctx, 'products.manage'); app.products.deleteBrand(ctx.params.id, ctx); return { ok: true }; });
  router.post('/api/price-lists', (ctx) => { need(ctx, 'settings.manage', 'products.prices'); return { id: app.products.savePriceList(ctx.body, ctx) }; });

  /* ================================================================ vehicles */
  router.get('/api/vehicle-makes', (ctx) => { need(ctx); return app.vehicles.makes(); });
  router.get('/api/vehicle-models', (ctx) => { need(ctx); return app.vehicles.models(ctx.query.make_id); });
  router.post('/api/vehicle-makes', (ctx) => { need(ctx, 'vehicles.manage', 'products.manage'); return { id: app.vehicles.saveMake(ctx.body, ctx) }; });
  router.post('/api/vehicle-models', (ctx) => { need(ctx, 'vehicles.manage', 'products.manage'); return { id: app.vehicles.saveModel(ctx.body, ctx) }; });
  router.del('/api/vehicle-makes/:id', (ctx) => { need(ctx, 'settings.manage'); app.vehicles.deleteMake(ctx.params.id, ctx); return { ok: true }; });
  router.del('/api/vehicle-models/:id', (ctx) => { need(ctx, 'settings.manage'); app.vehicles.deleteModel(ctx.params.id, ctx); return { ok: true }; });
  router.get('/api/vehicles', (ctx) => { need(ctx, 'vehicles.view', 'sales.view', 'service.view', 'pos.use'); return app.vehicles.list(ctx.query); });
  router.get('/api/vehicles/by-plate/:plate', (ctx) => { need(ctx, 'vehicles.view', 'sales.view', 'service.view', 'pos.use'); return { vehicle: app.vehicles.findByPlate(ctx.params.plate) }; });
  router.get('/api/vehicles/:id', (ctx) => { need(ctx, 'vehicles.view', 'sales.view', 'service.view'); return app.vehicles.get(ctx.params.id); });
  router.post('/api/vehicles', (ctx) => { need(ctx, 'vehicles.manage'); const id = app.vehicles.save(ctx.body, ctx); return app.vehicles.get(id); });

  /* ================================================================ partners */
  router.get('/api/partners', (ctx) => {
    need(ctx, 'partners.view', 'pos.use', 'sales.create', 'purchases.create');
    const rows = app.partners.list(ctx.query);
    if (!can(ctx, 'partners.balance')) for (const r of rows) { delete r.balances; delete r.balance_usd; }
    return rows;
  });
  router.get('/api/partners/:id', (ctx) => {
    need(ctx, 'partners.view', 'pos.use', 'sales.create');
    const p = app.partners.get(ctx.params.id);
    if (!can(ctx, 'partners.balance')) { delete p.balances; delete p.balance_usd; delete p.open_docs; }
    return p;
  });
  router.post('/api/partners', (ctx) => { need(ctx, 'partners.manage'); const id = app.partners.save(ctx.body, ctx); return app.partners.get(id); });
  router.del('/api/partners/:id', (ctx) => { need(ctx, 'partners.manage'); return app.partners.remove(ctx.params.id, ctx); });
  router.get('/api/partners/:id/statement', (ctx) => { need(ctx, 'partners.balance'); return app.partners.statement(ctx.params.id, ctx.query); });
  router.get('/api/partners/:id/open-docs', (ctx) => { need(ctx, 'partners.balance', 'payments.collect', 'payments.pay'); return app.partners.openDocs(ctx.params.id, ctx.query); });
  // changing a balance by hand (adjustment, currency conversion, cancelling such an entry) is its own permission
  router.post('/api/partners/:id/adjust', (ctx) => { need(ctx, 'partners.adjust'); return app.partners.adjust(ctx.params.id, ctx.body, ctx); });
  router.post('/api/partners/:id/convert', (ctx) => {
    need(ctx, 'partners.adjust');
    const b = ctx.body || {};
    // the conversion rate must be close to today's rates unless the user may set rates
    if (U.num(b.rate) > 0 && b.from_currency && b.to_currency && !can(ctx, 'settings.manage')) {
      const ref = app.convert(1, b.from_currency, b.to_currency);
      U.assert(ref > 0 && Math.abs(U.num(b.rate) - ref) / ref <= 0.10, 'rate_out_of_range', 'The rate is too far from today\'s rate', 400, { rate: U.num(b.rate), current: U.round(ref, 6) });
    }
    return app.partners.convert(ctx.params.id, b, ctx);
  });
  router.post('/api/partner-moves/:id/cancel', (ctx) => { need(ctx, 'partners.adjust'); app.partners.cancelMove(ctx.params.id, ctx.body.reason, ctx); return { ok: true }; });

  /* ================================================================ documents */
  const viewPerm = (type) => (app.docs.TYPES[type] ? app.docs.TYPES[type].perm.view : 'sales.view');
  router.get('/api/docs', (ctx) => {
    need(ctx);
    const types = String(ctx.query.type || 'sale').split(',');
    for (const t of types) U.assert(can(ctx, viewPerm(t)) || (t === 'sale' && can(ctx, 'pos.use')), 'forbidden', 'You do not have permission for this action', 403);
    if (types.length === 1 && types[0] === 'sale' && !can(ctx, 'sales.view')) ctx.query.created_by = ctx.user.id; // POS-only users see their own sales
    return stripCost(ctx, app.docs.list(ctx.query));
  });
  router.get('/api/docs/next-no', (ctx) => { need(ctx); return { no: app.peekNo(ctx.query.type || 'sale', ctx.query.date) }; });
  router.get('/api/docs/:id', (ctx) => {
    need(ctx);
    const d = app.docs.get(ctx.params.id, { history: can(ctx, 'audit.view') });
    U.assert(can(ctx, viewPerm(d.type)) || (d.type === 'sale' && can(ctx, 'pos.use') && d.created_by === ctx.user.id), 'forbidden', 'You do not have permission for this action', 403);
    return stripCost(ctx, d);
  });
  router.get('/api/docs/:id/draft-from/:type', (ctx) => {
    need(ctx, app.docs.TYPES[ctx.params.type] ? app.docs.TYPES[ctx.params.type].perm.create : 'sales.create');
    // the source document must be one this user may see (a purchase shows purchase prices)
    const src = app.db.get('SELECT type, created_by FROM docs WHERE id = ?', [ctx.params.id]);
    U.assert(src, 'not_found', 'Document not found', 404);
    U.assert(can(ctx, viewPerm(src.type)) || (src.type === 'sale' && can(ctx, 'pos.use') && src.created_by === ctx.user.id), 'forbidden', 'You do not have permission for this action', 403);
    return stripCost(ctx, app.docs.draftFrom(ctx.params.id, ctx.params.type));
  });
  router.post('/api/docs', (ctx) => {
    need(ctx);
    if (ctx.body.type === 'sale' && ctx.body.ref_doc_id) {
      const src = app.db.get('SELECT type FROM docs WHERE id = ?', [ctx.body.ref_doc_id]);
      if (src && src.type === 'service') need(ctx, 'service.invoice');
    }
    const r = app.docs.save(ctx.body, ctx);
    return stripCost(ctx, app.docs.get(r.id));
  });
  router.post('/api/docs/:id/post', (ctx) => { need(ctx); const r = app.docs.post(ctx.params.id, ctx); return stripCost(ctx, app.docs.get(r.id)); });
  router.post('/api/docs/:id/cancel', (ctx) => { need(ctx); app.docs.cancel(ctx.params.id, ctx.body.reason, ctx, { cancel_payments: !!ctx.body.cancel_payments }); return stripCost(ctx, app.docs.get(ctx.params.id)); });
  router.post('/api/docs/:id/status', (ctx) => { need(ctx); app.docs.setStatus(ctx.params.id, ctx.body.status, ctx); return stripCost(ctx, app.docs.get(ctx.params.id)); });
  router.del('/api/docs/:id', (ctx) => { need(ctx); app.docs.removeDraft(ctx.params.id, ctx); return { ok: true }; });

  /* ================================================================ payments */
  router.get('/api/payments', (ctx) => { need(ctx, 'payments.collect', 'payments.pay', 'cash.view', 'partners.balance'); return app.payments.list(ctx.query); });
  router.get('/api/payments/:id', (ctx) => { need(ctx, 'payments.collect', 'payments.pay', 'cash.view', 'partners.balance'); return app.payments.get(ctx.params.id); });
  router.post('/api/payments', (ctx) => {
    need(ctx, ctx.body.direction === 'out' ? 'payments.pay' : 'payments.collect');
    const r = app.payments.create(ctx.body, ctx);
    return app.payments.get(r.id);
  });
  router.post('/api/payments/:id/cancel', (ctx) => { need(ctx, 'payments.cancel'); app.payments.cancel(ctx.params.id, ctx.body.reason, ctx); return app.payments.get(ctx.params.id); });
  router.post('/api/payments/:id/allocate', (ctx) => { need(ctx, 'payments.collect', 'payments.pay'); app.payments.allocate(ctx.params.id, ctx.body.allocations, ctx); return app.payments.get(ctx.params.id); });

  /* ================================================================ money (cash / bank) */
  const moneyView = (ctx, acc) => need(ctx, acc && acc.type === 'bank' ? 'bank.view' : 'cash.view');
  router.get('/api/money/accounts', (ctx) => { need(ctx, 'cash.view', 'bank.view'); let rows = app.cash.accounts(ctx.query); if (!can(ctx, 'bank.view')) rows = rows.filter((a) => a.type !== 'bank'); if (!can(ctx, 'cash.view')) rows = rows.filter((a) => a.type === 'bank'); return rows; });
  router.post('/api/money/accounts', (ctx) => { need(ctx, ctx.body.type === 'bank' ? 'bank.manage' : 'cash.manage'); return { id: app.cash.accountSave(ctx.body, ctx) }; });
  router.del('/api/money/accounts/:id', (ctx) => { need(ctx, 'cash.manage', 'bank.manage'); return app.cash.accountRemove(ctx.params.id, ctx); });
  router.get('/api/money/accounts/:id/statement', (ctx) => { const a = app.cash.account(ctx.params.id); moneyView(ctx, a); return app.cash.statement(a.id, ctx.query); });
  router.post('/api/money/transfer', (ctx) => { need(ctx, 'cash.manage', 'bank.manage'); return app.cash.transfer(ctx.body, ctx); });
  router.get('/api/money/transfers', (ctx) => { need(ctx, 'cash.view', 'bank.view'); return app.cash.transfers(ctx.query); });
  router.post('/api/money/transfers/:id/cancel', (ctx) => { need(ctx, 'cash.manage', 'bank.manage'); app.cash.cancelTransfer(ctx.params.id, ctx.body.reason, ctx); return { ok: true }; });
  router.post('/api/money/manual', (ctx) => { need(ctx, 'cash.manage', 'bank.manage'); return app.cash.manual(ctx.body, ctx); });
  router.post('/api/money/moves/:id/cancel', (ctx) => { need(ctx, 'cash.manage', 'bank.manage'); app.cash.cancelMove(ctx.params.id, ctx.body.reason, ctx); return { ok: true }; });
  router.post('/api/money/count', (ctx) => { need(ctx, 'cash.manage'); return app.cash.count(ctx.body, ctx); });
  router.get('/api/money/counts', (ctx) => { need(ctx, 'cash.view'); return app.cash.counts(ctx.query); });

  /* ================================================================ income / expense */
  router.get('/api/finance/categories', (ctx) => { need(ctx); return app.finance.categories(ctx.query); });
  router.post('/api/finance/categories', (ctx) => { need(ctx, 'finance.manage'); return { id: app.finance.categorySave(ctx.body, ctx) }; });
  router.get('/api/finance/entries', (ctx) => { need(ctx, 'finance.view'); return app.finance.list(ctx.query); });
  router.post('/api/finance/entries', (ctx) => { need(ctx, 'finance.manage'); return { id: app.finance.save(ctx.body, ctx) }; });
  router.post('/api/finance/entries/:id/cancel', (ctx) => { need(ctx, 'finance.manage'); app.finance.cancel(ctx.params.id, ctx.body.reason, ctx); return { ok: true }; });
  router.get('/api/finance/recurring', (ctx) => { need(ctx, 'finance.view'); return app.finance.recurringList(); });
  router.post('/api/finance/recurring', (ctx) => { need(ctx, 'finance.manage'); return { id: app.finance.recurringSave(ctx.body, ctx) }; });
  router.del('/api/finance/recurring/:id', (ctx) => { need(ctx, 'finance.manage'); app.finance.recurringDelete(ctx.params.id, ctx); return { ok: true }; });
  router.post('/api/finance/recurring/generate', (ctx) => { need(ctx, 'finance.manage'); return app.finance.recurringGenerate(ctx.body.ids, ctx); });

  /* ================================================================ stock counts / warehouses */
  router.get('/api/stock/counts', (ctx) => { need(ctx, 'stock.count', 'stock.view'); return app.counts.list(); });
  router.post('/api/stock/counts', (ctx) => { need(ctx, 'stock.count'); return app.counts.create(ctx.body, ctx); });
  router.get('/api/stock/counts/:id', (ctx) => { need(ctx, 'stock.count', 'stock.view'); return stripCost(ctx, app.counts.get(ctx.params.id)); });
  router.post('/api/stock/counts/:id/lines', (ctx) => { need(ctx, 'stock.count'); return stripCost(ctx, app.counts.setLines(ctx.params.id, ctx.body.lines, ctx)); });
  router.post('/api/stock/counts/:id/post', (ctx) => { need(ctx, 'stock.count'); U.assert(can(ctx, 'stock.adjust'), 'forbidden', 'Posting a count needs the stock adjustment permission', 403); return app.counts.post(ctx.params.id, ctx.body, ctx); });
  router.del('/api/stock/counts/:id', (ctx) => { need(ctx, 'stock.count'); app.counts.remove(ctx.params.id, ctx); return { ok: true }; });
  router.get('/api/warehouses', (ctx) => {
    need(ctx);
    return app.db.all(`SELECT w.*, (SELECT COUNT(*) FROM stock_levels l WHERE l.warehouse_id = w.id AND l.qty <> 0) AS product_count,
      (SELECT SUM(l.qty * p.avg_cost_usd) FROM stock_levels l JOIN products p ON p.id = l.product_id WHERE l.warehouse_id = w.id AND l.qty > 0) AS value_usd
      FROM warehouses w ORDER BY w.is_default DESC, w.sort, w.name`).map((w) => (can(ctx, 'products.cost') ? w : { ...w, value_usd: undefined }));
  });
  router.post('/api/warehouses', (ctx) => {
    need(ctx, 'settings.manage');
    const b = ctx.body;
    const name = U.str(b.name, 100);
    U.assert(name, 'name_required', 'Name is required');
    return app.db.tx(() => {
      let id = b.id;
      if (id) {
        if (b.active === false) {
          const q = app.db.val('SELECT SUM(ABS(qty)) FROM stock_levels WHERE warehouse_id = ?', [id]) || 0;
          U.assert(q < 0.0001, 'warehouse_not_empty', 'Move the stock out of this warehouse before closing it');
          U.assert(!app.db.get('SELECT 1 FROM warehouses WHERE id = ? AND is_default = 1', [id]), 'default_warehouse', 'The default warehouse cannot be closed');
        }
        app.db.update('warehouses', id, { name, code: U.str(b.code, 20), address: U.str(b.address, 300), active: b.active === false ? 0 : 1 });
      } else {
        id = app.uuid();
        app.db.insert('warehouses', { id, name, code: U.str(b.code, 20), address: U.str(b.address, 300), is_default: 0, active: 1, sort: (app.db.val('SELECT MAX(sort) FROM warehouses') || 0) + 1, created_at: U.nowIso() });
      }
      if (b.is_default) app.db.run('UPDATE warehouses SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
      app.audit(ctx, 'save', 'warehouse', id, name);
      return { id };
    });
  });

  /* ================================================================ reports & dashboard */
  const REPORT_PERMS = {
    salesSummary: 'reports.sales', salesByProduct: 'reports.sales', salesByCategory: 'reports.sales', salesByBrand: 'reports.sales', salesByKind: 'reports.sales',
    salesByCustomer: 'reports.sales', staffPerformance: 'reports.sales', payments: 'reports.finance',
    stockCurrent: 'reports.stock', stockValueBy: 'reports.stock', purchaseSuggestions: 'reports.stock', bestSellers: 'reports.sales', deadStock: 'reports.stock', stockMoves: 'reports.stock',
    cashReport: 'reports.finance', dayEnd: 'reports.finance', balances: 'reports.finance', incomeExpense: 'reports.finance',
    profitLoss: 'reports.profit', profitTrend: 'reports.profit', rateHistory: 'reports.finance', audit: 'audit.view',
  };
  const PROFIT_REPORTS = new Set(['salesSummary', 'salesByProduct', 'salesByCategory', 'salesByBrand', 'salesByKind', 'salesByCustomer', 'bestSellers', 'staffPerformance', 'stockCurrent', 'stockValueBy', 'deadStock']);
  router.get('/api/reports/:name', (ctx) => {
    const name = ctx.params.name;
    U.assert(REPORT_PERMS[name] && typeof app.reports[name] === 'function', 'not_found', 'Unknown report', 404);
    need(ctx, REPORT_PERMS[name]);
    if (name === 'purchaseSuggestions') need(ctx, 'reports.stock', 'orders.manage');
    const r = app.reports[name](ctx.query);
    if (PROFIT_REPORTS.has(name) && !can(ctx, 'reports.profit')) {
      const strip = (o) => {
        if (Array.isArray(o)) return o.map(strip);
        if (o && typeof o === 'object') { const x = {}; for (const [k, v] of Object.entries(o)) if (!['cost', 'profit', 'margin', 'unit_cost', 'value', 'commission'].includes(k)) x[k] = strip(v); return x; }
        return o;
      };
      return strip(r);
    }
    return r;
  });
  router.get('/api/audit/:id', (ctx) => { need(ctx, 'audit.view'); return app.reports.auditEntry(ctx.params.id); });
  router.get('/api/dashboard', (ctx) => { need(ctx, 'dashboard.view'); return app.reports.dashboard(ctx.user); });
  router.get('/api/notifications', (ctx) => { need(ctx); return app.reports.notifications(ctx.user); });
  router.post('/api/notifications/read', (ctx) => { need(ctx); app.reports.markRead(ctx.user, ctx.body.keys); return { ok: true }; });

  /* ================================================================ users & roles */
  router.get('/api/users', (ctx) => { need(ctx, 'users.manage'); return app.users.list({ include_inactive: true }); });
  router.post('/api/users', (ctx) => { need(ctx, 'users.manage'); return { id: app.users.save(ctx.body, ctx) }; });
  router.post('/api/users/:id/unlock', (ctx) => { need(ctx, 'users.manage'); app.users.unlock(ctx.params.id, ctx); return { ok: true }; });
  router.get('/api/roles', (ctx) => { need(ctx, 'users.manage'); return app.users.rolesList(); });
  router.post('/api/roles', (ctx) => { need(ctx, 'users.manage'); return { id: app.users.roleSave(ctx.body, ctx) }; });
  router.del('/api/roles/:id', (ctx) => { need(ctx, 'users.manage'); app.users.roleDelete(ctx.params.id, ctx); return { ok: true }; });

  /* ================================================================ settings */
  const EDITABLE = ['general', 'pos', 'stock', 'invoice', 'labels', 'numbering', 'security', 'service', 'backup', 'network'];
  router.get('/api/settings', (ctx) => { need(ctx, 'settings.manage'); return app.allSettings(); });
  router.post('/api/settings/:key', (ctx) => {
    const key = ctx.params.key;
    U.assert(EDITABLE.includes(key), 'bad_key', 'Unknown settings group');
    need(ctx, key === 'backup' ? 'backup.manage' : 'settings.manage');
    const before = app.getSetting(key);
    const val = app.patchSetting(key, ctx.body || {});
    app.audit(ctx, 'settings', 'settings', key, key, { before, after: val });
    return val;
  });
  router.post('/api/company', (ctx) => {
    need(ctx, 'settings.manage');
    const patch = app.setup.sanitizeCompany(ctx.body || {});
    const old = app.getSetting('company');
    const val = app.patchSetting('company', patch);
    if (patch.logo_file_id !== undefined && old.logo_file_id && old.logo_file_id !== patch.logo_file_id) app.files.remove(old.logo_file_id);
    app.audit(ctx, 'settings', 'settings', 'company', val.name);
    return { ...val, logo_url: val.logo_file_id ? `/api/files/${val.logo_file_id}` : null };
  });
  router.post('/api/currencies/:code/rate', (ctx) => {
    need(ctx, 'settings.manage', 'cash.manage');
    const code = ctx.params.code;
    U.assert(code !== 'USD', 'bad_currency', 'USD is the base currency');
    const rate = U.num(ctx.body.rate);
    U.assert(rate > 0, 'bad_rate', 'Enter a valid rate');
    // guard against typing mistakes (an extra zero, a pasted number): sane bounds, and a confirmation for big jumps
    const BOUNDS = { IQD: [100, 100000], EUR: [0.2, 5] };
    const bounds = BOUNDS[code];
    U.assert(!bounds || (rate >= bounds[0] && rate <= bounds[1]), 'bad_rate', `Enter a rate between ${bounds && bounds[0]} and ${bounds && bounds[1]}`);
    const cur = app.currency(code);
    U.assert(!(cur.rate > 0 && Math.abs(rate - cur.rate) / cur.rate > 0.25) || ctx.body.confirm_big_change, 'rate_big_change',
      `The new rate ${rate} is very different from the current rate ${cur.rate}`, 409, { old: cur.rate, rate });
    app.db.tx(() => {
      app.db.run('UPDATE currencies SET rate = ?, updated_at = ? WHERE code = ?', [rate, U.nowIso(), code]);
      app.db.insert('rate_history', { id: app.uuid(), ts: U.nowIso(), currency: code, rate, source: ctx.body.source || 'manual', user_id: ctx.user.id });
      app.audit(ctx, 'rate', 'currency', code, { k: 'rate', v: { rate, code } });
    });
    app.invalidateCurrencies();
    return app.currencies();
  });
  router.post('/api/currencies', (ctx) => {
    need(ctx, 'settings.manage');
    const b = ctx.body;
    U.assert(b.code && b.code !== 'USD', 'bad_currency', 'Invalid currency');
    app.currency(b.code);
    app.db.update('currencies', b.code, { active: b.active ? 1 : 0, symbol: U.str(b.symbol, 8) || undefined, decimals: b.decimals != null ? Math.max(0, Math.min(4, Math.round(U.num(b.decimals)))) : undefined }, 'code');
    app.invalidateCurrencies();
    app.audit(ctx, 'settings', 'currency', b.code, b.code, b);
    return app.currencies();
  });
  router.get('/api/rates/online', async (ctx) => {
    need(ctx);
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    U.assert(j && j.rates && j.rates.IQD, 'rate_unavailable', 'Online rate is not available');
    return { IQD: j.rates.IQD, EUR: j.rates.EUR, time: j.time_last_update_utc };
  });

  /* ================================================================ backup */
  router.get('/api/backup', (ctx) => { need(ctx, 'backup.manage'); return { settings: app.getSetting('backup'), list: app.backup.list(), dir: app.backup.backupDir }; });
  router.post('/api/backup/now', (ctx) => { need(ctx, 'backup.manage'); const r = app.backup.backupNow({ folder: ctx.body.folder }); app.audit(ctx, 'backup', 'system', null, r.name); return r; });
  router.get('/api/backup/download/:name', (ctx) => {
    need(ctx, 'backup.manage');
    const f = app.backup.filePath(ctx.params.name);
    return { __raw: require('node:fs').readFileSync(f), type: 'application/octet-stream', filename: require('node:path').basename(f) };
  });
  router.post('/api/backup/restore', (ctx) => {
    need(ctx, 'backup.manage');
    let file;
    if (ctx.body.name) file = app.backup.filePath(ctx.body.name);
    else if (ctx.body.file_base64) {
      const p = require('node:path').join(app.dataDir, 'upload-restore.db');
      require('node:fs').writeFileSync(p, Buffer.from(ctx.body.file_base64, 'base64'));
      file = p;
    }
    U.assert(file, 'file_required', 'Choose a backup');
    const info = app.backup.scheduleRestore(file);
    app.audit(ctx, 'restore', 'system', null, { k: 'restore', v: { name: ctx.body.name || '' } }, info);
    ctx.requestRestart && ctx.requestRestart();
    return { ok: true, info, restart: true };
  }, { bigBody: true });
  router.get('/api/export/json', (ctx) => {
    need(ctx, 'backup.manage');
    const tables = app.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sessions', 'files') AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    const out = { app: 'recep-muhasebe', version: app.version, exported_at: U.nowIso(), tables: {} };
    for (const t of tables) out.tables[t] = app.db.all(`SELECT * FROM ${t}`);
    for (const u of out.tables.users || []) { delete u.password_hash; delete u.pin_hash; }
    return { __raw: Buffer.from(JSON.stringify(out)), type: 'application/json', filename: `recep-muhasebe-${U.today()}.json` };
  });

  /* ================================================================ system */
  router.get('/api/system/info', (ctx) => {
    need(ctx, 'settings.manage');
    const fs = require('node:fs');
    let size = 0;
    try { size = fs.statSync(app.dbFile).size; } catch (e) { /* */ }
    return {
      version: app.version, data_dir: app.dataDir, db_file: app.dbFile, db_size: size, port: ctx.port, lan: lanAddresses(),
      network: app.getSetting('network'), node: process.versions.node, platform: process.platform,
      counts: app.db.get(`SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM partners) AS partners,
        (SELECT COUNT(*) FROM docs) AS docs, (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM audit_log) AS audit`),
      sessions: app.db.all(`SELECT s.created_at, s.last_seen, s.ip, s.agent, u.full_name FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen DESC LIMIT 30`),
    };
  });
};
