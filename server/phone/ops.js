'use strict';
/*
 * What the phone may do on its offline copy (used on both sides: the phone decides with it what it keeps for
 * the shop computer, the computer checks with it what it accepts back).
 *
 *  - WRITES: everyday work. Done on the phone's copy at once, kept in order and replayed on the shop computer
 *    as soon as the phone reaches it. `base` names the record an edit changes: when the computer changed that
 *    record meanwhile, the phone's edit is not applied over it (the owner decides what to do).
 *  - LOCAL: signing in and out on the phone itself; nothing to send.
 *  - Everything else (settings, users, backups, cash boxes, warehouses...) needs the shop computer.
 */
const WRITES = [
  ['POST', '/api/products', { t: 'products', from: 'body', key: 'id' }],
  ['DELETE', '/api/products/:id', { t: 'products', from: 'params', key: 'id' }],
  ['POST', '/api/categories'],
  ['DELETE', '/api/categories/:id'],
  ['POST', '/api/brands'],
  ['DELETE', '/api/brands/:id'],
  ['POST', '/api/vehicle-makes'],
  ['POST', '/api/vehicle-models'],
  ['POST', '/api/vehicles', { t: 'vehicles', from: 'body', key: 'id' }],
  ['POST', '/api/partners', { t: 'partners', from: 'body', key: 'id' }],
  ['DELETE', '/api/partners/:id', { t: 'partners', from: 'params', key: 'id' }],
  ['POST', '/api/partners/:id/adjust'],
  ['POST', '/api/partners/:id/convert'],
  ['POST', '/api/partner-moves/:id/cancel'],
  ['POST', '/api/docs', { t: 'docs', from: 'body', key: 'id' }],
  ['POST', '/api/docs/:id/post', { t: 'docs', from: 'params', key: 'id' }],
  ['POST', '/api/docs/:id/cancel'],
  ['POST', '/api/docs/:id/status', { t: 'docs', from: 'params', key: 'id' }],
  ['DELETE', '/api/docs/:id', { t: 'docs', from: 'params', key: 'id' }],
  ['POST', '/api/payments'],
  ['POST', '/api/payments/:id/cancel'],
  ['POST', '/api/payments/:id/allocate'],
  ['POST', '/api/money/transfer'],
  ['POST', '/api/money/transfers/:id/cancel'],
  ['POST', '/api/money/manual'],
  ['POST', '/api/money/moves/:id/cancel'],
  ['POST', '/api/money/count'],
  ['POST', '/api/finance/categories'],
  ['POST', '/api/finance/entries'],
  ['POST', '/api/finance/entries/:id/cancel'],
  ['POST', '/api/stock/counts'],
  ['POST', '/api/stock/counts/:id/lines'],
  ['POST', '/api/stock/counts/:id/post'],
  ['DELETE', '/api/stock/counts/:id'],
  ['POST', '/api/currencies/:code/rate', { t: 'currencies', from: 'params', key: 'code', col: 'code' }],
  ['POST', '/api/notifications/read'],
];

const LOCAL = [
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/verify'],
  ['POST', '/api/products/for-sale'], // a read sent as POST (a list of product ids with prices for a customer)
];

/* reads that only make sense with the shop computer (they reach the internet or the computer's own files) */
const ONLINE_READS = [
  ['GET', '/api/rates/online'],
  ['GET', '/api/backup/download/:name'],
];

const key = (method, pattern) => `${method} ${pattern}`;
const writeRules = new Map(WRITES.map(([m, p, base]) => [key(m, p), { method: m, pattern: p, base: base || null }]));
const localSet = new Set(LOCAL.map(([m, p]) => key(m, p)));
const onlineReads = new Set(ONLINE_READS.map(([m, p]) => key(m, p)));

/** the rule for a write the phone may do offline, or null */
function writeRule(method, pattern) { return writeRules.get(key(method, pattern)) || null; }
function isLocal(method, pattern) { return localSet.has(key(method, pattern)); }
function needsComputer(method, pattern) {
  if (method === 'GET' || method === 'HEAD') return onlineReads.has(key('GET', pattern));
  return !writeRule(method, pattern) && !isLocal(method, pattern);
}

/** the record an edit changes: { t, col, id } or null (a new record, or a write that changes no single record) */
function baseOf(rule, params, body) {
  if (!rule || !rule.base) return null;
  const src = rule.base.from === 'params' ? params : body;
  const id = src && src[rule.base.key];
  if (!id || typeof id !== 'string') return null;
  return { t: rule.base.t, col: rule.base.col || 'id', id };
}

const BASE_TABLES = new Set(WRITES.filter((w) => w[2]).map((w) => w[2].t));

module.exports = { WRITES, LOCAL, writeRule, isLocal, needsComputer, baseOf, BASE_TABLES };
