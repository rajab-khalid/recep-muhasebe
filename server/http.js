'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** tiny router: add(method, '/api/products/:id', handler) */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^\\/]+)'; }) + '\\/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  del(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** reads a request body up to `limit` bytes; a bigger one is refused with 413 (the connection closes after the answer) */
function readBody(req, limit = 40 * 1024 * 1024) {
  const tooLarge = () => Object.assign(new Error('Request too large'), { status: 413, code: 'too_large' });
  if (Number(req.headers['content-length']) > limit) { req.pause(); return Promise.reject(tooLarge()); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; req.pause(); reject(tooLarge()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}, req) {
  if (res.headersSent) return;
  let data = body;
  let type = headers['Content-Type'];
  if (!(body instanceof Buffer) && typeof body !== 'string') {
    data = JSON.stringify(body === undefined ? { ok: true } : body);
    type = 'application/json; charset=utf-8';
  }
  const h = { 'Content-Type': type || 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers };
  const accept = req && req.headers['accept-encoding'] || '';
  if (typeof data === 'string') data = Buffer.from(data);
  if (data.length > 2048 && /\bgzip\b/.test(accept) && /json|text|javascript|css|svg/.test(h['Content-Type'])) {
    data = zlib.gzipSync(data);
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = data.length;
  res.writeHead(status, h);
  res.end(data);
}

/*
 * Pages may only run the program's own script files (no inline or injected scripts), talk only to this
 * server and cannot be framed by other sites. Styles may be inline: printouts and the screens use them.
 */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
const PAGE_HEADERS = { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' };

/** serve the UI folder (SPA: unknown paths fall back to index.html) */
function serveStatic(rootDir, req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); } catch (e) { return send(res, 400, 'Bad request', {}, req); }
  if (p === '/' || p === '') p = '/index.html';
  const root = path.resolve(rootDir);
  const file = path.resolve(path.join(root, p));
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', {}, req);
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    if (path.extname(p)) return send(res, 404, 'Not found', {}, req);
    target = path.join(rootDir, 'index.html');
  }
  const ext = path.extname(target).toLowerCase();
  const isIndex = target.endsWith('index.html');
  const cache = isIndex || ext === '.js' || ext === '.css' || ext === '.json' ? 'no-cache' : 'public, max-age=604800';
  const data = fs.readFileSync(target);
  const extra = ext === '.html' ? PAGE_HEADERS : {};
  send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...extra }, req);
}

module.exports = { Router, parseCookies, readBody, send, serveStatic, MIME, CSP };
