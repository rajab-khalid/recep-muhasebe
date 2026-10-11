'use strict';
/*
 * For the tests only: the few parts of sqlite-wasm's "oo1" API that the phone's offline engine uses, made on
 * top of node:sqlite, so the phone side can be tested in Node (the browser itself is tested separately).
 */
const { DatabaseSync } = require('node:sqlite');

class Stmt {
  constructor(db, sql) { this.db = db; this.s = db.prepare(sql); this.params = []; this.it = null; this.row = null; }
  bind(p) {
    this.reset();
    if (Array.isArray(p)) this.params = p;
    else if (p && typeof p === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(p)) o[k.replace(/^[:@$]/, '')] = v;
      this.params = [o];
    } else this.params = [p];
    return this;
  }
  clearBindings() { this.params = []; return this; }
  step() {
    if (!this.it) this.it = this.s.iterate(...this.params);
    const n = this.it.next();
    if (n.done) { this.it = null; this.row = null; return false; }
    this.row = n.value;
    return true;
  }
  get() { return this.row ? { ...this.row } : undefined; }
  reset() { if (this.it && typeof this.it.return === 'function') this.it.return(); this.it = null; this.row = null; return this; }
  finalize() { this.reset(); }
}

class DB {
  constructor(file) { this.raw = new DatabaseSync(file); this.pointer = 1; }
  prepare(sql) { return new Stmt(this.raw, sql); }
  exec(sql) { this.raw.exec(sql); return this; }
  changes() { return this.raw.prepare('SELECT changes() AS c').get().c; }
  close() { this.raw.close(); }
}

module.exports = { open: (file) => new DB(file) };
