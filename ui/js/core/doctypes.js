// Document types as the interface sees them: permissions, partner kind, payment direction, workflow statuses.
import { can } from './store.js';

export const DOC_TYPES = {
  sale: { icon: 'receipt', list: 'nav.sales', partner: 'customer', pay: 'in', posting: true, perm: { view: 'sales.view', create: 'sales.create', edit: 'sales.edit', cancel: 'sales.cancel' } },
  purchase: { icon: 'truck', list: 'nav.purchases', partner: 'supplier', pay: 'out', posting: true, perm: { view: 'purchases.view', create: 'purchases.create', edit: 'purchases.edit', cancel: 'purchases.cancel' } },
  sale_return: { icon: 'undo-2', list: 'nav.returns', partner: 'customer', pay: 'out', posting: true, returnOf: 'sale', perm: { view: 'returns.view', create: 'returns.create', edit: 'returns.create', cancel: 'returns.cancel' } },
  purchase_return: { icon: 'rotate-ccw', list: 'nav.purchase_returns', partner: 'supplier', pay: 'in', posting: true, returnOf: 'purchase', perm: { view: 'returns.view', create: 'returns.create', edit: 'returns.create', cancel: 'returns.cancel' } },
  quote: { icon: 'clipboard-list', list: 'nav.quotes', partner: 'customer', statuses: ['open', 'accepted', 'rejected', 'converted', 'cancelled'], perm: { view: 'quotes.view', create: 'quotes.manage', edit: 'quotes.manage', cancel: 'quotes.manage' } },
  service: { icon: 'wrench', list: 'nav.service', partner: 'customer', statuses: ['open', 'in_progress', 'waiting_parts', 'done', 'delivered', 'invoiced', 'cancelled'], perm: { view: 'service.view', create: 'service.manage', edit: 'service.manage', cancel: 'service.manage' } },
  purchase_order: { icon: 'file-text', list: 'nav.orders', partner: 'supplier', statuses: ['open', 'sent', 'received', 'cancelled'], perm: { view: 'orders.view', create: 'orders.manage', edit: 'orders.manage', cancel: 'orders.manage' } },
  transfer: { icon: 'arrow-left-right', list: 'nav.transfers', posting: true, noMoney: true, perm: { view: 'stock.view', create: 'stock.transfer', edit: 'stock.transfer', cancel: 'stock.transfer' } },
  adjust: { icon: 'scale', list: 'nav.adjustments', posting: true, noMoney: true, perm: { view: 'stock.view', create: 'stock.adjust', edit: 'stock.adjust', cancel: 'stock.adjust' } },
};

/** statuses a user can pick by hand (the others are set by the system) */
export const MANUAL_STATUSES = {
  quote: ['open', 'accepted', 'rejected'],
  service: ['open', 'in_progress', 'waiting_parts', 'done', 'delivered'],
  purchase_order: ['open', 'sent'],
};

/** which document types a document can be turned into */
export const CONVERSIONS = {
  quote: ['sale', 'service'],
  service: ['sale'],
  purchase_order: ['purchase'],
  sale: ['sale_return'],
  purchase: ['purchase_return'],
};

export const ADJUST_REASONS = ['opening', 'count', 'damage', 'loss', 'gift', 'own_use', 'correction', 'other'];

export function docType(type) { return DOC_TYPES[type] || DOC_TYPES.sale; }

export function canDoc(type, action) {
  const d = DOC_TYPES[type];
  if (!d) return false;
  if (type === 'sale' && action === 'create') return can(['sales.create', 'pos.use']);
  // purchase returns also need purchase rights (same rule as the server)
  if (type === 'purchase_return' && action !== 'view' && !can('purchases.create')) return false;
  // a return typed in freely, without picking the invoice, has its own permission
  if (action === 'create_unlinked') return can(d.perm.create) && can('returns.unlinked');
  return can(d.perm[action]);
}

/** a document that can still be changed */
export function isEditable(doc) {
  if (!doc || doc.status === 'cancelled') return false;
  if (['converted', 'invoiced'].includes(doc.status)) return false;
  const d = DOC_TYPES[doc.type];
  if (!d) return false;
  return doc.status === 'posted' ? can(d.perm.edit) : can(d.perm.create);
}

export function hasLines(type) { return true; }
export function isTradeDoc(type) { return ['sale', 'purchase', 'sale_return', 'purchase_return', 'quote', 'service', 'purchase_order'].includes(type); }
export function isPurchaseSide(type) { return ['purchase', 'purchase_return', 'purchase_order'].includes(type); }
export function usesVehicle(type) { return ['sale', 'service', 'quote', 'sale_return'].includes(type); }
export function usesWarehouse(type) { return ['sale', 'purchase', 'sale_return', 'purchase_return', 'service', 'transfer', 'adjust'].includes(type); }
