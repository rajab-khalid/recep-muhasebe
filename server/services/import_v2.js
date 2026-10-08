'use strict';
/*
 * Import data from Recep Muhasebe 1.x/2.x (and Finora): the single JSON "STATE" object the old app kept in
 * localStorage under 'finora_state_v1' (or a backup file exported from its "Yedek Al" screen).
 *
 * Everything is replayed through the normal services so stock, cost, partner and cash ledgers are built
 * exactly as if the documents had been entered in the new system. Problems found in the old data are fixed
 * conservatively and listed in the migration report.
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  const CAT_CODES = { electricity: 'electricity', water: 'water', rent: 'rent', salary: 'salary', fuel: 'fuel', maintenance: 'maintenance', internet: 'internet', other: 'other' };

  function unwrap(input) {
    let raw = input;
    if (typeof raw === 'string') raw = JSON.parse(raw);
    U.assert(raw && typeof raw === 'object', 'bad_file', 'This is not a Recep Muhasebe backup');
    const data = raw.data && (raw.data.products || raw.data.invoices || raw.data.accounts) ? raw.data : raw;
    U.assert(Array.isArray(data.products) || Array.isArray(data.invoices) || Array.isArray(data.accounts), 'bad_file', 'This is not a Recep Muhasebe backup');
    return { data, savedAt: raw.savedAt || null, lang: raw.lang || null };
  }

  /** summary shown before importing */
  function preview(input) {
    const { data, savedAt, lang } = unwrap(input);
    const s = data.settings || {};
    const rh = (data.rateHistory || []).filter((r) => r.source === 'manual' && r.rate >= 100 && r.rate <= 100000);
    const overrides = (data.invoices || []).map((i) => Number(i.rateOverride) || 0).filter((x) => x > 0);
    const suggestedRate = suggestRate(data);
    return {
      saved_at: savedAt, lang, company: s.companyName || null,
      counts: {
        accounts: (data.accounts || []).length, products: (data.products || []).length,
        sales: (data.invoices || []).filter((i) => i.kind === 'sale').length, purchases: (data.invoices || []).filter((i) => i.kind === 'purchase').length,
        cash: (data.cash || []).length, expenses: (data.expenses || []).length, quotes: (data.quotes || []).length,
        staff: (data.staff || []).length, banks: (data.banks || []).length,
      },
      suggested_rate: suggestedRate, last_manual_rate: rh.length ? rh[rh.length - 1].rate : null,
      invoice_rates: [...new Set(overrides)].slice(0, 5),
      has_logo: !!s.logoUrl, has_design: !!(s.headerLayout && s.headerLayout.length) || !!s.customTemplate,
      pin_lock: !!(s.pinLockEnabled && s.pinLock),
    };
  }

  function suggestRate(data) {
    const rh = (data.rateHistory || []).filter((r) => r.source === 'manual' && r.rate >= 100 && r.rate <= 100000);
    if (rh.length) return Math.round(rh[rh.length - 1].rate);
    const ov = (data.invoices || []).map((i) => Number(i.rateOverride) || 0).filter((x) => x > 0);
    if (ov.length) {
      const counts = {};
      for (const x of ov) counts[x] = (counts[x] || 0) + 1;
      return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
    }
    const rates = (data.settings && data.settings.rates) || {};
    // old rates are "value of 1 unit in the anchor currency"; the anchor was USD (rates.USD = 1) in 2.x and TRY in Finora
    return rates.IQD ? Math.round((rates.USD || 1) / rates.IQD) : 1310;
  }

  /** factor that turns an amount in the old currency into the new one (only the old "TRY" needs it) */
  function tryFactor(data) {
    const rates = (data.settings && data.settings.rates) || {};
    if (!rates.USD || !rates.TRY || Math.abs(rates.USD - rates.TRY) < 1e-9) return 1; // TRY was just the USD anchor
    return rates.TRY / rates.USD; // real Turkish lira (Finora era) -> USD
  }

  const mapCur = (c) => (c === 'IQD' ? 'IQD' : c === 'EUR' ? 'EUR' : 'USD'); // the old internal "TRY" anchor was USD

  /**
   * Run the import into an empty database.
   * opts: { usd_iqd, lang }
   */
  function run(input, opts = {}) {
    const { data, savedAt } = unwrap(input);
    U.assert(!db.get("SELECT 1 FROM docs LIMIT 1") && !db.get('SELECT 1 FROM products LIMIT 1'), 'not_empty', 'The new database already has data; import only works on a fresh installation', 409);
    const s = data.settings || {};
    const lang = ['tr', 'en', 'ar', 'ku'].includes(opts.lang) ? opts.lang : 'tr';
    const rate = U.num(opts.usd_iqd) > 0 ? U.num(opts.usd_iqd) : suggestRate(data);
    const defaultCurrency = ['USD', 'IQD'].includes(s.displayCurrency) ? s.displayCurrency : 'IQD';
    app.setup.seedDefaults(lang, { usd_iqd: rate, default_currency: defaultCurrency });
    const ctx = { user: null, system: 'import', skipPerm: true };
    const report = { warnings: [], fixed: [], counts: {}, checks: {} };
    const warn = (code, text, extra) => report.warnings.push({ code, text, ...extra });
    const fix = (code, text, extra) => report.fixed.push({ code, text, ...extra });

    db.tx(() => {
      db.run("UPDATE currencies SET rate = ? WHERE code = 'IQD'", [rate]);
      app.invalidateCurrencies();

      /* ------------------------------------------------ settings & design */
      const company = {
        name: s.companyName || '', address: s.address || '', phone: s.phone || '', tax_no: s.taxNo || '', tax_office: s.taxOffice || '',
      };
      if (s.logoUrl && String(s.logoUrl).startsWith('data:image')) {
        try { company.logo_file_id = app.files.saveDataUrl(s.logoUrl, 'logo'); } catch (e) { warn('logo', `Logo could not be imported: ${e.message}`, { error: e.message }); }
      }
      app.setSetting('company', Object.assign({}, app.getSetting('company'), company));
      const inv = app.getSetting('invoice');
      const hasLayout = Array.isArray(s.headerLayout) && s.headerLayout.length;
      const tpl = s.customTemplate && String(s.customTemplate).trim();
      app.setSetting('invoice', Object.assign({}, inv, {
        template: hasLayout ? 'layout' : tpl ? 'custom' : 'sherwan',
        customTemplate: tpl || null, headerLayout: hasLayout ? s.headerLayout : null, itemsTableConfig: Array.isArray(s.itemsTableConfig) ? s.itemsTableConfig : null,
        accentColor: s.accentColor || inv.accentColor, invDarkColor: s.invDarkColor || inv.invDarkColor, invFontFamily: s.invFontFamily || inv.invFontFamily,
        invBaseFontSize: s.invBaseFontSize || inv.invBaseFontSize, invTitleFontSize: s.invTitleFontSize || inv.invTitleFontSize,
        logoSize: s.logoSize || inv.logoSize, logoLayout: s.logoLayout || inv.logoLayout,
      }));
      app.patchSetting('labels', { width_mm: s.labelWidthMm || 50, height_mm: s.labelHeightMm || 30 });
      app.patchSetting('stock', { low_stock_default: Number(s.lowStockThreshold) >= 0 ? Number(s.lowStockThreshold || 5) : 5 });
      app.patchSetting('general', { display_currency: defaultCurrency, default_currency: defaultCurrency, lang });
      for (const r of data.rateHistory || []) {
        if (!(r.rate >= 100 && r.rate <= 100000)) continue; // skip typing mistakes such as 15400000000000
        db.insert('rate_history', { id: uuid(), ts: r.ts || U.nowIso(), currency: 'IQD', rate: r.rate, source: `v2-${r.source || 'manual'}` });
      }
      db.insert('rate_history', { id: uuid(), ts: U.nowIso(), currency: 'IQD', rate, source: 'import' });

      /* ------------------------------------------------ warehouses (old branches) */
      const whMap = {};
      for (const b of data.branches || []) {
        const id = uuid();
        db.insert('warehouses', { id, code: null, name: b.name || 'Şube', is_default: 0, active: 1, sort: 10 + (b.no || 0), legacy_id: b.id, created_at: U.nowIso() });
        whMap[b.id] = id;
      }
      const mainWh = app.stock.defaultWarehouseId();

      /* ------------------------------------------------ partners */
      const pMap = {};
      for (const a of data.accounts || []) {
        const id = app.partners.save({
          kind: ['customer', 'supplier', 'both'].includes(a.kind) ? a.kind : 'customer', name: a.name || '—', phone: a.phone, email: a.email,
          tax_no: a.taxNo, address: a.address, due_date: a.dueDate,
        }, ctx);
        db.run('UPDATE partners SET legacy_id = ?, no = COALESCE(?, no) WHERE id = ?', [a.id, a.no || null, id]);
        pMap[a.id] = id;
      }
      report.counts.partners = Object.keys(pMap).length;

      /* ------------------------------------------------ staff -> users */
      const sMap = {};
      const salesRole = db.val("SELECT id FROM roles WHERE code = 'sales'");
      const mgrRole = db.val("SELECT id FROM roles WHERE code = 'manager'");
      for (const st of data.staff || []) {
        const id = uuid();
        const { hashSecret } = require('../auth');
        db.insert('users', {
          id, username: null, full_name: st.name || '—', role_id: st.role === 'cashier' ? salesRole : mgrRole, phone: st.phone || null,
          pin_hash: st.pin && /^\d{4,8}$/.test(String(st.pin)) ? hashSecret(st.pin) : null,
          can_login: st.pin && /^\d{4,8}$/.test(String(st.pin)) ? 1 : 0, active: st.active === false ? 0 : 1, created_at: U.nowIso(), updated_at: U.nowIso(),
        });
        sMap[st.id] = id;
      }
      report.counts.staff = Object.keys(sMap).length;

      /* ------------------------------------------------ products */
      const prMap = {};
      const plRetail = app.products.defaultPriceListId();
      const tryProducts = [];
      const allProducts = [...(data.products || [])];
      // products referenced by invoices but deleted later: restore them as inactive from the trash (or a placeholder)
      const trashProducts = (data.trash || []).filter((t) => t.entity === 'product' && t.record).map((t) => t.record);
      const known = new Set(allProducts.map((p) => p.id));
      for (const invc of [...(data.invoices || []), ...(data.quotes || [])]) {
        for (const it of invc.items || []) {
          if (!it.productId || known.has(it.productId)) continue;
          const tr = trashProducts.find((p) => p.id === it.productId);
          allProducts.push(Object.assign({ batches: [] }, tr || { id: it.productId, name: it.name || '?', currency: invc.currency, salePrice: it.price, purchasePrice: 0, unit: 'adet' }, { _deleted: true }));
          known.add(it.productId);
          warn('deleted_product', `"${it.name}" was deleted in the old program; it was restored as an inactive product so invoice ${invc.no} stays complete`, { name: it.name, doc: invc.no });
        }
      }
      const tf = tryFactor(data);
      /**
       * Products saved with the old "TRY" currency: in 2.x that was only the internal anchor, but people also
       * picked it by mistake for dinar prices. Compare the purchase price with the purchase batches (kept in USD):
       * a ratio near the dinar rate means the prices are in IQD, a ratio near 1 means USD.
       */
      const productCur = (p) => {
        if (p.currency !== 'TRY') return { cur: mapCur(p.currency), f: 1 };
        if (tf !== 1) return { cur: 'USD', f: tf }; // real Turkish lira (Finora era)
        const pp = U.num(p.purchasePrice);
        const b = (p.batches || []).find((x) => U.num(x.unitCost) > 0 && (x.costCurrency || 'USD') === 'USD');
        if (b && pp > 0) {
          const ratio = pp / U.num(b.unitCost);
          if (ratio > rate * 0.7 && ratio < rate * 1.4) return { cur: 'IQD', f: 1 };
          if (ratio > 0.7 && ratio < 1.4) return { cur: 'USD', f: 1 };
        }
        const ref = pp || U.num(p.salePrice);
        return { cur: ref >= 250 ? 'IQD' : 'USD', f: 1 };
      };
      for (const p of allProducts) {
        const { cur, f } = productCur(p);
        // names may be Kurdish/Arabic inside a left-to-right sentence: keep each one isolated
        if (p.currency === 'TRY') tryProducts.push(`${p.code ? `${p.code} ` : ''}\u2068${p.name}\u2069 → ${cur}`);
        const prices = {};
        if (plRetail && p.salePrice != null) prices[plRetail] = U.round(U.num(p.salePrice) * f, 4);
        const id = app.products.save({
          name: p.name || '—', code: p.code, barcode: null, unit: p.unit, category_name: p.category, currency: cur,
          cost_price: U.round(U.num(p.purchasePrice) * f, 4), warranty_months: p.warrantyMonths, prices, active: p._deleted ? false : true,
          track_stock: !p._deleted || (p.batches || []).length > 0,
        }, ctx, { skipPerm: true });
        // barcodes: keep, but never let a duplicate block the import
        if (p.barcode) {
          const dup = db.get('SELECT name FROM products WHERE barcode = ? AND id <> ?', [p.barcode, id]);
          if (dup) warn('dup_barcode', `Barcode ${p.barcode} is used by "${dup.name}" and "${p.name}"; it was kept only on the first`, { barcode: p.barcode, first: dup.name, second: p.name });
          else db.run('UPDATE products SET barcode = ? WHERE id = ?', [String(p.barcode).trim(), id]);
        }
        if (p.photoUrl && String(p.photoUrl).startsWith('data:image')) {
          try { db.run('UPDATE products SET photo_id = ? WHERE id = ?', [app.files.saveDataUrl(p.photoUrl, `product-${id}`), id]); } catch (e) { /* ignore */ }
        }
        db.run('UPDATE products SET legacy_id = ?, no = COALESCE(?, no) WHERE id = ?', [p.id, p.no || null, id]);
        app.products.rebuildSearch(id);
        prMap[p.id] = { id, p, cur, f };
      }
      if (tryProducts.length) fix('try_currency', `${tryProducts.length} products had the old "TRY" currency; their currency was set from their purchase cost: ${tryProducts.join(', ')}`, { n: tryProducts.length, list: tryProducts.join(', ') });
      const dupCodes = db.all("SELECT code, COUNT(*) AS n FROM products WHERE code IS NOT NULL AND code <> '' GROUP BY code HAVING n > 1");
      if (dupCodes.length) warn('dup_codes', `${dupCodes.length} product codes are used by more than one product (e.g. ${dupCodes.slice(0, 5).map((d) => d.code).join(', ')})`, { n: dupCodes.length, list: dupCodes.slice(0, 8).map((d) => d.code).join(', ') });
      report.counts.products = allProducts.length;

      /* ------------------------------------------------ money accounts (banks) */
      for (const b of data.banks || []) {
        const id = app.cash.accountSave({ type: 'bank', name: b.bankName || 'Bank', currency: mapCur(b.currency), bank_name: b.bankName, branch: b.branch, iban: b.iban, opening_balance: U.num(b.openingBalance) }, ctx);
        db.run('UPDATE money_accounts SET legacy_id = ? WHERE id = ?', [b.id, id]);
      }

      /* ------------------------------------------------ opening stock (whatever the invoices do not explain) */
      const invoices = [...(data.invoices || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const netByProduct = {};
      for (const iv of invoices) {
        for (const it of iv.items || []) {
          if (!it.productId) continue;
          netByProduct[it.productId] = (netByProduct[it.productId] || 0) + (iv.kind === 'purchase' ? 1 : -1) * U.num(it.qty);
        }
      }
      const firstDate = invoices.length ? invoices[0].date : U.today();
      const openingDate = U.addDays(firstDate || U.today(), -1);
      const openLines = [];
      const negLines = [];
      for (const { id, p, cur, f: pf } of Object.values(prMap)) {
        const finalQty = (p.batches || []).reduce((sum, b) => sum + U.num(b.qty), 0);
        const opening = U.round(finalQty - (netByProduct[p.id] || 0), 4);
        if (Math.abs(opening) < 1e-9) continue;
        if (opening > 0) {
          // cost of manual batches: their own unit cost if known, else the product's purchase price
          const manual = (p.batches || []).find((b) => b.unitCost != null && !b.invoiceRef);
          const mf = manual && (manual.costCurrency || p.currency) === 'TRY' ? tf : 1;
          // no manual batch: the old program's remaining batches know what the goods really cost (better than the card price)
          const batchUsd = (b) => U.num(b.unitCost) * ((b.costCurrency || p.currency) === 'TRY' ? tf : 1) / app.fx(mapCur(b.costCurrency || cur), rate).rate;
          const costed = (p.batches || []).filter((b) => U.num(b.unitCost) > 0 && U.num(b.qty) > 0);
          const avgBatch = costed.length ? costed.reduce((sum, b) => sum + batchUsd(b) * U.num(b.qty), 0) / costed.reduce((sum, b) => sum + U.num(b.qty), 0) : null;
          const unitUsd = manual ? U.num(manual.unitCost) * mf / app.fx(mapCur(manual.costCurrency || cur), rate).rate
            : avgBatch != null ? avgBatch : U.num(p.purchasePrice) * pf / app.fx(cur, rate).rate;
          openLines.push({ product_id: id, qty: opening, unit_cost_usd: U.round(unitUsd, 6) });
        } else negLines.push({ product_id: id, qty: opening });
      }
      if (openLines.length) {
        app.docs.save({ type: 'adjust', date: openingDate, warehouse_id: mainWh, reason: 'opening', currency: 'USD', notes: 'Devir (v2)', lines: openLines, post: true }, ctx, { skipPerm: true });
      }
      report.counts.opening_stock_products = openLines.length;

      /* ------------------------------------------------ invoices */
      const dMap = {};
      const cashByInvoice = {};
      for (const c of data.cash || []) if (c.source === 'invoice' && c.ref) (cashByInvoice[c.ref] = cashByInvoice[c.ref] || []).push(c);
      const usedNos = { sale: new Set(), purchase: new Set() };
      for (const iv of invoices) {
        const type = iv.kind === 'purchase' ? 'purchase' : 'sale';
        let partnerId = pMap[iv.accountId];
        if (!partnerId) {
          const tr = (data.trash || []).find((t) => t.entity === 'account' && t.record && t.record.id === iv.accountId);
          partnerId = app.partners.save({ kind: type === 'sale' ? 'customer' : 'supplier', name: (tr && tr.record.name) || `? (${iv.no})` }, ctx);
          db.run('UPDATE partners SET legacy_id = ? WHERE id = ?', [iv.accountId, partnerId]);
          pMap[iv.accountId] = partnerId;
          warn('missing_account', `Invoice ${iv.no}: its account was deleted in the old program; it was recreated`, { doc: iv.no });
        }
        let no = String(iv.no || '').trim() || null;
        if (no && usedNos[type].has(no)) { let k = 2; while (usedNos[type].has(`${no}-${k}`)) k++; warn('dup_number', `Invoice number ${no} was used twice; the second one is now ${no}-${k}`, { doc: no, new_no: `${no}-${k}` }); no = `${no}-${k}`; }
        if (no) usedNos[type].add(no);
        const cur = mapCur(iv.currency);
        const ivRate = U.num(iv.rateOverride) > 0 ? U.num(iv.rateOverride) : rate;
        const ivf = iv.currency === 'TRY' ? tf : 1;
        const lines = (iv.items || []).map((it) => ({
          kind: 'product', product_id: it.productId && prMap[it.productId] ? prMap[it.productId].id : null,
          description: it.name, qty: U.num(it.qty), unit_price: U.round(U.num(it.price) * ivf, 6), discount: U.round(U.num(it.discount) * ivf, 6),
        })).map((l) => (l.product_id ? l : { ...l, kind: 'labor' }));
        const r = app.docs.save({
          type, no, date: iv.date || U.today(), due_date: iv.dueDate || null, partner_id: partnerId, currency: cur, usd_iqd: ivRate,
          discount: U.round(U.num(iv.discount) * ivf, 6), payment_method: iv.paymentMethod || null, staff_id: iv.staffId && sMap[iv.staffId] ? sMap[iv.staffId] : null,
          warehouse_id: iv.branchId && whMap[iv.branchId] ? whMap[iv.branchId] : mainWh, notes: iv.notes || null,
          vehicle_plate: iv.vehiclePlate || null, vehicle_desc: iv.vehicleType || null, lines, post: true, allow_negative: true,
        }, ctx, { skipPerm: true });
        db.run('UPDATE docs SET legacy_id = ? WHERE id = ?', [iv.id, r.id]);
        if (!iv.vehiclePlate && iv.vehicleType) db.run('UPDATE docs SET vehicle_desc = ? WHERE id = ?', [iv.vehicleType, r.id]);
        dMap[iv.id] = r.id;

        // payments that the old program linked to this invoice
        const doc = db.get('SELECT * FROM docs WHERE id = ?', [r.id]);
        for (const c of cashByInvoice[iv.id] || []) {
          let payCur = mapCur(c.currency);
          let amount = U.num(c.amount) * (c.currency === 'TRY' ? tf : 1);
          const cRate = U.num(c.rateOverride) > 0 ? U.num(c.rateOverride) : ivRate;
          if (payCur !== doc.currency) {
            // e.g. "40,000 USD" paid for a 70,000 IQD invoice: the number only makes sense in the invoice currency
            const conv = app.convert(amount, payCur, doc.currency, { usd_iqd: cRate });
            const plausibleAsDocCurrency = amount <= doc.total * 1.01 + (doc.currency === 'IQD' ? 1 : 0.01);
            if (conv > doc.total * 3 && plausibleAsDocCurrency) {
              fix('payment_currency', `${iv.no}: payment of ${amount} was recorded as ${payCur} but the invoice is in ${doc.currency}; it was imported as ${amount} ${doc.currency}`, { doc: iv.no, amount, from: payCur, to: doc.currency });
              payCur = doc.currency;
            }
          }
          const acc = app.cash.defaultAccount(payCur);
          if (!acc) { warn('no_cash', `No cash box for ${payCur}; payment skipped`, { currency: payCur }); continue; }
          app.payments.create({
            direction: type === 'sale' ? 'in' : 'out', partner_id: partnerId, account_id: acc.id, amount, method: c.method || 'cash',
            applied_currency: doc.currency, usd_iqd: cRate, date: c.date || doc.date, description: c.desc || null,
            allocations: [{ doc_id: doc.id, amount: app.convert(amount, payCur, doc.currency, { usd_iqd: cRate }) }], silent: true,
          }, ctx);
        }
        const after = db.get('SELECT total, paid, currency, no FROM docs WHERE id = ?', [r.id]);
        const over = app.money(U.num(db.val("SELECT SUM(applied_amount) FROM payments WHERE status = 'posted' AND id IN (SELECT payment_id FROM payment_allocations WHERE doc_id = ?)", [r.id])) - after.total, after.currency);
        if (over > (after.currency === 'IQD' ? 1 : 0.01)) warn('overpaid', `${after.no}: paid ${over} ${after.currency} more than the invoice total; the extra is kept as a credit on the account`, { doc: after.no, amount: over, currency: after.currency });
      }
      report.counts.sales = invoices.filter((i) => i.kind !== 'purchase').length;
      report.counts.purchases = invoices.filter((i) => i.kind === 'purchase').length;

      /* ------------------------------------------------ remaining stock differences (negative opening) */
      if (negLines.length) {
        app.docs.save({ type: 'adjust', date: U.today(), warehouse_id: mainWh, reason: 'count', currency: 'USD', notes: 'v2 stock correction', lines: negLines, post: true }, ctx, { skipPerm: true });
        warn('stock_correction', `${negLines.length} products had less stock than their invoices imply; a stock correction was posted`, { n: negLines.length });
      }

      /* ------------------------------------------------ expenses / recurring */
      const catByCode = Object.fromEntries(db.all("SELECT id, code FROM finance_categories").map((c) => [c.code, c.id]));
      const recMap = {};
      for (const r of data.recurringExpenses || []) {
        const cur = mapCur(r.currency);
        const acc = app.cash.defaultAccount(cur);
        const id = app.finance.recurringSave({ kind: 'expense', category_id: catByCode[CAT_CODES[r.category] || 'other'], description: r.description, currency: cur, amount: r.amount, day_of_month: r.dayOfMonth, account_id: acc && acc.id, active: r.active !== false }, ctx);
        db.run('UPDATE recurring_entries SET legacy_id = ? WHERE id = ?', [r.id, id]);
        recMap[r.id] = id;
      }
      for (const e of data.expenses || []) {
        const cur = mapCur(e.currency);
        const acc = app.cash.defaultAccount(cur);
        if (!acc || !(U.num(e.amount) > 0)) continue;
        const id = app.finance.save({ kind: 'expense', date: e.date, category_id: catByCode[CAT_CODES[e.category] || 'other'], description: e.description, currency: cur, amount: e.amount, account_id: acc.id, recurring_id: e.recurringRef ? recMap[e.recurringRef] : null }, ctx);
        db.run('UPDATE finance_entries SET legacy_id = ? WHERE id = ?', [e.id, id]);
      }
      report.counts.expenses = (data.expenses || []).length;

      /* ------------------------------------------------ manual cash entries */
      let manualCount = 0;
      for (const c of data.cash || []) {
        if (c.source === 'invoice' && c.ref && dMap[c.ref]) continue;
        if (c.source === 'expense') continue; // already represented by the expense entry
        const cur = mapCur(c.currency);
        const acc = app.cash.defaultAccount(cur);
        if (!acc || !(U.num(c.amount) > 0)) continue;
        if (c.linkedAccountId && pMap[c.linkedAccountId]) {
          app.payments.create({ direction: c.type === 'in' ? 'in' : 'out', partner_id: pMap[c.linkedAccountId], account_id: acc.id, amount: c.amount, applied_currency: cur, date: c.date, description: c.desc, usd_iqd: U.num(c.rateOverride) || rate, silent: true }, ctx);
        } else {
          app.finance.save({ kind: c.type === 'in' ? 'income' : 'expense', date: c.date, category_id: catByCode[c.type === 'in' ? 'other_income' : 'other'], description: c.desc, currency: cur, amount: c.amount, account_id: acc.id, usd_iqd: U.num(c.rateOverride) || rate }, ctx);
        }
        manualCount++;
      }
      report.counts.manual_cash = manualCount;

      /* ------------------------------------------------ quotes */
      for (const q of data.quotes || []) {
        const lines = (q.items || []).map((it) => ({ kind: it.productId && prMap[it.productId] ? 'product' : 'labor', product_id: it.productId && prMap[it.productId] ? prMap[it.productId].id : null, description: it.name, qty: it.qty, unit_price: it.price, discount: it.discount }));
        const r = app.docs.save({ type: 'quote', no: q.no, date: q.date, partner_id: pMap[q.accountId] || null, currency: mapCur(q.currency), usd_iqd: U.num(q.rateOverride) || rate, discount: q.discount, notes: q.notes, lines }, ctx, { skipPerm: true });
        if (q.convertedInvoiceId && dMap[q.convertedInvoiceId]) {
          db.run("UPDATE docs SET status = 'converted' WHERE id = ?", [r.id]);
          db.run('UPDATE docs SET ref_doc_id = ? WHERE id = ?', [r.id, dMap[q.convertedInvoiceId]]);
        }
        db.run('UPDATE docs SET legacy_id = ? WHERE id = ?', [q.id, r.id]);
      }
      report.counts.quotes = (data.quotes || []).length;

      /* ------------------------------------------------ activity log */
      for (const l of data.activityLog || []) {
        db.insert('audit_log', { id: uuid(), ts: l.ts || U.nowIso(), user_id: null, user_name: 'v2', action: `v2:${String(l.action || '').replace('log_', '')}`, entity: 'legacy', entity_id: null, summary: l.label || null, data: null, ip: null });
      }

      /* ------------------------------------------------ numbering continues after the old numbers */
      const prefixes = app.getSetting('numbering').prefixes;
      for (const [type, prefix] of Object.entries(prefixes)) {
        const re = new RegExp(`^${prefix}(\\d{4})-(\\d+)$`);
        const rows = db.all('SELECT no FROM docs WHERE type = ?', [type]);
        const max = {};
        for (const r of rows) { const m = re.exec(r.no || ''); if (m) max[m[1]] = Math.max(max[m[1]] || 0, Number(m[2])); }
        for (const [y, n] of Object.entries(max)) app.bumpSequence(type, y, n);
      }

      /* ------------------------------------------------ checks: old cash per currency vs new cash boxes */
      const oldCash = {};
      for (const c of data.cash || []) {
        const cur = mapCur(c.currency);
        oldCash[cur] = (oldCash[cur] || 0) + (c.type === 'in' ? 1 : -1) * U.num(c.amount);
      }
      const newCash = {};
      for (const a of app.cash.accounts()) if (a.type === 'cash') newCash[a.currency] = (newCash[a.currency] || 0) + a.balance;
      report.checks.cash = Object.keys({ ...oldCash, ...newCash }).map((c) => ({ currency: c, old: app.money(oldCash[c] || 0, c), new: app.money(newCash[c] || 0, c) }));
      for (const c of report.checks.cash) {
        if (c.new < 0) warn('negative_cash', `The ${c.currency} cash box is ${c.new} ${c.currency}: the old program had no opening cash balance. Count the cash and enter the real amount as an opening balance.`, { currency: c.currency, amount: c.new });
      }
      let stockMismatch = 0;
      for (const { id, p } of Object.values(prMap)) {
        const finalQty = (p.batches || []).reduce((sum, b) => sum + U.num(b.qty), 0);
        if (Math.abs(app.stock.qtyOf(id) - finalQty) > 1e-6) stockMismatch++;
      }
      report.checks.stock_mismatch = stockMismatch;
      report.checks.stock_total = U.round(db.val('SELECT SUM(qty) FROM stock_levels') || 0, 3);
      report.checks.partners = app.partners.list({ balance: 'nonzero' }).map((p) => ({ name: p.name, balances: p.balances }));
      report.rate = rate;
      report.saved_at = savedAt;
      app.patchSetting('general', { imported_from_v2: U.nowIso() });
      app.audit(ctx, 'import_v2', 'system', null, { k: 'import', v: { products: report.counts.products, sales: report.counts.sales, purchases: report.counts.purchases } }, report);
    });
    return report;
  }

  return { preview, run, unwrap, suggestRate, tryFactor };
};
