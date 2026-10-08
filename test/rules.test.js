'use strict';
/* Safety rules found in review: change, returns, rates, edits, permissions, counts, purchase returns. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app');

function freshApp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rm-rules-${name}-`));
  const app = createApp({ dataDir: dir });
  app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test Shop' }, admin: { full_name: 'Owner', username: 'owner', pin: '1234' } });
  const admin = app.users.list()[0];
  const ctx = { user: admin, ip: '127.0.0.1' };
  return { app, ctx };
}
const near = (a, b, eps = 0.01, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

/** a cashier user (default "sales" role) */
function cashier(app, ctx) {
  const role = app.db.get("SELECT id FROM roles WHERE code = 'sales'");
  app.users.save({ full_name: 'Kasiyer', username: 'kasa', role_id: role.id, pin: '4321', can_login: true, active: true }, ctx);
  const u = app.users.list().find((x) => x.username === 'kasa');
  assert.ok(Array.isArray(u.permissions));
  return { user: u, ip: '127.0.0.1' };
}

function stocked(app, ctx, price = 10000, cost = 4) {
  const pl = app.products.defaultPriceListId();
  const pid = app.products.save({ name: 'Item', currency: 'IQD', prices: { [pl]: price } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'Supplier' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 20, unit_price: cost }], post: true }, ctx);
  return { pid, sup };
}

test('POS change cannot exceed what was paid above the total, and only from a cash box', () => {
  const { app, ctx } = freshApp('change');
  const { pid } = stocked(app, ctx);
  const iqd = app.cash.defaultAccount('IQD');
  const sale = (pay, change) => app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 1, unit_price: 10000 }], post: true, payments: pay, change }, ctx);
  assert.equal(code(() => sale([{ account_id: iqd.id, amount: 10000 }], { account_id: iqd.id, amount: 500000 })), 'change_too_big');
  assert.equal(app.cash.balance(iqd.id), 0, 'nothing written when refused');
  const ok = sale([{ account_id: iqd.id, amount: 25000 }], { account_id: iqd.id, amount: 15000 });
  assert.equal(app.docs.get(ok.id).payment_status, 'paid');
  assert.equal(app.cash.balance(iqd.id), 10000);
  // walk-in overpaid without change: refused
  assert.equal(code(() => sale([{ account_id: iqd.id, amount: 30000 }], null)), 'walkin_overpaid');
});

test('lines: no negative prices or zero quantities; kind follows the product', () => {
  const { app, ctx } = freshApp('lines');
  const { pid } = stocked(app, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'C' }, ctx);
  assert.equal(code(() => app.docs.save({ type: 'sale', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 10000 }, { kind: 'labor', description: 'free', qty: 1, unit_price: -10000 }], post: true }, ctx)), 'bad_price');
  assert.equal(code(() => app.docs.save({ type: 'sale', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, qty: -1, unit_price: 10000 }], post: true }, ctx)), 'bad_qty');
  // a stock product sent as "service" still leaves stock
  const r = app.docs.save({ type: 'sale', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, kind: 'service', qty: 2, unit_price: 10000 }], post: true }, ctx);
  assert.equal(app.docs.get(r.id).lines[0].kind, 'product');
  assert.equal(app.stock.qtyOf(pid), 18);
});

test('document rate far from today needs the right to set rates', () => {
  const { app, ctx } = freshApp('rate');
  const { pid } = stocked(app, ctx);
  const c = cashier(app, ctx);
  const iqd = app.cash.defaultAccount('IQD');
  assert.equal(code(() => app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', usd_iqd: 150, lines: [{ product_id: pid, qty: 1, unit_price: 10000 }], post: true, payments: [{ account_id: iqd.id, amount: 10000 }] }, c)), 'rate_out_of_range');
  const ok = app.docs.save({ type: 'sale', channel: 'pos', currency: 'IQD', usd_iqd: 1480, lines: [{ product_id: pid, qty: 1, unit_price: 10000 }], post: true, payments: [{ account_id: iqd.id, amount: 10000 }] }, c);
  assert.ok(ok.id);
});

test('returns: price capped at the invoice price, unlinked returns need permission, a return settles its credit invoice', () => {
  const { app, ctx } = freshApp('returns');
  const { pid } = stocked(app, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'Ahmet' }, ctx);
  const s = app.docs.save({ type: 'sale', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, qty: 2, unit_price: 10000 }], post: true }, ctx);
  const line = app.docs.get(s.id).lines[0];
  assert.equal(code(() => app.docs.save({ type: 'sale_return', partner_id: cust, ref_doc_id: s.id, currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 900000, ref_line_id: line.id }], post: true }, ctx)), 'return_price');
  const c = cashier(app, ctx);
  assert.equal(code(() => app.docs.save({ type: 'sale_return', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, qty: 1, unit_price: 10000 }], post: true }, c)), 'forbidden');
  const r = app.docs.save({ type: 'sale_return', partner_id: cust, ref_doc_id: s.id, currency: 'IQD', lines: [{ product_id: pid, qty: 2, unit_price: 10000, ref_line_id: line.id }], post: true }, ctx);
  assert.deepEqual(app.partners.balances(cust), {});
  assert.equal(app.docs.get(s.id).payment_status, 'paid', 'returned credit sale is settled');
  assert.equal(app.docs.get(r.id).payment_status, 'paid', 'nothing to refund');
  assert.equal(app.partners.openDocs(cust, { direction: 'in' }).length, 0);
  // cancelling the return opens the invoice again
  app.docs.cancel(r.id, 'test', ctx);
  assert.equal(app.docs.get(s.id).payment_status, 'unpaid');
});

test('editing a paid invoice down releases the extra allocation; a line cannot go below its returns', () => {
  const { app, ctx } = freshApp('edit');
  const { pid } = stocked(app, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'Ali' }, ctx);
  const iqd = app.cash.defaultAccount('IQD');
  const s = app.docs.save({ type: 'sale', partner_id: cust, currency: 'IQD', lines: [{ product_id: pid, qty: 4, unit_price: 10000 }], post: true, payments: [{ account_id: iqd.id, amount: 40000 }] }, ctx);
  const d = app.docs.get(s.id);
  app.docs.save({ ...d, lines: [{ ...d.lines[0], qty: 2 }], payments: undefined }, ctx);
  const d2 = app.docs.get(s.id);
  assert.equal(d2.total, 20000);
  assert.equal(d2.paid, 20000);
  assert.equal(d2.payment_status, 'paid');
  // return 2, then try to cut the sale line to 1
  app.docs.save({ type: 'sale_return', partner_id: cust, ref_doc_id: s.id, currency: 'IQD', lines: [{ product_id: pid, qty: 2, unit_price: 10000, ref_line_id: d2.lines[0].id }], post: true }, ctx);
  const d3 = app.docs.get(s.id);
  assert.equal(code(() => app.docs.save({ ...d3, lines: [{ ...d3.lines[0], qty: 1 }], payments: undefined }, ctx)), 'line_returned_qty');
});

test('unpaid purchase extra cost is owed to the supplier', () => {
  const { app, ctx } = freshApp('extra');
  const pid = app.products.save({ name: 'Box', currency: 'USD', prices: { [app.products.defaultPriceListId()]: 20 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'Sup' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', usd_iqd: 1500, extra_cost: 50, lines: [{ product_id: pid, qty: 10, unit_price: 10 }], post: true }, ctx);
  assert.deepEqual(app.partners.balances(sup), { USD: -150 });
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [pid]), 15, 1e-6);
});

test('a stock count posted days later does not undo the sales made after it', () => {
  const { app, ctx } = freshApp('count');
  const day = (n) => app.U.addDays(app.U.today(), n);
  const pid = app.products.save({ name: 'Item', currency: 'IQD', prices: { [app.products.defaultPriceListId()]: 10000 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'Supplier' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, date: day(-10), currency: 'USD', usd_iqd: 1500, lines: [{ product_id: pid, qty: 20, unit_price: 4 }], post: true }, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'K' }, ctx);
  const wh = app.stock.defaultWarehouseId();
  const cnt = app.counts.create({ warehouse_id: wh, date: day(-3), scope: 'all' }, ctx);
  app.counts.setLines(cnt.id, [{ product_id: pid, counted: 20 }], ctx);
  app.docs.save({ type: 'sale', partner_id: cust, date: day(-1), currency: 'IQD', lines: [{ product_id: pid, qty: 5, unit_price: 10000 }], post: true }, ctx);
  app.counts.post(cnt.id, {}, ctx);
  assert.equal(app.stock.qtyOf(pid), 15);
});

test('a purchase return leaves stock at the credited price', () => {
  const { app, ctx } = freshApp('pret');
  const pid = app.products.save({ name: 'Lamp', currency: 'USD', prices: { [app.products.defaultPriceListId()]: 40 } }, ctx);
  const sup = app.partners.save({ kind: 'supplier', name: 'S' }, ctx);
  app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 10 }], post: true }, ctx);
  const p2 = app.docs.save({ type: 'purchase', partner_id: sup, currency: 'USD', lines: [{ product_id: pid, qty: 10, unit_price: 20 }], post: true }, ctx);
  const l2 = app.docs.get(p2.id).lines[0];
  app.docs.save({ type: 'purchase_return', partner_id: sup, ref_doc_id: p2.id, currency: 'USD', lines: [{ product_id: pid, qty: 5, unit_price: 20, ref_line_id: l2.id }], post: true }, ctx);
  // 15 left worth 10*10 + 5*20 = 200 -> 13.33 each
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [pid]), 200 / 15, 1e-4);
});

test('cashiers cannot write off balances or enter opening balances', () => {
  const { app, ctx } = freshApp('perms');
  const c = cashier(app, ctx);
  const cust = app.partners.save({ kind: 'customer', name: 'X' }, ctx);
  assert.ok(!app.users.can(c.user, 'partners.adjust'));
  assert.equal(code(() => app.partners.save({ kind: 'customer', name: 'Y', opening: [{ currency: 'IQD', amount: -500000 }] }, c)), 'forbidden');
  assert.ok(app.users.can(ctx.user, 'partners.adjust'));
  app.partners.adjust(cust, { currency: 'IQD', amount: 1000 }, ctx);
  assert.deepEqual(app.partners.balances(cust), { IQD: 1000 });
});

test('wrong PINs pause the user (network pauses survive a restart), an address too; this computer is never locked out from the network', () => {
  const { app, ctx } = freshApp('lock');
  const cash = cashier(app, ctx);
  const id = cash.user.id;
  const NET = '192.168.1.50';
  const tryPin = (pin, ip = NET, a = app) => code(() => a.users.login({ user_id: id, pin, ip }));
  for (let i = 0; i < 5; i++) assert.equal(tryPin('0000'), 'wrong_credentials'); // the 5th miss starts a pause
  assert.equal(tryPin('4321'), 'too_many_attempts', 'even the right PIN waits');
  // misses from the network do not lock the shop's own computer
  assert.ok(app.users.login({ user_id: id, pin: '4321', ip: '127.0.0.1' }).token);
  // the network pause is in the database: a restarted program still knows it, and the users list shows it
  const app2 = createApp({ dataDir: app.dataDir });
  assert.equal(tryPin('4321', NET, app2), 'too_many_attempts');
  assert.ok(app2.users.get(id).locked_until);
  // the second round of 5 misses pauses longer (minutes)
  app2.db.run('UPDATE users SET locked_until = NULL WHERE id = ?', [id]);
  for (let i = 0; i < 5; i++) assert.equal(tryPin('1111', NET, app2), 'wrong_credentials');
  let e = null;
  try { app2.users.login({ user_id: id, pin: '4321', ip: NET }); } catch (x) { e = x; }
  assert.equal(e && e.code, 'too_many_attempts_min');
  assert.ok(e.details.min >= 2);
  // misses typed on this computer pause it too (kept in memory only)
  for (let i = 0; i < 5; i++) assert.equal(tryPin('2222', '127.0.0.1', app2), 'wrong_credentials');
  assert.equal(tryPin('4321', '127.0.0.1', app2), 'too_many_attempts');
  // an admin unlocks both; the right PIN works again and clears the count
  app2.users.unlock(id, ctx);
  assert.ok(app2.users.login({ user_id: id, pin: '4321', ip: NET }).token);
  assert.ok(app2.users.login({ user_id: id, pin: '4321', ip: '127.0.0.1' }).token);
  assert.equal(app2.db.val('SELECT failed_logins FROM users WHERE id = ?', [id]), 0);
  // one address guessing across users is paused after 20 misses; this computer and other addresses are not
  const owner = app2.users.list().find((u) => u.username === 'owner');
  for (let i = 0; i < 20; i++) {
    const who = i % 2 ? owner.id : id;
    app2.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [who]);
    code(() => app2.users.login({ user_id: who, pin: '9999', ip: '192.168.1.77' }));
  }
  app2.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL');
  assert.equal(code(() => app2.users.login({ user_id: owner.id, pin: '1234', ip: '192.168.1.77' })), 'too_many_attempts_min');
  assert.ok(app2.users.login({ user_id: owner.id, pin: '1234', ip: '127.0.0.1' }).token);
  assert.ok(app2.users.login({ user_id: owner.id, pin: '1234', ip: '192.168.1.78' }).token);
});

test('one attempt is one guess; long user names are cut; changing a PIN needs the current one', () => {
  const { app, ctx } = freshApp('guess');
  const cash = cashier(app, ctx);
  const id = cash.user.id;
  // password and pin fields carrying two different guesses: only one is tried
  assert.equal(code(() => app.users.login({ user_id: id, password: '1111', pin: '4321', ip: '192.168.1.5' })), 'wrong_credentials');
  assert.ok(app.users.login({ user_id: id, password: '4321', pin: '4321', ip: '192.168.1.5' }).token);
  assert.ok(app.users.login({ user_id: id, pin: '4321', ip: '192.168.1.5' }).token);
  // a huge user name is not stored in full
  code(() => app.users.login({ username: 'x'.repeat(100000), password: 'a', ip: '192.168.1.6' }));
  const row = app.db.get("SELECT user_name FROM audit_log WHERE action = 'login_failed' ORDER BY ts DESC LIMIT 1");
  assert.ok(row.user_name.length <= 60);
  // a PIN-only user must give the current PIN to set a new one; misses count like sign-in misses
  assert.equal(code(() => app.users.changeOwnSecret(id, { current: '', pin: '5555' }, '192.168.1.5')), 'wrong_password');
  app.users.changeOwnSecret(id, { current: '4321', pin: '5555' }, '192.168.1.5');
  assert.ok(app.users.login({ user_id: id, pin: '5555', ip: '127.0.0.1' }).token);
  // the lock screen uses the same rules
  assert.equal(app.users.verifyUserSecret(id, '0000', '192.168.1.5'), false);
  assert.equal(app.users.verifyUserSecret(id, '5555', '192.168.1.5'), true);
  // an unknown address is not "this computer": no password-free sign-in
  const owner = app.users.list().find((u) => u.username === 'owner');
  app.db.run('UPDATE users SET pin_hash = NULL, password_hash = NULL WHERE id = ?', [owner.id]);
  assert.equal(code(() => app.users.login({ user_id: owner.id, ip: '' })), 'wrong_credentials');
  assert.ok(app.users.login({ user_id: owner.id, ip: '127.0.0.1' }).token);
});

test('a SIFRE-SIFIRLA file in the data folder removes the admin PIN at the next start (this computer only)', () => {
  const { app, ctx } = freshApp('reset');
  cashier(app, ctx);
  const owner = app.users.list().find((u) => u.username === 'owner');
  assert.equal(code(() => app.users.login({ user_id: owner.id, ip: '127.0.0.1' })), 'wrong_credentials');
  assert.equal(app.users.emergencyReset(), 0, 'nothing happens without the file');
  fs.writeFileSync(path.join(app.dataDir, 'SIFRE-SIFIRLA.txt.txt'), '');
  assert.equal(app.users.emergencyReset(), 1);
  assert.ok(!fs.readdirSync(app.dataDir).some((f) => /sifirla/i.test(f) && !f.startsWith('kullanildi')), 'the file is used up');
  assert.ok(app.users.login({ user_id: owner.id, ip: '127.0.0.1' }).token, 'owner signs in on this computer');
  assert.equal(code(() => app.users.login({ user_id: owner.id, ip: '192.168.1.9' })), 'wrong_credentials', 'never from the network');
  const kasa = app.users.list().find((u) => u.username === 'kasa');
  assert.ok(kasa.has_pin, 'other users keep their PIN');
});

test('an admin setting a new PIN lifts a pause from this computer too; over-long passwords are refused', () => {
  const { app, ctx } = freshApp('newpin');
  const cash = cashier(app, ctx);
  const id = cash.user.id;
  for (let i = 0; i < 5; i++) code(() => app.users.login({ user_id: id, pin: '0000', ip: '127.0.0.1' }));
  assert.equal(code(() => app.users.login({ user_id: id, pin: '4321', ip: '127.0.0.1' })), 'too_many_attempts');
  assert.ok(app.users.get(id).locked_until, 'the users list shows the pause from this computer');
  app.users.save({ ...app.users.get(id), id, pin: '6789' }, ctx);
  assert.ok(app.users.login({ user_id: id, pin: '6789', ip: '127.0.0.1' }).token);
  assert.equal(code(() => app.users.save({ ...app.users.get(id), id, password: 'x'.repeat(201) }, ctx)), 'password_too_long');
});
