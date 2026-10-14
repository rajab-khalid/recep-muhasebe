'use strict';
/*
 * The phone's offline copy: the copy the shop computer gives, work done on the phone without the computer,
 * and that work replayed on the computer (same ids, numbers and dates; once only; edits of records changed
 * meanwhile kept as problems). The phone side runs the real packed engine on top of node:sqlite here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startServer } = require('../server/index');
const { engine } = require('../server/phone/bundle');
const oo1 = require('./helpers/oo1');

const PIN = '1357';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-offline-'));

async function loadModules() {
  const e = path.join(tmpDir, `engine-${engine().hash}.mjs`);
  fs.writeFileSync(e, engine().code);
  const c = path.join(tmpDir, 'core.mjs');
  fs.writeFileSync(c, fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'engine', 'core.js'), 'utf8'));
  return { engineModule: await import(pathToFileURL(e).href), core: await import(pathToFileURL(c).href) };
}

function call(port, { method = 'GET', pathName, body, cookie, headers = {}, raw = false }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathName,
      headers: {
        host: `127.0.0.1:${port}`, 'accept-encoding': 'gzip', ...(cookie ? { cookie } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(method !== 'GET' ? { 'x-requested-with': 'recep' } : {}), ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        let json = null;
        if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ } }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** the shop computer, set up with an owner who has a PIN, plus some stock to sell */
async function shop() {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'pc-'));
  const s = await startServer({ dataDir: dir, port: 21000 + Math.floor(Math.random() * 3000) });
  s.app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Şêrwan' }, admin: { full_name: 'Rajab', username: 'rajab', pin: PIN } });
  const owner = s.app.users.list()[0];
  const ctx = { user: owner };
  const pid = s.app.products.save({ name: 'Cila', currency: 'IQD', prices: {}, cost_price: 0 }, ctx);
  const supplier = s.app.partners.save({ name: 'Toptancı', kind: 'supplier' }, ctx);
  s.app.docs.save({ type: 'purchase', partner_id: supplier, currency: 'IQD', post: true, lines: [{ product_id: pid, qty: 20, unit_price: 3000 }] }, ctx);
  const login = await call(s.port, { method: 'POST', pathName: '/api/auth/login', body: { user_id: owner.id, pin: PIN } });
  assert.equal(login.status, 200);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  return { s, owner, pid, cookie, dir };
}

/** the phone takes a copy: register, download, open it with the engine, as the phone app does */
async function takeCopy(t, mods, deviceId) {
  const reg = await call(t.s.port, { method: 'POST', pathName: '/api/phone/register', cookie: t.cookie, body: { device_id: deviceId, name: 'iPhone' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const snap = await call(t.s.port, { pathName: `/api/phone/snapshot?device=${deviceId}`, cookie: t.cookie, raw: true });
  assert.equal(snap.status, 200);
  assert.equal(snap.headers['x-rm-series'], reg.json.code);
  assert.equal(snap.buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  const file = path.join(tmpDir, `phone-${crypto.randomUUID()}.db`);
  fs.writeFileSync(file, snap.buf);
  const raw = oo1.open(file);
  mods.core.writeMeta(raw, { phone_series: reg.json.code, phone_owner: t.owner.id, phone_token: snap.headers['x-rm-token'], phone_device: deviceId });
  const core = mods.core.createCore({ engineModule: mods.engineModule, raw, agent: 'test-phone' });
  return { core, raw, file, code: reg.json.code, token: snap.headers['x-rm-token'] };
}

async function phoneLogin(core, userId) {
  const r = await core.request({ method: 'POST', path: '/api/auth/login', body: { user_id: userId, pin: PIN } });
  assert.equal(r.status, 200, JSON.stringify(r.error));
  assert.ok(r.session);
  return r.session;
}

test('the copy for the phone leaves out sessions, other users\' PINs and product photos', async () => {
  const t = await shop();
  try {
    const ctx = { user: t.owner };
    // a second user with a PIN, a product photo and the shop logo
    const role = t.s.app.db.get("SELECT id FROM roles WHERE code = 'sales'");
    t.s.app.users.save({ full_name: 'Kasiyer', role_id: role.id, pin: '2468' }, ctx);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const logo = t.s.app.files.saveDataUrl(png, 'logo');
    t.s.app.patchSetting('company', { logo_file_id: logo });
    t.s.app.files.saveDataUrl(png, 'photo');
    const mods = await loadModules();
    const p = await takeCopy(t, mods, crypto.randomUUID());
    const users = p.raw.raw.prepare('SELECT full_name, pin_hash, password_hash, pin_len FROM users').all();
    assert.equal(users.length, 2);
    assert.ok(users.find((u) => u.full_name === 'Rajab').pin_hash, 'the owner can sign in on the phone');
    assert.equal(users.find((u) => u.full_name === 'Kasiyer').pin_hash, null, 'other users\' PINs never leave the computer');
    assert.equal(users.find((u) => u.full_name === 'Kasiyer').pin_len, null, 'nor their length');
    assert.equal(p.raw.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.deepEqual(p.raw.raw.prepare('SELECT id FROM files').all().map((r) => r.id), [logo], 'only the logo is copied');
    assert.equal(p.raw.raw.prepare("SELECT COUNT(*) AS n FROM phone_devices").get().n, 0);
    // the owner signs in on the copy with the 4-digit PIN (the 6-digit rule is for the network only); who is
    // signed in to the shop computer is not something the copy can tell
    const tok = await phoneLogin(p.core, t.owner.id);
    const sess = await p.core.request({ method: 'GET', path: '/api/auth/sessions', token: tok });
    assert.equal(sess.status, 409);
    assert.equal(sess.error.code, 'needs_online');
    // only the owner, and only a registered phone
    const other = await call(t.s.port, { pathName: `/api/phone/snapshot?device=${crypto.randomUUID()}`, cookie: t.cookie, raw: true });
    assert.equal(other.status, 404);
  } finally { await t.s.close(); }
});

test('work done on the phone offline reaches the computer with the same ids, numbers and dates, once', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const p = await takeCopy(t, mods, deviceId);
    assert.equal(p.code, 'T1');
    const token = await phoneLogin(p.core, t.owner.id);
    const req = (method, pth, body, query) => p.core.request({ method, path: pth, body, query, token });

    // wrong PIN on the phone
    const bad = await p.core.request({ method: 'POST', path: '/api/auth/login', body: { user_id: t.owner.id, pin: '0000' } });
    assert.equal(bad.status, 401);

    // a new customer, a credit sale to them, then a part payment — all offline
    const cust = await req('POST', '/api/partners', { name: 'Ahmed Zaxoyî', kind: 'customer', phone: '0750' });
    assert.equal(cust.status, 200, JSON.stringify(cust.error));
    const acc = t.s.app.db.get("SELECT id FROM money_accounts WHERE type = 'cash' AND currency = 'IQD'");
    const sale = await req('POST', '/api/docs', { type: 'sale', partner_id: cust.data.id, currency: 'IQD', post: true, usd_iqd: 1500, lines: [{ product_id: t.pid, qty: 2, unit_price: 10000 }] });
    assert.equal(sale.status, 200, JSON.stringify(sale.error));
    assert.equal(sale.data.no, `SF${new Date().getFullYear()}-T1-0001`, 'offline invoices have the phone\'s own series');
    const pay = await req('POST', '/api/payments', { direction: 'in', partner_id: cust.data.id, account_id: acc.id, amount: 5000, allocations: [{ doc_id: sale.data.id, amount: 5000 }] });
    assert.equal(pay.status, 200, JSON.stringify(pay.error));
    // the phone shows its own work at once
    const local = await req('GET', `/api/partners/${cust.data.id}`);
    assert.equal(local.data.balances.IQD, 15000);
    const list = await req('GET', '/api/docs', undefined, { type: 'sale' });
    assert.ok(list.data.rows.some((r) => r.id === sale.data.id));
    // admin work needs the computer
    const setting = await req('POST', '/api/settings/pos', { allow_negative_stock: false });
    assert.equal(setting.status, 409);
    assert.equal(setting.error.code, 'needs_online');
    assert.equal(p.core.pendingCount(), 3);

    const ops = p.core.pending();
    assert.deepEqual(ops.map((o) => o.path), ['/api/partners', '/api/docs', '/api/payments']);
    assert.ok(ops[1].uuids.some(([table, id]) => table === 'docs' && id === sale.data.id), 'ids are kept with the table they are for');
    // a few hours pass before the computer is reached: the work keeps its own time
    const sync = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops } });
    assert.equal(sync.status, 200, JSON.stringify(sync.json));
    assert.deepEqual(sync.json.results.map((r) => r.status), ['applied', 'applied', 'applied'], JSON.stringify(sync.json.results));

    const app = t.s.app;
    const pc = app.docs.get(sale.data.id);
    assert.equal(pc.no, sale.data.no, 'same number on the computer');
    assert.equal(pc.partner_id, cust.data.id, 'same customer record');
    assert.equal(pc.date, ops[1].day);
    assert.equal(pc.created_at, ops[1].ts, 'the time the sale was made on the phone');
    assert.equal(pc.paid, 5000);
    assert.equal(app.partners.balances(cust.data.id).IQD, 15000);
    assert.equal(app.db.get('SELECT no FROM payments WHERE id = ?', [pay.data.id]).no, pay.data.no);
    assert.equal(app.db.get("SELECT last_no FROM sequences WHERE key = ?", [`sale:${new Date().getFullYear()}:T1`]).last_no, 1, 'the phone series goes on from here');
    assert.equal(app.db.get("SELECT ip FROM audit_log WHERE entity = 'doc' AND entity_id = ?", [sale.data.id]).ip, 'telefon:T1');

    // the phone lost the answer and sends the same work again: nothing is applied twice
    const again = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops } });
    assert.deepEqual(again.json.results.map((r) => r.status), ['duplicate', 'duplicate', 'duplicate']);
    assert.equal(app.db.val('SELECT COUNT(*) FROM docs WHERE no = ?', [sale.data.no]), 1);
    assert.deepEqual(p.core.settle(again.json.results), { applied: 3, problems: 0 });
    assert.equal(p.core.pendingCount(), 0);

    // the next copy continues the series
    const p2 = await takeCopy(t, mods, deviceId);
    const token2 = await phoneLogin(p2.core, t.owner.id);
    const next = await p2.core.request({ method: 'GET', path: '/api/docs/next-no', query: { type: 'sale' }, token: token2 });
    assert.equal(next.data.no, `SF${new Date().getFullYear()}-T1-0002`);
  } finally { await t.s.close(); }
});

test('a purchase with customs and freight made on the phone offline reaches the computer with the same costs', async () => {
  const t = await shop();
  try {
    const app = t.s.app;
    const carrier = app.partners.save({ kind: 'supplier', name: 'Habur Nakliyat' }, { user: t.owner });
    const supplier = app.db.get("SELECT id FROM partners WHERE name = 'Toptancı'").id;
    const cash = app.db.get("SELECT id FROM money_accounts WHERE type = 'cash' AND currency = 'IQD'");
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    const r = await p.core.request({
      method: 'POST', path: '/api/docs', token, body: {
        type: 'purchase', partner_id: supplier, currency: 'IQD', usd_iqd: 1500, post: true, cost_split: 'qty',
        lines: [{ product_id: t.pid, qty: 5, unit_price: 3000 }],
        costs: [{ kind: 'customs', amount: 5000, currency: 'IQD', account_id: cash.id }, { kind: 'freight', amount: 2, currency: 'USD', partner_id: carrier }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    const onPhone = p.raw.raw.prepare('SELECT id, kind, amount, currency, account_id, partner_id FROM doc_costs WHERE doc_id = ? ORDER BY sort').all(r.data.id).map((x) => ({ ...x }));
    assert.equal(onPhone.length, 2);
    const ops = p.core.pending();
    const sync = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops } });
    assert.deepEqual(sync.json.results.map((x) => x.status), ['applied'], JSON.stringify(sync.json.results));
    const onPc = app.db.all('SELECT id, kind, amount, currency, account_id, partner_id FROM doc_costs WHERE doc_id = ? ORDER BY sort', [r.data.id]).map((x) => ({ ...x }));
    assert.deepEqual(onPc, onPhone, 'same cost rows, same ids');
    // 5.000 IQD + $2 (3.000 IQD) over 5 units: 1.600 IQD on each, paid from the cash box and owed to the carrier
    const line = app.db.get('SELECT unit_cost_usd FROM doc_lines WHERE doc_id = ?', [r.data.id]);
    assert.ok(Math.abs(line.unit_cost_usd - (3000 + 1600) / 1500) < 1e-6, String(line.unit_cost_usd));
    assert.equal(app.db.val("SELECT SUM(amount) FROM money_moves WHERE doc_id = ? AND kind = 'purchase_extra' AND voided = 0", [r.data.id]), -5000);
    assert.deepEqual(app.partners.balances(carrier), { USD: -2 });
  } finally { await t.s.close(); }
});

test('an edit of a record changed on the computer meanwhile is kept as a problem; the owner can apply it anyway', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const cust = t.s.app.partners.save({ name: 'Hevî', kind: 'customer', phone: '111' }, { user: t.owner });
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    const before = await p.core.request({ method: 'GET', path: `/api/partners/${cust}`, token });
    const edit = await p.core.request({ method: 'POST', path: '/api/partners', token, body: { ...before.data, phone: '222' } });
    assert.equal(edit.status, 200, JSON.stringify(edit.error));
    // meanwhile at the shop
    await new Promise((r) => setTimeout(r, 5));
    t.s.app.partners.save({ id: cust, name: 'Hevî', kind: 'customer', phone: '333' }, { user: t.owner });

    const res = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.equal(res.json.results[0].status, 'conflict');
    assert.equal(t.s.app.db.get('SELECT phone FROM partners WHERE id = ?', [cust]).phone, '333', 'the computer\'s change stays');
    p.core.settle(res.json.results);
    const probs = await call(t.s.port, { pathName: `/api/phone/problems?device=${deviceId}`, cookie: t.cookie });
    assert.equal(probs.json.length, 1);
    assert.equal(probs.json[0].error.code, 'changed_on_pc');
    assert.equal(probs.json[0].label.action, 'update');
    // the owner decides the phone's version is right
    const retry = await call(t.s.port, { method: 'POST', pathName: `/api/phone/problems/${probs.json[0].id}/retry`, cookie: t.cookie, body: { force: true } });
    assert.equal(retry.json.status, 'applied', JSON.stringify(retry.json));
    assert.equal(t.s.app.db.get('SELECT phone FROM partners WHERE id = ?', [cust]).phone, '222');
    const none = await call(t.s.port, { pathName: `/api/phone/problems?device=${deviceId}`, cookie: t.cookie });
    assert.equal(none.json.length, 0);
  } finally { await t.s.close(); }
});

test('work that cannot be applied is listed, keeps its number taken, and can be dismissed', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const cust = t.s.app.partners.save({ name: 'Ciwan', kind: 'customer' }, { user: t.owner });
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    const sale = await p.core.request({ method: 'POST', path: '/api/docs', token, body: { type: 'sale', partner_id: cust, currency: 'IQD', post: true, lines: [{ product_id: t.pid, qty: 1, unit_price: 9000 }] } });
    assert.equal(sale.status, 200, JSON.stringify(sale.error));
    // the sale is cancelled on the phone too, but at the shop the same invoice number was typed by hand meanwhile
    t.s.app.docs.save({ type: 'sale', no: sale.data.no, partner_id: cust, currency: 'IQD', post: true, lines: [{ product_id: t.pid, qty: 1, unit_price: 9000 }] }, { user: t.owner });
    const res = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.equal(res.json.results[0].status, 'failed');
    assert.equal(res.json.results[0].error.code, 'number_taken');
    assert.equal(t.s.app.db.get('SELECT last_no FROM sequences WHERE key = ?', [`sale:${new Date().getFullYear()}:T1`]).last_no, 1);
    const probs = await call(t.s.port, { pathName: '/api/phone/problems', cookie: t.cookie });
    assert.equal(probs.json.length, 1);
    const dis = await call(t.s.port, { method: 'POST', pathName: `/api/phone/problems/${probs.json[0].id}/dismiss`, cookie: t.cookie, body: {} });
    assert.equal(dis.status, 200);
    assert.equal((await call(t.s.port, { pathName: '/api/phone/problems', cookie: t.cookie })).json.length, 0);
    // sent again by a phone that lost the answer: stays dismissed
    const again = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.equal(again.json.results[0].status, 'dismissed');
  } finally { await t.s.close(); }
});

test('a write sent online with an id is not applied twice when the phone replays it after a lost answer', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    const opId = crypto.randomUUID();
    // online: reaches the computer, the answer is lost
    const online = await call(t.s.port, { method: 'POST', pathName: '/api/partners', cookie: t.cookie, headers: { 'x-op-id': opId, 'x-device-id': deviceId }, body: { name: 'Dilan', kind: 'customer' } });
    assert.equal(online.status, 200);
    // the phone does it again on its copy with the same id, and later sends it
    const local = await p.core.request({ method: 'POST', path: '/api/partners', token, opId, body: { name: 'Dilan', kind: 'customer' } });
    assert.equal(local.status, 200);
    const res = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.equal(res.json.results[0].status, 'duplicate');
    assert.equal(t.s.app.db.val("SELECT COUNT(*) FROM partners WHERE name = 'Dilan'"), 1);
    // the same id online again (the phone asks again after a lost answer): the first answer, nothing done twice
    const twice = await call(t.s.port, { method: 'POST', pathName: '/api/partners', cookie: t.cookie, headers: { 'x-op-id': opId }, body: { name: 'Dilan', kind: 'customer' } });
    assert.equal(twice.status, 200);
    assert.equal(twice.headers['x-op-duplicate'], '1');
    assert.equal(twice.json.id, online.json.id, 'the answer kept from the first time');
    assert.equal(t.s.app.db.val("SELECT COUNT(*) FROM partners WHERE name = 'Dilan'"), 1);
    // a write the phone cannot do offline is recognised the same way
    const op2 = crypto.randomUUID();
    const pl1 = await call(t.s.port, { method: 'POST', pathName: '/api/price-lists', cookie: t.cookie, headers: { 'x-op-id': op2 }, body: { name: 'Usta listesi' } });
    const pl2 = await call(t.s.port, { method: 'POST', pathName: '/api/price-lists', cookie: t.cookie, headers: { 'x-op-id': op2 }, body: { name: 'Usta listesi' } });
    assert.equal(pl2.json.id, pl1.json.id);
    assert.equal(t.s.app.db.val("SELECT COUNT(*) FROM price_lists WHERE name = 'Usta listesi'"), 1);
    // and sign-in is never answered from a record
    const l2 = await call(t.s.port, { method: 'POST', pathName: '/api/auth/login', headers: { 'x-op-id': op2 }, body: { user_id: t.owner.id, pin: PIN } });
    assert.ok(l2.headers['set-cookie'], 'a real sign-in, with its cookie');
  } finally { await t.s.close(); }
});

test('the change token moves with the data, and only the owner may keep a copy', async () => {
  const t = await shop();
  try {
    const deviceId = crypto.randomUUID();
    await call(t.s.port, { method: 'POST', pathName: '/api/phone/register', cookie: t.cookie, body: { device_id: deviceId } });
    const a = await call(t.s.port, { pathName: `/api/phone/state?device=${deviceId}`, cookie: t.cookie });
    const b = await call(t.s.port, { pathName: `/api/phone/state?device=${deviceId}`, cookie: t.cookie });
    assert.equal(a.json.token, b.json.token, 'reading changes nothing');
    await call(t.s.port, { method: 'POST', pathName: '/api/partners', cookie: t.cookie, body: { name: 'Nû', kind: 'customer' } });
    const c = await call(t.s.port, { pathName: `/api/phone/state?device=${deviceId}`, cookie: t.cookie });
    assert.notEqual(c.json.token, a.json.token);
    // a cashier cannot take the shop's data home
    const role = t.s.app.db.get("SELECT id FROM roles WHERE code = 'sales'");
    const uid = t.s.app.users.save({ full_name: 'Kasiyer', role_id: role.id, pin: '2468' }, { user: t.owner });
    const login = await call(t.s.port, { method: 'POST', pathName: '/api/auth/login', body: { user_id: uid, pin: '2468' } });
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const reg = await call(t.s.port, { method: 'POST', pathName: '/api/phone/register', cookie, body: { device_id: crypto.randomUUID() } });
    assert.equal(reg.status, 403);
    assert.equal(reg.json.error.code, 'offline_owner_only');
    // a removed phone gets nothing more
    await call(t.s.port, { method: 'POST', pathName: `/api/phone/devices/${deviceId}/revoke`, cookie: t.cookie, body: {} });
    const gone = await call(t.s.port, { pathName: `/api/phone/snapshot?device=${deviceId}`, cookie: t.cookie, raw: true });
    assert.equal(gone.status, 403);
  } finally { await t.s.close(); }
});

test('engine and file list are served with tags; the engine runs the program\'s own code', async () => {
  const t = await shop();
  try {
    const e = await call(t.s.port, { pathName: '/phone/engine.js', raw: true });
    assert.equal(e.status, 200);
    assert.match(e.headers['content-type'], /javascript/);
    const again = await call(t.s.port, { pathName: '/phone/engine.js', headers: { 'if-none-match': e.headers.etag }, raw: true });
    assert.equal(again.status, 304);
    const files = await call(t.s.port, { pathName: '/app-files.json' });
    assert.ok(files.json.files.includes('/index.html'));
    assert.ok(files.json.files.includes('/phone/engine.js'));
    assert.ok(files.json.files.includes('/vendor/sqlite/sqlite3.wasm'));
    assert.match(files.json.hash, /^[0-9a-f]{20}$/);
    // the browser scrypt is the same as the computer's
    const mods = await loadModules();
    const salt = crypto.randomBytes(16);
    const mine = Buffer.from(mods.engineModule.internals.scrypt(new TextEncoder().encode('2580'), new Uint8Array(salt), 16384, 8, 1, 32));
    assert.ok(mine.equals(crypto.scryptSync('2580', salt, 32, { N: 16384, r: 8, p: 1 })));
  } finally { await t.s.close(); }
});

test('a different number of records made on the computer does not move the phone\'s ids onto other records', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const ctx = { user: t.owner };
    const app = t.s.app;
    const cust = app.partners.save({ name: 'Rêber', kind: 'customer' }, ctx);
    const pB = app.products.save({ name: 'Wax', currency: 'IQD' }, ctx);
    const pC = app.products.save({ name: 'Polish', currency: 'IQD' }, ctx);
    const sup = app.db.get("SELECT id FROM partners WHERE kind = 'supplier'").id;
    app.docs.save({ type: 'purchase', partner_id: sup, currency: 'IQD', post: true, lines: [{ product_id: pB, qty: 5, unit_price: 1000 }, { product_id: pC, qty: 5, unit_price: 1000 }] }, ctx);
    const deviceId = crypto.randomUUID();
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    // offline: a 3-line sale for a car the phone does not know yet (the phone makes a vehicle record)
    const sale = await p.core.request({ method: 'POST', path: '/api/docs', token, body: {
      type: 'sale', partner_id: cust, currency: 'IQD', post: true, vehicle_plate: '34 ABC 123',
      lines: [{ product_id: t.pid, qty: 2, unit_price: 9000 }, { product_id: pB, qty: 1, unit_price: 3000 }, { product_id: pC, qty: 1, unit_price: 3000 }],
    } });
    assert.equal(sale.status, 200, JSON.stringify(sale.error));
    const lineA = sale.data.lines.find((l) => l.product_id === t.pid);
    // and a return of the first product from it
    const ret = await p.core.request({ method: 'POST', path: '/api/docs', token, body: {
      type: 'sale_return', partner_id: cust, currency: 'IQD', post: true, ref_doc_id: sale.data.id,
      lines: [{ product_id: t.pid, qty: 1, unit_price: 9000, ref_line_id: lineA.id }],
    } });
    assert.equal(ret.status, 200, JSON.stringify(ret.error));
    // meanwhile the same car was registered at the shop: there the sale makes no vehicle record
    app.vehicles.save({ plate: '34 ABC 123', partner_id: cust }, ctx);
    const res = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.deepEqual(res.json.results.map((r) => r.status), ['applied', 'applied'], JSON.stringify(res.json.results));
    const pcSale = app.docs.get(sale.data.id);
    assert.deepEqual(pcSale.lines.map((l) => l.id).sort(), sale.data.lines.map((l) => l.id).sort(), 'the sale\'s lines keep the phone\'s ids');
    const pcRet = app.docs.get(ret.data.id);
    const refLine = app.db.get('SELECT product_id FROM doc_lines WHERE id = ?', [pcRet.lines[0].ref_line_id]);
    assert.equal(refLine.product_id, t.pid, 'the return points at the line of the product returned');
    assert.equal(app.docs.get(sale.data.id).lines.find((l) => l.product_id === t.pid).returned_qty, 1);
  } finally { await t.s.close(); }
});

test('a write redone on the phone after a lost answer gets the same record ids the computer gave it', async () => {
  const t = await shop();
  try {
    const mods = await loadModules();
    const deviceId = crypto.randomUUID();
    const cust = t.s.app.partners.save({ name: 'Azad', kind: 'customer' }, { user: t.owner });
    const p = await takeCopy(t, mods, deviceId);
    const token = await phoneLogin(p.core, t.owner.id);
    const opId = crypto.randomUUID();
    const body = { type: 'sale', partner_id: cust, currency: 'IQD', post: true, lines: [{ product_id: t.pid, qty: 1, unit_price: 9000 }] };
    const online = await call(t.s.port, { method: 'POST', pathName: '/api/docs', cookie: t.cookie, headers: { 'x-op-id': opId, 'x-device-id': deviceId }, body });
    assert.equal(online.status, 200);
    const local = await p.core.request({ method: 'POST', path: '/api/docs', token, opId, body });
    assert.equal(local.status, 200, JSON.stringify(local.error));
    assert.equal(local.data.id, online.json.id, 'same id on the phone and the computer');
    // later offline work for that sale
    const acc = t.s.app.db.get("SELECT id FROM money_accounts WHERE type = 'cash' AND currency = 'IQD'");
    const pay = await p.core.request({ method: 'POST', path: '/api/payments', token, body: { direction: 'in', partner_id: cust, account_id: acc.id, amount: 4000, allocations: [{ doc_id: local.data.id, amount: 4000 }] } });
    assert.equal(pay.status, 200, JSON.stringify(pay.error));
    const res = await call(t.s.port, { method: 'POST', pathName: '/api/phone/sync', cookie: t.cookie, body: { device_id: deviceId, ops: p.core.pending() } });
    assert.deepEqual(res.json.results.map((r) => r.status), ['duplicate', 'applied'], JSON.stringify(res.json.results));
    assert.equal(t.s.app.db.val('SELECT COUNT(*) FROM docs WHERE partner_id = ?', [cust]), 1, 'the sale exists once');
    assert.equal(t.s.app.docs.get(online.json.id).paid, 4000, 'the payment found the sale');
    // the number the phone gave the redo is not handed out again
    const key = `sale:${new Date().getFullYear()}:${p.code}`;
    assert.equal(t.s.app.db.get('SELECT last_no FROM sequences WHERE key = ?', [key]).last_no, 1);
  } finally { await t.s.close(); }
});
