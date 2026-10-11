// Offline engine core: answers the program's API calls from the phone's copy, and keeps the work done on it,
// in order, for the shop computer. It knows nothing about storage or the network (see worker.js), so the same
// code runs in the phone's worker and in the program's tests.

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function newId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); // older phones
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const copyOf = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** the phone's own calendar date (YYYY-MM-DD) */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class LocalError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

const META = ['phone_series', 'phone_owner', 'phone_token', 'phone_snapshot_at', 'phone_version', 'phone_device', 'phone_engine'];

/** device information kept inside the copy (written when a copy is installed) */
export function readMeta(raw) {
  const out = {};
  const st = raw.prepare(`SELECT key, value FROM meta WHERE key IN (${META.map(() => '?').join(',')})`);
  try {
    st.bind(META);
    while (st.step()) { const r = st.get({}); out[r.key] = r.value; }
  } finally { st.finalize(); }
  return out;
}

export function writeMeta(raw, values) {
  const st = raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  try {
    for (const [k, v] of Object.entries(values)) {
      if (!META.includes(k)) continue;
      st.bind([k, v == null ? null : String(v)]);
      st.step();
      st.reset();
    }
  } finally { st.finalize(); }
}

export function ensureQueue(raw) {
  raw.exec('CREATE TABLE IF NOT EXISTS _rm_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, op TEXT NOT NULL)');
}

/**
 * engineModule: the packed server code (/phone/engine.js); raw: the open sqlite-wasm database of the copy.
 * agent: shown in the sign-in records of the copy.
 */
export function createCore({ engineModule, raw, agent = '' }) {
  ensureQueue(raw);
  const meta = readMeta(raw);
  const series = meta.phone_series || null;
  const ownerId = meta.phone_owner || null;
  const eng = engineModule.boot({ openDb: () => raw, series });
  const { app, router, ops, util, db } = eng;

  const sqlOne = (sql, params = []) => app.db.get(sql, params);

  function labelOf(ts) {
    const a = sqlOne('SELECT action, entity, msg, summary FROM audit_log WHERE ts = ? ORDER BY rowid DESC LIMIT 1', [ts]);
    if (!a) return null;
    let msg = null;
    try { msg = a.msg ? JSON.parse(a.msg) : null; } catch (e) { msg = null; }
    return { action: a.action, entity: a.entity, msg, summary: a.summary };
  }

  /** run a write on the copy and keep it for the shop computer, both in one transaction */
  function recordOp(rule, match, ctx, method, pathname, opId) {
    const id = opId && ID_RE.test(opId) ? opId : newId();
    if (sqlOne('SELECT 1 FROM _rm_queue WHERE id = ?', [id])) throw new LocalError(409, 'duplicate_op', 'Already done');
    const ts = new Date().toISOString();
    const day = localDay();
    const original = { query: copyOf(ctx.query), body: copyOf(ctx.body) };
    let base = ops.baseOf(rule, match.params, ctx.body);
    if (base) {
      const row = sqlOne(`SELECT updated_at FROM ${base.t} WHERE ${base.col} = ?`, [base.id]);
      base = row ? { ...base, v: row.updated_at || null } : null;
    }
    // record ids, table by table; a write redone after its online answer was lost (opId) gets the ids the
    // shop computer gave it from the same id, so later work that points at them matches there too
    const uuids = [];
    const make = opId && ID_RE.test(opId) ? db.seededIds(opId) : () => newId();
    util.setClock(ts, day);
    db.setIdSource((table) => { const v = make(table); uuids.push([table || '', v]); return v; });
    app.recordNos = [];
    try {
      return app.db.tx(() => {
        const result = match.route.handler(ctx);
        if (result && typeof result.then === 'function') throw new LocalError(409, 'needs_online', 'This needs the shop computer');
        const op = {
          id, ts, day, method, path: pathname, query: original.query, body: original.body,
          uuids, nos: app.recordNos.slice(), base, label: labelOf(ts), user_id: ctx.user ? ctx.user.id : null,
        };
        app.db.run('INSERT INTO _rm_queue (id, ts, op) VALUES (?, ?, ?)', [id, ts, JSON.stringify(op)]);
        return result;
      });
    } finally {
      util.setClock(null);
      db.setIdSource(null);
      app.recordNos = null;
    }
  }

  /**
   * One API call: { method, path, query, body, token, opId } -> { status, data } or { status, error }.
   * Raw answers (files, exports) come back as { status, raw: { bytes, type, filename } }.
   */
  async function request({ method = 'GET', path, query = {}, body = {}, token = null, opId = null }) {
    const pathname = String(path || '').split('?')[0];
    const verb = method === 'HEAD' ? 'GET' : method;
    try {
      const match = router.match(verb, pathname);
      if (!match) throw new LocalError(404, 'not_found', 'Not found');
      const pattern = match.route.pattern;
      if (ops.needsComputer(verb, pattern)) throw new LocalError(409, 'needs_online', 'This needs the shop computer');
      const user = token ? app.users.session(token) : null;
      if (!match.route.opts.public && !user) throw new LocalError(401, 'unauthorized', 'Please sign in');
      if (user && ownerId && user.id !== ownerId) throw new LocalError(403, 'offline_owner_only', 'The offline copy belongs to another user');
      let session;
      const ctx = {
        app, user, token, ip: 'offline', req: { method: verb, url: pathname, headers: { 'user-agent': agent } }, res: null,
        params: match.params, query: query || {}, body: body || {}, port: 0, remote: true, offline: true,
        setSession(t) { session = t; }, requestRestart() {},
      };
      const rule = verb !== 'GET' ? ops.writeRule(verb, pattern) : null;
      let result;
      if (rule) result = recordOp(rule, match, ctx, verb, pathname, opId);
      else {
        result = match.route.handler(ctx);
        if (result && typeof result.then === 'function') result = await result;
      }
      // on the phone only the copy's owner signs in (the others' PINs never leave the shop computer anyway)
      if (pattern === '/api/auth/login' && ownerId && result && result.user && result.user.id !== ownerId) {
        if (session) app.users.logout(session);
        throw new LocalError(401, 'wrong_credentials', 'Wrong user name, password or PIN');
      }
      // what only the phone's copy says about itself
      if (pattern === '/api/auth/users' && Array.isArray(result) && ownerId) result = result.filter((u) => u.id === ownerId);
      if (pattern === '/api/setup/status' && result) result = { ...result, offline: true };
      if (pattern === '/api/bootstrap' && result && result.server) result = { ...result, server: { ...result.server, offline: true, lan: [] } };
      if (result && result.__raw) {
        const bytes = result.__raw instanceof Uint8Array ? result.__raw : new TextEncoder().encode(String(result.__raw));
        return { status: 200, raw: { bytes: new Uint8Array(bytes), type: result.type || 'application/octet-stream', filename: result.filename || null } };
      }
      const out = { status: 200, data: result === undefined ? { ok: true } : JSON.parse(JSON.stringify(result)) };
      if (session !== undefined) out.session = session;
      return out;
    } catch (e) {
      const status = e.status || (e.code && /^[a-z_]+$/.test(e.code) ? 400 : 500);
      return { status, error: { code: e.code || 'server_error', message: e.message || 'Error', details: e.details } };
    }
  }

  /** a session for the copy's owner who was already signed in to the shop computer (the connection dropped) */
  function adopt(userId) {
    if (!ownerId || userId !== ownerId) throw new LocalError(403, 'offline_owner_only', 'The offline copy belongs to another user');
    const u = sqlOne('SELECT id FROM users WHERE id = ? AND active = 1 AND can_login = 1', [userId]);
    if (!u) throw new LocalError(401, 'unauthorized', 'Please sign in');
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const now = new Date();
    app.db.insert('sessions', {
      token, user_id: userId, created_at: now.toISOString(), last_seen: now.toISOString(),
      expires_at: new Date(now.getTime() + 86400000).toISOString(), ip: 'offline', agent: String(agent).slice(0, 200), remember: 0,
    });
    return token;
  }

  /** the kept work, oldest first */
  function pending(limit = 200) {
    return app.db.all('SELECT op FROM _rm_queue ORDER BY seq LIMIT ?', [limit]).map((r) => JSON.parse(r.op));
  }
  function pendingCount() { return app.db.val('SELECT COUNT(*) FROM _rm_queue') || 0; }

  /** the shop computer's answers: everything it took (or kept as a problem) leaves the phone's list */
  function settle(results) {
    let applied = 0;
    let problems = 0;
    app.db.tx(() => {
      for (const r of results || []) {
        if (!r || !r.id) continue;
        if (['applied', 'duplicate', 'dismissed'].includes(r.status)) applied++;
        else if (['failed', 'conflict'].includes(r.status)) problems++;
        else continue;
        app.db.run('DELETE FROM _rm_queue WHERE id = ?', [r.id]);
      }
    });
    return { applied, problems };
  }

  return { app, router, request, adopt, pending, pendingCount, settle, meta: { ...meta }, ownerId, series };
}
