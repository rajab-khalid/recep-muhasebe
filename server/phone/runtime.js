/*
 * Runtime of the phone's offline engine (browser side). This text is appended to the program's own server
 * files when the engine is packed (see bundle.js): a small CommonJS loader, and the few Node built-ins the
 * server code uses, made from what a phone's browser has. Nothing here runs on the shop computer.
 */
/* global __src, __pkg */
/* eslint-disable no-bitwise */

/* ------------------------------------------------------------------ Buffer (the parts the program uses) */
const __te = new TextEncoder();
const __td = new TextDecoder();
class Buffer extends Uint8Array {
  static from(v, enc) {
    if (typeof v === 'string') {
      if (enc === 'hex') {
        const s = v.length % 2 ? v.slice(0, -1) : v;
        const b = new Buffer(s.length / 2);
        for (let i = 0; i < b.length; i++) {
          const x = parseInt(s.substr(i * 2, 2), 16);
          if (Number.isNaN(x)) return b.subarray(0, i);
          b[i] = x;
        }
        return b;
      }
      if (enc === 'base64') {
        let s = v.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
        if (s.length % 4 === 1) s = s.slice(0, -1);
        else if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
        const bin = atob(s);
        const b = new Buffer(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return b;
      }
      return Buffer.wrap(__te.encode(v));
    }
    if (v instanceof ArrayBuffer) return Buffer.wrap(new Uint8Array(v));
    if (ArrayBuffer.isView(v)) return Buffer.wrap(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (Array.isArray(v)) return Buffer.wrap(Uint8Array.from(v));
    throw new TypeError('Buffer.from: unsupported value');
  }
  static wrap(u8) { const b = new Buffer(u8.length); b.set(u8); return b; }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(x) { return x instanceof Buffer; }
  static concat(list) {
    const n = list.reduce((s, x) => s + x.length, 0);
    const out = new Buffer(n);
    let at = 0;
    for (const x of list) { out.set(x, at); at += x.length; }
    return out;
  }
  toString(enc) {
    if (enc === 'hex') { let s = ''; for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0'); return s; }
    if (enc === 'base64') {
      let bin = '';
      for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    return __td.decode(this);
  }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
}

/* ------------------------------------------------------------------ SHA-256, HMAC, PBKDF2 and scrypt (RFC 7914) */
const __K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(msg) {
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bits >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + __K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}
function hmacSha256(key, msg) {
  let k = key.length > 64 ? sha256(key) : key;
  const kp = new Uint8Array(64);
  kp.set(k);
  const ipad = new Uint8Array(64 + msg.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { ipad[i] = kp[i] ^ 0x36; opad[i] = kp[i] ^ 0x5c; }
  ipad.set(msg, 64);
  opad.set(sha256(ipad), 64);
  k = null;
  return sha256(opad);
}
function pbkdf2Sha256Once(password, salt, dkLen) {
  const out = new Uint8Array(dkLen);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  for (let i = 1, at = 0; at < dkLen; i++, at += 32) {
    block[salt.length] = (i >>> 24) & 0xff; block[salt.length + 1] = (i >>> 16) & 0xff;
    block[salt.length + 2] = (i >>> 8) & 0xff; block[salt.length + 3] = i & 0xff;
    const u = hmacSha256(password, block);
    out.set(u.subarray(0, Math.min(32, dkLen - at)), at);
  }
  return out;
}
function salsa208(B, x) {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  for (let i = 0; i < 8; i += 2) {
    let t;
    t = x[0] + x[12]; x[4] ^= (t << 7) | (t >>> 25); t = x[4] + x[0]; x[8] ^= (t << 9) | (t >>> 23);
    t = x[8] + x[4]; x[12] ^= (t << 13) | (t >>> 19); t = x[12] + x[8]; x[0] ^= (t << 18) | (t >>> 14);
    t = x[5] + x[1]; x[9] ^= (t << 7) | (t >>> 25); t = x[9] + x[5]; x[13] ^= (t << 9) | (t >>> 23);
    t = x[13] + x[9]; x[1] ^= (t << 13) | (t >>> 19); t = x[1] + x[13]; x[5] ^= (t << 18) | (t >>> 14);
    t = x[10] + x[6]; x[14] ^= (t << 7) | (t >>> 25); t = x[14] + x[10]; x[2] ^= (t << 9) | (t >>> 23);
    t = x[2] + x[14]; x[6] ^= (t << 13) | (t >>> 19); t = x[6] + x[2]; x[10] ^= (t << 18) | (t >>> 14);
    t = x[15] + x[11]; x[3] ^= (t << 7) | (t >>> 25); t = x[3] + x[15]; x[7] ^= (t << 9) | (t >>> 23);
    t = x[7] + x[3]; x[11] ^= (t << 13) | (t >>> 19); t = x[11] + x[7]; x[15] ^= (t << 18) | (t >>> 14);
    t = x[0] + x[3]; x[1] ^= (t << 7) | (t >>> 25); t = x[1] + x[0]; x[2] ^= (t << 9) | (t >>> 23);
    t = x[2] + x[1]; x[3] ^= (t << 13) | (t >>> 19); t = x[3] + x[2]; x[0] ^= (t << 18) | (t >>> 14);
    t = x[5] + x[4]; x[6] ^= (t << 7) | (t >>> 25); t = x[6] + x[5]; x[7] ^= (t << 9) | (t >>> 23);
    t = x[7] + x[6]; x[4] ^= (t << 13) | (t >>> 19); t = x[4] + x[7]; x[5] ^= (t << 18) | (t >>> 14);
    t = x[10] + x[9]; x[11] ^= (t << 7) | (t >>> 25); t = x[11] + x[10]; x[8] ^= (t << 9) | (t >>> 23);
    t = x[8] + x[11]; x[9] ^= (t << 13) | (t >>> 19); t = x[9] + x[8]; x[10] ^= (t << 18) | (t >>> 14);
    t = x[15] + x[14]; x[12] ^= (t << 7) | (t >>> 25); t = x[12] + x[15]; x[13] ^= (t << 9) | (t >>> 23);
    t = x[13] + x[12]; x[14] ^= (t << 13) | (t >>> 19); t = x[14] + x[13]; x[15] ^= (t << 18) | (t >>> 14);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}
function blockMix(B, Y, r, X, x) {
  // X = last 64-byte block of B
  const last = (2 * r - 1) * 16;
  for (let i = 0; i < 16; i++) X[i] = B[last + i];
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa208(X, x);
    // even blocks go to the first half, odd ones to the second
    const to = ((i & 1) ? r + (i >> 1) : (i >> 1)) * 16;
    for (let j = 0; j < 16; j++) Y[to + j] = X[j];
  }
}
function scrypt(password, salt, N, r, p, dkLen) {
  if (!(N > 1) || (N & (N - 1)) !== 0) throw new RangeError('scrypt: N must be a power of 2');
  const blockWords = 32 * r;
  const B = pbkdf2Sha256Once(password, salt, p * 128 * r);
  const XY = new Int32Array(blockWords * 2);
  const V = new Int32Array(blockWords * N);
  const X = new Int32Array(16);
  const tmp = new Int32Array(16);
  const dv = new DataView(B.buffer);
  for (let k = 0; k < p; k++) {
    const off = k * 128 * r;
    const cur = XY.subarray(0, blockWords);
    const nxt = XY.subarray(blockWords);
    for (let i = 0; i < blockWords; i++) cur[i] = dv.getInt32(off + i * 4, true);
    for (let i = 0; i < N; i++) {
      V.set(cur, i * blockWords);
      blockMix(cur, nxt, r, X, tmp);
      cur.set(nxt);
    }
    for (let i = 0; i < N; i++) {
      const j = cur[(2 * r - 1) * 16] & (N - 1);
      const vj = j * blockWords;
      for (let w = 0; w < blockWords; w++) cur[w] ^= V[vj + w];
      blockMix(cur, nxt, r, X, tmp);
      cur.set(nxt);
    }
    for (let i = 0; i < blockWords; i++) dv.setInt32(off + i * 4, cur[i], true);
  }
  return pbkdf2Sha256Once(password, B, dkLen);
}

/* ------------------------------------------------------------------ Node built-ins */
let __env = null; // set by boot(): { openDb(file) -> sqlite-wasm oo1 DB }
const __bytes = (v) => (typeof v === 'string' ? __te.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));

const __crypto = {
  randomUUID() {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Buffer.wrap(b).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  randomBytes(n) { const b = Buffer.alloc(n); globalThis.crypto.getRandomValues(b); return b; },
  scryptSync(secret, salt, keylen, o = {}) { return Buffer.wrap(scrypt(__bytes(String(secret)), __bytes(salt), o.N || 16384, o.r || 8, o.p || 1, keylen)); },
  timingSafeEqual(a, b) {
    if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  },
  createHash(alg) {
    if (String(alg).toLowerCase() !== 'sha256') throw new Error(`Hash ${alg} is not available on the phone`);
    const parts = [];
    const h = {
      update(v) { parts.push(__bytes(typeof v === 'string' ? v : v)); return h; },
      digest(enc) {
        const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let at = 0;
        for (const p of parts) { all.set(p, at); at += p.length; }
        const out = Buffer.wrap(sha256(all));
        return enc ? out.toString(enc) : out;
      },
    };
    return h;
  },
};

class __Statement {
  constructor(db, sql) { this.db = db; this.st = db.prepare(sql); }
  bind(args) {
    const st = this.st;
    st.clearBindings();
    if (!args.length) return;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array) && !Array.isArray(args[0])) {
      const named = {};
      for (const [k, v] of Object.entries(args[0])) named[/^[:@$]/.test(k) ? k : `:${k}`] = v;
      st.bind(named);
    } else st.bind(args);
  }
  all(...args) {
    this.bind(args);
    const rows = [];
    try { while (this.st.step()) rows.push(this.st.get({})); } finally { this.st.reset(); }
    return rows;
  }
  get(...args) {
    this.bind(args);
    try { return this.st.step() ? this.st.get({}) : undefined; } finally { this.st.reset(); }
  }
  run(...args) {
    this.bind(args);
    try { this.st.step(); } finally { this.st.reset(); }
    return { changes: this.db.changes(), lastInsertRowid: 0 };
  }
}
class __DatabaseSync {
  constructor(file) { this.raw = __env.openDb(file); }
  prepare(sql) { return new __Statement(this.raw, sql); }
  exec(sql) {
    // the phone's storage has no write-ahead log and no other connections to wait for
    if (/^\s*PRAGMA\s+(journal_mode\s*=\s*WAL|busy_timeout|synchronous)\b/i.test(sql)) return;
    this.raw.exec(sql);
  }
  close() { /* the phone engine closes its database itself */ }
}

const __unavailable = (name) => () => { const e = new Error(`${name} is not available on the phone`); e.code = 'needs_online'; e.status = 409; throw e; };
const __fs = {
  existsSync: () => false,
  mkdirSync: () => undefined,
  readdirSync: () => [],
  statSync: __unavailable('fs.statSync'),
  readFileSync: __unavailable('fs.readFileSync'),
  writeFileSync: __unavailable('fs.writeFileSync'),
  copyFileSync: __unavailable('fs.copyFileSync'),
  unlinkSync: __unavailable('fs.unlinkSync'),
  renameSync: __unavailable('fs.renameSync'),
  rmSync: __unavailable('fs.rmSync'),
};
function __normalize(p) {
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return (String(p).startsWith('/') ? '/' : '') + out.join('/');
}
const __path = {
  sep: '/',
  join: (...p) => __normalize(p.filter((x) => x !== '').join('/')) || '.',
  resolve: (...p) => { let r = ''; for (const x of p) r = String(x).startsWith('/') ? x : `${r}/${x}`; return __normalize(r.startsWith('/') ? r : `/${r}`); },
  dirname: (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : (i === 0 ? '/' : '.'); },
  basename: (p, ext) => { let b = String(p).replace(/\/+$/, '').replace(/^.*\//, ''); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
  extname: (p) => { const b = String(p).replace(/^.*\//, ''); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
};
const __os = { hostname: () => 'phone', networkInterfaces: () => ({}), tmpdir: () => '/tmp' };
const __zlib = { gzipSync: __unavailable('zlib.gzipSync') };
const __process = { versions: { node: 'phone' }, platform: 'phone', env: {}, cwd: () => '/' };

function __builtin(name) {
  switch (name) {
    case 'sqlite': return { DatabaseSync: __DatabaseSync };
    case 'crypto': return __crypto;
    case 'fs': return __fs;
    case 'path': return __path;
    case 'os': return __os;
    case 'zlib': return __zlib;
    default: throw new Error(`Module node:${name} is not available on the phone`);
  }
}

/* ------------------------------------------------------------------ CommonJS loader */
let __cache = Object.create(null);
function __resolve(from, spec) {
  const parts = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  const id = parts.join('/');
  if (id === 'package.json' || id.endsWith('.json')) return 'package.json';
  return id.endsWith('.js') ? id : `${id}.js`;
}
function __require(from) {
  return function require(spec) {
    if (spec.startsWith('node:')) return __builtin(spec.slice(5));
    const id = __resolve(from, spec);
    if (id === 'package.json') return __pkg;
    const hit = __cache[id];
    if (hit) return hit.exports;
    const fn = __src[id];
    if (!fn) throw new Error(`Module not found: ${spec} (from ${from})`);
    const module = { exports: {} };
    __cache[id] = module;
    fn.call(module.exports, __require(id), module, module.exports, __process, Buffer, id, __path.dirname(id));
    return module.exports;
  };
}

/**
 * Start the engine on an open database. env.openDb(file) returns the sqlite-wasm database to use;
 * env.series is the phone's own document number series (e.g. "T1"). Each start gets fresh modules.
 */
export function boot(env) {
  __env = env;
  __cache = Object.create(null);
  const require = __require('boot.js');
  const { createApp } = require('./app');
  const app = createApp({ dataDir: '/offline', dbFile: '/offline/main.db', phone: true, series: env.series || null });
  const { Router } = require('./http');
  const router = new Router();
  require('./api/routes')(router, app);
  return { app, router, ops: require('./phone/ops'), util: require('./util'), db: require('./db') };
}

export const version = __pkg.version;
export const internals = { Buffer, sha256, hmacSha256, scrypt, crypto: __crypto, path: __path };
