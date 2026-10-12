'use strict';
/*
 * API for the phone app's offline copy (shop computer only; not part of the phone's own engine).
 * Only the owner (admin) may keep a copy of the shop's data on a phone.
 */
const { engine } = require('./bundle');

module.exports = function registerPhoneRoutes(router, app) {
  const { U } = app;
  const sync = require('./sync')(app, router);
  const need = (ctx) => {
    U.assert(ctx.user, 'unauthorized', 'Please sign in', 401);
    U.assert(sync.isOwner(ctx.user), 'offline_owner_only', 'Only the owner (admin) can keep an offline copy on a phone', 403);
  };

  /** a phone starts keeping a copy: it gets its own document number series (T1, T2...) */
  router.post('/api/phone/register', (ctx) => {
    need(ctx);
    const d = sync.register(ctx.body.device_id, ctx.user, { name: ctx.body.name, agent: ctx.req.headers['user-agent'] });
    sync.linkSession(ctx, d.id);
    return { code: d.code };
  }, { smallBody: true });

  /** cheap check: has anything changed since the phone's copy was made? */
  router.get('/api/phone/state', (ctx) => {
    need(ctx);
    const d = sync.deviceFor(ctx.query.device, ctx.user, ctx);
    app.db.update('phone_devices', d.id, { last_seen: U.nowIso() });
    sync.linkSession(ctx, d.id);
    return { token: app.changeToken(), version: app.version, engine: engine().hash, code: d.code, problems: sync.problems({ device_id: d.id }).length };
  });

  /** the copy itself (an SQLite database, gzip-packed) */
  router.get('/api/phone/snapshot', async (ctx) => {
    need(ctx);
    const d = sync.deviceFor(ctx.query.device, ctx.user, ctx);
    sync.linkSession(ctx, d.id);
    const s = await sync.snapshot(ctx.user);
    app.db.update('phone_devices', d.id, { last_snapshot_at: U.nowIso(), last_seen: U.nowIso() });
    return {
      __raw: s.gz, type: 'application/vnd.sqlite3', cache: 'no-store',
      headers: { 'Content-Encoding': 'gzip', 'X-RM-Token': s.token, 'X-RM-Series': d.code, 'X-RM-Version': app.version, 'X-RM-Size': String(s.size), 'X-RM-Engine': engine().hash },
    };
  });

  /** the work the phone did offline, in order */
  router.post('/api/phone/sync', (ctx) => { need(ctx); return sync.sync(ctx.body || {}, ctx); }, { bigBody: true });

  router.get('/api/phone/problems', (ctx) => {
    need(ctx);
    if (ctx.query.device) return sync.problems({ device_id: sync.deviceFor(ctx.query.device, ctx.user, ctx).id });
    return sync.problems();
  });
  router.post('/api/phone/problems/:id/retry', (ctx) => { need(ctx); return sync.retry(ctx.params.id, ctx, { force: !!(ctx.body && ctx.body.force) }); });
  router.post('/api/phone/problems/:id/dismiss', (ctx) => { need(ctx); return sync.dismiss(ctx.params.id, ctx); });

  /*
   * Public: was this phone removed on the shop computer? A removed phone is signed out as well, so it can no
   * longer ask with a session; it asks this from its sign-in screen and drops its copy. Nothing else is told.
   */
  router.get('/api/phone/removed', (ctx) => {
    const d = sync.device(ctx.query.device);
    return { removed: !!(d && d.revoked) };
  }, { public: true });

  router.get('/api/phone/devices', (ctx) => { need(ctx); return sync.devices(); });
  router.post('/api/phone/devices/:id/revoke', (ctx) => { need(ctx); return sync.revoke(ctx.params.id, ctx); });

  return sync;
};
