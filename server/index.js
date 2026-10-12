'use strict';
/*
 * HTTP server: serves the UI and the JSON API on one port.
 * Used by the Electron main process, and can also run on its own:
 *   node server/index.js --data ./data --port 8642 [--host 0.0.0.0]
 */
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./app');
const { Router, parseCookies, readBody, send, serveStatic } = require('./http');
const registerRoutes = require('./api/routes');
const registerPhoneRoutes = require('./phone/routes');
const phoneOps = require('./phone/ops');
const { engine: phoneEngine, appFiles } = require('./phone/bundle');

const COOKIE = 'rm_sid';

/*
 * The program is opened by an address (127.0.0.1, the PC's network IP), by this computer's own name, or by
 * its Tailscale name (pc-name.tailnet.ts.net, used by the phone app). Any other host name is refused: a web
 * page cannot point its own domain at this computer ("DNS rebinding") and use the program from a browser here.
 * ts.net names are safe to accept: their addresses are set by Tailscale and always point into a private
 * Tailscale network, never at this computer's own or local network addresses.
 */
const TS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.ts\.net$/;
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(h); // an IPv6 address
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  if (h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (TS_HOST.test(h)) return true;
  const me = os.hostname().toLowerCase();
  return h === me || h === `${me}.local`;
}

const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip);

/*
 * Who is asking. Tailscale's "serve" (the phone app's secure address) runs on this computer and passes each
 * request on from 127.0.0.1, naming the phone in X-Forwarded-For. Such a request is never treated as this
 * computer itself: no sign-in without a PIN, and wrong PINs count against the phone's own address.
 * Only a program on this computer can send these headers to 127.0.0.1 (web pages cannot add them to requests
 * for another site), and Tailscale replaces whatever the phone sent with the real values.
 */
function clientOf(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!peer) return null;
  const h = req.headers;
  if (!isLoopback(peer)) return { ip: peer, proxied: false, https: false };
  const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '');
  const proxied = h['x-forwarded-for'] !== undefined || h['tailscale-user-login'] !== undefined || TS_HOST.test(host.replace(/\.$/, ''));
  if (!proxied) return { ip: peer, proxied: false, https: false };
  let ip = String(h['x-forwarded-for'] || '').split(',')[0].trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (!/^[0-9a-f:.]{2,45}$/i.test(ip) || isLoopback(ip)) ip = 'proxy';
  return { ip, proxied: true, https: String(h['x-forwarded-proto'] || '').toLowerCase() === 'https' };
}

function startServer(opts = {}) {
  const app = createApp({ dataDir: opts.dataDir, desktop: !!opts.desktop });
  const reset = app.users.emergencyReset();
  if (reset) console.log(`[users] PIN/password removed for ${reset} admin user(s) (SIFRE-SIFIRLA file)`);
  const uiDir = opts.uiDir || path.join(__dirname, '..', 'ui');
  const router = new Router();
  registerRoutes(router, app);
  const phone = registerPhoneRoutes(router, app);
  try { phone.prune(); } catch (e) { console.error('[phone] prune failed', e); }
  const net = app.getSetting('network');
  const port = Number(opts.port || net.port || 8642);
  const host = opts.host || (net.lan_enabled ? '0.0.0.0' : '127.0.0.1');
  let actualPort = port;

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host)) return send(res, 421, { error: { code: 'bad_host', message: 'Open the program by its IP address' } }, {}, req);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    // the phone app's offline engine (the program's own server code, packed for the phone) and its file list
    if (pathname === '/phone/engine.js' || pathname === '/app-files.json') {
      const isEngine = pathname === '/phone/engine.js';
      const tag = `"${isEngine ? phoneEngine().hash : appFiles(uiDir).hash}"`;
      if (String(req.headers['if-none-match'] || '').split(',').map((x) => x.trim()).includes(tag)) {
        res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      const body = isEngine ? phoneEngine().code : JSON.stringify(appFiles(uiDir));
      return send(res, 200, body, { 'Content-Type': isEngine ? 'text/javascript; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: tag }, req);
    }
    if (!pathname.startsWith('/api/')) return serveStatic(uiDir, req, res, pathname);

    const client = clientOf(req);
    if (!client) { req.destroy(); return undefined; } // the connection is already gone
    const { ip } = client;
    const match = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);
    if (!match) return send(res, 404, { error: { code: 'not_found', message: 'Not found' } }, {}, req);

    // CSRF: state-changing requests must carry our custom header (forces a CORS preflight that we never allow)
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'recep') {
      return send(res, 403, { error: { code: 'csrf', message: 'Bad request origin' } }, {}, req);
    }
    const cookies = parseCookies(req.headers.cookie);
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = bearer || cookies[COOKIE] || null;
    const user = token ? app.users.session(token) : null;
    const query = Object.fromEntries(url.searchParams.entries());
    // sign-in is checked before the request body is read, so strangers cannot make the server read large uploads
    if (!match.route.opts.public && !user) {
      return send(res, 401, { error: { code: 'unauthorized', message: 'Please sign in' } }, {}, req);
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        if (match.route.opts.pre) match.route.opts.pre();
        const limit = match.route.opts.bigBody ? 150 * 1024 * 1024 : match.route.opts.smallBody ? 64 * 1024 : 12 * 1024 * 1024;
        const buf = await readBody(req, limit);
        body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      } catch (e) {
        if (e.status === 413) res.once('finish', () => req.destroy());
        return send(res, e.status || 400, { error: { code: e.code || 'bad_json', message: e.message } }, { Connection: 'close' }, req);
      }
    }
    const setCookies = [];
    const secure = client.https ? '; Secure' : ''; // the phone app's https address: the cookie never travels unencrypted
    const ctx = {
      app, user, token, ip, req, res, params: match.params, query, body, port: actualPort, remote: client.proxied,
      setSession(tok, remember, days) {
        if (!tok) setCookies.push(`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
        else setCookies.push(`${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict${secure}${remember ? `; Max-Age=${Math.round((days || 90) * 86400)}` : ''}`);
      },
      requestRestart: () => { if (opts.onRestartRequested) setTimeout(() => opts.onRestartRequested(), 300); },
    };
    try {
      /*
       * A write from the phone app carries its own id. If its answer was lost on the way, the phone sends it
       * again with the same id (or does it on its offline copy and sends that later): it is then answered from
       * the record of the first time and not applied twice.
       */
      const opId = req.method !== 'GET' && user && !/^\/api\/(auth|phone|setup)\//.test(pathname) ? String(req.headers['x-op-id'] || '') : '';
      let result;
      let duplicate = false;
      if (opId && phone.ID_RE.test(opId)) {
        let w = phone.onlineWrite(opId, String(req.headers['x-device-id'] || ''), ctx, () => match.route.handler(ctx), { atomic: !!phoneOps.writeRule(req.method, match.route.pattern) });
        if (w && typeof w.then === 'function') w = await w;
        result = w.result;
        duplicate = w.duplicate;
      } else {
        result = match.route.handler(ctx);
        if (result && typeof result.then === 'function') result = await result;
      }
      // the data changed: phones keeping an offline copy will fetch a new one
      // (a changed PIN counts too: the phone's copy must not keep accepting the old one)
      if (req.method !== 'GET' && !duplicate && !/^\/api\/(auth\/(login|logout|verify|sessions)|phone\/|notifications\/)/.test(pathname)) app.noteChange();
      const headers = {};
      if (duplicate) headers['X-Op-Duplicate'] = '1'; // the answer kept from the first time this write was sent
      if (setCookies.length) headers['Set-Cookie'] = setCookies;
      if (result && result.__raw) {
        headers['Content-Type'] = result.type || 'application/octet-stream';
        if (result.cache) headers['Cache-Control'] = result.cache;
        if (result.filename) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(result.filename)}"`;
        if (result.headers) Object.assign(headers, result.headers);
        return send(res, 200, result.__raw, headers, req);
      }
      return send(res, 200, result === undefined ? { ok: true } : result, headers, req);
    } catch (err) {
      const status = err.status || (err.code && /^[a-z_]+$/.test(err.code) ? 400 : 500);
      if (status >= 500) console.error('[api]', req.method, pathname, err);
      const headers = {};
      if (setCookies.length) headers['Set-Cookie'] = setCookies;
      return send(res, status, { error: { code: err.code || 'server_error', message: err.message || 'Server error', details: err.details } }, headers, req);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[server]', e);
      send(res, 500, { error: { code: 'server_error', message: e.message } }, {}, req);
    });
  });
  server.keepAliveTimeout = 5000;

  // automatic daily backup
  const backupTimer = setInterval(() => app.backup.autoBackup(), 3 * 3600 * 1000);
  backupTimer.unref && backupTimer.unref();
  setTimeout(() => app.backup.autoBackup(), 15000).unref();

  function listen(p, attempts = 0) {
    return new Promise((resolve, reject) => {
      const onErr = (e) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && attempts < 20 && !opts.strictPort) resolve(listen(p + 1, attempts + 1));
        else reject(e);
      };
      const onOk = () => { server.off('error', onErr); actualPort = server.address().port; resolve(actualPort); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, host);
    });
  }

  return listen(port).then((p) => ({
    app, server, port: p, host, url: `http://127.0.0.1:${p}`,
    close: () => new Promise((resolve) => { clearInterval(backupTimer); server.close(() => { app.close(); resolve(); }); setTimeout(() => { try { app.close(); } catch (e) { /* */ } resolve(); }, 1500); }),
  }));
}

module.exports = { startServer, hostAllowed, clientOf };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  startServer({ dataDir: path.resolve(get('data', path.join(process.cwd(), 'data'))), port: Number(get('port', 0)) || undefined, host: get('host'), strictPort: args.includes('--strict-port') })
    .then((s) => console.log(`Recep Muhasebe server ${s.app.version} on http://${s.host}:${s.port} (data: ${s.app.dataDir})`))
    .catch((e) => { console.error(e); process.exit(1); });
}
