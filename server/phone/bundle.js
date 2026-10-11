'use strict';
/*
 * The phone's offline engine: the program's own server code (routes, services, rules) packed into one browser
 * module, so the phone applies exactly the same rules to its copy as the shop computer does. It is put
 * together from the server files when first asked for and served as /phone/engine.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const FIXED = ['app.js', 'db.js', 'schema.js', 'util.js', 'auth.js', 'seed.js', 'http.js', 'api/routes.js', 'phone/ops.js'];

function files() {
  const services = fs.readdirSync(path.join(ROOT, 'services')).filter((f) => f.endsWith('.js')).sort().map((f) => `services/${f}`);
  return [...FIXED, ...services];
}

let cached = null;

/** { code, hash } of the engine module (made once per program start; the files do not change meanwhile) */
function engine() {
  if (cached) return cached;
  let version = '0';
  try { version = require('../../package.json').version; } catch (e) { /* keep 0 */ }
  const out = ['// Recep Muhasebe — offline engine for the phone app, made from the program\'s server files.', 'const __src = Object.create(null);'];
  for (const rel of files()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    out.push(`__src[${JSON.stringify(rel)}] = function (require, module, exports, process, Buffer, __filename, __dirname) {\n${src}\n};`);
  }
  out.push(`const __pkg = ${JSON.stringify({ version })};`);
  out.push(fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf8'));
  const body = out.join('\n');
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 20);
  // the engine knows which build it is, so the phone can tell a copy made for another build
  const code = `${body}\nexport const hash = ${JSON.stringify(hash)};\n`;
  cached = { code, hash, version };
  return cached;
}

/*
 * The list of the program's screen files, for the phone app to keep (so it opens without the shop computer).
 * `hash` changes whenever any file (or the engine) changes: the phone then takes the new files.
 */
const appFilesCache = new Map();
function appFiles(uiDir) {
  if (appFilesCache.has(uiDir)) return appFilesCache.get(uiDir);
  const list = [];
  const h = crypto.createHash('sha256');
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile() && !ent.name.startsWith('.')) {
        const st = fs.statSync(full);
        list.push(r);
        h.update(`${r}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };
  walk(uiDir, '');
  list.push('/phone/engine.js');
  h.update(engine().hash);
  const out = { hash: h.digest('hex').slice(0, 20), files: list };
  appFilesCache.set(uiDir, out);
  return out;
}

module.exports = { engine, files, appFiles };
