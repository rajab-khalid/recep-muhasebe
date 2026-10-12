'use strict';
/*
 * 3.2.1 sign-in safety: a new PIN signs the other devices out, an admin can sign out one device (a lost phone)
 * or everyone else, a phone signs in only with a PIN of 6 digits or more, and wrong PINs typed from a phone
 * warn the admin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');
const { startServer } = require('../server/index');

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

function freshApp(name, pin = '1234') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rm-sec-${name}-`));
  const app = createApp({ dataDir: dir });
  app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test Shop' }, admin: { full_name: 'Owner', username: 'owner', pin } });
  const owner = app.users.list()[0];
  return { app, owner, ctx: { user: owner, ip: '127.0.0.1' } };
}

function cashier(app, ctx, pin = '4321') {
  const role = app.db.get("SELECT id FROM roles WHERE code = 'sales'");
  const id = app.users.save({ full_name: 'Kasiyer', username: 'kasa', role_id: role.id, pin, can_login: true, active: true }, ctx);
  return app.users.get(id);
}

const signIn = (app, userId, pin, ip = '127.0.0.1', extra = {}) => app.users.login({ user_id: userId, pin, password: pin, ip, ...extra }).token;
const alive = (app, token) => !!app.users.session(token);

test('a new PIN or password signs the user out everywhere else; so does losing the right to sign in', () => {
  const { app, owner, ctx } = freshApp('signout');
  const kasa = cashier(app, ctx);
  const c1 = signIn(app, kasa.id, '4321');
  const c2 = signIn(app, kasa.id, '4321', '100.70.1.9', { offline: true }); // e.g. the phone's own copy
  const o1 = signIn(app, owner.id, '1234');
  const o2 = signIn(app, owner.id, '1234');
  assert.ok(alive(app, c1) && alive(app, c2) && alive(app, o1) && alive(app, o2));

  // the admin gives the cashier a new PIN: the cashier is signed out on every device, the admin is not
  app.users.save({ ...app.users.get(kasa.id), id: kasa.id, pin: '8642' }, { ...ctx, token: o1 });
  assert.ok(!alive(app, c1) && !alive(app, c2), 'the cashier signs in again with the new PIN');
  assert.ok(alive(app, o1) && alive(app, o2));

  // the owner changes their own PIN from one screen: that screen stays, the other one is signed out
  app.users.changeOwnSecret(owner.id, { current: '1234', pin: '9753' }, '127.0.0.1', { token: o1 });
  assert.ok(alive(app, o1), 'the screen that changed it stays signed in');
  assert.ok(!alive(app, o2), 'the other device (a lost phone) does not');

  // the same through the Users screen, on their own record
  const o3 = signIn(app, owner.id, '9753');
  app.users.save({ ...app.users.get(owner.id), id: owner.id, pin: '97531' }, { ...ctx, token: o1 });
  assert.ok(alive(app, o1) && !alive(app, o3));

  // removing the PIN, taking away the right to sign in, or switching the user off: signed out
  let k = signIn(app, kasa.id, '8642');
  app.users.save({ ...app.users.get(kasa.id), id: kasa.id, clear_pin: true, password: 'kasa-sifre' }, ctx);
  assert.ok(!alive(app, k));
  k = signIn(app, kasa.id, 'kasa-sifre');
  app.users.save({ ...app.users.get(kasa.id), id: kasa.id, can_login: false }, ctx);
  assert.ok(!alive(app, k));
  // a session left over for a user who may not sign in is refused anyway
  app.db.insert('sessions', { id: 'x1', token: 'leftover', user_id: kasa.id, created_at: new Date().toISOString(), remember: 0 });
  assert.equal(app.users.session('leftover'), null);

  // a SIFRE-SIFIRLA file signs the admins out everywhere (they come back in on this computer only)
  const o4 = signIn(app, owner.id, '97531');
  fs.writeFileSync(path.join(app.dataDir, 'SIFRE-SIFIRLA'), '');
  assert.equal(app.users.emergencyReset(), 1);
  assert.ok(!alive(app, o1) && !alive(app, o4));
  assert.equal(app.users.get(owner.id).pin_len, null);
});

test('ending sessions with nothing chosen ends nothing; everyone else only when asked for', () => {
  const { app, owner } = freshApp('endnone');
  const t1 = signIn(app, owner.id, '1234');
  const t2 = signIn(app, owner.id, '1234');
  assert.equal(app.users.endSessions({}), 0);
  assert.equal(app.users.endSessions({ id: undefined, userId: '' }), 0);
  assert.equal(app.users.endSessions({ except: t1 }), 0);
  assert.ok(alive(app, t1) && alive(app, t2));
  assert.equal(app.users.endSessions({ all: true, except: t1 }), 1);
  assert.ok(alive(app, t1) && !alive(app, t2));
  assert.equal(app.users.endSessions({ token: t1 }), 1);
  assert.ok(!alive(app, t1));
});

test('a phone signs in only with 6 digits or more; this computer and the phone\'s own copy still take 4', () => {
  const { app, owner, ctx } = freshApp('six');
  const kasa = cashier(app, ctx); // PIN 4321
  const PHONE = '100.70.1.2';

  // the right 4-digit PIN from a phone is not even tried, the user is not paused for it, the phone address counts it
  assert.equal(code(() => signIn(app, kasa.id, '4321', PHONE)), 'remote_pin_short');
  assert.equal(code(() => app.users.login({ username: 'kasa', password: 'abc', ip: PHONE })), 'remote_pin_short');
  assert.equal(app.db.val('SELECT failed_logins FROM users WHERE id = ?', [kasa.id]), 0);
  assert.equal(app.db.val('SELECT count FROM login_failures WHERE ip = ?', [PHONE]), 2);
  const rec = app.db.get("SELECT msg FROM audit_log WHERE action = 'login_failed' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual(JSON.parse(rec.msg), { k: 'login_failed', v: { short: 1 } });
  // an empty secret from a phone is still an ordinary miss
  assert.equal(code(() => app.users.login({ user_id: kasa.id, ip: PHONE })), 'wrong_credentials');

  assert.ok(signIn(app, kasa.id, '4321'), 'this computer');
  assert.ok(signIn(app, kasa.id, '4321', 'offline', { offline: true }), "the phone's own copy, with the shop computer off");

  // the lock screen of a phone that is already signed in still takes the old PIN (no one is shut out)
  assert.equal(app.users.verifyUserSecret(kasa.id, '4321', PHONE), true);

  // a PIN changed from a phone must be long enough to sign in from a phone again; on this computer 4 is fine
  assert.equal(code(() => app.users.changeOwnSecret(kasa.id, { current: '4321', pin: '1357' }, PHONE)), 'new_secret_short');
  assert.equal(code(() => app.users.changeOwnSecret(kasa.id, { current: '4321', password: 'abcde' }, PHONE)), 'new_secret_short');
  app.users.changeOwnSecret(kasa.id, { current: '4321', pin: '135790' }, PHONE);
  assert.ok(signIn(app, kasa.id, '135790', PHONE));
  app.users.changeOwnSecret(kasa.id, { current: '135790', pin: '2468' }, '127.0.0.1');
  assert.equal(app.users.get(kasa.id).pin_len, 4);
  // an admin on a phone may not give themselves a PIN too short for a phone (other users may get one: they
  // may work on the shop computer only)
  const phoneCtx = { user: owner, ip: PHONE };
  assert.equal(code(() => app.users.save({ ...app.users.get(owner.id), id: owner.id, pin: '9876' }, phoneCtx)), 'new_secret_short');
  app.users.save({ ...app.users.get(kasa.id), id: kasa.id, pin: '9876' }, phoneCtx);
  assert.equal(app.users.get(kasa.id).pin_len, 4);
  // a wrong current PIN typed on a phone is recorded like a wrong sign-in
  const before = app.db.val("SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed' AND ip = ?", [PHONE]);
  assert.equal(code(() => app.users.changeOwnSecret(kasa.id, { current: '000000', pin: '135790' }, PHONE)), 'wrong_password');
  assert.equal(app.db.val("SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed' AND ip = ?", [PHONE]), before + 1);

  // an address that keeps trying short PINs is paused like any other (20 tries in a quarter of an hour)
  app.users.save({ ...app.users.get(owner.id), id: owner.id, pin: '864200' }, ctx);
  for (let i = 0; i < 20; i++) code(() => signIn(app, owner.id, '0000', '100.70.1.3'));
  assert.equal(code(() => signIn(app, owner.id, '864200', '100.70.1.3')), 'too_many_attempts_min');
  assert.ok(signIn(app, owner.id, '864200', '100.70.1.4'), 'other phones are not paused');
  assert.equal(app.db.val('SELECT failed_logins FROM users WHERE id = ?', [owner.id]), 0);
});

test('the PIN length is kept when set, learnt when typed, and never shown before signing in', () => {
  const { app, owner, ctx } = freshApp('len', '123456');
  assert.equal(app.users.get(owner.id).pin_len, 6);
  const kasa = cashier(app, ctx, '4321');
  assert.equal(app.users.get(kasa.id).pin_len, 4);
  // a PIN set before 3.2.1 has no length yet: it is learnt the next time it is typed right
  app.db.run('UPDATE users SET pin_len = NULL');
  assert.equal(app.users.get(kasa.id).pin_len, null);
  code(() => signIn(app, kasa.id, '9999'));
  assert.equal(app.users.get(kasa.id).pin_len, null, 'a wrong PIN teaches nothing');
  signIn(app, kasa.id, '4321');
  assert.equal(app.users.get(kasa.id).pin_len, 4);
  app.users.verifyUserSecret(owner.id, '123456', '100.70.1.2');
  assert.equal(app.users.get(owner.id).pin_len, 6);
  // the user list on the sign-in screen (seen before signing in) does not tell it
  assert.ok(app.users.loginUsers().every((u) => !('pin_len' in u)));
  // nor does the activity log of the change
  const rec = app.db.get("SELECT data FROM audit_log WHERE action = 'update' AND entity = 'user' ORDER BY rowid DESC LIMIT 1");
  assert.ok(!rec || !/pin_len/.test(rec.data || ''));
});

/* ------------------------------------------------------------------ over HTTP: the sessions list and phones */
function call(port, { method = 'GET', pathName, body, cookie, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathName,
      headers: {
        host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(method !== 'GET' ? { 'x-requested-with': 'recep' } : {}), ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const viaTailscale = (phoneIp) => ({ host: 'dukkan-pc.tail1a2b3c.ts.net', 'x-forwarded-for': phoneIp, 'x-forwarded-proto': 'https' });
const cookieOf = (r) => String(r.headers['set-cookie'][0]).split(';')[0];

test('an admin sees who is signed in where, signs out a lost phone or everyone else; a removed phone is signed out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-sec-http-'));
  const s = await startServer({ dataDir: dir, port: 23000 + Math.floor(Math.random() * 2000) });
  try {
    s.app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test' }, admin: { full_name: 'Rajab', username: 'rajab', pin: '135790' } });
    const owner = s.app.users.list()[0];
    const login = (headers = {}, user = owner.id, pin = '135790') => call(s.port, { method: 'POST', pathName: '/api/auth/login', headers, body: { user_id: user, pin, password: pin } });
    const me = async (cookie, headers = {}) => (await call(s.port, { pathName: '/api/auth/me', cookie, headers })).json.user;

    const pc = cookieOf(await login()); // the shop computer
    const phone1 = cookieOf(await login(viaTailscale('100.70.1.2')));
    const phone2 = cookieOf(await login(viaTailscale('100.70.1.3')));

    // phone 1 keeps an offline copy: registering links its session to it
    const dev1 = crypto.randomUUID();
    const reg = await call(s.port, { method: 'POST', pathName: '/api/phone/register', cookie: phone1, headers: viaTailscale('100.70.1.2'), body: { device_id: dev1, name: 'Android' } });
    assert.equal(reg.status, 200);

    // the list: no secret tokens, this screen marked, the shop computer and the phone's series named
    const list = await call(s.port, { pathName: '/api/auth/sessions', cookie: pc });
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 3);
    for (const c of [pc, phone1, phone2]) assert.ok(!list.text.includes(c.split('=')[1]), 'tokens never leave the computer');
    const mine = list.json.find((x) => x.current);
    assert.ok(mine && mine.here);
    const p1 = list.json.find((x) => x.ip === '100.70.1.2');
    const p2 = list.json.find((x) => x.ip === '100.70.1.3');
    assert.equal(p1.device_code, 'T1');
    assert.equal(p2.device_code, null);
    assert.ok(p1.id && p2.id && !p1.here);

    // a cashier may not see or end sessions
    const role = s.app.db.get("SELECT id FROM roles WHERE code = 'sales'");
    const kasaId = s.app.users.save({ full_name: 'Kasiyer', role_id: role.id, pin: '2468', can_login: true, active: true }, { user: owner });
    const kasa = cookieOf(await login({}, kasaId, '2468'));
    assert.equal((await call(s.port, { pathName: '/api/auth/sessions', cookie: kasa })).status, 403);
    assert.equal((await call(s.port, { method: 'POST', pathName: `/api/auth/sessions/${p2.id}/end`, cookie: kasa, body: {} })).status, 403);

    // signing out the second phone: it asks for a PIN again; the screen in use cannot sign itself out this way
    const end = await call(s.port, { method: 'POST', pathName: `/api/auth/sessions/${p2.id}/end`, cookie: pc, body: {} });
    assert.equal(end.status, 200);
    assert.equal(await me(phone2, viaTailscale('100.70.1.3')), null);
    assert.ok(await me(phone1, viaTailscale('100.70.1.2')));
    const self = await call(s.port, { method: 'POST', pathName: `/api/auth/sessions/${mine.id}/end`, cookie: pc, body: {} });
    assert.equal(self.status, 400);
    assert.equal(self.json.error.code, 'session_current');
    const gone = await call(s.port, { method: 'POST', pathName: `/api/auth/sessions/${p2.id}/end`, cookie: pc, body: {} });
    assert.equal(gone.status, 404);

    // removing the phone with the copy (it was lost) signs it out as well
    const devRow = s.app.db.get('SELECT id FROM phone_devices WHERE code = ?', ['T1']);
    const rev = await call(s.port, { method: 'POST', pathName: `/api/phone/devices/${devRow.id}/revoke`, cookie: pc, body: {} });
    assert.equal(rev.status, 200);
    assert.equal(rev.json.signed_out, 1);
    assert.equal(await me(phone1, viaTailscale('100.70.1.2')), null);
    assert.ok(await me(pc));
    // signed out, the phone still learns from its sign-in screen that it was removed (and drops its copy)
    const removed = async (id) => (await call(s.port, { pathName: `/api/phone/removed?device=${id}`, headers: viaTailscale('100.70.1.2') })).json.removed;
    assert.equal(await removed(dev1), true);
    assert.equal(await removed(crypto.randomUUID()), false);
    assert.equal(await removed('not-an-id'), false);

    // a session of that phone from before it was linked (e.g. signed in before 3.2.1) is signed out as soon as
    // the phone shows up: at its check-in, or with its next piece of work
    const old1 = cookieOf(await login(viaTailscale('100.70.1.2')));
    const old2 = cookieOf(await login(viaTailscale('100.70.1.2')));
    const st = await call(s.port, { pathName: `/api/phone/state?device=${dev1}`, cookie: old1, headers: viaTailscale('100.70.1.2') });
    assert.equal(st.status, 403);
    assert.equal(st.json.error.code, 'device_revoked');
    assert.equal(await me(old1, viaTailscale('100.70.1.2')), null);
    const opId = crypto.randomUUID();
    const w = await call(s.port, { method: 'POST', pathName: '/api/partners', cookie: old2, headers: { ...viaTailscale('100.70.1.2'), 'x-op-id': opId, 'x-device-id': dev1 }, body: { kind: 'customer', name: 'Kayıp telefondan' } });
    assert.equal(w.status, 403);
    assert.equal(w.json.error.code, 'device_revoked');
    assert.equal(await me(old2, viaTailscale('100.70.1.2')), null);
    assert.equal(s.app.db.val("SELECT COUNT(*) FROM partners WHERE name = 'Kayıp telefondan'"), 0, 'the work was not done');

    // a phone with a copy names itself when signing in; one signed in before 3.2.1 is matched at its next check-in
    const reg2 = crypto.randomUUID();
    const p3 = cookieOf(await login(viaTailscale('100.70.1.4')));
    assert.equal((await call(s.port, { method: 'POST', pathName: '/api/phone/register', cookie: p3, headers: viaTailscale('100.70.1.4'), body: { device_id: reg2, name: 'iPhone' } })).status, 200);
    const p4 = cookieOf(await login({ ...viaTailscale('100.70.1.4'), 'x-device-id': reg2 }));
    const p5 = cookieOf(await login(viaTailscale('100.70.1.4')));
    s.app.db.run('UPDATE sessions SET device_id = NULL WHERE token = ?', [p5.split('=')[1]]);
    assert.equal((await call(s.port, { pathName: `/api/phone/state?device=${reg2}`, cookie: p5, headers: viaTailscale('100.70.1.4') })).status, 200);
    const linked = s.app.db.all('SELECT token FROM sessions WHERE device_id = ?', [reg2]).map((r) => `rm_sid=${r.token}`).sort();
    assert.deepEqual(linked, [p3, p4, p5].sort());
    // an unknown or removed phone id at sign-in links nothing
    const p6 = cookieOf(await login({ ...viaTailscale('100.70.1.5'), 'x-device-id': dev1 }));
    assert.equal(s.app.db.val('SELECT device_id FROM sessions WHERE token = ?', [p6.split('=')[1]]), null);

    // sessions made before 3.2.1 get a public id when listed
    s.app.db.run('UPDATE sessions SET id = NULL WHERE token = ?', [p6.split('=')[1]]);
    const again = await call(s.port, { pathName: '/api/auth/sessions', cookie: pc });
    assert.ok(again.json.every((x) => x.id));

    // everyone else at once; the screen asking stays; the change token does not move for it
    const tokenBefore = s.app.changeToken();
    const all = await call(s.port, { method: 'POST', pathName: '/api/auth/sessions/end-others', cookie: pc, body: {} });
    assert.equal(all.status, 200);
    assert.ok(all.json.n >= 4);
    assert.ok(await me(pc));
    for (const c of [p3, p4, p5, p6, kasa]) assert.equal(await me(c), null);
    assert.equal(s.app.changeToken(), tokenBefore);
    assert.equal(s.app.db.val("SELECT COUNT(*) FROM audit_log WHERE action = 'sign_out'"), 2);

    // set up from a phone: the admin PIN must be long enough to sign in from a phone afterwards
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-sec-setup-'));
    const s2 = await startServer({ dataDir: dir2, port: 25000 + Math.floor(Math.random() * 2000) });
    try {
      const body = (pin) => ({ lang: 'tr', usd_iqd: 1500, company: { name: 'X' }, admin: { full_name: 'A', username: 'a', pin } });
      const bad = await call(s2.port, { method: 'POST', pathName: '/api/setup/complete', headers: viaTailscale('100.70.9.9'), body: body('1234') });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'remote_pin_short');
      assert.equal(s2.app.setup.isDone(), false, 'nothing was set up');
      for (const pin of ['123456789', 'abcdefgh']) {
        const odd = await call(s2.port, { method: 'POST', pathName: '/api/setup/complete', headers: viaTailscale('100.70.9.9'), body: body(pin) });
        assert.equal(odd.json.error.code, 'remote_pin_short', `${pin} would not be kept as a PIN`);
        assert.equal(s2.app.setup.isDone(), false);
      }
      const ok = await call(s2.port, { method: 'POST', pathName: '/api/setup/complete', headers: viaTailscale('100.70.9.9'), body: body('123456') });
      assert.equal(ok.status, 200);
      assert.ok(String(ok.headers['set-cookie']).includes('rm_sid='));
    } finally { await s2.close(); }
  } finally {
    await s.close();
  }
});

test('wrong PINs typed from a phone warn the admin once they pause a user or an address', () => {
  const { app, owner, ctx } = freshApp('warn', '123456');
  const kasa = cashier(app, ctx, '432100');
  const PHONE = '100.70.1.2';
  const warnings = (u = owner) => app.reports.notifications(app.users.get(u.id)).filter((n) => n.kind === 'login_fails');

  for (let i = 0; i < 4; i++) code(() => signIn(app, kasa.id, '000000', PHONE));
  assert.equal(warnings().length, 0, 'a few typing mistakes are no warning');
  code(() => signIn(app, kasa.id, '000000', PHONE)); // the 5th: the user is paused
  let w = warnings();
  assert.equal(w.length, 1);
  assert.equal(w[0].name, 'Kasiyer');
  assert.equal(w[0].value, 5);
  assert.equal(w[0].ip, PHONE);
  assert.equal(w[0].level, 'danger');
  assert.equal(w[0].read, false);
  assert.equal(w[0].agent, null, 'a device that never signed in here is unknown');
  // only for those who manage users
  assert.equal(warnings(kasa).length, 0);
  // misses typed on the shop computer itself are not a phone warning
  for (let i = 0; i < 5; i++) code(() => signIn(app, owner.id, '1111', '127.0.0.1'));
  assert.equal(warnings().length, 1);
  // read: it stays read until the next pause brings it back
  app.reports.markRead(app.users.get(owner.id), [w[0].key]);
  assert.equal(warnings()[0].read, true);
  app.db.run('UPDATE users SET locked_until = NULL WHERE id = ?', [kasa.id]);
  for (let i = 0; i < 5; i++) code(() => signIn(app, kasa.id, '000000', PHONE));
  w = warnings();
  assert.equal(w.length, 1);
  assert.equal(w[0].read, false);
  assert.equal(w[0].value, 10);
  // the phone is named once it has signed in here
  app.db.run('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?', [kasa.id]);
  app.users.login({ user_id: kasa.id, pin: '432100', ip: PHONE, agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' });
  assert.match(warnings()[0].agent, /Android/);
  // the phone's own copy (shop computer off) is never counted as a phone on the network
  app.db.run("UPDATE audit_log SET ip = 'offline' WHERE action = 'login_failed'");
  assert.equal(warnings().length, 0);
});
