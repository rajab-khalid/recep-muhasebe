'use strict';
/* HTTP server rules: allowed host names, the phone app's Tailscale address, file caching. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { startServer, hostAllowed, clientOf } = require('../server/index');

test('host names: IPs, this computer and Tailscale names only', () => {
  assert.equal(hostAllowed('127.0.0.1:8642'), true);
  assert.equal(hostAllowed('192.168.1.20:8642'), true);
  assert.equal(hostAllowed('localhost:8642'), true);
  assert.equal(hostAllowed('[::1]:8642'), true);
  assert.equal(hostAllowed(`${os.hostname()}:8642`), true);
  assert.equal(hostAllowed('dukkan-pc.tail1a2b3c.ts.net'), true);
  assert.equal(hostAllowed('dukkan-pc.tail1a2b3c.ts.net:443'), true);
  assert.equal(hostAllowed('DUKKAN-PC.Tail1a2b3c.TS.NET'), true);
  assert.equal(hostAllowed('tail1a2b3c.ts.net'), false, 'a tailnet name alone is not a device');
  assert.equal(hostAllowed('ts.net'), false);
  assert.equal(hostAllowed('pc.tail1.ts.net.evil.com'), false);
  assert.equal(hostAllowed('evil-ts.net'), false);
  assert.equal(hostAllowed('pc.evil.com'), false);
  assert.equal(hostAllowed('-bad.tail1.ts.net'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed(undefined), false);
});

test('client address: requests passed on by Tailscale are never "this computer"', () => {
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  assert.deepEqual(clientOf(req('::ffff:127.0.0.1', { host: '127.0.0.1:8642' })), { ip: '127.0.0.1', proxied: false, https: false });
  assert.deepEqual(clientOf(req('192.168.1.7', { host: '192.168.1.20:8642', 'x-forwarded-for': '1.2.3.4' })), { ip: '192.168.1.7', proxied: false, https: false },
    'a PC on the network cannot pretend to be someone else');
  assert.deepEqual(clientOf(req('127.0.0.1', { host: 'pc.tail1.ts.net', 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' })),
    { ip: '100.101.102.103', proxied: true, https: true });
  assert.deepEqual(clientOf(req('::1', { host: 'pc.tail1.ts.net', 'x-forwarded-for': 'fd7a:115c:a1e0::5', 'x-forwarded-proto': 'https' })),
    { ip: 'fd7a:115c:a1e0::5', proxied: true, https: true });
  // a forwarded "127.0.0.1" or junk never becomes the local computer
  assert.equal(clientOf(req('127.0.0.1', { host: '127.0.0.1:8642', 'x-forwarded-for': '127.0.0.1' })).ip, 'proxy');
  assert.equal(clientOf(req('127.0.0.1', { host: '127.0.0.1:8642', 'x-forwarded-for': '::ffff:127.0.0.1' })).ip, 'proxy');
  assert.equal(clientOf(req('127.0.0.1', { host: 'pc.tail1.ts.net' })).ip, 'proxy');
  assert.equal(clientOf(req('127.0.0.1', { host: '127.0.0.1', 'tailscale-user-login': 'a@b.c' })).proxied, true);
  assert.equal(clientOf(req('127.0.0.1', { host: '127.0.0.1', 'x-forwarded-for': '<script>' })).ip, 'proxy');
  assert.equal(clientOf(req('', {})), null);
});

function request(port, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathName,
      headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length, 'x-requested-with': 'recep' } : {}), ...headers },
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

test('phone app over Tailscale: no sign-in without a PIN, secure cookie, misses counted per phone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-server-'));
  const s = await startServer({ dataDir: dir, port: 19000 + Math.floor(Math.random() * 2000) });
  try {
    // owner without PIN or password (single-PC setup)
    s.app.setup.complete({ lang: 'tr', usd_iqd: 1500, company: { name: 'Test' }, admin: { full_name: 'Owner', username: 'owner' } });
    const owner = s.app.users.list()[0];
    const ts = { host: 'dukkan-pc.tail1a2b3c.ts.net', 'x-forwarded-for': '100.70.1.2', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dukkan-pc.tail1a2b3c.ts.net' };

    const viaPhone = await request(s.port, { method: 'POST', pathName: '/api/auth/login', headers: ts, body: { user_id: owner.id, remember: true } });
    assert.equal(viaPhone.status, 401, 'the phone must type a PIN even if the owner has none');
    const row = s.app.db.get('SELECT * FROM login_failures WHERE ip = ?', ['100.70.1.2']);
    assert.ok(row && row.count === 1, 'the miss is counted against the phone');

    const here = await request(s.port, { method: 'POST', pathName: '/api/auth/login', body: { user_id: owner.id, remember: true } });
    assert.equal(here.status, 200, 'this computer itself still signs in without a PIN');
    assert.ok(!/Secure/.test(String(here.headers['set-cookie'])), 'plain http cookie on this computer');

    // a 4-digit PIN works on this computer, but a phone needs 6 digits: the short one is not even tried
    s.app.users.save({ id: owner.id, full_name: 'Owner', username: 'owner', role_id: owner.role_id, pin: '2468', can_login: true, active: true }, { user: owner, ip: '127.0.0.1' });
    const short = await request(s.port, { method: 'POST', pathName: '/api/auth/login', headers: ts, body: { user_id: owner.id, pin: '2468', password: '2468', remember: true } });
    assert.equal(short.status, 401);
    assert.equal(short.json.error.code, 'remote_pin_short');
    assert.equal(short.json.error.details.min, 6);
    assert.equal(s.app.db.val('SELECT failed_logins FROM users WHERE id = ?', [owner.id]), 0, 'the user is not paused for it');
    assert.equal(s.app.db.get('SELECT count FROM login_failures WHERE ip = ?', ['100.70.1.2']).count, 2, 'the phone address is');
    const pc = await request(s.port, { method: 'POST', pathName: '/api/auth/login', body: { user_id: owner.id, pin: '2468', password: '2468', remember: true } });
    assert.equal(pc.status, 200, 'this computer still takes the 4-digit PIN');

    // with a 6-digit PIN, the phone signs in and gets a cookie that only travels over https
    s.app.users.save({ id: owner.id, full_name: 'Owner', username: 'owner', role_id: owner.role_id, pin: '246810', can_login: true, active: true }, { user: owner, ip: '127.0.0.1' });
    const ok = await request(s.port, { method: 'POST', pathName: '/api/auth/login', headers: ts, body: { user_id: owner.id, pin: '246810', password: '246810', remember: true } });
    assert.equal(ok.status, 200);
    const cookie = String(ok.headers['set-cookie']);
    assert.match(cookie, /rm_sid=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+/);
    const sess = s.app.db.get('SELECT ip FROM sessions ORDER BY created_at DESC LIMIT 1');
    assert.equal(sess.ip, '100.70.1.2', 'the session shows the phone address');

    // the session works through the Tailscale name
    const tok = /rm_sid=([^;]+)/.exec(cookie)[1];
    const me = await request(s.port, { pathName: '/api/auth/me', headers: { ...ts, cookie: `rm_sid=${tok}` } });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.id, owner.id);

    // any other host name is refused
    const evil = await request(s.port, { pathName: '/api/ping', headers: { host: 'evil.example.com' } });
    assert.equal(evil.status, 421);
  } finally {
    await s.close();
  }
});

test('UI files carry a validator; an unchanged file is answered with 304', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-server-'));
  const s = await startServer({ dataDir: dir, port: 21000 + Math.floor(Math.random() * 2000) });
  try {
    const first = await request(s.port, { pathName: '/js/main.js' });
    assert.equal(first.status, 200);
    assert.ok(first.headers.etag);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const again = await request(s.port, { pathName: '/js/main.js', headers: { 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    const page = await request(s.port, { pathName: '/', headers: { 'if-none-match': 'W/"other"' } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    const manifest = await request(s.port, { pathName: '/manifest.webmanifest' });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
    assert.equal(manifest.headers['cache-control'], 'no-cache');
  } finally {
    await s.close();
  }
});
