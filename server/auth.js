'use strict';
const crypto = require('node:crypto');

/* Every permission the system knows. Grouped for the role editor in the UI. */
const PERMISSIONS = {
  dashboard: ['dashboard.view', 'dashboard.profit'],
  sales: ['pos.use', 'sales.view', 'sales.create', 'sales.edit', 'sales.cancel', 'sales.credit', 'sales.discount', 'sales.below_cost'],
  purchases: ['purchases.view', 'purchases.create', 'purchases.edit', 'purchases.cancel', 'orders.view', 'orders.manage'],
  returns: ['returns.view', 'returns.create', 'returns.cancel', 'returns.unlinked'],
  quotes: ['quotes.view', 'quotes.manage'],
  service: ['service.view', 'service.manage', 'service.invoice'],
  products: ['products.view', 'products.manage', 'products.prices', 'products.cost'],
  stock: ['stock.view', 'stock.adjust', 'stock.count', 'stock.transfer'],
  partners: ['partners.view', 'partners.manage', 'partners.balance', 'partners.adjust'],
  vehicles: ['vehicles.view', 'vehicles.manage'],
  payments: ['payments.collect', 'payments.pay', 'payments.cancel'],
  cash: ['cash.view', 'cash.manage', 'bank.view', 'bank.manage'],
  finance: ['finance.view', 'finance.manage'],
  reports: ['reports.sales', 'reports.stock', 'reports.finance', 'reports.profit'],
  admin: ['users.manage', 'settings.manage', 'backup.manage', 'audit.view'],
};
const ALL_PERMISSIONS = Object.values(PERMISSIONS).flat();

const ROLE_DEFAULTS = [
  { code: 'admin', name: 'Yönetici (Admin)', permissions: ['*'], sort: 1 },
  {
    code: 'manager', name: 'Müdür', sort: 2,
    permissions: ALL_PERMISSIONS.filter((p) => !['users.manage', 'settings.manage', 'backup.manage'].includes(p)),
  },
  {
    code: 'accounting', name: 'Muhasebe', sort: 3,
    permissions: [
      'dashboard.view', 'dashboard.profit', 'sales.view', 'purchases.view', 'purchases.create', 'returns.view', 'quotes.view',
      'service.view', 'orders.view', 'products.view', 'products.cost', 'stock.view',
      'partners.view', 'partners.manage', 'partners.balance', 'partners.adjust', 'vehicles.view',
      'payments.collect', 'payments.pay', 'payments.cancel', 'cash.view', 'cash.manage', 'bank.view', 'bank.manage',
      'finance.view', 'finance.manage', 'reports.sales', 'reports.stock', 'reports.finance', 'reports.profit', 'audit.view',
    ],
  },
  {
    code: 'sales', name: 'Satış Personeli', sort: 4,
    permissions: [
      'dashboard.view', 'pos.use', 'sales.view', 'sales.create', 'sales.credit', 'returns.view', 'returns.create',
      'quotes.view', 'quotes.manage', 'service.view', 'service.manage', 'service.invoice',
      'products.view', 'stock.view', 'partners.view', 'partners.manage', 'partners.balance',
      'vehicles.view', 'vehicles.manage', 'payments.collect',
    ],
  },
  {
    code: 'warehouse', name: 'Depo Sorumlusu', sort: 5,
    permissions: [
      'dashboard.view', 'products.view', 'products.manage', 'products.cost', 'stock.view', 'stock.adjust', 'stock.count', 'stock.transfer',
      'purchases.view', 'purchases.create', 'orders.view', 'orders.manage', 'partners.view', 'vehicles.view', 'reports.stock',
    ],
  },
  {
    code: 'technician', name: 'Usta / Teknisyen', sort: 6,
    permissions: ['dashboard.view', 'service.view', 'service.manage', 'products.view', 'stock.view', 'vehicles.view', 'vehicles.manage', 'partners.view'],
  },
];

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (!stored || secret == null) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(secret), salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }

function hasPerm(perms, p) {
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(p);
}

module.exports = { PERMISSIONS, ALL_PERMISSIONS, ROLE_DEFAULTS, hashSecret, verifySecret, newToken, hasPerm };
