'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hashSecret, verifySecret, newToken, newSessionId, hasPerm, ALL_PERMISSIONS } = require('../auth');

/*
 * Signing in from a phone or another device (anything but this computer itself) needs a PIN of at least 6
 * digits, or a password of at least 6 characters: a 4-digit PIN is guessed far too soon by anyone who reaches
 * the program. On this computer, and on the phone's own offline copy, 4-digit PINs still work.
 */
const REMOTE_MIN_SECRET = 6;

module.exports = (app) => {
  const { db, uuid, U } = app;
  const sessionCache = new Map(); // token -> {user, at}

  function roleRow(id) { return db.get('SELECT * FROM roles WHERE id = ?', [id]); }

  function permsOfRole(role) {
    if (!role) return [];
    return U.parseJson(role.permissions, []);
  }

  function publicUser(u) {
    if (!u) return null;
    const role = u.role_id ? roleRow(u.role_id) : null;
    return {
      id: u.id, username: u.username, full_name: u.full_name, role_id: u.role_id,
      role_name: role ? role.name : null, role_code: role ? role.code : null,
      phone: u.phone, can_login: !!u.can_login, active: !!u.active,
      has_password: !!u.password_hash, has_pin: !!u.pin_hash,
      // digits of the PIN when known (PINs set before 3.2.1 are learnt the next time they are typed)
      pin_len: u.pin_hash && u.pin_len ? u.pin_len : null,
      max_discount_pct: u.max_discount_pct, commission_sales_pct: u.commission_sales_pct,
      commission_labor_pct: u.commission_labor_pct, default_warehouse_id: u.default_warehouse_id,
      lang: u.lang, notes: u.notes, created_at: u.created_at, last_login_at: u.last_login_at,
      locked_until: lockedUntil(u),
      permissions: permsOfRole(role),
    };
  }

  /** when a paused user may try again (network or this computer, whichever is later), or null */
  function lockedUntil(u) {
    const now = Date.now();
    const net = u.locked_until ? Date.parse(u.locked_until) : 0;
    const loc = (localFails.get(u.id) || {}).until || 0;
    const until = Math.max(net > now ? net : 0, loc > now ? loc : 0);
    return until ? new Date(until).toISOString() : null;
  }

  function rolesList() {
    return db.all('SELECT * FROM roles ORDER BY sort, name').map((r) => ({
      ...r, permissions: U.parseJson(r.permissions, []), builtin: !!r.builtin,
      user_count: db.val('SELECT COUNT(*) FROM users WHERE role_id = ? AND active = 1', [r.id]),
    }));
  }

  function roleSave(data, ctx) {
    const name = U.str(data.name, 80);
    U.assert(name, 'name_required', 'Role name is required');
    let perms = Array.isArray(data.permissions) ? data.permissions.filter((p) => p === '*' || ALL_PERMISSIONS.includes(p)) : [];
    return db.tx(() => {
      if (data.id) {
        const r = roleRow(data.id);
        U.assert(r, 'not_found', 'Role not found', 404);
        if (r.code === 'admin') perms = ['*']; // the admin role always keeps everything
        db.update('roles', r.id, { name, permissions: JSON.stringify(perms) });
        app.audit(ctx, 'update', 'role', r.id, name, { permissions: perms });
        return r.id;
      }
      const id = uuid('roles');
      const sort = (db.val('SELECT MAX(sort) FROM roles') || 0) + 1;
      db.insert('roles', { id, code: null, name, permissions: JSON.stringify(perms), builtin: 0, sort });
      app.audit(ctx, 'create', 'role', id, name, { permissions: perms });
      return id;
    });
  }

  function roleDelete(id, ctx) {
    const r = roleRow(id);
    U.assert(r, 'not_found', 'Role not found', 404);
    U.assert(!r.builtin, 'role_builtin', 'Built-in roles cannot be deleted');
    U.assert(!db.val('SELECT COUNT(*) FROM users WHERE role_id = ?', [id]), 'role_in_use', 'This role is assigned to users');
    db.run('DELETE FROM roles WHERE id = ?', [id]);
    app.audit(ctx, 'delete', 'role', id, r.name);
  }

  function list({ include_inactive } = {}) {
    const rows = db.all(`SELECT * FROM users ${include_inactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, full_name`);
    return rows.map(publicUser);
  }

  function get(id) { return publicUser(db.get('SELECT * FROM users WHERE id = ?', [id])); }

  function activeAdminCount(excludeId) {
    return db.val(`SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.active = 1 AND u.can_login = 1 AND r.code = 'admin' AND u.id <> ?`, [excludeId || '']);
  }

  function save(data, ctx) {
    const full_name = U.str(data.full_name, 120);
    U.assert(full_name, 'name_required', 'Name is required');
    const username = U.str(data.username, 60);
    const role_id = data.role_id || null;
    if (role_id) U.assert(roleRow(role_id), 'role_not_found', 'Role not found');
    return db.tx(() => {
      const now = U.nowIso();
      const fields = {
        full_name, username: username ? username.toLowerCase() : null, role_id,
        phone: U.str(data.phone, 40), can_login: data.can_login === undefined ? 1 : (data.can_login ? 1 : 0),
        active: data.active === undefined ? 1 : (data.active ? 1 : 0),
        max_discount_pct: data.max_discount_pct === '' || data.max_discount_pct == null ? null : U.num(data.max_discount_pct),
        commission_sales_pct: U.num(data.commission_sales_pct), commission_labor_pct: U.num(data.commission_labor_pct),
        default_warehouse_id: data.default_warehouse_id || null, lang: data.lang || null, notes: U.str(data.notes),
        updated_at: now,
      };
      if (fields.username) {
        const dup = db.get('SELECT id FROM users WHERE username = ? AND id <> ?', [fields.username, data.id || '']);
        U.assert(!dup, 'username_taken', 'This username is already used');
      }
      if (data.password) {
        U.assert(String(data.password).length <= 200, 'password_too_long', 'Password is too long (at most 200 characters)');
        fields.password_hash = hashSecret(data.password);
      }
      if (data.pin) {
        U.assert(/^\d{4,8}$/.test(String(data.pin)), 'bad_pin', 'PIN must be 4-8 digits');
        fields.pin_hash = hashSecret(data.pin);
        fields.pin_len = String(data.pin).length;
      }
      // an admin on a phone giving themselves a PIN they could not sign in from a phone with
      if (data.id && ctx && ctx.user && data.id === ctx.user.id && fromNetwork(ctx.ip, ctx.offline)) {
        const short = (data.pin && String(data.pin).length < REMOTE_MIN_SECRET) || (data.password && String(data.password).length < REMOTE_MIN_SECRET);
        U.assert(!short, 'new_secret_short', 'To sign in from a phone, the new PIN or password needs at least 6 digits', 400, { min: REMOTE_MIN_SECRET });
      }
      if (data.clear_pin) { fields.pin_hash = null; fields.pin_len = null; }
      if (data.password || data.pin || data.unlock) {
        fields.failed_logins = 0;
        fields.locked_until = null;
        if (data.id) localFails.delete(data.id);
      }
      if (data.id) {
        const u = db.get('SELECT * FROM users WHERE id = ?', [data.id]);
        U.assert(u, 'not_found', 'User not found', 404);
        const role = roleRow(u.role_id);
        const newRole = roleRow(role_id);
        const losingAdmin = role && role.code === 'admin' && (!newRole || newRole.code !== 'admin' || !fields.active || !fields.can_login);
        if (losingAdmin) U.assert(activeAdminCount(u.id) > 0, 'last_admin', 'At least one active admin user is required');
        db.update('users', u.id, fields);
        // a user who may no longer sign in is signed out everywhere; so is one whose PIN or password changed
        // (a lost phone does not stay signed in), except the admin's own screen when they changed their own
        if (!fields.active || !fields.can_login) endSessions({ userId: u.id });
        else if (data.password || data.pin || data.clear_pin) endSessions({ userId: u.id, except: ctx && ctx.token });
        sessionCache.clear();
        app.audit(ctx, 'update', 'user', u.id, full_name, { ...fields, password_hash: fields.password_hash ? '***' : undefined, pin_hash: fields.pin_hash ? '***' : undefined, pin_len: undefined });
        return u.id;
      }
      const id = uuid('users');
      if (fields.can_login) U.assert(fields.username || fields.pin_hash, 'login_needs_username', 'A username or PIN is required to sign in');
      db.insert('users', { id, ...fields, created_at: now });
      app.audit(ctx, 'create', 'user', id, full_name);
      return id;
    });
  }

  /**
   * A user's own new PIN or password (the current one is needed). Changed from a phone, it must be long enough
   * to sign in from a phone again. Every other session of the user ends; `token` (this screen) stays.
   */
  function changeOwnSecret(userId, { current, password, pin }, ip, { token, offline } = {}) {
    const u = db.get('SELECT * FROM users WHERE id = ?', [userId]);
    U.assert(u, 'not_found', 'User not found', 404);
    if (password) U.assert(String(password).length <= 200, 'password_too_long', 'Password is too long (at most 200 characters)');
    if (pin) U.assert(/^\d{4,8}$/.test(String(pin)), 'bad_pin', 'PIN must be 4-8 digits');
    if (fromNetwork(ip, offline)) {
      const short = (pin && String(pin).length < REMOTE_MIN_SECRET) || (password && String(password).length < REMOTE_MIN_SECRET);
      U.assert(!short, 'new_secret_short', 'To sign in from a phone, the new PIN or password needs at least 6 digits', 400, { min: REMOTE_MIN_SECRET });
    }
    if (u.password_hash || u.pin_hash) {
      checkLocks(u, ip);
      const typed = typedSecret(current);
      const how = matchedBy(u, typed);
      if (!how) {
        const paused = noteFailure(u, ip);
        app.audit({ user: publicUser(u), ip }, 'login_failed', 'user', u.id, { k: 'login_failed', v: paused ? { wait: paused } : {} });
        throw new U.AppError('wrong_password', 'Current password or PIN is wrong', 403);
      }
      noteSuccess(u, ip);
      if (how === 'pin') learnPinLen(u, typed);
    }
    const f = { updated_at: U.nowIso() };
    if (password) f.password_hash = hashSecret(password);
    if (pin) { f.pin_hash = hashSecret(pin); f.pin_len = String(pin).length; }
    db.update('users', userId, f);
    if (password || pin) endSessions({ userId, except: token });
    app.audit({ user: u, ip }, 'update', 'user', userId, 'password/pin changed');
  }

  function loginUsers() {
    return db.all(`SELECT u.id, u.full_name, u.username, u.pin_hash IS NOT NULL AS has_pin, u.password_hash IS NOT NULL AS has_password, r.name AS role_name
      FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND u.can_login = 1 ORDER BY u.full_name`)
      .map((r) => ({ ...r, has_pin: !!r.has_pin, has_password: !!r.has_password }));
  }

  /*
   * Wrong passwords/PINs. After every 5 misses in a row a user is paused, a little longer each time
   * (30 s, 2 min, 10 min, then 30 min), until a right answer or an admin unlocks the user.
   * Misses over the network and misses typed on this computer are counted apart: someone on the network
   * cannot lock the shop's own computer out. Network pauses are kept in the database (a restart does not
   * clear them); a network address that keeps missing (20 misses in 15 minutes, any user names) is paused
   * for 15 minutes as well, so a PC on the network cannot walk through all the 4-digit PINs. Misses on this
   * computer are only kept in memory: whoever sits at it can reach the database file anyway.
   */
  const LOCK_STEPS = [30, 120, 600, 1800];
  const IP_LIMIT = 20;
  const IP_WINDOW = 15 * 60000;
  const IP_LOCK = 15 * 60000;
  const localFails = new Map(); // user id -> { n, until } for misses typed on this computer

  const stepFor = (n) => LOCK_STEPS[Math.min(n / 5 - 1, LOCK_STEPS.length - 1)];

  function lockError(untilMs) {
    const wait = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
    if (wait > 90) return new U.AppError('too_many_attempts_min', 'Too many wrong attempts, try again later', 429, { wait, min: Math.ceil(wait / 60) });
    return new U.AppError('too_many_attempts', 'Too many wrong attempts, wait a little', 429, { wait });
  }

  function checkLocks(u, ip) {
    const now = Date.now();
    if (isLocalIp(ip)) {
      const f = u && localFails.get(u.id);
      if (f && f.until > now) throw lockError(f.until);
      return;
    }
    if (ip) {
      const r = db.get('SELECT locked_until FROM login_failures WHERE ip = ?', [ip]);
      if (r && r.locked_until && Date.parse(r.locked_until) > now) throw lockError(Date.parse(r.locked_until));
    }
    if (u && u.locked_until && Date.parse(u.locked_until) > now) throw lockError(Date.parse(u.locked_until));
  }

  /** counts a miss; returns how many seconds the user or the address is now paused for (0 = not paused) */
  function noteFailure(u, ip) {
    const now = Date.now();
    let paused = 0;
    if (isLocalIp(ip)) {
      if (u) {
        const f = localFails.get(u.id) || { n: 0, until: 0 };
        f.n++;
        if (f.n % 5 === 0) { paused = stepFor(f.n); f.until = now + paused * 1000; }
        localFails.set(u.id, f);
      }
      return paused;
    }
    if (u) {
      const n = (u.failed_logins || 0) + 1;
      const patch = { failed_logins: n };
      if (n % 5 === 0) {
        paused = stepFor(n);
        patch.locked_until = new Date(now + paused * 1000).toISOString();
      }
      db.update('users', u.id, patch);
      sessionCache.clear();
    }
    if (ip) paused = Math.max(paused, noteAddressMiss(ip));
    return paused;
  }

  /** a miss counted against a network address only (20 in 15 minutes pause it); returns the pause in seconds */
  function noteAddressMiss(ip) {
    const now = Date.now();
    let paused = 0;
    const r = db.get('SELECT * FROM login_failures WHERE ip = ?', [ip]);
    const fresh = !r || !r.first_at || now - Date.parse(r.first_at) > IP_WINDOW;
    let count = fresh ? 1 : (r.count || 0) + 1;
    let firstAt = fresh ? new Date(now).toISOString() : r.first_at;
    let lockedUntil = r ? r.locked_until : null;
    if (count >= IP_LIMIT) { lockedUntil = new Date(now + IP_LOCK).toISOString(); count = 0; firstAt = null; paused = IP_LOCK / 1000; }
    db.run(`INSERT INTO login_failures (ip, count, first_at, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET count = excluded.count, first_at = excluded.first_at, locked_until = excluded.locked_until`,
    [ip, count, firstAt, lockedUntil]);
    return paused;
  }

  // a right answer clears that side's misses for the user; an address keeps its count, so knowing one PIN
  // does not help guessing another
  function noteSuccess(u, ip) {
    if (isLocalIp(ip)) { localFails.delete(u.id); return; }
    if (u.failed_logins || u.locked_until) { db.update('users', u.id, { failed_logins: 0, locked_until: null }); sessionCache.clear(); }
  }

  /** the one secret typed for a sign-in (the screens send the same value as password and PIN) */
  function typedSecret(password, pin) {
    const v = password !== undefined && password !== null && password !== '' ? password : pin;
    return v === undefined || v === null ? '' : String(v).slice(0, 200);
  }

  /** which one is right: 'password', 'pin' or null. A PIN is only tried for 4-8 digits, so each attempt is exactly one guess */
  function matchedBy(u, secret) {
    if (!secret) return null;
    if (u.password_hash && verifySecret(secret, u.password_hash)) return 'password';
    return u.pin_hash && /^\d{4,8}$/.test(secret) && verifySecret(secret, u.pin_hash) ? 'pin' : null;
  }

  /** a PIN set before its length was kept (before 3.2.1): its length is known once it is typed right */
  function learnPinLen(u, pin) {
    const n = String(pin).length;
    if (u.pin_len === n) return;
    db.update('users', u.id, { pin_len: n });
    u.pin_len = n;
    sessionCache.clear();
  }

  /** a sign-in from a phone or another device: not this computer itself, and not the phone's own offline copy */
  function fromNetwork(ip, offline) { return !offline && !isLocalIp(ip); }

  /** admin: let a paused user try again right away */
  function unlock(id, ctx) {
    const u = db.get('SELECT * FROM users WHERE id = ?', [id]);
    U.assert(u, 'not_found', 'User not found', 404);
    db.update('users', id, { failed_logins: 0, locked_until: null });
    localFails.delete(id);
    sessionCache.clear();
    app.audit(ctx, 'update', 'user', id, { k: 'user_unlocked', v: { name: u.full_name } });
  }

  /**
   * Forgotten admin PIN: a file whose name starts with "SIFRE-SIFIRLA" (any extension), put into the data
   * folder while the program is closed, removes the PIN/password of the admin users at the next start. They
   * can then sign in without a secret from this computer only (never from the network) and set a new PIN.
   * Whoever can put a file into that folder can already copy the database, so this opens nothing new.
   */
  function emergencyReset() {
    let files = [];
    try { files = fs.readdirSync(app.dataDir); } catch (e) { return 0; }
    const norm = (n) => n.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/[\s_]+/g, '-');
    const hits = files.filter((f) => norm(f).startsWith('sifre-sifirla'));
    if (!hits.length) return 0;
    const admins = db.all(`SELECT u.* FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.active = 1`);
    db.tx(() => {
      for (const u of admins) {
        db.update('users', u.id, { pin_hash: null, password_hash: null, pin_len: null, failed_logins: 0, locked_until: null, can_login: 1, updated_at: U.nowIso() });
        endSessions({ userId: u.id }); // signed out everywhere: from now on only this computer lets them in
        localFails.delete(u.id);
        app.audit({ system: 'system' }, 'update', 'user', u.id, { k: 'secret_reset', v: { name: u.full_name } });
      }
    });
    sessionCache.clear();
    for (const f of hits) {
      const full = path.join(app.dataDir, f);
      try { fs.rmSync(full, { force: true }); } catch (e) {
        try { fs.renameSync(full, path.join(app.dataDir, `kullanildi-${Date.now()}-${f}`)); } catch (x) { /* leave it */ }
      }
    }
    return admins.length;
  }

  /** a phone that keeps an offline copy sends its id when signing in: removing that phone signs it out too */
  function knownDevice(id) {
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return null;
    const d = db.get('SELECT id FROM phone_devices WHERE id = ? AND revoked = 0', [String(id)]);
    return d ? d.id : null;
  }

  /**
   * offline: the phone's own copy is signing its owner in (no network involved).
   * device_id: the phone's offline-copy id, when it has one.
   */
  function login({ user_id, username, password, pin, remember, ip, agent, offline, device_id }) {
    const name = username === undefined || username === null ? '' : String(username).trim().toLowerCase().slice(0, 60);
    let u;
    if (user_id) u = db.get('SELECT * FROM users WHERE id = ?', [String(user_id).slice(0, 64)]);
    else if (name) u = db.get('SELECT * FROM users WHERE username = ?', [name]);
    checkLocks(u, ip);
    const secret = typedSecret(password, pin);
    // from a phone or another device a short PIN or password is not even tried, so the answer tells nothing
    // about it; the attempt still counts against the address, so it cannot be repeated without end
    if (secret && secret.length < REMOTE_MIN_SECRET && fromNetwork(ip, offline)) {
      const paused = ip ? noteAddressMiss(ip) : 0;
      app.audit({ ip, system: name || (u && u.full_name) || null }, 'login_failed', 'user', u ? u.id : null, { k: 'login_failed', v: paused ? { wait: paused, short: 1 } : { short: 1 } });
      throw new U.AppError('remote_pin_short', 'From a phone or another device the PIN or password needs at least 6 digits', 401, { min: REMOTE_MIN_SECRET });
    }
    let how = null;
    if (u && u.active && u.can_login) {
      how = matchedBy(u, secret);
      // a user without any secret (e.g. a fresh single-PC setup) may log in from this computer only
      if (!how && !u.password_hash && !u.pin_hash && isLocalIp(ip)) how = 'none';
    }
    if (!how) {
      const paused = noteFailure(u, ip);
      app.audit({ ip, system: name || (u && u.full_name) || null }, 'login_failed', 'user', u ? u.id : null, { k: 'login_failed', v: paused ? { wait: paused } : {} });
      throw new U.AppError('wrong_credentials', 'Wrong user name, password or PIN', 401);
    }
    noteSuccess(u, ip);
    if (how === 'pin') learnPinLen(u, secret);
    const token = newToken();
    const now = new Date();
    const sec = app.getSetting('security');
    const days = remember ? (sec.session_days || 90) : 1;
    db.insert('sessions', {
      id: newSessionId(), token, user_id: u.id, created_at: now.toISOString(), last_seen: now.toISOString(),
      expires_at: new Date(now.getTime() + days * 86400000).toISOString(), ip: ip || null, agent: agent ? String(agent).slice(0, 200) : null,
      remember: remember ? 1 : 0, device_id: knownDevice(device_id),
    });
    db.update('users', u.id, { last_login_at: now.toISOString() });
    app.audit({ user: u, ip }, 'login', 'user', u.id, u.full_name);
    return { token, user: publicUser(u), remember: !!remember, days };
  }

  /** this computer itself; an unknown address counts as the network */
  function isLocalIp(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  function session(token) {
    if (!token) return null;
    const c = sessionCache.get(token);
    if (c && Date.now() - c.at < 5000) return c.user;
    const s = db.get('SELECT * FROM sessions WHERE token = ?', [token]);
    if (!s) { sessionCache.delete(token); return null; }
    if (s.expires_at && s.expires_at < new Date().toISOString()) {
      db.run('DELETE FROM sessions WHERE token = ?', [token]);
      sessionCache.delete(token);
      return null;
    }
    const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1 AND can_login = 1', [s.user_id]);
    if (!u) return null;
    const pu = publicUser(u);
    if (!c || Date.now() - c.at > 60000) {
      const now = new Date();
      const patch = { last_seen: now.toISOString() };
      if (!s.remember) patch.expires_at = new Date(now.getTime() + 86400000).toISOString();
      db.update('sessions', token, patch, 'token');
    }
    sessionCache.set(token, { user: pu, at: Date.now() });
    return pu;
  }

  function logout(token) {
    if (!token) return;
    db.run('DELETE FROM sessions WHERE token = ?', [token]);
    sessionCache.delete(token);
  }

  /** the lock screen: same pause rules as signing in */
  function verifyUserSecret(userId, secret, ip) {
    const u = db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!u) return false;
    if (!u.password_hash && !u.pin_hash) return true;
    checkLocks(u, ip);
    const typed = typedSecret(secret);
    const how = matchedBy(u, typed);
    if (how) {
      noteSuccess(u, ip);
      if (how === 'pin') learnPinLen(u, typed);
    } else {
      const paused = noteFailure(u, ip);
      app.audit({ user: publicUser(u), ip }, 'login_failed', 'user', u.id, { k: 'login_failed', v: paused ? { wait: paused } : {} });
    }
    return !!how;
  }

  /**
   * End sessions: one by its public id or its token, those of one phone (deviceId), a user's (userId), or,
   * only with `all: true`, everyone's. `except` (a token) is never ended: the screen that asked stays open.
   * Nothing chosen, nothing ends. Returns how many ended.
   */
  function endSessions({ id, token, deviceId, userId, all = false, except } = {}) {
    const where = [];
    const params = [];
    if (id) { where.push('id = ?'); params.push(String(id)); }
    if (token) { where.push('token = ?'); params.push(String(token)); }
    if (deviceId) { where.push('device_id = ?'); params.push(String(deviceId)); }
    if (userId) { where.push('user_id = ?'); params.push(String(userId)); }
    if (!where.length && !all) return 0;
    if (except) { where.push('token <> ?'); params.push(String(except)); }
    const r = db.run(`DELETE FROM sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params);
    sessionCache.clear();
    return (r && r.changes) || 0;
  }

  /** who is signed in where (newest first); tokens never leave this function */
  function sessionsList(currentToken) {
    db.run('UPDATE sessions SET id = lower(hex(randomblob(12))) WHERE id IS NULL');
    const now = new Date().toISOString();
    return db.all(`SELECT s.id, s.token, s.user_id, u.full_name, s.created_at, s.last_seen, s.ip, s.agent,
        d.code AS device_code, d.name AS device_name
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN phone_devices d ON d.id = s.device_id AND d.revoked = 0
      WHERE s.expires_at IS NULL OR s.expires_at >= ? ORDER BY s.last_seen DESC LIMIT 200`, [now])
      .map(({ token, ...s }) => ({ ...s, current: !!currentToken && token === currentToken, here: isLocalIp(s.ip) }));
  }

  /** a session by its public id (for the record of who ended which) */
  function sessionById(id) {
    if (!id) return null;
    return db.get(`SELECT s.id, s.user_id, u.full_name, s.ip, s.agent, d.code AS device_code FROM sessions s
      JOIN users u ON u.id = s.user_id LEFT JOIN phone_devices d ON d.id = s.device_id WHERE s.id = ?`, [String(id)]) || null;
  }

  /** can `user` do permission p? */
  function can(user, p) { return !!user && hasPerm(user.permissions, p); }

  return {
    rolesList, roleSave, roleDelete, list, get, save, changeOwnSecret, loginUsers, login, session, logout, unlock, emergencyReset,
    verifyUserSecret, can, publicUser, activeAdminCount, endSessions, sessionsList, sessionById, fromNetwork, REMOTE_MIN_SECRET,
  };
};
