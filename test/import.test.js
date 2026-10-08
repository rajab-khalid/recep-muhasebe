'use strict';
/* Import of Recep Muhasebe 2.x data (synthetic fixture shaped like the real localStorage JSON). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app');

function fixture() {
  return {
    v: 1, savedAt: '2026-09-13T18:45:37.333Z', lang: 'tr',
    data: {
      settings: {
        companyName: 'Şêrwan', address: 'Zakho', phone: '0750', rates: { TRY: 1, USD: 1, IQD: 1 / 1311 }, baseCurrency: 'TRY', displayCurrency: 'IQD',
        headerLayout: [{ id: 'logo', type: 'logo', x: 30, y: 20, w: 140, h: 120 }], itemsTableConfig: [{ key: 'row', visible: true, label: '' }],
        lowStockThreshold: 3, labelWidthMm: 40, labelHeightMm: 25, pinLockEnabled: false,
      },
      accounts: [
        { id: 'a1', kind: 'supplier', name: 'Hemin Cars', phone: '0750' },
        { id: 'a2', kind: 'customer', name: 'Daily sales' },
      ],
      products: [
        { id: 'p1', code: '100', barcode: '6408910360242', name: 'Cover Stern', unit: 'adet', category: '', purchasePrice: 7750, salePrice: 15000, currency: 'IQD', warrantyMonths: 0,
          batches: [{ id: 'b1', qty: 5, invoiceRef: 'i1', unitCost: 5, costCurrency: 'USD' }, { id: 'b2', qty: 2 }] },
        { id: 'p2', code: '100', barcode: '', name: 'Old TRY item', unit: 'adet', purchasePrice: 2, salePrice: 4, currency: 'TRY', batches: [{ id: 'b3', qty: 3 }] },
      ],
      invoices: [
        { id: 'i1', kind: 'purchase', no: 'AF2026-0001', date: '2026-08-01', accountId: 'a1', currency: 'USD', discount: 0, rateOverride: 1520,
          items: [{ productId: 'p1', name: 'Cover Stern', qty: 10, price: 5, discount: 0 }] },
        { id: 'i2', kind: 'sale', no: 'SF2026-0001', date: '2026-08-02', accountId: 'a2', currency: 'IQD', discount: 0, rateOverride: 1520,
          items: [{ productId: 'p1', name: 'Cover Stern', qty: 5, price: 15000, discount: 0 }, { productId: 'gone', name: 'Deleted thing', qty: 1, price: 5000, discount: 0 }] },
        { id: 'i3', kind: 'purchase', no: 'AF2026-0002', date: '2026-08-03', accountId: 'a1', currency: 'IQD', discount: 0, rateOverride: 1520,
          items: [{ productId: 'p2', name: 'Old TRY item', qty: 1, price: 70000, discount: 0 }] },
      ],
      cash: [
        { id: 'c1', date: '2026-08-01', type: 'out', amount: 50, currency: 'USD', source: 'invoice', ref: 'i1', linkedAccountId: 'a1', rateOverride: 1520 },
        { id: 'c2', date: '2026-08-02', type: 'in', amount: 80000, currency: 'USD', source: 'invoice', ref: 'i2', linkedAccountId: 'a2', rateOverride: 1520 },
        { id: 'c3', date: '2026-08-03', type: 'out', amount: 40000, currency: 'USD', source: 'invoice', ref: 'i3', linkedAccountId: 'a1', rateOverride: 1520 },
        { id: 'c4', date: '2026-08-04', type: 'out', amount: 30000, currency: 'IQD', source: 'invoice', ref: 'i3', linkedAccountId: 'a1' },
        { id: 'c5', date: '2026-08-05', type: 'out', amount: 25000, currency: 'IQD', source: 'manual', desc: 'Generator' },
      ],
      expenses: [{ id: 'e1', date: '2026-08-06', category: 'rent', amount: 300, currency: 'USD', description: 'Rent' }],
      recurringExpenses: [], staff: [{ id: 's1', name: 'Ali', role: 'cashier', pin: '4321', active: true }], quotes: [],
      activityLog: [{ id: 'l1', ts: '2026-08-01T10:00:00Z', action: 'log_created', label: 'Alış Faturası #AF2026-0001' }],
      trash: [], rateHistory: [{ ts: '2026-08-01T10:00:00Z', rate: 1520, source: 'manual' }], branches: [],
    },
  };
}

test('imports old data, fixes known problems, keeps stock exact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-imp-'));
  const app = createApp({ dataDir: dir });
  const pv = app.importer.preview(JSON.stringify(fixture()));
  assert.equal(pv.suggested_rate, 1520);
  const rep = app.importer.run(fixture(), { lang: 'tr' });
  assert.equal(rep.checks.stock_mismatch, 0);
  const p1 = app.db.get("SELECT * FROM products WHERE legacy_id = 'p1'");
  assert.equal(app.stock.qtyOf(p1.id), 7);
  assert.equal(p1.barcode, '6408910360242');
  const p2 = app.db.get("SELECT * FROM products WHERE legacy_id = 'p2'");
  assert.equal(p2.currency, 'USD');
  assert.equal(app.stock.qtyOf(p2.id), 3);
  // both wrong-currency payments were fixed
  assert.ok(rep.fixed.filter((f) => f.code === 'payment_currency').length === 2);
  const sale = app.db.get("SELECT * FROM docs WHERE no = 'SF2026-0001'");
  assert.equal(sale.total, 80000);
  assert.equal(sale.payment_status, 'paid');
  const iqd = app.cash.defaultAccount('IQD');
  assert.equal(app.cash.balance(iqd.id), 80000 - 40000 - 30000 - 25000);
  assert.equal(app.cash.balance(app.cash.defaultAccount('USD').id), -50 - 300);
  // deleted product restored as inactive, numbering continues
  assert.ok(app.db.get("SELECT 1 FROM products WHERE name = 'Deleted thing' AND active = 0"));
  assert.equal(app.peekNo('sale', '2026-08-10'), 'SF2026-0002');
  // staff imported with PIN login, settings carried over
  assert.ok(app.db.get("SELECT 1 FROM users WHERE full_name = 'Ali' AND pin_hash IS NOT NULL"));
  assert.equal(app.getSetting('invoice').template, 'layout');
  assert.equal(app.getSetting('labels').width_mm, 40);
  assert.equal(app.currencies().find((c) => c.code === 'IQD').rate, 1520);
  assert.throws(() => app.importer.run(fixture(), {}), (e) => e.code === 'not_empty');
});
