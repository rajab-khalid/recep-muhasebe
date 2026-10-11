'use strict';
/*
 * Thin synchronous wrapper around node:sqlite (built into Node >= 22.13 and Electron >= 35).
 * - Statement cache
 * - Positional (array) or named (object) parameters, with undefined/boolean sanitising
 * - Nested transactions via SAVEPOINT
 * - Small insert/update helpers that only touch the given columns
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function clean(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

function cleanParams(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(clean);
  const out = {};
  for (const k of Object.keys(params)) out[k] = clean(params[k]);
  return out;
}

class DB {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.afterCommit = [];
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql) { this.raw.exec(sql); }

  all(sql, params) {
    const p = cleanParams(params);
    const s = this.stmt(sql);
    return Array.isArray(p) ? s.all(...p) : s.all(p);
  }

  get(sql, params) {
    const p = cleanParams(params);
    const s = this.stmt(sql);
    return Array.isArray(p) ? s.get(...p) : s.get(p);
  }

  /** first column of first row */
  val(sql, params) {
    const r = this.get(sql, params);
    if (!r) return undefined;
    const k = Object.keys(r)[0];
    return r[k];
  }

  run(sql, params) {
    const p = cleanParams(params);
    const s = this.stmt(sql);
    return Array.isArray(p) ? s.run(...p) : s.run(p);
  }

  insert(table, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    this.run(sql, keys.map((k) => obj[k]));
    return obj;
  }

  update(table, id, obj, idCol = 'id') {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && k !== idCol);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
    return this.run(sql, [...keys.map((k) => obj[k]), id]).changes;
  }

  /** Run fn inside a transaction. Nested calls become savepoints. */
  tx(fn) {
    const depth = this.depth;
    const sp = `sp_${depth}`;
    if (depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('db.tx callback must be synchronous');
      }
      this.depth--;
      if (depth === 0) {
        this.raw.exec('COMMIT');
        const hooks = this.afterCommit.splice(0);
        for (const h of hooks) { try { h(); } catch (e) { console.error('afterCommit hook failed', e); } }
      } else {
        this.raw.exec(`RELEASE ${sp}`);
      }
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (depth === 0) {
          this.raw.exec('ROLLBACK');
          this.afterCommit.length = 0;
        } else {
          this.raw.exec(`ROLLBACK TO ${sp}`);
          this.raw.exec(`RELEASE ${sp}`);
        }
      } catch (e2) { /* ignore */ }
      throw err;
    }
  }

  onCommit(fn) {
    if (this.depth === 0) fn();
    else this.afterCommit.push(fn);
  }

  close() {
    this.cache.clear();
    try { this.raw.close(); } catch (e) { /* ignore */ }
  }
}

/*
 * New record ids; `table` names what the id is for. A phone's offline work is replayed on the shop computer
 * with the ids the phone gave it, table by table, so later work that points at those records (a payment for
 * a sale made offline, a return of one of its lines) still finds them, even when the computer makes a
 * different number of other records on the way (an existing vehicle, an extra payment allocation...).
 */
let idSource = null;
function uuid(table) {
  const v = idSource && idSource(table || '');
  return v || crypto.randomUUID();
}
/** fn(table) returns the next id to use (or nothing for a fresh one); null goes back to fresh ids */
function setIdSource(fn) { idSource = typeof fn === 'function' ? fn : null; }

/**
 * Ids worked out from a seed: the same seed gives the same ids on the phone and on the shop computer (used for
 * a write whose answer was lost: the phone does it again on its copy, with the same record ids).
 */
function seededIds(seed) {
  const counts = {};
  return (table) => {
    const t = table || '';
    const n = (counts[t] = (counts[t] || 0) + 1);
    const h = crypto.createHash('sha256').update(`${seed}|${t}|${n}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

module.exports = { DB, uuid, setIdSource, seededIds };
