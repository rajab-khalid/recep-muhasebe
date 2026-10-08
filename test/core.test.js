'use strict';
/* Business-logic tests: run with `node --test test/` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app');

function freshApp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rm-${name}-`));
  const app = createApp({ dataDir: dir });
  app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test Shop' }, admin: { full_name: 'Owner', username: 'owner', pin: '1234' } });
  const admin = app.users.list()[0];
  const ctx = { user: admin, ip: '127.0.0.1' };
  return { app, ctx, dir };
}
const near = (a, b, eps = 0.01, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);

test('setup seeds reference data', () => {
  const { app } = freshApp('seed');
  assert.equal(app.currencies().find((c) => c.code === 'IQD').rate, 1500);
  assert.ok(app.partners.walkinId());
  assert.equal(app.cash.accounts().length, 2);
  assert.ok(app.db.val('SELECT COUNT(*) FROM vehicle_models') > 200);
  assert.ok(app.products.defaultPriceListId());
});

test('purchase -> stock, average cost, supplier balance, partial payment', () => {
  const { app, ctx } = freshApp('purchase');
  const pl = app.products.defaultPriceListId();
  const pid = app.products.save({ name: 'LED H4', currency: 'IQD', prices: { [pl]: 30000 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'Hemin Cars' }, ctx);
  const usdBox = app.cash.defaultAccount('USD');
  const r = app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 10, unit_price: 12 }], post: true,
    payments: [{ account_id: usdBox.id, amount: 50 }] }, ctx);
  const d = app.docs.get(r.id);
  assert.equal(d.total, 120);
  assert.equal(d.payment_status, 'partial');
  assert.equal(app.stock.qtyOf(pid), 10);
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [pid]), 12, 1e-6);
  assert.deepEqual(app.partners.balances(sup), { USD: -70 });
  assert.equal(app.cash.balance(usdBox.id), -50);
  // product reference cost in its own currency (IQD)
  assert.equal(app.db.val('SELECT cost_price FROM products WHERE id = ?', [pid]), 18000);
  // second purchase at different price -> weighted average
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 10, unit_price: 14 }], post: true }, ctx);
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [pid]), 13, 1e-6);
});

test('POS sale with mixed USD + IQD payment and change', () => {
  const { app, ctx } = freshApp('pos');
  const pl = app.products.defaultPriceListId();
  const pid = app.products.save({ name: 'Seat cover', currency: 'IQD', prices: { [pl]: 75000 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 5, unit_price: 30 }], post: true }, ctx);
  const usd = app.cash.defaultAccount('USD');
  const iqd = app.cash.defaultAccount('IQD');
  // total 150,000 IQD; customer pays $100 (=150,000? no: 100*1500=150,000) -> pay $80 + 40,000 IQD = 160,000; change 10,000 IQD
  const r = app.docs.save({
    type: 'sale', channel: 'pos', currency: 'IQD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 2, unit_price: 75000 }], post: true,
    payments: [{ account_id: usd.id, amount: 80 }, { account_id: iqd.id, amount: 40000 }], change: { account_id: iqd.id, amount: 10000 },
  }, ctx);
  const d = app.docs.get(r.id);
  assert.equal(d.total, 150000);
  assert.equal(d.payment_status, 'paid');
  assert.equal(app.cash.balance(usd.id), 80);
  assert.equal(app.cash.balance(iqd.id), 30000);
  assert.deepEqual(app.partners.balances(app.partners.walkinId()), {});
  assert.equal(app.stock.qtyOf(pid), 3);
  near(d.cost_usd, 60, 1e-6, 'cost snapshot');
  near(d.total_usd, 100, 1e-6);
});

test('credit sale, cross-currency collection with FIFO allocation', () => {
  const { app, ctx } = freshApp('credit');
  const pid = app.products.save({ name: 'Mat', currency: 'USD', prices: { [app.products.defaultPriceListId()]: 50 } }, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'Ahmet Auto' }, ctx);
  const s1 = app.docs.save({ type: 'sale', partner_id: cust, currency: 'USD', lines: [{ product_id: pid, qty: 2, unit_price: 50 }], post: true }, ctx);
  const s2 = app.docs.save({ type: 'sale', partner_id: cust, currency: 'USD', lines: [{ product_id: pid, qty: 1, unit_price: 50 }], post: true }, ctx);
  assert.deepEqual(app.partners.balances(cust), { USD: 150 });
  // customer pays 180,000 IQD against the USD debt at 1500 => $120, FIFO: s1 fully ($100), s2 $20
  const iqd = app.cash.defaultAccount('IQD');
  app.payments.create({ direction: 'in', partner_id: cust, account_id: iqd.id, amount: 180000, applied_currency: 'USD', usd_iqd: 1500, auto_allocate: true }, ctx);
  assert.equal(app.docs.get(s1.id).payment_status, 'paid');
  const d2 = app.docs.get(s2.id);
  assert.equal(d2.payment_status, 'partial');
  near(d2.paid, 20);
  assert.deepEqual(app.partners.balances(cust), { USD: 30 });
  assert.equal(app.cash.balance(iqd.id), 180000);
  const st = app.partners.statement(cust);
  assert.equal(st.sections[0].closing, 30);
});

test('walk-in customer cannot buy on credit; discount and below-cost rules for staff', () => {
  const { app, ctx } = freshApp('rules');
  const pl = app.products.defaultPriceListId();
  const pid = app.products.save({ name: 'Polish', currency: 'IQD', prices: { [pl]: 10000 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'IQD', lines: [{ product_id: pid, qty: 10, unit_price: 6000 }], post: true }, ctx);
  assert.throws(() => app.docs.save({ type: 'sale', currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 10000 }], post: true }, ctx), (e) => e.code === 'walkin_credit');
  const salesRole = app.db.val("SELECT id FROM roles WHERE code = 'sales'");
  const uid = app.users.save({ full_name: 'Staff', username: 'staff', pin: '5555', role_id: salesRole, max_discount_pct: 5 }, ctx);
  const sctx = { user: app.users.get(uid) };
  const iqd = app.cash.defaultAccount('IQD');
  // 10% discount > 5% limit
  assert.throws(() => app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 10000, discount: 1000 }], post: true, payments: [{ account_id: iqd.id, amount: 9000 }] }, sctx), (e) => e.code === 'discount_limit');
  // below cost (5,000 < 6,000) — also above the discount limit, so allow the discount by giving the price via another list check: use admin-sized limit
  app.users.save({ id: uid, full_name: 'Staff', username: 'staff', role_id: salesRole, max_discount_pct: 60 }, ctx);
  const sctx2 = { user: app.users.get(uid) };
  assert.throws(() => app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 5000 }], post: true, payments: [{ account_id: iqd.id, amount: 5000 }] }, sctx2), (e) => e.code === 'below_cost');
  // within limits works
  const ok = app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 9800 }], post: true, payments: [{ account_id: iqd.id, amount: 9800 }] }, sctx2);
  assert.equal(app.docs.get(ok.id).payment_status, 'paid');
  // negative stock blocked when disabled
  app.patchSetting('pos', { allow_negative_stock: false });
  assert.throws(() => app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', lines: [{ product_id: pid, qty: 50, unit_price: 10000 }], post: true, payments: [{ account_id: iqd.id, amount: 500000 }] }, ctx), (e) => e.code === 'insufficient_stock');
});

test('sale return at original cost, edit and cancel keep ledgers consistent', () => {
  const { app, ctx } = freshApp('return');
  const pid = app.products.save({ name: 'Camera', currency: 'USD', prices: { [app.products.defaultPriceListId()]: 100 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'C' }, ctx);
  app.docs.save({ type: 'purchase', date: '2026-01-01', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 40 }], post: true }, ctx);
  const sale = app.docs.save({ type: 'sale', date: '2026-01-05', partner_id: cust, currency: 'USD', lines: [{ product_id: pid, qty: 3, unit_price: 100 }], post: true }, ctx);
  app.docs.save({ type: 'purchase', date: '2026-01-06', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 60 }], post: true }, ctx);
  const draft = app.docs.draftFrom(sale.id, 'sale_return');
  draft.lines[0].qty = 1;
  const ret = app.docs.save({ ...draft, date: '2026-01-07', post: true }, ctx);
  const rd = app.docs.get(ret.id);
  near(rd.lines[0].unit_cost_usd, 40, 1e-6, 'return cost = original sale cost');
  assert.equal(app.stock.qtyOf(pid), 18);
  assert.deepEqual(app.partners.balances(cust), { USD: 200 });
  // cannot return more than sold
  const d2 = app.docs.draftFrom(sale.id, 'sale_return');
  d2.lines[0].qty = 5;
  assert.throws(() => app.docs.save({ ...d2, post: true }, ctx), (e) => e.code === 'return_qty');
  // cannot cancel the sale while the return exists
  assert.throws(() => app.docs.cancel(sale.id, 'x', ctx), (e) => e.code === 'has_returns');
  app.docs.cancel(ret.id, 'mistake', ctx);
  assert.deepEqual(app.partners.balances(cust), { USD: 300 });
  // edit the sale: 3 -> 2 units
  const s = app.docs.get(sale.id);
  app.docs.save({ ...s, payments: undefined, lines: s.lines.map((l) => ({ ...l, qty: 2 })) }, ctx);
  assert.equal(app.stock.qtyOf(pid), 18);
  assert.deepEqual(app.partners.balances(cust), { USD: 200 });
  assert.equal(app.docs.get(sale.id).rev, 2);
  assert.equal(app.db.val('SELECT COUNT(*) FROM stock_moves WHERE doc_id = ? AND voided = 1', [sale.id]), 1);
  app.docs.cancel(sale.id, 'test', ctx);
  assert.equal(app.stock.qtyOf(pid), 20);
  assert.deepEqual(app.partners.balances(cust), {});
});

test('back-dated purchase recalculates later sale costs', () => {
  const { app, ctx } = freshApp('recalc');
  const pid = app.products.save({ name: 'Film', currency: 'USD' }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'C' }, ctx);
  app.docs.save({ type: 'purchase', date: '2026-02-01', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 10 }], post: true }, ctx);
  const sale = app.docs.save({ type: 'sale', date: '2026-02-10', partner_id: cust, currency: 'USD', lines: [{ product_id: pid, qty: 5, unit_price: 30 }], post: true }, ctx);
  near(app.docs.get(sale.id).cost_usd, 50, 1e-6);
  // a purchase dated before the sale arrives later
  app.docs.save({ type: 'purchase', date: '2026-02-05', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 20 }], post: true }, ctx);
  near(app.docs.get(sale.id).cost_usd, 75, 1e-6, 'avg 15 * 5');
});

test('landed cost (extra cost) spreads into unit cost and is paid from cash', () => {
  const { app, ctx } = freshApp('landed');
  const a = app.products.save({ name: 'A', currency: 'USD' }, ctx);
  const b = app.products.save({ name: 'B', currency: 'USD' }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  const usd = app.cash.defaultAccount('USD');
  const r = app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', extra_cost: 30, extra_account_id: usd.id,
    lines: [{ product_id: a, qty: 10, unit_price: 10 }, { product_id: b, qty: 10, unit_price: 20 }], post: true }, ctx);
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [a]), 11, 1e-6);
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [b]), 22, 1e-6);
  assert.deepEqual(app.partners.balances(sup), { USD: -300 });
  assert.equal(app.cash.balance(usd.id), -30);
  app.docs.cancel(r.id, 'x', ctx);
  assert.equal(app.cash.balance(usd.id), 0);
});

test('warehouse transfer, adjustment and stock count', () => {
  const { app, ctx } = freshApp('stock');
  const pid = app.products.save({ name: 'Oil', currency: 'USD', opening_stock: { qty: 20, unit_cost: 5 } }, ctx);
  assert.equal(app.stock.qtyOf(pid), 20);
  const w1 = app.stock.defaultWarehouseId();
  const w2 = app.uuid();
  app.db.insert('warehouses', { id: w2, name: 'Depo 2', active: 1, is_default: 0, sort: 2 });
  app.docs.save({ type: 'transfer', warehouse_id: w1, to_warehouse_id: w2, currency: 'USD', lines: [{ product_id: pid, qty: 8 }], post: true }, ctx);
  assert.equal(app.stock.qtyOf(pid, w1), 12);
  assert.equal(app.stock.qtyOf(pid, w2), 8);
  const c = app.counts.create({ warehouse_id: w1 }, ctx);
  app.counts.setLines(c.id, [{ product_id: pid, counted: 10 }], ctx);
  const res = app.counts.post(c.id, {}, ctx);
  assert.equal(res.adjusted, 1);
  assert.equal(app.stock.qtyOf(pid, w1), 10);
  const pl = app.reports.profitLoss({ from: '2000-01-01', to: '2100-01-01' });
  near(pl.stock_adjustments, -10, 1e-6, 'count loss 2 x $5');
});

test('money transfer, currency exchange and cash count', () => {
  const { app, ctx } = freshApp('money');
  const usd = app.cash.defaultAccount('USD');
  const iqd = app.cash.defaultAccount('IQD');
  app.cash.manual({ account_id: usd.id, amount: 500, kind: 'opening' }, ctx);
  const bank = app.cash.accountSave({ type: 'bank', name: 'KIB', currency: 'USD' }, ctx);
  app.cash.transfer({ from_account_id: usd.id, to_account_id: bank, from_amount: 200 }, ctx);
  assert.equal(app.cash.balance(usd.id), 300);
  assert.equal(app.cash.balance(bank), 200);
  const ex = app.cash.transfer({ from_account_id: usd.id, to_account_id: iqd.id, from_amount: 100, to_amount: 151000 }, ctx);
  assert.equal(app.cash.balance(iqd.id), 151000);
  assert.equal(app.db.val('SELECT usd_iqd FROM transfers WHERE id = ?', [ex.id]), 1510);
  const cnt = app.cash.count({ account_id: usd.id, counted: 195, post_diff: true }, ctx);
  assert.equal(cnt.diff, -5);
  assert.equal(app.cash.balance(usd.id), 195);
  app.cash.cancelTransfer(ex.id, 'x', ctx);
  assert.equal(app.cash.balance(iqd.id), 0);
});

test('expenses, recurring, partner currency conversion, reports run', () => {
  const { app, ctx } = freshApp('finance');
  const iqd = app.cash.defaultAccount('IQD');
  app.cash.manual({ account_id: iqd.id, amount: 1000000, kind: 'opening' }, ctx);
  const rent = app.db.val("SELECT id FROM finance_categories WHERE code = 'rent'");
  app.finance.save({ kind: 'expense', category_id: rent, amount: 300000, account_id: iqd.id, description: 'Rent' }, ctx);
  assert.equal(app.cash.balance(iqd.id), 700000);
  app.finance.recurringSave({ kind: 'expense', category_id: rent, amount: 100000, currency: 'IQD', day_of_month: 1, account_id: iqd.id }, ctx);
  assert.equal(app.finance.recurringPending().length, 1);
  app.finance.recurringGenerate(null, ctx);
  assert.equal(app.finance.recurringPending().length, 0);
  const cust = app.partners.save({ kind: 'customer', name: 'X', opening: [{ currency: 'IQD', amount: 150000 }] }, ctx);
  app.partners.convert(cust, { from_currency: 'IQD', to_currency: 'USD', from_amount: 150000, rate: 1 / 1500 }, ctx);
  assert.deepEqual(app.partners.balances(cust), { USD: 100 });
  const pl = app.reports.profitLoss({});
  assert.ok(pl.opex > 0);
  for (const name of ['salesSummary', 'salesByProduct', 'salesByCategory', 'salesByBrand', 'salesByCustomer', 'staffPerformance', 'payments', 'stockCurrent', 'stockValueBy', 'purchaseSuggestions', 'bestSellers', 'deadStock', 'stockMoves', 'cashReport', 'dayEnd', 'balances', 'incomeExpense', 'profitTrend', 'rateHistory', 'audit']) {
    assert.doesNotThrow(() => app.reports[name]({}), name);
  }
  assert.ok(app.reports.dashboard(ctx.user).date);
  assert.ok(Array.isArray(app.reports.notifications(ctx.user)));
});

test('vehicle-aware product search', () => {
  const { app, ctx } = freshApp('search');
  const corolla = app.db.val("SELECT id FROM vehicle_models WHERE name = 'Corolla'");
  app.products.save({ name: 'Fren balatası Bosch', fitments: [{ model_id: corolla, year_from: 2018, year_to: 2022 }] }, ctx);
  app.products.save({ name: 'Fren balatası Camry', fitments: [{ model_id: app.db.val("SELECT id FROM vehicle_models WHERE name = 'Camry'") }] }, ctx);
  app.products.save({ name: 'كه ڤه ر ستێرن' }, ctx);
  assert.equal(app.products.list({ q: '2019 Corolla fren balatası' }).rows.length, 1);
  assert.equal(app.products.list({ q: '2016 corolla fren' }).rows.length, 0);
  assert.equal(app.products.list({ q: 'fren balatasi' }).rows.length, 2);
  assert.equal(app.products.list({ q: 'کەڤەر' }).rows.length, 1, 'Kurdish spelling variants match');
});

test('quote -> service order -> invoice keeps status chain', () => {
  const { app, ctx } = freshApp('flow');
  const pid = app.products.save({ name: 'Android screen', currency: 'USD', opening_stock: { qty: 2, unit_cost: 200 } }, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'Ahmed', phone: '0750' }, ctx);
  const q = app.docs.save({ type: 'quote', partner_id: cust, currency: 'USD', lines: [{ product_id: pid, qty: 1, unit_price: 350 }, { kind: 'labor', description: 'Montaj', qty: 1, unit_price: 50 }] }, ctx);
  const sd = app.docs.draftFrom(q.id, 'service');
  const svc = app.docs.save({ ...sd, vehicle_plate: '12 A 3456', vehicle: { model_text: 'Corolla', year: 2020 }, technician_id: ctx.user.id }, ctx);
  assert.equal(app.docs.get(q.id).status, 'converted');
  app.docs.setStatus(svc.id, 'done', ctx);
  const inv = app.docs.draftFrom(svc.id, 'sale');
  const usd = app.cash.defaultAccount('USD');
  const s = app.docs.save({ ...inv, post: true, payments: [{ account_id: usd.id, amount: 400 }] }, ctx);
  assert.equal(app.docs.get(svc.id).status, 'invoiced');
  const sale = app.docs.get(s.id);
  assert.equal(sale.total, 400);
  assert.ok(sale.vehicle_id);
  const hist = app.vehicles.history(sale.vehicle_id);
  assert.ok(hist.length >= 2);
  const perf = app.reports.staffPerformance({});
  assert.ok(perf.rows.find((r) => r.labor > 0));
});
