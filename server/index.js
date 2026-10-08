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

const COOKIE = 'rm_sid';

/*
 * The program is opened by an address (127.0.0.1, the PC's network IP) or by this computer's own name.
 * Any other host name is refused: a web page cannot point its own domain at this computer ("DNS rebinding")
 * and use the program from a browser here.
 */
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(h); // an IPv6 address
  h = h.replace(/:\d+$/, '');
  if (h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  const me = os.hostname().toLowerCase();
  return h === me || h === `${me}.local`;
}

function startServer(opts = {}) {
  const app = createApp({ dataDir: opts.dataDir, desktop: !!opts.desktop });
  const reset = app.users.emergencyReset();
  if (reset) console.log(`[users] PIN/password removed for ${reset} admin user(s) (SIFRE-SIFIRLA file)`);
  const uiDir = opts.uiDir || path.join(__dirname, '..', 'ui');
  const router = new Router();
  registerRoutes(router, app);
  const net = app.getSetting('network');
  const port = Number(opts.port || net.port || 8642);
  const host = opts.host || (net.lan_enabled ? '0.0.0.0' : '127.0.0.1');
  let actualPort = port;

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host)) return send(res, 421, { error: { code: 'bad_host', message: 'Open the program by its IP address' } }, {}, req);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(uiDir, req, res, pathname);

    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ip) { req.destroy(); return undefined; } // the connection is already gone
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
    const ctx = {
      app, user, token, ip, req, res, params: match.params, query, body, port: actualPort,
      setSession(tok, remember, days) {
        if (!tok) setCookies.push(`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        else setCookies.push(`${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${Math.round((days || 90) * 86400)}` : ''}`);
      },
      requestRestart: () => { if (opts.onRestartRequested) setTimeout(() => opts.onRestartRequested(), 300); },
    };
    try {
      let result = match.route.handler(ctx);
      if (result && typeof result.then === 'function') result = await result;
      const headers = {};
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

module.exports = { startServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  startServer({ dataDir: path.resolve(get('data', path.join(process.cwd(), 'data'))), port: Number(get('port', 0)) || undefined, host: get('host'), strictPort: args.includes('--strict-port') })
    .then((s) => console.log(`Recep Muhasebe server ${s.app.version} on http://${s.host}:${s.port} (data: ${s.app.dataDir})`))
    .catch((e) => { console.error(e); process.exit(1); });
}
