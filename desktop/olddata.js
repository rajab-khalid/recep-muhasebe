'use strict';
/*
 * Finds and reads the data of the previous program (Recep Muhasebe 1.x/2.x, earlier "Finora").
 * That program kept everything in the browser storage of its window: Chromium's "Local Storage" LevelDB
 * folder inside its user-data folder, under the key "finora_state_v1".
 *
 * The folder is never changed: it is copied to a temporary folder first and only the copy is read.
 * This file reads LevelDB directly (log files and table files, with Snappy decompression), so it does not
 * depend on any browser engine; the main process also has a second way through Chromium itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const KEY = 'finora_state_v1';
// folder names the old program may have used under %APPDATA%
const OLD_NAMES = ['Recep Muhasebe', 'recep-muhasebe', 'Finora', 'finora', 'Recep Muhasebe 2', 'recep-muhasebe-2', 'Finora Muhasebe'];

/* ---------------------------------------------------------------- small readers */
function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    if (pos >= buf.length) throw new Error('varint past end');
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

/** raw Snappy block decompression */
function snappy(src) {
  let [len, p] = varint(src, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[p + i] << (8 * i);
        p += bytes;
      }
      n += 1;
      src.copy(out, o, p, p + n);
      p += n;
      o += n;
    } else {
      let n;
      let off;
      if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; } else if (kind === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(p); p += 2; } else { n = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
      if (off === 0 || off > o) throw new Error('bad snappy offset');
      for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
    }
  }
  return out;
}

/* ---------------------------------------------------------------- LevelDB */
/** calls onPut(key, value, seq) / onDel(key, seq) for every record of a write-ahead log file */
function scanLog(buf, onPut, onDel) {
  const BLOCK = 32768;
  let pos = 0;
  let pending = null;
  const records = [];
  while (pos + 7 <= buf.length) {
    const left = BLOCK - (pos % BLOCK);
    if (left < 7) { pos += left; continue; }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const start = pos + 7;
    if (type === 0 && len === 0) { pos += left; continue; } // zero-filled tail
    if (start + len > buf.length) break;
    const chunk = buf.subarray(start, start + len);
    pos = start + len;
    if (type === 1) { records.push(chunk); pending = null; } else if (type === 2) pending = [chunk];
    else if (type === 3) { if (pending) pending.push(chunk); } else if (type === 4) { if (pending) { pending.push(chunk); records.push(Buffer.concat(pending)); } pending = null; }
  }
  for (const r of records) {
    try {
      if (r.length < 12) continue;
      let seq = Number(r.readBigUInt64LE(0));
      const count = r.readUInt32LE(8);
      let p = 12;
      for (let i = 0; i < count && p < r.length; i++, seq++) {
        const tag = r[p++];
        let klen;
        [klen, p] = varint(r, p);
        const key = r.subarray(p, p + klen);
        p += klen;
        if (tag === 1) {
          let vlen;
          [vlen, p] = varint(r, p);
          onPut(key, r.subarray(p, p + vlen), seq);
          p += vlen;
        } else onDel(key, seq);
      }
    } catch (e) { /* damaged record: skip */ }
  }
}

function readBlock(buf, offset, size) {
  const data = buf.subarray(offset, offset + size);
  const comp = buf[offset + size];
  return comp === 1 ? snappy(data) : data;
}

function blockEntries(block, cb) {
  const nRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - nRestarts * 4;
  let p = 0;
  let last = Buffer.alloc(0);
  while (p < end) {
    let shared;
    let nonShared;
    let vlen;
    [shared, p] = varint(block, p);
    [nonShared, p] = varint(block, p);
    [vlen, p] = varint(block, p);
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(p, p + nonShared)]);
    p += nonShared;
    const value = block.subarray(p, p + vlen);
    p += vlen;
    last = key;
    cb(key, value);
  }
}

/** every entry of a table file (.ldb / .sst): internal keys carry the sequence number and the kind */
function scanTable(buf, onPut, onDel) {
  if (buf.length < 48) return;
  const footer = buf.subarray(buf.length - 48);
  let p = 0;
  let mOff; let mSize; let iOff; let iSize;
  [mOff, p] = varint(footer, p);
  [mSize, p] = varint(footer, p);
  [iOff, p] = varint(footer, p);
  [iSize, p] = varint(footer, p);
  const index = readBlock(buf, iOff, iSize);
  blockEntries(index, (k, handle) => {
    try {
      let q = 0;
      let off; let size;
      [off, q] = varint(handle, q);
      [size, q] = varint(handle, q);
      const block = readBlock(buf, off, size);
      blockEntries(block, (ikey, value) => {
        if (ikey.length < 8) return;
        const user = ikey.subarray(0, ikey.length - 8);
        const tag = ikey.readBigUInt64LE(ikey.length - 8);
        const seq = Number(tag >> 8n);
        const kind = Number(tag & 0xffn);
        if (kind === 1) onPut(user, value, seq); else onDel(user, seq);
      });
    } catch (e) { /* damaged block: skip */ }
  });
}

/** Chromium's local-storage key for our item, for any origin form ("file://", "file:///") and either encoding */
function isOurKey(key) {
  if (key.length < KEY.length + 3 || key[0] !== 0x5f) return false; // "_"
  const latin = Buffer.from(`\u0001${KEY}`, 'latin1');
  const utf16 = Buffer.concat([Buffer.from([0]), Buffer.from(KEY, 'utf16le')]);
  const head = key.subarray(0, 8).toString('latin1');
  if (!head.startsWith('_file:')) return false;
  const tail = (b) => key.length > b.length && key.subarray(key.length - b.length).equals(b) && key[key.length - b.length - 1] === 0;
  return tail(latin) || tail(utf16);
}

function decodeValue(v) {
  if (!v || !v.length) return '';
  if (v[0] === 0) return v.subarray(1).toString('utf16le');
  if (v[0] === 1) return v.subarray(1).toString('latin1');
  return v.toString('utf8');
}

/** newest value of the old program's key in a LevelDB folder, or null */
function readLevelDb(dir) {
  let best = null;
  const put = (k, v, seq) => { if (isOurKey(k) && (!best || seq > best.seq)) best = { seq, value: Buffer.from(v), deleted: false }; };
  const del = (k, seq) => { if (isOurKey(k) && (!best || seq > best.seq)) best = { seq, value: null, deleted: true }; };
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try {
      if (f.endsWith('.log')) scanLog(fs.readFileSync(full), put, del);
      else if (f.endsWith('.ldb') || f.endsWith('.sst')) scanTable(fs.readFileSync(full), put, del);
    } catch (e) { /* unreadable file: skip */ }
  }
  if (!best || best.deleted) return null;
  return decodeValue(best.value);
}

/* ---------------------------------------------------------------- folders */
/** copy of a LevelDB folder in a temporary place (the original is only read) */
function copyLevelDb(src) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-old-'));
  const target = path.join(dest, 'Local Storage', 'leveldb');
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === 'LOCK') continue;
    try { fs.copyFileSync(path.join(src, f), path.join(target, f)); } catch (e) { /* locked or vanished: skip */ }
  }
  return { root: dest, leveldb: target };
}

/** the old program's folders that hold browser storage */
function candidates(appDataDir, extra = []) {
  const out = [];
  const seen = new Set();
  for (const name of [...OLD_NAMES, ...extra]) {
    const dir = path.join(appDataDir, name);
    const ldb = path.join(dir, 'Local Storage', 'leveldb');
    let real;
    try { real = fs.realpathSync(ldb); } catch (e) { continue; }
    if (seen.has(real.toLowerCase())) continue;
    seen.add(real.toLowerCase());
    out.push({ id: name, name, dir, leveldb: ldb });
  }
  return out;
}

function summarize(json) {
  try {
    const raw = JSON.parse(json);
    const data = raw && raw.data ? raw.data : raw;
    if (!data || typeof data !== 'object') return null;
    return {
      saved_at: raw.savedAt || null,
      counts: { products: (data.products || []).length, invoices: (data.invoices || []).length, accounts: (data.accounts || []).length },
      company: data.settings && data.settings.companyName ? data.settings.companyName : null,
    };
  } catch (e) { return null; }
}

/** read one candidate through a temporary copy; returns { json, info } or null */
function readCandidate(c) {
  const copy = copyLevelDb(c.leveldb);
  try {
    const json = readLevelDb(copy.leveldb);
    if (!json) return null;
    const info = summarize(json);
    return info ? { json, info } : null;
  } finally {
    try { fs.rmSync(copy.root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { KEY, OLD_NAMES, candidates, readCandidate, readLevelDb, copyLevelDb, summarize, snappy, scanLog, scanTable, isOurKey };
