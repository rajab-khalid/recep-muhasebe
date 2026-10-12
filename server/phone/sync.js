'use strict';
/*
 * Shop computer side of the phone's offline copy.
 *
 *  - Devices: each phone that keeps a copy gets a short code (T1, T2...). Its documents made offline are
 *    numbered in that series, so they never collide with the computer's numbers.
 *  - Snapshot: a copy of the database for the phone, without sign-in sessions, other users' PINs and product
 *    photos, made in a background thread so the program does not pause while it is made.
 *  - Sync: the work the phone did offline, replayed here in order through the normal API handlers, with the
 *    phone's own times, record ids and document numbers. Every piece is applied once (the phone may send it
 *    again after a lost answer). An edit of a record that was changed here meanwhile is not applied over it;
 *    it is kept as a problem for the owner, like anything else that could not be applied.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const ops = require('./ops');
const { setIdSource, seededIds } = require('../db');

/* The snapshot is made in a worker thread: a consistent copy (VACUUM INTO), cleaned, packed with gzip. */
const SNAPSHOT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { src, tmp, userId, logoId, auditFrom } = workerData;
let done = false;
try {
  const s = new DatabaseSync(src);
  try { s.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); } finally { s.close(); }
  const d = new DatabaseSync(tmp);
  try {
    d.exec('PRAGMA journal_mode = DELETE');
    d.exec('PRAGMA secure_delete = ON');
    d.exec('BEGIN');
    d.exec('DELETE FROM sessions; DELETE FROM login_failures; DELETE FROM phone_ops; DELETE FROM phone_devices;');
    d.prepare('UPDATE users SET password_hash = NULL, pin_hash = NULL, pin_len = NULL WHERE id <> ?').run(userId);
    d.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL').run();
    d.prepare('DELETE FROM files WHERE id <> ?').run(logoId || '');
    d.prepare('DELETE FROM audit_log WHERE ts < ?').run(auditFrom);
    d.exec('COMMIT');
    d.exec('VACUUM');
  } finally { d.close(); }
  const raw = fs.readFileSync(tmp);
  const gz = new Uint8Array(zlib.gzipSync(raw, { level: 6 }));
  done = true;
  parentPort.postMessage({ ok: true, size: raw.length, gz }, [gz.buffer]);
} catch (e) {
  if (!done) parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
} finally {
  try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
}
`;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE_RE = /^[a-z_.]{1,40}$/;
const MAX_OPS = 500;

module.exports = function phoneSync(app, router) {
  const { db, U } = app;

  /** only the owner (admin) may keep a full copy of the shop's data on a phone */
  const isOwner = (user) => !!(user && Array.isArray(user.permissions) && user.permissions.includes('*'));

  /* ------------------------------------------------------------------ devices */
  function device(id) {
    return id && ID_RE.test(String(id)) ? db.get('SELECT * FROM phone_devices WHERE id = ?', [String(id)]) || null : null;
  }

  function register(id, user, { name, agent } = {}) {
    U.assert(id && ID_RE.test(String(id)), 'bad_device', 'Invalid device');
    return db.tx(() => {
      const now = U.nowIso();
      const d = device(id);
      if (d) {
        U.assert(!d.revoked, 'device_revoked', 'This phone was removed from offline work on the shop computer', 403);
        db.update('phone_devices', d.id, { user_id: user.id, name: U.str(name, 80) || d.name, agent: U.str(agent, 200) || d.agent, last_seen: now });
        return device(id);
      }
      const used = new Set(db.all('SELECT code FROM phone_devices').map((r) => r.code));
      let n = 1;
      while (used.has(`T${n}`)) n++;
      db.insert('phone_devices', { id: String(id), code: `T${n}`, user_id: user.id, name: U.str(name, 80), agent: U.str(agent, 200), created_at: now, last_seen: now, revoked: 0 });
      app.audit({ user }, 'phone_copy', 'system', null, { k: 'phone_copy', v: { code: `T${n}`, name: U.str(name, 80) || '' } });
      return device(id);
    });
  }

  /**
   * The phone asking must be this user's, known here and not removed. A removed phone (e.g. lost) that still
   * shows up with a session is signed out on the spot: that session may be older than its link to the phone.
   */
  function deviceFor(id, user, ctx) {
    const d = device(id);
    U.assert(d, 'device_unknown', 'This phone is not set up for offline work', 404);
    if (d.revoked) {
      if (ctx && ctx.token) app.users.endSessions({ token: ctx.token });
      throw new U.AppError('device_revoked', 'This phone was removed from offline work on the shop computer', 403);
    }
    U.assert(d.user_id === user.id, 'device_other_user', 'The offline copy on this phone belongs to another user', 403);
    return d;
  }

  function devices() {
    return db.all(`SELECT d.*, u.full_name AS user_name,
        (SELECT COUNT(*) FROM phone_ops o WHERE o.device_id = d.id AND o.status IN ('failed', 'conflict')) AS problems
      FROM phone_devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.revoked, d.code`);
  }

  /** a removed phone (e.g. lost) is signed out too, unless it is the very screen removing it */
  function revoke(id, ctx) {
    const d = device(id);
    U.assert(d, 'not_found', 'Not found', 404);
    db.update('phone_devices', d.id, { revoked: 1 });
    const ended = app.users.endSessions({ deviceId: d.id, except: ctx && ctx.token });
    app.audit(ctx, 'phone_copy_removed', 'system', null, { k: 'phone_copy_removed', v: { code: d.code, name: d.name || '' } });
    return { ok: true, signed_out: ended };
  }

  /**
   * The session asking belongs to this phone: removing the phone signs it out. Phones that were signed in
   * before 3.2.1 are matched this way at their next check-in.
   */
  function linkSession(ctx, deviceId) {
    if (!ctx || !ctx.token || !deviceId) return;
    db.run('UPDATE sessions SET device_id = ? WHERE token = ? AND (device_id IS NULL OR device_id <> ?)', [deviceId, ctx.token, deviceId]);
  }

  /* ------------------------------------------------------------------ snapshot */
  const cache = new Map(); // `${token}|${userId}` -> { gz, size, token }
  const building = new Map(); // same key -> Promise

  function buildSnapshot(user) {
    const logoId = (app.getSetting('company') || {}).logo_file_id || '';
    const tmp = path.join(os.tmpdir(), `rm-phone-${process.pid}-${app.uuid()}.db`);
    const auditFrom = new Date(Date.now() - 60 * 86400000).toISOString();
    return new Promise((resolve, reject) => {
      const w = new Worker(SNAPSHOT_WORKER, { eval: true, workerData: { src: app.dbFile, tmp, userId: user.id, logoId, auditFrom } });
      let settled = false;
      w.once('message', (m) => {
        settled = true;
        if (m && m.ok) resolve({ gz: Buffer.from(m.gz.buffer, m.gz.byteOffset, m.gz.byteLength), size: m.size });
        else reject(new U.AppError('snapshot_failed', `The copy could not be made: ${(m && m.error) || ''}`, 500));
      });
      w.once('error', (e) => { if (!settled) { settled = true; reject(new U.AppError('snapshot_failed', `The copy could not be made: ${e.message}`, 500)); } });
      w.once('exit', (code) => { if (!settled) { settled = true; reject(new U.AppError('snapshot_failed', `The copy could not be made (${code})`, 500)); } });
    });
  }

  async function snapshot(user) {
    const token = app.changeToken();
    const key = `${token}|${user.id}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (!building.has(key)) {
      building.set(key, buildSnapshot(user).then((s) => {
        const out = { ...s, token };
        for (const k of cache.keys()) if (k.endsWith(`|${user.id}`)) cache.delete(k); // one copy per user is enough
        cache.set(key, out);
        return out;
      }).finally(() => building.delete(key)));
    }
    return building.get(key);
  }

  /* ------------------------------------------------------------------ replay */
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

  /** the op as sent by the phone, checked and trimmed to what is used */
  function clean(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id, 40);
    const method = ['POST', 'DELETE'].includes(raw.method) ? raw.method : null;
    const p = str(raw.path, 300);
    let ts = str(raw.ts, 40);
    if (!id || !ID_RE.test(id) || !method || !p || !p.startsWith('/api/') || !ts || !Number.isFinite(Date.parse(ts))) return null;
    // a phone whose clock runs ahead cannot date work in the future
    let day = U.isDate(raw.day) ? raw.day : null;
    if (Date.parse(ts) > Date.now() + 10 * 60000) { ts = new Date().toISOString(); day = null; }
    if (!Array.isArray(raw.uuids) || raw.uuids.length > 50000 || !Array.isArray(raw.nos) || raw.nos.length > 2000) return null;
    return {
      id, method, path: p, ts, day, seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : 0,
      query: raw.query && typeof raw.query === 'object' ? raw.query : {},
      body: raw.body && typeof raw.body === 'object' ? raw.body : {},
      // [table, id] in the order the phone made them
      uuids: raw.uuids.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && TABLE_RE.test(x[0] || 'x') && typeof x[1] === 'string' && ID_RE.test(x[1])),
      nos: raw.nos.filter((x) => x && typeof x === 'object' && typeof x.type === 'string' && typeof x.no === 'string'),
      base: raw.base && typeof raw.base === 'object' && typeof raw.base.t === 'string' && typeof raw.base.id === 'string' ? raw.base : null,
      label: raw.label && typeof raw.label === 'object' ? raw.label : null,
      user_id: str(raw.user_id, 64),
    };
  }

  /** the phone's ids, handed out table by table in the phone's order */
  function idQueue(op) {
    const q = new Map();
    for (const [t, id] of op.uuids) {
      if (!q.has(t)) q.set(t, []);
      q.get(t).push(id);
    }
    return (table) => { const list = q.get(table || ''); return list && list.length ? list.shift() : undefined; };
  }

  /** the phone's number series goes on after the numbers this op took, even when the op itself failed */
  function keepSeries(op) {
    for (const r of op.nos) {
      if (typeof r.key === 'string' && /^[a-z_]+:\d{4}:[A-Z0-9]{1,6}$/.test(r.key) && Number(r.n) > 0) {
        db.run('INSERT INTO sequences (key, last_no) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_no = MAX(last_no, excluded.last_no)', [r.key, Math.floor(Number(r.n))]);
      }
    }
  }

  function record(op, dev, user, status, error) {
    const keep = status !== 'applied';
    db.run(`INSERT INTO phone_ops (id, device_id, user_id, seq, ts, method, path, status, error, op, label, source, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, op = excluded.op, label = excluded.label, applied_at = excluded.applied_at`,
    [op.id, dev ? dev.id : null, user ? user.id : null, op.seq, op.ts, op.method, op.path, status, error ? JSON.stringify(error) : null,
      keep ? JSON.stringify(op) : null, op.label ? JSON.stringify(op.label) : null, new Date().toISOString(), status === 'applied' ? new Date().toISOString() : null]);
  }

  const errorOf = (e) => ({ code: (e && e.code) || 'server_error', message: (e && e.message) || 'Error', details: e && e.details });

  /**
   * Apply one op from the phone. Returns { id, status, error? } with status applied | duplicate | failed | conflict.
   * opts.force: apply an edit even though the record was changed here meanwhile (the owner chose so).
   */
  function applyOp(raw, ctx, dev, opts = {}) {
    const op = clean(raw);
    if (!op) {
      // unreadable: kept as a problem when it can be told apart, so the phone does not drop it unseen
      const id = raw && typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
      const error = { code: 'bad_op', message: 'Invalid offline work item' };
      if (!id) return { id: null, status: 'failed', error };
      if ((db.get('SELECT status FROM phone_ops WHERE id = ?', [id]) || {}).status === 'applied') return { id, status: 'duplicate' };
      let content = null;
      try { content = JSON.stringify(raw); } catch (e) { content = null; }
      const stub = { id, seq: 0, ts: new Date().toISOString(), method: String(raw.method || '').slice(0, 10), path: String(raw.path || '').slice(0, 300), nos: [], label: raw.label && typeof raw.label === 'object' ? raw.label : null };
      record(stub, dev, ctx.user, 'failed', error);
      if (content && content.length <= 8 * 1024 * 1024) db.run('UPDATE phone_ops SET op = ? WHERE id = ?', [content, id]); // kept as sent, for a closer look
      return { id, status: 'failed', error };
    }
    const prev = db.get('SELECT status FROM phone_ops WHERE id = ?', [op.id]);
    if (prev && prev.status === 'applied') {
      db.tx(() => keepSeries(op)); // numbers the phone gave it stay taken (the phone may have printed them)
      return { id: op.id, status: 'duplicate' };
    }
    if (prev && prev.status === 'dismissed' && !opts.retry) return { id: op.id, status: 'dismissed' };
    const fail = (status, error) => {
      db.tx(() => { record(op, dev, ctx.user, status, error); keepSeries(op); });
      return { id: op.id, status, error };
    };
    const m = router.match(op.method, op.path.split('?')[0]);
    const rule = m && ops.writeRule(op.method, m.route.pattern);
    if (!rule) return fail('failed', { code: 'needs_online', message: 'This work cannot be done offline' });
    if (op.user_id && op.user_id !== ctx.user.id) return fail('failed', { code: 'device_other_user', message: 'Done by another user' });
    // an edit: the record must still be as the phone saw it
    if (op.base && !opts.force && ops.BASE_TABLES.has(op.base.t) && ['id', 'code'].includes(op.base.col || 'id')) {
      const row = db.get(`SELECT updated_at FROM ${op.base.t} WHERE ${op.base.col || 'id'} = ?`, [op.base.id]);
      if (row && (row.updated_at || null) !== (op.base.v || null)) return fail('conflict', { code: 'changed_on_pc', message: 'Changed on the shop computer meanwhile' });
    }
    try {
      U.setClock(op.ts, op.day);
      setIdSource(idQueue(op));
      app.replayNos = op.nos.map((x) => ({ ...x }));
      db.tx(() => {
        const opCtx = {
          app, user: ctx.user, token: null, ip: `telefon:${dev ? dev.code : '?'}`, req: ctx.req, res: null, params: m.params,
          query: op.query, body: op.body, port: ctx.port, remote: true, replay: true, setSession() {}, requestRestart() {},
        };
        const r = m.route.handler(opCtx);
        U.assert(!(r && typeof r.then === 'function'), 'needs_online', 'This work cannot be done offline');
        keepSeries(op);
        record(op, dev, ctx.user, 'applied', null);
      });
      app.noteChange();
      return { id: op.id, status: 'applied' };
    } catch (e) {
      U.setClock(null);
      setIdSource(null);
      app.replayNos = null;
      return fail('failed', errorOf(e));
    } finally {
      U.setClock(null);
      setIdSource(null);
      app.replayNos = null;
    }
  }

  function sync(body, ctx) {
    const dev = deviceFor(body.device_id, ctx.user, ctx);
    linkSession(ctx, dev.id);
    const list = Array.isArray(body.ops) ? body.ops : [];
    U.assert(list.length <= MAX_OPS, 'too_many_ops', 'Too much offline work at once');
    const results = list.map((op) => applyOp(op, ctx, dev));
    db.update('phone_devices', dev.id, { last_sync_at: U.nowIso(), last_seen: U.nowIso() });
    return { results, token: app.changeToken() };
  }

  /* ------------------------------------------------------------------ problems (work that could not be applied) */
  function problems({ device_id } = {}) {
    const where = ["o.status IN ('failed', 'conflict')"];
    const params = [];
    if (device_id) { where.push('o.device_id = ?'); params.push(device_id); }
    return db.all(`SELECT o.id, o.device_id, d.code AS device_code, o.ts, o.method, o.path, o.status, o.error, o.label, o.created_at
      FROM phone_ops o LEFT JOIN phone_devices d ON d.id = o.device_id WHERE ${where.join(' AND ')} ORDER BY o.ts, o.seq LIMIT 500`, params)
      .map((r) => ({ ...r, error: U.parseJson(r.error, null), label: U.parseJson(r.label, null) }));
  }

  function problemRow(id) {
    const r = db.get('SELECT * FROM phone_ops WHERE id = ?', [id]);
    U.assert(r && ['failed', 'conflict'].includes(r.status), 'not_found', 'Not found', 404);
    return r;
  }

  function retry(id, ctx, { force } = {}) {
    const r = problemRow(id);
    const op = U.parseJson(r.op, null);
    U.assert(op, 'not_found', 'Not found', 404);
    U.assert(!op.user_id || op.user_id === ctx.user.id, 'device_other_user', 'Done by another user', 403);
    const dev = device(r.device_id);
    return applyOp(op, ctx, dev, { force: !!force, retry: true });
  }

  function dismiss(id, ctx) {
    const r = problemRow(id);
    db.update('phone_ops', r.id, { status: 'dismissed', applied_at: U.nowIso() });
    app.audit(ctx, 'phone_op_dismissed', 'system', null, { k: 'phone_op_dismissed', v: { path: r.path } });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ the phone's work done online (lost answers) */
  /**
   * A write the phone sent online with its own id (X-Op-Id). If the answer was lost, the phone does it again
   * on its copy and sends it later with the same id: then it is recognised here and not applied twice.
   * run() does the write; this wraps it so the id is kept in the same transaction.
   */
  /**
   * A write from the phone app with its own id (X-Op-Id): kept with its answer, so the same write sent again
   * (the answer was lost on the way) is answered from the record instead of being done twice.
   * Work the phone can also do offline (atomic) is done in one transaction with its record and with record ids
   * worked out from the op's id: if the phone redoes it on its copy and sends it later, it is recognised and
   * later offline work that points at these records finds them here too.
   * Returns { result, duplicate } (or a Promise of it for an asynchronous handler).
   */
  function onlineWrite(opId, deviceId, ctx, run, { atomic = false } = {}) {
    // a removed phone does no more work here, and is signed out (see deviceFor)
    const named = device(deviceId);
    if (named && named.revoked) {
      if (ctx.token) app.users.endSessions({ token: ctx.token });
      throw new U.AppError('device_revoked', 'This phone was removed from offline work on the shop computer', 403);
    }
    const prev = db.get('SELECT status, result FROM phone_ops WHERE id = ?', [opId]);
    if (prev && prev.status === 'applied') return { duplicate: true, result: U.parseJson(prev.result, { ok: true }) };
    const keep = (r) => {
      const now = new Date().toISOString();
      const dev = device(deviceId);
      let text = null;
      if (r !== undefined && !(r && r.__raw)) { try { text = JSON.stringify(r); } catch (e) { text = null; } }
      if (text && text.length > 1024 * 1024) text = null;
      db.run(`INSERT INTO phone_ops (id, device_id, user_id, ts, method, path, status, source, result, created_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'applied', result = excluded.result, applied_at = excluded.applied_at`,
      [opId, dev ? dev.id : null, ctx.user ? ctx.user.id : null, now, ctx.req.method, ctx.req.url.split('?')[0].slice(0, 300), atomic ? 'online' : 'online-plain', text, now, now]);
    };
    if (!atomic) {
      // other writes (settings, imports, backups...) keep their own transactions; the record follows them
      const r = run();
      if (r && typeof r.then === 'function') return r.then((x) => { keep(x); return { result: x, duplicate: false }; });
      keep(r);
      return { result: r, duplicate: false };
    }
    setIdSource(seededIds(opId));
    try {
      return db.tx(() => {
        const r = run();
        U.assert(!(r && typeof r.then === 'function'), 'server_error', 'Unexpected asynchronous write');
        keep(r);
        return { result: r, duplicate: false };
      });
    } finally { setIdSource(null); }
  }

  /*
   * Old bookkeeping is dropped: applied work after 120 days, problems someone dismissed after 30 days. The
   * kept answers of online writes are only needed for a moment (a lost answer): dropped after 3 days; online
   * writes the phone cannot do offline are forgotten then altogether.
   */
  function prune() {
    const day = 86400000;
    const ago = (n) => new Date(Date.now() - n * day).toISOString();
    db.run("DELETE FROM phone_ops WHERE (status = 'applied' AND created_at < ?) OR (status = 'dismissed' AND applied_at < ?) OR (source = 'online-plain' AND created_at < ?)", [ago(120), ago(30), ago(3)]);
    db.run("UPDATE phone_ops SET result = NULL WHERE result IS NOT NULL AND created_at < ?", [ago(3)]);
  }

  return { isOwner, device, register, deviceFor, devices, revoke, linkSession, snapshot, applyOp, sync, problems, retry, dismiss, onlineWrite, prune, ID_RE };
};
