'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/* Backups are full copies of the SQLite database (VACUUM INTO: consistent even while the app is running). */
module.exports = (app) => {
  const { db, U } = app;
  const backupDir = path.join(app.dataDir, 'backups');

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function backupNow({ reason = 'manual', folder } = {}) {
    fs.mkdirSync(backupDir, { recursive: true });
    const name = `recep-muhasebe-${stamp()}${reason === 'auto' ? '-auto' : reason === 'pre-restore' ? '-before-restore' : reason === 'pre-update' ? '-before-update' : ''}.db`;
    const file = path.join(backupDir, name);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const out = { file, name, size: fs.statSync(file).size };
    const cfg = app.getSetting('backup');
    const extra = folder || cfg.folder;
    if (extra) {
      try {
        fs.mkdirSync(extra, { recursive: true });
        fs.copyFileSync(file, path.join(extra, name));
        out.copied_to = extra;
      } catch (e) {
        out.copy_error = e.message;
      }
    }
    app.patchSetting('backup', { last_at: U.nowIso(), last_file: name });
    prune();
    return out;
  }

  function list() {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  function prune() {
    const keep = Math.max(3, Number(app.getSetting('backup').keep) || 30);
    const autos = list().filter((b) => b.name.includes('-auto'));
    for (const b of autos.slice(keep)) {
      try { fs.unlinkSync(path.join(backupDir, b.name)); } catch (e) { /* ignore */ }
    }
  }

  /** daily automatic backup (called at start-up and every few hours) */
  function autoBackup() {
    const cfg = app.getSetting('backup');
    if (!cfg.auto || !app.setup.isDone()) return null;
    const last = cfg.last_at ? U.today(new Date(cfg.last_at)) : null;
    if (last === U.today()) return null;
    try { return backupNow({ reason: 'auto' }); } catch (e) { console.error('auto backup failed', e); return null; }
  }

  function filePath(name) {
    const safe = path.basename(String(name));
    const f = path.join(backupDir, safe);
    U.assert(fs.existsSync(f), 'not_found', 'Backup not found', 404);
    return f;
  }

  /** check that a file is a Recep Muhasebe database */
  function inspect(file) {
    let d;
    try {
      d = new DatabaseSync(file, { readOnly: true });
      const ver = d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      const docs = d.prepare('SELECT COUNT(*) AS n FROM docs').get();
      const prods = d.prepare('SELECT COUNT(*) AS n FROM products').get();
      const company = d.prepare("SELECT value FROM settings WHERE key = 'company'").get();
      return { ok: true, schema_version: ver ? Number(ver.value) : 0, docs: docs.n, products: prods.n, company: company ? U.parseJson(company.value, {}).name : null };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      try { d && d.close(); } catch (e) { /* ignore */ }
    }
  }

  /** stage a restore; it is applied on the next start (see applyPendingRestore) */
  function scheduleRestore(file) {
    const info = inspect(file);
    U.assert(info.ok, 'bad_backup', `Not a valid backup file: ${info.error || ''}`);
    backupNow({ reason: 'pre-restore' });
    fs.copyFileSync(file, path.join(app.dataDir, 'restore-pending.db'));
    app.audit({ system: 'backup' }, 'restore_scheduled', 'system', null, path.basename(file), info);
    return info;
  }

  return { backupNow, list, prune, autoBackup, filePath, inspect, scheduleRestore, backupDir };
};

/** before opening the DB: if a restore was staged, swap the files */
module.exports.applyPendingRestore = function applyPendingRestore(dataDir, dbFile) {
  const pending = path.join(dataDir, 'restore-pending.db');
  if (!fs.existsSync(pending)) return false;
  for (const ext of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(dbFile + ext)) fs.unlinkSync(dbFile + ext); } catch (e) { /* ignore */ }
  }
  fs.renameSync(pending, dbFile);
  return true;
};
