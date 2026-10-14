'use strict';
/*
 * A purchase's costs — customs, freight, other — entered one by one: each paid from a cash box or owed to the
 * supplier or another account (e.g. the carrier), spread over the goods per unit or by value, so the products'
 * costs (and profits) include them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server/app');
const { MIGRATIONS } = require('../server/schema');

function freshApp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rm-costs-${name}-`));
  const app = createApp({ dataDir: dir });
  app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test Shop' }, admin: { full_name: 'Owner', username: 'owner', pin: '1234' } });
  const owner = app.users.list()[0];
  return { app, ctx: { user: owner, ip: '127.0.0.1' } };
}
const near = (a, b, eps = 1e-4, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

/** a cheap and a dear product, the supplier and a carrier */
function shop(name) {
  const t = freshApp(name);
  const { app, ctx } = t;
  t.cloth = app.products.save({ name: 'Mikrofiber bez', currency: 'IQD' }, ctx);
  t.wax = app.products.save({ name: 'Seramik kaplama', currency: 'IQD' }, ctx);
  t.supplier = app.partners.save({ kind: 'supplier', name: 'İstanbul Toptan' }, ctx);
  t.carrier = app.partners.save({ kind: 'supplier', name: 'Habur Nakliyat' }, ctx);
  t.cashIqd = app.cash.defaultAccount('IQD');
  t.buy = (extra = {}) => app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true,
    lines: [{ product_id: t.cloth, qty: 10, unit_price: 1000 }, { product_id: t.wax, qty: 2, unit_price: 50000 }],
    ...extra,
  }, ctx);
  return t;
}
const costsOf = (app, docId) => app.db.all('SELECT * FROM doc_costs WHERE doc_id = ? ORDER BY sort', [docId]);
const lineOf = (app, docId, productId) => app.db.get('SELECT * FROM doc_lines WHERE doc_id = ? AND product_id = ?', [docId, productId]);
const extraMoves = (app, docId) => ({
  cash: app.db.all("SELECT account_id, amount, description FROM money_moves WHERE doc_id = ? AND kind = 'purchase_extra' AND voided = 0", [docId]),
  partners: app.db.all("SELECT partner_id, currency, amount, description FROM partner_moves WHERE doc_id = ? AND kind = 'purchase_extra' AND voided = 0", [docId]),
});

test('customs, freight and other costs: each paid its own way, the same amount on every unit', () => {
  const t = shop('qty');
  const { app } = t;
  const r = t.buy({
    cost_split: 'qty',
    costs: [
      { kind: 'customs', description: 'İbrahim Halil', amount: 24000, currency: 'IQD', account_id: t.cashIqd.id },
      { kind: 'freight', amount: 10, currency: 'USD', partner_id: t.carrier },
      { kind: 'other', amount: 6000, currency: 'IQD' },
      { kind: 'other', amount: 0, currency: 'IQD' }, // empty rows are dropped
    ],
  });
  const d = app.docs.get(r.id);
  // 24.000 + $10 (15.000) + 6.000 = 45.000 IQD over 12 units: 3.750 IQD on each unit
  assert.equal(d.extra_cost, 45000);
  assert.equal(d.cost_split, 'qty');
  assert.equal(d.costs.length, 3);
  assert.deepEqual(d.costs.map((c) => c.kind), ['customs', 'freight', 'other']);
  assert.equal(d.costs[0].account_name, t.cashIqd.name);
  assert.equal(d.costs[1].partner_name, 'Habur Nakliyat');
  const cloth = lineOf(app, r.id, t.cloth);
  const wax = lineOf(app, r.id, t.wax);
  near(cloth.unit_cost_usd, (1000 + 3750) / 1500, 1e-6, 'cloth');
  near(wax.unit_cost_usd, (50000 + 3750) / 1500, 1e-6, 'wax');
  near(cloth.extra_usd, 3750 * 10 / 1500, 1e-6);
  near(wax.extra_usd, 3750 * 2 / 1500, 1e-6);
  near(app.db.val('SELECT avg_cost_usd FROM products WHERE id = ?', [t.cloth]), (1000 + 3750) / 1500, 1e-6, 'stock cost');
  // customs left the cash box, freight is owed to the carrier (in dollars), the rest to the supplier with the goods
  assert.equal(app.cash.balance(t.cashIqd.id), -24000);
  assert.deepEqual(app.partners.balances(t.carrier), { USD: -10 });
  assert.deepEqual(app.partners.balances(t.supplier), { IQD: -(110000 + 6000) });
  const m = extraMoves(app, r.id);
  assert.deepEqual(m.cash.map((x) => x.description), ['Gümrük — İbrahim Halil']);
  assert.deepEqual(m.partners.map((x) => x.description).sort(), ['Diğer masraf', 'Navlun']);
  // the product page shows the cost with expenses
  const p = app.products.get(t.cloth);
  near(p.recent_purchases[0].extra_usd, 25, 1e-6);
});

test('by value: dear goods carry more, every product the same share of its price', () => {
  const t = shop('value');
  const { app } = t;
  const r = t.buy({ cost_split: 'value', costs: [{ kind: 'customs', amount: 11000, currency: 'IQD', account_id: t.cashIqd.id }] });
  // 11.000 on 110.000 of goods: 10% on each price
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 1100 / 1500, 1e-6);
  near(lineOf(app, r.id, t.wax).unit_cost_usd, 55000 / 1500, 1e-6);
  // nothing has a price (free goods): shared per unit instead
  const free = app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true, cost_split: 'value',
    lines: [{ product_id: t.cloth, qty: 4, unit_price: 0 }], costs: [{ kind: 'freight', amount: 6000, currency: 'IQD', account_id: t.cashIqd.id }],
  }, t.ctx);
  near(lineOf(app, free.id, t.cloth).unit_cost_usd, 1500 / 1500, 1e-6);
});

test('a service line carries no costs; costs need goods; negative costs are refused', () => {
  const t = shop('rules');
  const { app, ctx } = t;
  const r = app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true, cost_split: 'qty',
    lines: [{ product_id: t.cloth, qty: 10, unit_price: 1000 }, { kind: 'labor', description: 'Montaj', qty: 1, unit_price: 5000 }],
    costs: [{ kind: 'freight', amount: 10000, currency: 'IQD', account_id: t.cashIqd.id }],
  }, ctx);
  near(lineOf(app, r.id, t.cloth).extra_usd, 10000 / 1500, 1e-6, 'all of it on the goods');
  assert.equal(code(() => app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', post: true,
    lines: [{ kind: 'labor', description: 'Montaj', qty: 1, unit_price: 5000 }], costs: [{ kind: 'freight', amount: 100, currency: 'IQD' }],
  }, ctx)), 'costs_need_goods');
  assert.equal(code(() => t.buy({ costs: [{ kind: 'customs', amount: -5, currency: 'IQD' }] })), 'bad_cost');
  assert.equal(code(() => t.buy({ costs: [{ kind: 'customs', amount: 5, currency: 'IQD', partner_id: 'nobody' }] })), 'partner_not_found');
  assert.equal(code(() => t.buy({ costs: [{ kind: 'customs', amount: 5, currency: 'IQD', account_id: 'nowhere' }] })), 'account_not_found');
});

test('editing a purchase replaces its costs and their payments; cancelling takes them back', () => {
  const t = shop('edit');
  const { app, ctx } = t;
  const r = t.buy({
    cost_split: 'qty',
    costs: [{ kind: 'customs', amount: 24000, currency: 'IQD', account_id: t.cashIqd.id }, { kind: 'freight', amount: 10, currency: 'USD', partner_id: t.carrier }],
  });
  const d = app.docs.get(r.id);
  app.docs.save({
    ...d, id: r.id, lines: d.lines, post: true,
    costs: [{ kind: 'customs', amount: 30000, currency: 'IQD', account_id: t.cashIqd.id }],
  }, ctx);
  assert.equal(app.cash.balance(t.cashIqd.id), -30000);
  assert.deepEqual(app.partners.balances(t.carrier), {}, 'the freight is no longer owed');
  assert.equal(costsOf(app, r.id).length, 1);
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, (1000 + 2500) / 1500, 1e-6, '30.000 over 12 units');
  app.docs.cancel(r.id, 'yanlış', ctx);
  assert.equal(app.cash.balance(t.cashIqd.id), 0);
  assert.deepEqual(app.partners.balances(t.supplier), {});
  assert.equal(costsOf(app, r.id).length, 1, 'the cancelled invoice still shows what it had');
});

test('a draft keeps its costs and applies them when posted; deleting the draft removes them', () => {
  const t = shop('draft');
  const { app, ctx } = t;
  const r = t.buy({ post: false, cost_split: 'qty', costs: [{ kind: 'freight', amount: 12000, currency: 'IQD', account_id: t.cashIqd.id }] });
  assert.equal(app.cash.balance(t.cashIqd.id), 0, 'nothing paid while it is a draft');
  app.docs.post(r.id, ctx);
  assert.equal(app.cash.balance(t.cashIqd.id), -12000);
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 2000 / 1500, 1e-6);
  const r2 = t.buy({ post: false, costs: [{ kind: 'freight', amount: 500, currency: 'IQD' }] });
  app.docs.removeDraft(r2.id, ctx);
  assert.equal(costsOf(app, r2.id).length, 0);
});

test('the older single extra cost still works, and sending it back unchanged keeps the cost rows', () => {
  const t = shop('legacy');
  const { app, ctx } = t;
  const r = t.buy({ extra_cost: 11000, extra_account_id: t.cashIqd.id });
  const rows = costsOf(app, r.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'other');
  assert.equal(rows[0].account_id, t.cashIqd.id);
  assert.equal(app.docs.get(r.id).cost_split, 'value', 'spread by value, as before');
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 1100 / 1500, 1e-6);
  // a newer invoice with several costs edited by an older client (one total, unchanged): rows stay as they are
  const r2 = t.buy({ cost_split: 'qty', costs: [{ kind: 'customs', amount: 3000, currency: 'IQD', account_id: t.cashIqd.id }, { kind: 'freight', amount: 3000, currency: 'IQD', partner_id: t.carrier }] });
  const before = costsOf(app, r2.id).map((c) => [c.kind, c.amount, c.account_id, c.partner_id]);
  const d2 = app.docs.get(r2.id);
  app.docs.save({ ...d2, id: r2.id, lines: d2.lines, costs: undefined, extra_cost: d2.extra_cost, extra_account_id: null, post: true }, ctx);
  assert.deepEqual(costsOf(app, r2.id).map((c) => [c.kind, c.amount, c.account_id, c.partner_id]), before);
  assert.equal(app.docs.get(r2.id).cost_split, 'qty');
});

test('an older database: its single extra costs become cost rows, spread by value as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-costs-mig-'));
  const file = path.join(dir, 'recep-muhasebe.db');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (let v = 0; v < 6; v++) raw.exec(MIGRATIONS[v]);
  raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '6')");
  raw.exec(`INSERT INTO docs (id, type, no, date, status, currency, rate, usd_iqd, extra_cost, extra_account_id, created_at)
    VALUES ('d1', 'purchase', 'AF1', '2026-10-01', 'posted', 'IQD', 1500, 1500, 9000, 'acc-1', '2026-10-01T10:00:00Z'),
           ('d2', 'purchase', 'AF2', '2026-10-01', 'posted', 'USD', 1, 1500, 0, NULL, '2026-10-01T10:00:00Z'),
           ('d3', 'sale', 'SF1', '2026-10-01', 'posted', 'IQD', 1500, 1500, 0, NULL, '2026-10-01T10:00:00Z'),
           ('d4', 'purchase', 'AF3', '2026-10-01', 'posted', 'IQD', 1500, 1500, -3000, NULL, '2026-10-01T10:00:00Z')`);
  raw.close();
  const app = createApp({ dataDir: dir });
  const rows = app.db.all('SELECT * FROM doc_costs ORDER BY doc_id');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].doc_id, rows[1].amount], ['d4', -3000], 'a negative extra cost too');
  assert.equal(rows[0].doc_id, 'd1');
  assert.equal(rows[0].amount, 9000);
  assert.equal(rows[0].currency, 'IQD');
  assert.equal(rows[0].account_id, 'acc-1');
  assert.equal(rows[0].kind, 'other');
  assert.match(rows[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(app.db.all('SELECT id, cost_split FROM docs ORDER BY id').map((d) => [d.id, d.cost_split]), [['d1', 'value'], ['d2', null], ['d3', null], ['d4', 'value']]);
});

test('a cost paid from a box of another currency is kept in that currency: the box does not move with the rate', () => {
  const t = shop('fxbox');
  const { app, ctx } = t;
  const cashUsd = app.cash.defaultAccount('USD');
  const r = t.buy({ cost_split: 'qty', costs: [{ kind: 'customs', amount: 24000, currency: 'IQD', account_id: cashUsd.id }] });
  assert.deepEqual(costsOf(app, r.id).map((c) => [c.currency, c.amount]), [['USD', 16]]);
  assert.equal(app.cash.balance(cashUsd.id), -16);
  // the invoice's rate is changed later: still $16 out of the box, and the goods carry $16
  const d = app.docs.get(r.id);
  app.docs.save({ ...d, id: r.id, lines: d.lines, usd_iqd: 1480, costs: d.costs, post: true }, ctx);
  assert.equal(app.cash.balance(cashUsd.id), -16);
  near(lineOf(app, r.id, t.cloth).extra_usd, 16 * 10 / 12, 1e-6);
  assert.equal(app.docs.get(r.id).extra_cost, 16 * 1480);
});

test('products kept in stock carry the costs; products without stock tracking only when nothing else is there', () => {
  const t = shop('untracked');
  const { app, ctx } = t;
  const loose = app.products.save({ name: 'Dökme şampuan', currency: 'IQD', track_stock: 0 }, ctx);
  const r = app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true, cost_split: 'qty',
    lines: [{ product_id: t.cloth, qty: 10, unit_price: 3000 }, { product_id: loose, qty: 10, unit_price: 3000 }],
    costs: [{ kind: 'freight', amount: 30000, currency: 'IQD', account_id: t.cashIqd.id }],
  }, ctx);
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 6000 / 1500, 1e-6, 'all of it on the stock item');
  assert.equal(lineOf(app, r.id, loose).extra_usd, 0);
  const r2 = app.docs.save({
    type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true, cost_split: 'qty',
    lines: [{ product_id: loose, qty: 5, unit_price: 3000 }], costs: [{ kind: 'freight', amount: 5000, currency: 'IQD' }],
  }, ctx);
  near(lineOf(app, r2.id, loose).extra_usd, 5000 / 1500, 1e-6, 'shown on the only goods there are');
});

test('an older invoice keeps what its version allowed: a negative extra cost, costs on an invoice without goods', () => {
  const t = shop('older');
  const { app, ctx } = t;
  // as the update leaves an invoice with a negative extra cost: it lowered the goods' cost and touched no account
  const r = t.buy({});
  app.db.run("INSERT INTO doc_costs (id, doc_id, sort, kind, currency, amount, created_at) VALUES ('c-neg', ?, 0, 'other', 'IQD', -11000, '2026-10-01T10:00:00Z')", [r.id]);
  app.db.run("UPDATE docs SET extra_cost = -11000, cost_split = 'value' WHERE id = ?", [r.id]);
  let d = app.docs.get(r.id);
  app.docs.save({ ...d, id: r.id, lines: d.lines, costs: d.costs, post: true }, ctx); // saved again from the new screen
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 900 / 1500, 1e-6, '10% off, as before');
  assert.deepEqual(extraMoves(app, r.id), { cash: [], partners: [] });
  assert.equal(app.docs.get(r.id).extra_cost, -11000);
  d = app.docs.get(r.id);
  app.docs.save({ ...d, id: r.id, lines: d.lines, costs: undefined, extra_cost: -11000, post: true }, ctx); // and from an older one
  near(lineOf(app, r.id, t.cloth).unit_cost_usd, 900 / 1500, 1e-6);
  d = app.docs.get(r.id);
  assert.equal(code(() => app.docs.save({ ...d, id: r.id, lines: d.lines, costs: [...d.costs, { kind: 'other', amount: -500, currency: 'IQD' }], post: true }, ctx)), 'bad_cost', 'a new negative cost is refused');
  // an invoice of services only, with a cost paid from the cash box
  const s = app.docs.save({ type: 'purchase', partner_id: t.supplier, currency: 'IQD', usd_iqd: 1500, post: true, lines: [{ kind: 'labor', description: 'Montaj', qty: 1, unit_price: 5000 }] }, ctx);
  app.db.run("INSERT INTO doc_costs (id, doc_id, sort, kind, currency, amount, account_id, created_at) VALUES ('c-svc', ?, 0, 'other', 'IQD', 2000, ?, '2026-10-01T10:00:00Z')", [s.id, t.cashIqd.id]);
  app.db.run("UPDATE docs SET extra_cost = 2000, cost_split = 'value' WHERE id = ?", [s.id]);
  const sd = app.docs.get(s.id);
  app.docs.save({ ...sd, id: s.id, lines: sd.lines, costs: sd.costs, post: true }, ctx);
  assert.equal(app.cash.balance(t.cashIqd.id), -2000, 'still paid from the box');
  const sd2 = app.docs.get(s.id);
  assert.equal(code(() => app.docs.save({ ...sd2, id: s.id, lines: sd2.lines, costs: [...sd2.costs, { kind: 'freight', amount: 100, currency: 'IQD' }], post: true }, ctx)), 'costs_need_goods');
});

test('an older screen cannot change costs entered with this version, and does not lose them', () => {
  const t = shop('oldscreen');
  const { app, ctx } = t;
  const r = t.buy({ cost_split: 'qty', costs: [{ kind: 'customs', amount: 3000, currency: 'IQD', account_id: t.cashIqd.id }, { kind: 'freight', amount: 2, currency: 'USD', partner_id: t.carrier }] });
  const d = app.docs.get(r.id);
  assert.equal(code(() => app.docs.save({ ...d, id: r.id, lines: d.lines, costs: undefined, extra_cost: 1000, extra_account_id: null, post: true }, ctx)), 'costs_need_update');
  // the invoice moved to dollars there (that screen converts its total itself): the costs stay, each in its currency
  app.docs.save({ ...d, id: r.id, currency: 'USD', lines: d.lines.map((l) => ({ ...l, unit_price: l.unit_price / 1500 })), costs: undefined, extra_cost: 4, extra_account_id: null, post: true }, ctx);
  assert.deepEqual(costsOf(app, r.id).map((c) => [c.kind, c.currency, c.amount]), [['customs', 'IQD', 3000], ['freight', 'USD', 2]]);
  assert.deepEqual(app.partners.balances(t.carrier), { USD: -2 });
  assert.equal(app.cash.balance(t.cashIqd.id), -3000);
  // an invoice without costs saved there is not marked "by price"
  const plain = t.buy({});
  const pd = app.docs.get(plain.id);
  app.docs.save({ ...pd, id: plain.id, lines: pd.lines, costs: undefined, extra_cost: 0, post: true }, ctx);
  assert.equal(app.docs.get(plain.id).cost_split, null);
});

test('costs go only to open accounts; an account named on costs is closed, not deleted; the history keeps the costs', () => {
  const t = shop('refs');
  const { app, ctx } = t;
  assert.equal(code(() => t.buy({ costs: [{ kind: 'freight', amount: 5, currency: 'IQD', partner_id: app.partners.walkinId() }] })), 'bad_cost_partner');
  const gone = app.partners.save({ kind: 'supplier', name: 'Eski Nakliyeci' }, ctx);
  app.db.run('UPDATE partners SET active = 0 WHERE id = ?', [gone]);
  assert.equal(code(() => t.buy({ costs: [{ kind: 'freight', amount: 5, currency: 'IQD', partner_id: gone }] })), 'bad_cost_partner');
  const closed = app.cash.accountSave({ type: 'cash', name: 'Eski kasa', currency: 'IQD', active: false }, ctx);
  assert.equal(code(() => t.buy({ costs: [{ kind: 'customs', amount: 5, currency: 'IQD', account_id: closed }] })), 'account_inactive');
  // a draft names the carrier and a new box: neither can be deleted any more, only closed
  const box = app.cash.accountSave({ type: 'cash', name: 'Gümrük kasası', currency: 'IQD' }, ctx);
  const r = t.buy({ post: false, costs: [{ kind: 'freight', amount: 5, currency: 'IQD', partner_id: t.carrier }, { kind: 'customs', amount: 7, currency: 'IQD', account_id: box }] });
  assert.deepEqual(app.partners.remove(t.carrier, ctx), { deactivated: true });
  assert.deepEqual(app.cash.accountRemove(box, ctx), { deactivated: true });
  // the history of an edit and of a deleted draft says what the costs were
  const d = app.docs.get(r.id);
  app.docs.save({ ...d, id: r.id, lines: d.lines, costs: [], post: false }, ctx);
  const edit = JSON.parse(app.db.val("SELECT data FROM audit_log WHERE entity = 'doc' AND entity_id = ? AND action = 'update' ORDER BY ts DESC LIMIT 1", [r.id]));
  assert.deepEqual(edit.before.costs.map((c) => [c.k, c.a, c.p || c.acc]), [['freight', 5, t.carrier], ['customs', 7, box]]);
  const r2 = t.buy({ post: false, costs: [{ kind: 'other', amount: 9, currency: 'IQD' }] });
  app.docs.removeDraft(r2.id, ctx);
  const del = JSON.parse(app.db.val("SELECT data FROM audit_log WHERE entity_id = ? AND action = 'delete_draft'", [r2.id]));
  assert.deepEqual(del.costs.map((c) => [c.k, c.a]), [['other', 9]]);
});

test('a purchase keeps its costs only with goods; old odd amounts stay as they were; paying needs the right to pay', () => {
  const t = shop('holes');
  const { app, ctx } = t;
  // goods removed later: the costs would be carried by nothing
  const r = t.buy({ cost_split: 'qty', costs: [{ kind: 'freight', amount: 10000, currency: 'IQD', account_id: t.cashIqd.id }] });
  const d = app.docs.get(r.id);
  assert.equal(code(() => app.docs.save({ ...d, id: r.id, costs: d.costs, post: true, lines: [{ kind: 'labor', description: 'Montaj', qty: 1, unit_price: 5000 }] }, ctx)), 'costs_need_goods');
  // amounts an earlier version kept with more decimals than the currency has: still the same costs, unchanged
  const o = t.buy({});
  app.db.run("INSERT INTO doc_costs (id, doc_id, sort, kind, currency, amount, created_at) VALUES ('c-frac', ?, 0, 'other', 'IQD', -3000.5, '2026-10-01T10:00:00Z')", [o.id]);
  app.db.run("UPDATE docs SET extra_cost = -3000.5, cost_split = 'value' WHERE id = ?", [o.id]);
  const od = app.docs.get(o.id);
  app.docs.save({ ...od, id: o.id, lines: od.lines, costs: od.costs, post: true }, ctx);
  assert.deepEqual(costsOf(app, o.id).map((c) => c.amount), [-3000.5]);
  // someone who may not pay out money: a cost owed to the supplier is fine, one paid from the box is not
  const depo = app.users.save({ full_name: 'Depo', username: 'depo', role_id: app.db.val("SELECT id FROM roles WHERE code = 'warehouse'"), pin: '2468' }, ctx);
  const wctx = { user: app.users.get(depo), ip: '127.0.0.1' };
  const line = [{ product_id: t.cloth, qty: 1, unit_price: 1000 }];
  assert.equal(code(() => app.docs.save({ type: 'purchase', partner_id: t.supplier, currency: 'IQD', post: true, lines: line, costs: [{ kind: 'customs', amount: 700, currency: 'IQD', account_id: t.cashIqd.id }] }, wctx)), 'forbidden');
  const w = app.docs.save({ type: 'purchase', partner_id: t.supplier, currency: 'IQD', post: true, lines: line, costs: [{ kind: 'customs', amount: 700, currency: 'IQD' }] }, wctx);
  assert.equal(costsOf(app, w.id).length, 1);
  // a purchase made from an order knows which products are kept in stock (the editor spreads the costs by it)
  const loose = app.products.save({ name: 'Dökme şampuan', currency: 'IQD', track_stock: 0 }, ctx);
  const po = app.docs.save({ type: 'purchase_order', partner_id: t.supplier, currency: 'IQD', lines: [{ product_id: t.cloth, qty: 2, unit_price: 1000 }, { product_id: loose, qty: 2, unit_price: 1000 }] }, ctx);
  const draft = app.docs.draftFrom(po.id, 'purchase');
  assert.deepEqual(draft.lines.map((l) => l.track_stock), [1, 0]);
});

test('an older screen may still change the one plain extra cost it knows', () => {
  const t = shop('plain');
  const { app, ctx } = t;
  // entered there, or with this version as one "other" cost paid from the IQD box: the older screen shows that box
  const r = t.buy({ cost_split: 'value', costs: [{ kind: 'other', amount: 9000, currency: 'IQD', account_id: t.cashIqd.id }] });
  assert.equal(app.db.val('SELECT extra_account_id FROM docs WHERE id = ?', [r.id]), t.cashIqd.id);
  const d = app.docs.get(r.id);
  app.docs.save({ ...d, id: r.id, lines: d.lines, costs: undefined, extra_cost: 12000, extra_account_id: t.cashIqd.id, post: true }, ctx);
  assert.deepEqual(costsOf(app, r.id).map((c) => [c.kind, c.amount, c.account_id]), [['other', 12000, t.cashIqd.id]]);
  assert.equal(app.cash.balance(t.cashIqd.id), -12000);
  // one paid from a box of another currency is not what that screen shows: it may not change it
  const usd = app.cash.defaultAccount('USD');
  const r2 = t.buy({ costs: [{ kind: 'other', amount: 3000, currency: 'IQD', account_id: usd.id }] });
  assert.equal(app.db.val('SELECT extra_account_id FROM docs WHERE id = ?', [r2.id]), null);
  const d2 = app.docs.get(r2.id);
  assert.equal(code(() => app.docs.save({ ...d2, id: r2.id, lines: d2.lines, costs: undefined, extra_cost: 4000, extra_account_id: null, post: true }, ctx)), 'costs_need_update');
});
