'use strict';
/*
 * Documents: sales (incl. POS), purchases, returns, quotes, service/work orders, purchase orders,
 * warehouse transfers and stock adjustments — one table, type-specific behaviour.
 *
 * Posting a document writes its effects into the ledgers (stock_moves, partner_moves, money_moves).
 * Editing a posted document voids the old effect rows (kept for history, rev N) and writes new ones (rev N+1).
 * Cancelling voids the effects and marks the document cancelled. Nothing is deleted.
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  const TYPES = {
    sale: { posting: true, stockSign: -1, partnerSign: 1, perm: { view: 'sales.view', create: 'sales.create', edit: 'sales.edit', cancel: 'sales.cancel' }, payDir: 'in' },
    purchase: { posting: true, stockSign: 1, partnerSign: -1, perm: { view: 'purchases.view', create: 'purchases.create', edit: 'purchases.edit', cancel: 'purchases.cancel' }, payDir: 'out' },
    sale_return: { posting: true, stockSign: 1, partnerSign: -1, perm: { view: 'returns.view', create: 'returns.create', edit: 'returns.create', cancel: 'returns.cancel' }, payDir: 'out' },
    purchase_return: { posting: true, stockSign: -1, partnerSign: 1, perm: { view: 'returns.view', create: 'returns.create', edit: 'returns.create', cancel: 'returns.cancel' }, payDir: 'in' },
    quote: { posting: false, perm: { view: 'quotes.view', create: 'quotes.manage', edit: 'quotes.manage', cancel: 'quotes.manage' } },
    service: { posting: false, perm: { view: 'service.view', create: 'service.manage', edit: 'service.manage', cancel: 'service.manage' } },
    purchase_order: { posting: false, perm: { view: 'orders.view', create: 'orders.manage', edit: 'orders.manage', cancel: 'orders.manage' } },
    transfer: { posting: true, perm: { view: 'stock.view', create: 'stock.transfer', edit: 'stock.transfer', cancel: 'stock.transfer' } },
    adjust: { posting: true, perm: { view: 'stock.view', create: 'stock.adjust', edit: 'stock.adjust', cancel: 'stock.adjust' } },
  };
  const STATUSES = {
    quote: ['open', 'accepted', 'rejected', 'converted', 'cancelled'],
    service: ['open', 'in_progress', 'waiting_parts', 'done', 'delivered', 'invoiced', 'cancelled'],
    purchase_order: ['open', 'sent', 'received', 'cancelled'],
  };

  function typeDef(type) {
    const t = TYPES[type];
    U.assert(t, 'bad_type', `Unknown document type ${type}`);
    return t;
  }

  function requirePerm(ctx, p) {
    if (ctx.skipPerm) return;
    U.assert(app.users.can(ctx.user, p), 'forbidden', 'You do not have permission for this action', 403, { permission: p });
  }

  /* ------------------------------------------------------------------ line maths */
  function computeLines(lines, currency) {
    const dec = app.currency(currency).decimals;
    const out = [];
    let i = 0;
    for (const l of lines || []) {
      const kind = ['product', 'service', 'labor', 'text'].includes(l.kind) ? l.kind : (l.product_id ? 'product' : 'labor');
      const qty = kind === 'text' ? 0 : U.num(l.qty, 1);
      const price = kind === 'text' ? 0 : U.num(l.unit_price);
      const gross = qty * price;
      let discount = U.num(l.discount);
      const pct = l.discount_pct === '' || l.discount_pct == null ? null : U.num(l.discount_pct);
      if (pct != null && pct > 0) discount = gross * pct / 100;
      discount = U.round(Math.min(Math.max(discount, 0), Math.abs(gross)), Math.max(dec, 2));
      const lineTotal = U.round(gross - discount * Math.sign(gross || 1), dec);
      if (kind !== 'text' && !l.product_id && !U.str(l.description)) continue;
      out.push({
        id: l.id || null, line_no: ++i, kind, product_id: l.product_id || null, code: U.str(l.code, 80),
        description: U.str(l.description, 500), qty, unit: U.str(l.unit, 20), unit_price: price, discount, discount_pct: pct,
        line_total: lineTotal, staff_id: l.staff_id || null, ref_line_id: l.ref_line_id || null, note: U.str(l.note, 500),
        unit_cost_usd: l.unit_cost_usd != null && l.unit_cost_usd !== '' ? U.num(l.unit_cost_usd) : null,
        received_qty: l.received_qty != null ? U.num(l.received_qty) : null,
      });
    }
    return out;
  }

  function computeTotals(lines, d, currency) {
    const dec = app.currency(currency).decimals;
    let subtotal = 0;
    let lineDiscount = 0;
    let sum = 0;
    for (const l of lines) {
      if (l.kind === 'text') continue;
      subtotal += l.qty * l.unit_price;
      lineDiscount += l.discount;
      sum += l.line_total;
    }
    let discount = U.num(d.discount);
    if (d.discount_pct != null && d.discount_pct !== '' && U.num(d.discount_pct) > 0) discount = sum * U.num(d.discount_pct) / 100;
    discount = U.round(Math.min(Math.max(discount, 0), Math.max(sum, 0)), dec);
    let total = U.round(sum - discount, dec);
    // optional cash rounding for IQD (e.g. to 250) — decided by the client and sent as `rounding`
    const rounding = U.num(d.rounding);
    if (rounding && Math.abs(rounding) < Math.max(1, total * 0.05)) total = U.round(total + rounding, dec);
    return { subtotal: U.round(subtotal, dec + 2), line_discount: U.round(lineDiscount, dec + 2), discount, total, lines_sum: U.round(sum, dec) };
  }

  /* ------------------------------------------------------------------ queries */
  function get(id, opts = {}) {
    const d = db.get(`SELECT d.*, p.name AS partner_display, p.phone AS partner_phone2, p.address AS partner_address, p.tax_no AS partner_tax_no,
        p.is_walkin, p.kind AS partner_kind, w.name AS warehouse_name, w2.name AS to_warehouse_name,
        u.full_name AS staff_name, t.full_name AS technician_name, cu.full_name AS created_by_name, uu.full_name AS updated_by_name,
        cx.full_name AS cancelled_by_name, pl.name AS price_list_name, rd.no AS ref_no, rd.type AS ref_type,
        v.plate AS v_plate, v.year AS v_year, v.engine AS v_engine, v.color AS v_color, v.vin AS v_vin, mk.name AS v_make, md.name AS v_model, v.make_text AS v_make_text, v.model_text AS v_model_text
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id LEFT JOIN warehouses w ON w.id = d.warehouse_id
      LEFT JOIN warehouses w2 ON w2.id = d.to_warehouse_id LEFT JOIN users u ON u.id = d.staff_id LEFT JOIN users t ON t.id = d.technician_id
      LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by LEFT JOIN users cx ON cx.id = d.cancelled_by
      LEFT JOIN price_lists pl ON pl.id = d.price_list_id LEFT JOIN docs rd ON rd.id = d.ref_doc_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN vehicle_makes mk ON mk.id = v.make_id LEFT JOIN vehicle_models md ON md.id = v.model_id
      WHERE d.id = ?`, [id]);
    U.assert(d, 'not_found', 'Document not found', 404);
    d.partner_name = d.partner_display || d.partner_name;
    d.partner_phone = d.partner_phone || d.partner_phone2;
    d.vehicle_desc = d.vehicle_desc || [d.v_make || d.v_make_text, d.v_model || d.v_model_text, d.v_year].filter(Boolean).join(' ') || null;
    d.lines = db.all(`SELECT l.*, pr.name AS product_name, pr.code AS product_code, pr.barcode, pr.unit AS product_unit, pr.track_stock, pr.warranty_months,
        pr.photo_id, s.full_name AS staff_name
      FROM doc_lines l LEFT JOIN products pr ON pr.id = l.product_id LEFT JOIN users s ON s.id = l.staff_id
      WHERE l.doc_id = ? ORDER BY l.line_no`, [id]);
    if (['sale', 'purchase'].includes(d.type)) {
      for (const l of d.lines) {
        l.returned_qty = db.val(`SELECT SUM(rl.qty) FROM doc_lines rl JOIN docs rd ON rd.id = rl.doc_id
          WHERE rl.ref_line_id = ? AND rd.status = 'posted'`, [l.id]) || 0;
      }
    }
    d.payments = db.all(`SELECT p.id, p.no, p.date, p.direction, p.method, p.currency, p.amount, p.applied_currency, p.applied_amount, p.usd_iqd,
        p.purpose, al.amount AS allocated, a.name AS account_name, p.status
      FROM payment_allocations al JOIN payments p ON p.id = al.payment_id LEFT JOIN money_accounts a ON a.id = p.account_id
      WHERE al.doc_id = ? AND al.voided = 0 ORDER BY p.date, p.created_at`, [id]);
    d.change = db.all(`SELECT p.id, p.no, p.currency, p.amount, a.name AS account_name FROM payments p LEFT JOIN money_accounts a ON a.id = p.account_id
      WHERE p.doc_id = ? AND p.purpose = 'change' AND p.status = 'posted'`, [id]);
    d.related = db.all(`SELECT id, type, no, date, status, total, currency FROM docs WHERE (ref_doc_id = ? OR id = ?) AND id <> ? ORDER BY date`, [id, d.ref_doc_id || '', id]);
    d.remaining = TYPES[d.type] && TYPES[d.type].payDir && d.status === 'posted' ? app.money(d.total - d.paid, d.currency) : null;
    d.partner_balances = d.partner_id ? app.partners.balances(d.partner_id) : {};
    if (opts.history) d.history = db.all("SELECT ts, user_name, action, summary FROM audit_log WHERE entity = 'doc' AND entity_id = ? ORDER BY ts", [id]);
    return d;
  }

  function list(f = {}) {
    const where = [];
    const params = [];
    if (f.type) {
      const types = String(f.type).split(',');
      where.push(`d.type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (f.status) {
      const st = String(f.status).split(',');
      where.push(`d.status IN (${st.map(() => '?').join(',')})`);
      params.push(...st);
    } else if (!f.include_cancelled) where.push("d.status <> 'cancelled'");
    if (f.payment_status) {
      if (f.payment_status === 'open') where.push("d.payment_status IN ('unpaid', 'partial')");
      else { where.push('d.payment_status = ?'); params.push(f.payment_status); }
    }
    if (f.overdue) { where.push("d.due_date IS NOT NULL AND d.due_date < ? AND d.payment_status IN ('unpaid','partial')"); params.push(U.today()); }
    if (f.partner_id) { where.push('d.partner_id = ?'); params.push(f.partner_id); }
    if (f.vehicle_id) { where.push('d.vehicle_id = ?'); params.push(f.vehicle_id); }
    if (f.staff_id) { where.push('(d.staff_id = ? OR d.technician_id = ?)'); params.push(f.staff_id, f.staff_id); }
    if (f.warehouse_id) { where.push('(d.warehouse_id = ? OR d.to_warehouse_id = ?)'); params.push(f.warehouse_id, f.warehouse_id); }
    if (f.channel) { where.push('d.channel = ?'); params.push(f.channel); }
    if (f.currency) { where.push('d.currency = ?'); params.push(f.currency); }
    if (f.from) { where.push('d.date >= ?'); params.push(f.from); }
    if (f.to) { where.push('d.date <= ?'); params.push(f.to); }
    if (f.created_by) { where.push('d.created_by = ?'); params.push(f.created_by); }
    if (f.product_id) { where.push('EXISTS (SELECT 1 FROM doc_lines l WHERE l.doc_id = d.id AND l.product_id = ?)'); params.push(f.product_id); }
    if (f.q) {
      const q = String(f.q).trim();
      const plate = U.normPlate(q);
      const terms = U.searchTerms(q);
      const ors = ['d.no LIKE ?', 'd.legacy_id = ?'];
      params.push(`%${q}%`, q);
      if (plate) { ors.push("REPLACE(UPPER(COALESCE(d.vehicle_plate, '')), ' ', '') LIKE ?"); params.push(`%${plate}%`); ors.push('v.plate_norm LIKE ?'); params.push(`%${plate}%`); }
      if (terms.length) {
        ors.push(`(${terms.map(() => "(COALESCE(p.search, '') || ' ' || lower(COALESCE(d.partner_name, '')) || ' ' || lower(COALESCE(d.notes, ''))) LIKE ?").join(' AND ')})`);
        params.push(...terms.map((t) => `%${t}%`));
      }
      where.push(`(${ors.join(' OR ')})`);
    }
    const limit = Math.min(Number(f.limit) || 300, 5000);
    const offset = Number(f.offset) || 0;
    const sql = `SELECT d.id, d.type, d.no, d.date, d.due_date, d.valid_until, d.status, d.channel, d.partner_id,
        COALESCE(p.name, d.partner_name) AS partner_name, p.phone AS partner_phone, d.currency, d.rate, d.usd_iqd,
        d.subtotal, d.discount, d.line_discount, d.total, d.total_usd, d.cost_usd, d.paid, d.payment_status, d.payment_method,
        d.vehicle_id, COALESCE(v.plate, d.vehicle_plate) AS vehicle_plate, d.vehicle_desc, d.km, d.complaint,
        d.staff_id, u.full_name AS staff_name, d.technician_id, t.full_name AS technician_name,
        d.warehouse_id, w.name AS warehouse_name, d.to_warehouse_id, w2.name AS to_warehouse_name,
        d.ref_doc_id, rd.no AS ref_no, d.reason, d.notes, d.created_at, d.updated_at, cu.full_name AS created_by_name,
        (SELECT COUNT(*) FROM doc_lines l WHERE l.doc_id = d.id AND l.kind <> 'text') AS line_count
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN users u ON u.id = d.staff_id LEFT JOIN users t ON t.id = d.technician_id LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN warehouses w2 ON w2.id = d.to_warehouse_id
      LEFT JOIN docs rd ON rd.id = d.ref_doc_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.date DESC, d.created_at DESC LIMIT ? OFFSET ?`;
    const rows = db.all(sql, [...params, limit, offset]);
    const agg = db.all(`SELECT d.currency, COUNT(*) AS n, SUM(d.total) AS total, SUM(d.total - d.paid) AS open, SUM(d.total_usd) AS total_usd, SUM(d.cost_usd) AS cost_usd
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY d.currency`, params);
    const today = U.today();
    for (const r of rows) {
      r.remaining = r.payment_status ? app.money(r.total - r.paid, r.currency) : null;
      r.overdue_days = r.due_date && r.payment_status && r.payment_status !== 'paid' && r.due_date < today ? U.daysBetween(r.due_date, today) : 0;
      r.profit_usd = ['sale'].includes(r.type) ? U.round(r.total_usd - r.cost_usd, 2) : null;
    }
    return { rows, totals: agg, count: agg.reduce((s, a) => s + a.n, 0) };
  }

  /* ------------------------------------------------------------------ list price helper (for discount checks) */
  function listPriceIn(productId, priceListId, currency, fx) {
    const p = db.get('SELECT currency, price_rate FROM products WHERE id = ?', [productId]);
    if (!p) return null;
    let price = priceListId ? db.val('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?', [productId, priceListId]) : null;
    if (price == null) price = db.val('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?', [productId, app.products.defaultPriceListId()]);
    if (price == null) return null;
    // a product with its own rate is priced with that rate, as the screens do
    return app.convert(price, p.currency, currency, p.price_rate > 0 ? { usd_iqd: p.price_rate } : fx);
  }

  /* ------------------------------------------------------------------ validation for sales */
  function checkSaleRules(doc, lines, ctx, data) {
    const pos = app.getSetting('pos');
    const user = ctx.user;
    const fx = { usd_iqd: doc.usd_iqd };
    // effective discount vs list prices
    let listTotal = 0;
    for (const l of lines) {
      if (l.kind === 'text') continue;
      let lp = l.product_id ? listPriceIn(l.product_id, doc.price_list_id, doc.currency, fx) : null;
      if (lp == null || lp < l.unit_price) lp = l.unit_price;
      listTotal += lp * l.qty;
    }
    const disc = listTotal > 0 ? (listTotal - doc.total) / listTotal * 100 : 0;
    if (!ctx.skipPerm && disc > 0.0001 && !app.users.can(user, 'sales.discount')) {
      const max = user && user.max_discount_pct != null ? user.max_discount_pct : pos.default_max_discount_pct;
      U.assert(disc <= (Number(max) || 0) + 0.01, 'discount_limit', `Discount ${disc.toFixed(1)}% is above your limit (${Number(max) || 0}%)`, 400, { discount_pct: U.round(disc, 2), max });
    }
    // below cost
    if (!ctx.skipPerm && pos.block_below_cost && !app.users.can(user, 'sales.below_cost') && doc.type === 'sale') {
      const share = doc.lines_sum > 0 ? doc.total / doc.lines_sum : 1;
      const bad = [];
      for (const l of lines) {
        if (l.kind !== 'product' || !l.product_id || !(l.qty > 0)) continue;
        const cost = app.stock.currentCost(l.product_id);
        if (!cost) continue;
        const netUsd = (l.line_total * share) / l.qty / doc.rate;
        if (netUsd < cost - 0.0001) bad.push(l.description || l.product_id);
      }
      U.assert(!bad.length, 'below_cost', `Price is below cost: ${bad.join(', ')}`, 400, { products: bad });
    }
    checkStock(doc, lines, ctx, data);
  }

  /** goods leaving a warehouse (sale, transfer, purchase return): enough stock unless the shop allows negative stock */
  function checkStock(doc, lines, ctx, data) {
    const pos = app.getSetting('pos');
    if (pos.allow_negative_stock || (data.allow_negative && ctx.skipPerm)) return;
    const need = {};
    for (const l of lines) if (l.product_id && l.kind === 'product' && l.qty > 0) need[l.product_id] = (need[l.product_id] || 0) + l.qty;
    const short = [];
    for (const [pid, q] of Object.entries(need)) {
      const p = db.get('SELECT name, track_stock FROM products WHERE id = ?', [pid]);
      if (!p || !p.track_stock) continue;
      let have = app.stock.qtyOf(pid, doc.warehouse_id);
      // when a posted document is edited, the goods it already took out count as available again
      if (doc.id) have += db.val('SELECT -SUM(qty) FROM stock_moves WHERE doc_id = ? AND product_id = ? AND warehouse_id = ? AND voided = 0', [doc.id, pid, doc.warehouse_id]) || 0;
      if (have < q - 1e-9) short.push(`${p.name} (${U.round(have, 2)})`);
    }
    U.assert(!short.length, 'insufficient_stock', `Not enough stock: ${short.join(', ')}`, 400, { products: short });
  }

  /* ------------------------------------------------------------------ effects */
  function applyEffects(doc, lines, ctx) {
    const t = TYPES[doc.type];
    const userId = ctx.user && ctx.user.id;
    const touched = new Set();
    const productRows = {};
    const prodOf = (id) => (productRows[id] = productRows[id] || db.get('SELECT * FROM products WHERE id = ?', [id]));

    if (doc.type === 'transfer') {
      U.assert(doc.warehouse_id && doc.to_warehouse_id && doc.warehouse_id !== doc.to_warehouse_id, 'transfer_warehouses', 'Choose two different warehouses');
      for (const l of lines) {
        if (!l.product_id || !(l.qty > 0)) continue;
        const p = prodOf(l.product_id);
        if (!p || !p.track_stock) continue;
        const cost = app.stock.currentCost(l.product_id);
        app.stock.addMove({ date: doc.date, product_id: l.product_id, warehouse_id: doc.warehouse_id, qty: -l.qty, unit_cost_usd: cost, kind: 'transfer_out', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
        app.stock.addMove({ date: doc.date, product_id: l.product_id, warehouse_id: doc.to_warehouse_id, qty: l.qty, unit_cost_usd: cost, kind: 'transfer_in', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
        touched.add(l.product_id);
      }
      return touched;
    }

    if (doc.type === 'adjust') {
      for (const l of lines) {
        if (!l.product_id || !l.qty) continue;
        const p = prodOf(l.product_id);
        if (!p || !p.track_stock) continue;
        const fixed = l.qty > 0 && l.unit_cost_usd != null;
        const cost = fixed ? l.unit_cost_usd : app.stock.currentCost(l.product_id);
        app.stock.addMove({
          date: doc.date, product_id: l.product_id, warehouse_id: doc.warehouse_id, qty: l.qty, unit_cost_usd: cost, cost_fixed: fixed,
          kind: doc.reason === 'opening' ? 'opening' : doc.reason === 'count' ? 'count' : 'adjust', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId, note: doc.reason,
        });
        touched.add(l.product_id);
      }
      return touched;
    }

    // sale / purchase / returns
    const sumLines = lines.reduce((s, l) => s + (l.kind === 'text' ? 0 : l.line_total), 0);
    const share = sumLines > 0 ? doc.total / sumLines : 1; // doc-level discount spread over lines
    const extra = doc.type === 'purchase' ? U.num(doc.extra_cost) : 0;
    for (const l of lines) {
      if (l.kind !== 'product' || !l.product_id || !l.qty) continue;
      const p = prodOf(l.product_id);
      if (!p) continue;
      if (doc.type === 'purchase') {
        const landed = l.line_total * share + (sumLines > 0 ? extra * (l.line_total / sumLines) : 0);
        const unitUsd = l.qty ? landed / l.qty / doc.rate : 0;
        db.run('UPDATE doc_lines SET unit_cost_usd = ?, extra_usd = ? WHERE id = ?', [U.round(unitUsd, 6), U.round((sumLines > 0 ? extra * (l.line_total / sumLines) : 0) / doc.rate, 6), l.id]);
        if (p.track_stock) {
          app.stock.addMove({ date: doc.date, product_id: p.id, warehouse_id: doc.warehouse_id, qty: l.qty, unit_cost_usd: unitUsd, cost_fixed: 1, kind: 'purchase', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
          touched.add(p.id);
        }
        // reference "last purchase price" in the product's own currency
        const inProdCur = app.convert(l.qty ? (l.line_total * share) / l.qty : l.unit_price, doc.currency, p.currency, { usd_iqd: doc.usd_iqd });
        const later = db.get("SELECT 1 FROM docs d JOIN doc_lines x ON x.doc_id = d.id WHERE x.product_id = ? AND d.type = 'purchase' AND d.status = 'posted' AND d.date > ? AND d.id <> ? LIMIT 1", [p.id, doc.date, doc.id]);
        if (!later) db.run('UPDATE products SET cost_price = ?, last_supplier_id = ?, last_purchase_date = ? WHERE id = ?', [app.money(inProdCur, p.currency) || U.round(inProdCur, 4), doc.partner_id, doc.date, p.id]);
      } else if (doc.type === 'sale') {
        const cost = p.track_stock ? app.stock.currentCost(p.id) : app.stock.standardCostUsd(p);
        db.run('UPDATE doc_lines SET unit_cost_usd = ? WHERE id = ?', [U.round(cost, 6), l.id]);
        if (p.track_stock) {
          app.stock.addMove({ date: doc.date, product_id: p.id, warehouse_id: doc.warehouse_id, qty: -l.qty, unit_cost_usd: cost, kind: 'sale', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
          touched.add(p.id);
        }
        if (!p.last_sale_date || p.last_sale_date < doc.date) db.run('UPDATE products SET last_sale_date = ? WHERE id = ?', [doc.date, p.id]);
      } else if (doc.type === 'sale_return') {
        let cost = null;
        if (l.ref_line_id) cost = db.val('SELECT unit_cost_usd FROM doc_lines WHERE id = ?', [l.ref_line_id]);
        if (cost == null) cost = app.stock.currentCost(p.id);
        db.run('UPDATE doc_lines SET unit_cost_usd = ? WHERE id = ?', [U.round(cost, 6), l.id]);
        if (p.track_stock) {
          app.stock.addMove({ date: doc.date, product_id: p.id, warehouse_id: doc.warehouse_id, qty: l.qty, unit_cost_usd: cost, kind: 'sale_return', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
          touched.add(p.id);
        }
      } else if (doc.type === 'purchase_return') {
        // the goods leave stock at the price the supplier credits back, so no profit or loss is invented
        const cost = l.qty ? (l.line_total * share) / l.qty / doc.rate : app.stock.currentCost(p.id);
        db.run('UPDATE doc_lines SET unit_cost_usd = ? WHERE id = ?', [U.round(cost, 6), l.id]);
        if (p.track_stock) {
          app.stock.addMove({ date: doc.date, product_id: p.id, warehouse_id: doc.warehouse_id, qty: -l.qty, unit_cost_usd: cost, cost_fixed: 1, kind: 'purchase_return', doc_id: doc.id, line_id: l.id, rev: doc.rev, user_id: userId });
          touched.add(p.id);
        }
      }
    }
    // non-stock lines (services / labour) carry their standard cost if any
    for (const l of lines) {
      if (l.kind === 'service' && l.product_id && doc.type === 'sale') {
        const p = prodOf(l.product_id);
        db.run('UPDATE doc_lines SET unit_cost_usd = ? WHERE id = ?', [U.round(app.stock.standardCostUsd(p), 6), l.id]);
      }
    }
    // partner balance
    if (doc.partner_id && doc.total) {
      app.partners.addMove({
        date: doc.date, partner_id: doc.partner_id, currency: doc.currency, amount: t.partnerSign * doc.total,
        kind: doc.type, doc_id: doc.id, description: doc.no, due_date: doc.due_date, rev: doc.rev, user_id: userId,
        rate: doc.rate, usd_iqd: doc.usd_iqd,
      });
    }
    // purchase extra cost not paid yet: owed to the supplier together with the goods
    if (doc.type === 'purchase' && extra > 0 && !doc.extra_account_id && doc.partner_id) {
      app.partners.addMove({
        date: doc.date, partner_id: doc.partner_id, currency: doc.currency, amount: -extra, kind: 'purchase_extra', doc_id: doc.id,
        description: `${doc.no} — extra cost`, due_date: doc.due_date, rev: doc.rev, user_id: userId, rate: doc.rate, usd_iqd: doc.usd_iqd,
      });
    }
    // purchase extra cost paid from a cash/bank account
    if (doc.type === 'purchase' && extra > 0 && doc.extra_account_id) {
      const acc = app.cash.account(doc.extra_account_id);
      const amt = app.convert(extra, doc.currency, acc.currency, { usd_iqd: doc.usd_iqd });
      app.cash.addMove({ date: doc.date, account_id: acc.id, amount: -amt, kind: 'purchase_extra', doc_id: doc.id, description: `${doc.no} — extra cost`, user_id: userId, usd_iqd: doc.usd_iqd, rev: doc.rev });
    }
    return touched;
  }

  function voidEffects(docId) {
    const prods = app.stock.voidDoc(docId);
    // a return that settled part of its invoice no longer does
    for (const c of db.all('SELECT DISTINCT doc_id FROM doc_credits WHERE credit_doc_id = ? AND voided = 0', [docId])) {
      db.run('UPDATE doc_credits SET voided = 1 WHERE credit_doc_id = ? AND doc_id = ?', [docId, c.doc_id]);
      app.payments.refreshDoc(c.doc_id);
    }
    db.run('UPDATE partner_moves SET voided = 1 WHERE doc_id = ? AND payment_id IS NULL AND voided = 0', [docId]);
    db.run("UPDATE money_moves SET voided = 1 WHERE doc_id = ? AND payment_id IS NULL AND kind = 'purchase_extra' AND voided = 0", [docId]);
    return prods;
  }

  /* ------------------------------------------------------------------ save */
  /**
   * Create or update a document. See header comment for data shape.
   * data.post = true posts it (applies effects). data.status may set a workflow status for quote/service/PO.
   */
  function save(data, ctx, opts = {}) {
    if (opts.skipPerm) ctx = Object.assign({}, ctx, { skipPerm: true });
    const type = data.type;
    const t = typeDef(type);
    const existing = data.id ? db.get('SELECT * FROM docs WHERE id = ?', [data.id]) : null;
    if (data.id) U.assert(existing, 'not_found', 'Document not found', 404);
    if (existing) {
      U.assert(existing.type === type, 'type_mismatch', 'Document type cannot change');
      U.assert(existing.status !== 'cancelled', 'doc_cancelled', 'A cancelled document cannot be edited');
      U.assert(!['converted', 'invoiced'].includes(existing.status) || data.force, 'doc_closed', 'This document was already converted and cannot be edited');
      requirePerm(ctx, existing.status === 'posted' ? t.perm.edit : t.perm.create);
    } else if (type === 'sale' && data.channel === 'pos') {
      if (!ctx.skipPerm) U.assert(app.users.can(ctx.user, 'pos.use') || app.users.can(ctx.user, 'sales.create'), 'forbidden', 'You do not have permission for this action', 403);
    } else requirePerm(ctx, t.perm.create);
    if (type === 'purchase_return') requirePerm(ctx, 'purchases.create');
    if (['sale_return', 'purchase_return'].includes(type) && !(data.ref_doc_id || (existing && existing.ref_doc_id))) requirePerm(ctx, 'returns.unlinked');

    const date = U.isDate(data.date) ? data.date : (existing ? existing.date : U.today());
    const general = app.getSetting('general');
    const currency = data.currency || (existing && existing.currency) || general.default_currency || 'IQD';
    app.currency(currency);
    const usdIqd = U.num(data.usd_iqd) > 0 ? U.num(data.usd_iqd) : (existing ? existing.usd_iqd : app.usdIqd());
    const fx = app.fx(currency, usdIqd);
    {
      // a typed rate far from today's rate changes every price and profit: only for people who may set rates
      const cur = app.usdIqd();
      const changed = !existing || Math.abs((existing.usd_iqd || 0) - usdIqd) > 1e-9;
      if (!ctx.skipPerm && changed && cur > 0 && Math.abs(usdIqd - cur) / cur > 0.10 && !app.users.can(ctx.user, 'settings.manage') && !app.users.can(ctx.user, 'cash.manage')) {
        U.assert(false, 'rate_out_of_range', `The rate ${usdIqd} is too far from today's rate ${cur}`, 400, { rate: usdIqd, current: cur });
      }
    }

    // partner
    let partnerId = data.partner_id || null;
    if (!partnerId && ['sale', 'quote', 'service'].includes(type) && !data.partner_name) partnerId = app.partners.walkinId();
    if (['purchase', 'purchase_return', 'purchase_order'].includes(type)) U.assert(partnerId, 'partner_required', 'Choose a supplier');
    if (['sale', 'sale_return'].includes(type)) U.assert(partnerId, 'partner_required', 'Choose a customer');
    let partner = null;
    if (partnerId) {
      partner = db.get('SELECT * FROM partners WHERE id = ?', [partnerId]);
      U.assert(partner, 'partner_not_found', 'Account not found', 404);
    }

    // warehouse
    let warehouseId = data.warehouse_id || (existing && existing.warehouse_id) || null;
    if (!warehouseId && ['sale', 'purchase', 'sale_return', 'purchase_return', 'transfer', 'adjust', 'service'].includes(type)) {
      const u = ctx.user && ctx.user.default_warehouse_id;
      warehouseId = (u && db.get('SELECT 1 FROM warehouses WHERE id = ? AND active = 1', [u]) && u) || app.getSetting('pos').default_warehouse_id || app.stock.defaultWarehouseId();
    }

    const lines = computeLines(data.lines, currency);
    if (t.posting && type !== 'adjust') U.assert(lines.some((l) => l.kind !== 'text'), 'lines_required', 'Add at least one line');
    if (type === 'adjust') U.assert(lines.some((l) => l.product_id && l.qty), 'lines_required', 'Add at least one product');
    // product details for lines (name/code snapshot)
    for (const l of lines) {
      if (!l.product_id) {
        if (['product', 'service'].includes(l.kind)) l.kind = 'labor';
        continue;
      }
      const p = db.get('SELECT id, name, code, unit, type, track_stock, warranty_months FROM products WHERE id = ?', [l.product_id]);
      U.assert(p, 'product_not_found', 'Product not found', 404);
      if (!l.description) l.description = p.name;
      if (!l.code) l.code = p.code;
      if (!l.unit) l.unit = p.unit;
      // the kind of a product line follows the product card (a stock item cannot be sent as a service)
      if (l.kind !== 'text') l.kind = p.type === 'service' ? 'service' : 'product';
      l._warranty_months = p.warranty_months;
    }
    if (!ctx.skipPerm) {
      for (const l of lines) {
        if (l.kind === 'text') continue;
        if (type === 'adjust') { U.assert(l.qty !== 0 || !l.product_id, 'bad_qty', `"${l.description}": quantity cannot be zero`, 400, { name: l.description }); continue; }
        U.assert(l.qty > 0, 'bad_qty', `"${l.description}": quantity must be more than zero`, 400, { name: l.description });
        U.assert(l.unit_price >= 0, 'bad_price', `"${l.description}": the price cannot be negative`, 400, { name: l.description });
      }
    }
    const totals = computeTotals(lines, data, currency);
    if (['transfer', 'adjust'].includes(type)) { totals.total = 0; totals.subtotal = 0; }

    // returns: validate against the original document
    if (['sale_return', 'purchase_return'].includes(type) && data.ref_doc_id) {
      const orig = db.get('SELECT * FROM docs WHERE id = ?', [data.ref_doc_id]);
      U.assert(orig && orig.type === (type === 'sale_return' ? 'sale' : 'purchase') && orig.status === 'posted', 'bad_ref', 'The original invoice was not found');
      U.assert(!partnerId || orig.partner_id === partnerId, 'ref_partner', 'The original invoice belongs to another account');
      for (const l of lines) {
        if (!l.ref_line_id) continue;
        const ol = db.get('SELECT * FROM doc_lines WHERE id = ? AND doc_id = ?', [l.ref_line_id, orig.id]);
        U.assert(ol, 'bad_ref_line', 'Returned line not found on the original invoice');
        const already = db.val(`SELECT SUM(rl.qty) FROM doc_lines rl JOIN docs rd ON rd.id = rl.doc_id
          WHERE rl.ref_line_id = ? AND rd.status = 'posted' AND rd.id <> ?`, [ol.id, data.id || '']) || 0;
        U.assert(l.qty <= ol.qty - already + 1e-9, 'return_qty', `"${ol.description}": at most ${U.round(ol.qty - already, 3)} can be returned`, 400, { name: ol.description, max: U.round(ol.qty - already, 3) });
        // price: not more than was really paid for it (line price after its own and the invoice discount), compared in USD
        if (!ctx.skipPerm && ol.qty > 0 && l.qty > 0) {
          const origSum = db.val("SELECT SUM(line_total) FROM doc_lines WHERE doc_id = ? AND kind <> 'text'", [orig.id]) || 0;
          const origShare = origSum > 0 ? orig.total / origSum : 1;
          const origUnitUsd = (ol.line_total * origShare) / ol.qty / (orig.rate || 1);
          const retUnitUsd = l.line_total / l.qty / (fx.rate || 1);
          U.assert(retUnitUsd <= origUnitUsd * 1.005 + 0.0005, 'return_price', `"${ol.description}": the return price is higher than on invoice ${orig.no}`, 400, { name: ol.description, no: orig.no });
        }
      }
    }

    const status = (() => {
      if (t.posting) {
        if (data.post || (existing && existing.status === 'posted')) return 'posted';
        return 'draft';
      }
      const allowed = STATUSES[type];
      if (data.status && allowed.includes(data.status) && !['converted', 'invoiced', 'cancelled'].includes(data.status)) return data.status;
      return existing ? existing.status : allowed[0];
    })();

    return db.tx(() => {
      const now = U.nowIso();
      const userId = ctx.user ? ctx.user.id : null;
      let id = existing ? existing.id : uuid();
      let no = existing ? existing.no : null;
      if (!existing) {
        if (data.no) {
          no = U.str(data.no, 40);
          U.assert(!db.get('SELECT 1 FROM docs WHERE type = ? AND no = ?', [type, no]), 'number_taken', `Number ${no} is already used`, 400, { no });
        } else no = app.nextNo(type, date);
      } else if (data.no && data.no !== existing.no) {
        no = U.str(data.no, 40);
        U.assert(!db.get('SELECT 1 FROM docs WHERE type = ? AND no = ? AND id <> ?', [type, no, id]), 'number_taken', `Number ${no} is already used`, 400, { no });
      }
      // vehicle
      let vehicleId = data.vehicle_id || null;
      if (['sale', 'service', 'quote', 'sale_return'].includes(type) && (data.vehicle_id || data.vehicle_plate || (data.vehicle && Object.keys(data.vehicle).length))) {
        vehicleId = app.vehicles.resolveForDoc({
          vehicle_id: data.vehicle_id, vehicle_plate: data.vehicle_plate, vehicle_desc: data.vehicle_desc,
          partner_id: partner && !partner.is_walkin ? partner.id : null, km: data.km, vehicle: data.vehicle,
        }, ctx);
      }
      const rev = existing ? (existing.status === 'posted' && status === 'posted' ? existing.rev + 1 : existing.rev) : 1;
      let dueDate = U.isDate(data.due_date) ? data.due_date : null;
      if (!dueDate && partner && partner.payment_days && ['sale', 'purchase'].includes(type)) dueDate = U.addDays(date, partner.payment_days);
      const row = {
        type, no, date, due_date: dueDate, valid_until: U.isDate(data.valid_until) ? data.valid_until : null, status,
        channel: data.channel || (existing && existing.channel) || null,
        partner_id: partnerId, partner_name: U.str(data.partner_name, 200) || (partner ? partner.name : null), partner_phone: U.str(data.partner_phone, 40) || (partner ? partner.phone : null),
        warehouse_id: warehouseId, to_warehouse_id: data.to_warehouse_id || null,
        currency, rate: fx.rate, usd_iqd: fx.usd_iqd, price_list_id: data.price_list_id || (partner && partner.price_list_id) || null,
        subtotal: totals.subtotal, line_discount: totals.line_discount, discount: totals.discount,
        extra_cost: type === 'purchase' ? U.num(data.extra_cost) : 0, extra_account_id: type === 'purchase' ? (data.extra_account_id || null) : null,
        total: totals.total, total_usd: U.round(totals.total / fx.rate, 6),
        payment_method: U.str(data.payment_method, 20),
        vehicle_id: vehicleId, vehicle_plate: U.str(data.vehicle_plate, 30), vehicle_desc: U.str(data.vehicle_desc, 120), km: data.km ? Math.round(U.num(data.km)) : null,
        complaint: U.str(data.complaint, 2000), work_done: U.str(data.work_done, 2000),
        staff_id: data.staff_id || (existing ? existing.staff_id : (ctx.user ? ctx.user.id : null)), technician_id: data.technician_id || null,
        ref_doc_id: data.ref_doc_id || (existing ? existing.ref_doc_id : null), reason: U.str(data.reason, 60),
        notes: U.str(data.notes, 4000), internal_note: U.str(data.internal_note, 4000), rev,
        updated_by: userId, updated_at: now,
      };
      if (status === 'posted' && (!existing || existing.status !== 'posted')) row.posted_at = now;

      // business rules for sales; stock for goods leaving a warehouse
      if (type === 'sale' && status === 'posted') {
        checkSaleRules({ ...row, id: existing ? existing.id : null, lines_sum: totals.lines_sum }, lines, ctx, data);
      } else if (['transfer', 'purchase_return'].includes(type) && status === 'posted') {
        checkStock({ ...row, id: existing ? existing.id : null }, lines, ctx, data);
      }
      // a line cannot go below what was already returned from it
      if (existing && ['sale', 'purchase'].includes(type)) {
        for (const l of lines) {
          if (!l.id) continue;
          const back = db.val(`SELECT SUM(rl.qty) FROM doc_lines rl JOIN docs rd ON rd.id = rl.doc_id WHERE rl.ref_line_id = ? AND rd.status = 'posted'`, [l.id]) || 0;
          U.assert(l.qty >= back - 1e-9, 'line_returned_qty', `"${l.description}": ${U.round(back, 3)} were already returned`, 400, { name: l.description, n: U.round(back, 3) });
        }
      }

      let oldLines = [];
      let touched = new Set();
      if (existing) {
        oldLines = db.all('SELECT * FROM doc_lines WHERE doc_id = ? ORDER BY line_no', [id]);
        if (existing.status === 'posted') voidEffects(id).forEach((p) => touched.add(p));
        db.update('docs', id, row);
      } else {
        db.insert('docs', { id, ...row, cost_usd: 0, paid: 0, payment_status: t.payDir ? 'unpaid' : null, created_by: userId, created_at: now });
      }

      // lines: keep ids of lines that came back, delete removed (unless referenced by returns)
      const keepIds = new Set(lines.filter((l) => l.id).map((l) => l.id));
      for (const ol of oldLines) {
        if (keepIds.has(ol.id)) continue;
        const ref = db.get(`SELECT rd.no FROM doc_lines rl JOIN docs rd ON rd.id = rl.doc_id WHERE rl.ref_line_id = ? AND rd.status <> 'cancelled' LIMIT 1`, [ol.id]);
        U.assert(!ref, 'line_returned', `"${ol.description}" was returned in ${ref && ref.no}; it cannot be removed`, 400, { name: ol.description, no: ref && ref.no });
        db.run('UPDATE stock_moves SET line_id = NULL WHERE line_id = ?', [ol.id]);
        db.run('DELETE FROM doc_lines WHERE id = ?', [ol.id]);
      }
      for (const l of lines) {
        const lineRow = {
          doc_id: id, line_no: l.line_no, kind: l.kind, product_id: l.product_id, code: l.code, description: l.description,
          qty: l.qty, unit: l.unit, unit_price: l.unit_price, discount: l.discount, discount_pct: l.discount_pct, line_total: l.line_total,
          staff_id: l.staff_id, ref_line_id: l.ref_line_id, note: l.note, received_qty: l.received_qty,
          warranty_until: type === 'sale' && l._warranty_months > 0 ? U.addMonths(date, l._warranty_months) : null,
        };
        if (type === 'adjust') lineRow.unit_cost_usd = l.unit_cost_usd;
        if (l.id && oldLines.some((o) => o.id === l.id)) db.update('doc_lines', l.id, lineRow);
        else { l.id = uuid(); db.insert('doc_lines', { id: l.id, ...lineRow }); }
      }

      const doc = db.get('SELECT * FROM docs WHERE id = ?', [id]);
      if (status === 'posted') applyEffects(doc, lines, ctx).forEach((p) => touched.add(p));
      for (const pid of touched) app.stock.recalc(pid);
      if (['sale', 'sale_return'].includes(type)) app.stock.refreshDocCost(id);

      // source document bookkeeping
      if (!existing && row.ref_doc_id) {
        const src = db.get('SELECT * FROM docs WHERE id = ?', [row.ref_doc_id]);
        if (src && src.type === 'quote' && ['sale', 'service'].includes(type)) db.run("UPDATE docs SET status = 'converted', updated_at = ? WHERE id = ?", [now, src.id]);
        if (src && src.type === 'service' && type === 'sale') db.run("UPDATE docs SET status = 'invoiced', updated_at = ? WHERE id = ?", [now, src.id]);
        if (src && src.type === 'purchase_order' && type === 'purchase') db.run("UPDATE docs SET status = 'received', updated_at = ? WHERE id = ?", [now, src.id]);
      }

      // a posted invoice that was edited: allocations that no longer fit are released (the money stays on the account)
      if (existing && existing.status === 'posted' && t.payDir) {
        const tolE = currency === 'IQD' ? 1 : 0.01;
        if (existing.partner_id !== partnerId || existing.currency !== currency) {
          db.run('UPDATE payment_allocations SET voided = 1 WHERE doc_id = ? AND voided = 0', [id]);
          db.run('UPDATE doc_credits SET voided = 1 WHERE doc_id = ? AND voided = 0', [id]);
        } else {
          let over = app.money((db.val('SELECT SUM(amount) FROM payment_allocations WHERE doc_id = ? AND voided = 0', [id]) || 0)
            + (db.val('SELECT SUM(amount) FROM doc_credits WHERE doc_id = ? AND voided = 0', [id]) || 0) - totals.total, currency);
          if (over > tolE) {
            for (const a of db.all('SELECT * FROM payment_allocations WHERE doc_id = ? AND voided = 0 ORDER BY created_at DESC', [id])) {
              if (over <= tolE) break;
              const cut = Math.min(a.amount, over);
              if (cut >= a.amount - 1e-9) db.run('UPDATE payment_allocations SET voided = 1 WHERE id = ?', [a.id]);
              else db.run('UPDATE payment_allocations SET amount = ? WHERE id = ?', [app.money(a.amount - cut, currency), a.id]);
              over = app.money(over - cut, currency);
            }
          }
        }
      }

      // immediate payments (POS tenders or "paid now" on an invoice)
      if (status === 'posted' && t.payDir && Array.isArray(data.payments)) {
        const tolP = currency === 'IQD' ? 1 : 0.01;
        const inDoc = (p) => (U.num(p.applied_amount) > 0 ? U.num(p.applied_amount) : app.convert(U.num(p.amount), app.cash.account(p.account_id).currency, currency, { usd_iqd: fx.usd_iqd }));
        const pays = data.payments.filter((p) => U.num(p.amount) > 0);
        const tendered = pays.reduce((sum, p) => sum + inDoc(p), 0);
        const due = app.money(totals.total - (existing ? (db.val('SELECT SUM(amount) FROM payment_allocations WHERE doc_id = ? AND voided = 0', [id]) || 0) : 0), currency);
        let changeDoc = 0;
        if (data.change && U.num(data.change.amount) > 0 && !ctx.skipPerm) {
          const chAcc = app.cash.account(data.change.account_id);
          U.assert(chAcc.type === 'cash', 'change_account', 'Change can only be given from a cash box');
          changeDoc = app.convert(U.num(data.change.amount), chAcc.currency, currency, { usd_iqd: fx.usd_iqd });
          U.assert(changeDoc <= tendered - due + tolP, 'change_too_big', 'The change is more than the money received above the total', 400, { change: U.round(changeDoc, 2), over: U.round(Math.max(0, tendered - due), 2) });
          const nonCash = pays.filter((p) => app.cash.account(p.account_id).type !== 'cash').reduce((sum, p) => sum + inDoc(p), 0);
          U.assert(nonCash <= due + tolP, 'card_over', 'Card or bank payments cannot be more than the total when change is given');
        }
        if (partner && partner.is_walkin && !ctx.skipPerm) U.assert(tendered - changeDoc <= due + tolP, 'walkin_overpaid', 'The walk-in customer paid more than the total; give the difference back as change', 400, { over: U.round(tendered - changeDoc - due, 2) });
        for (const p of data.payments) {
          if (!(U.num(p.amount) > 0)) continue;
          app.payments.create({
            direction: t.payDir, partner_id: partnerId, account_id: p.account_id, amount: p.amount, method: p.method,
            applied_currency: currency, applied_amount: p.applied_amount, usd_iqd: fx.usd_iqd, date,
            description: p.description || no, allocations: [{ doc_id: id, amount: p.applied_amount || app.convert(p.amount, app.cash.account(p.account_id).currency, currency, { usd_iqd: fx.usd_iqd }) }],
            allow_over: false, purpose: type === 'sale' ? 'sale' : type, silent: true,
          }, ctx);
        }
        // change handed back to the customer (POS)
        if (data.change && U.num(data.change.amount) > 0) {
          // the change is linked to the doc for display but is not an allocation
          app.payments.create({
            direction: t.payDir === 'in' ? 'out' : 'in', partner_id: partnerId, account_id: data.change.account_id, amount: data.change.amount,
            applied_currency: currency, usd_iqd: fx.usd_iqd, date, description: `${no} — change`, purpose: 'change', link_doc_id: id, silent: true,
          }, ctx);
        }
      }
      if (status === 'posted' && ['sale_return', 'purchase_return'].includes(type) && row.ref_doc_id) {
        const orig = db.get('SELECT * FROM docs WHERE id = ?', [row.ref_doc_id]);
        if (orig && orig.status === 'posted') {
          const open = app.payments.remainingOf(orig);
          const retInOrig = app.money(app.convert(totals.total, currency, orig.currency, { usd_iqd: orig.usd_iqd }), orig.currency);
          const apply = Math.min(open, retInOrig);
          if (apply > (orig.currency === 'IQD' ? 1 : 0.01)) {
            const creditAmt = app.money(app.convert(apply, orig.currency, currency, { usd_iqd: orig.usd_iqd }), currency);
            db.insert('doc_credits', { id: uuid(), doc_id: orig.id, credit_doc_id: id, amount: apply, credit_amount: Math.min(creditAmt, totals.total), voided: 0, created_at: now });
            app.payments.refreshDoc(orig.id);
          }
        }
      }
      if (t.payDir) app.payments.refreshDoc(id);

      // credit control: an unpaid remainder needs a real customer and permission
      if (type === 'sale' && status === 'posted') {
        const d2 = db.get('SELECT total, paid FROM docs WHERE id = ?', [id]);
        const unpaid = app.money(d2.total - d2.paid, currency);
        const tol = currency === 'IQD' ? 1 : 0.01;
        if (unpaid > tol) {
          U.assert(!partner || !partner.is_walkin, 'walkin_credit', 'A credit (unpaid) sale needs a named customer, not the walk-in customer');
          if (!ctx.skipPerm) U.assert(app.users.can(ctx.user, 'sales.credit'), 'forbidden_credit', 'You are not allowed to make credit sales', 403);
          if (partner && partner.credit_limit && !data.confirm_credit_limit) {
            const ccy = partner.credit_currency || currency;
            const bals = app.partners.balances(partner.id);
            const bal = app.money(Object.entries(bals).reduce((sum, [c, v]) => sum + app.convert(v, c, ccy), 0), ccy);
            U.assert(bal <= partner.credit_limit + tol, 'credit_limit', `Credit limit exceeded (${bal} / ${partner.credit_limit} ${ccy})`, 409, { balance: bal, limit: partner.credit_limit, currency: ccy });
          }
        }
      }

      const action = existing ? (existing.status === 'draft' && status === 'posted' ? 'post' : 'update') : 'create';
      app.audit(ctx, action, 'doc', id, { k: 'doc', v: { type, no, total: totals.total, currency } },
        existing ? { before: { ...existing, lines: oldLines.map((l) => ({ d: l.description, q: l.qty, p: l.unit_price, t: l.line_total })) } } : undefined);
      return { id, no };
    });
  }

  /* ------------------------------------------------------------------ status / cancel / convert */
  function setStatus(id, status, ctx) {
    const d = db.get('SELECT * FROM docs WHERE id = ?', [id]);
    U.assert(d, 'not_found', 'Document not found', 404);
    const t = typeDef(d.type);
    U.assert(!t.posting, 'bad_status', 'Use post/cancel for this document');
    requirePerm(ctx, t.perm.edit);
    U.assert(STATUSES[d.type].includes(status) && !['converted', 'invoiced', 'cancelled'].includes(status), 'bad_status', 'Invalid status');
    U.assert(!['converted', 'invoiced', 'cancelled'].includes(d.status), 'doc_closed', 'This document is closed');
    db.tx(() => {
      db.update('docs', id, { status, updated_by: ctx.user && ctx.user.id, updated_at: U.nowIso() });
      app.audit(ctx, 'status', 'doc', id, { k: 'status', v: { no: d.no, from: d.status, to: status } });
    });
  }

  function post(id, ctx) {
    const d = get(id);
    U.assert(d.status === 'draft', 'not_draft', 'Only drafts can be posted');
    return save({ ...d, post: true, lines: d.lines, payments: undefined, change: undefined, no: undefined }, ctx);
  }

  function cancel(id, reason, ctx, opts = {}) {
    const d = db.get('SELECT * FROM docs WHERE id = ?', [id]);
    U.assert(d, 'not_found', 'Document not found', 404);
    const t = typeDef(d.type);
    requirePerm(ctx, t.perm.cancel);
    U.assert(d.status !== 'cancelled', 'already_cancelled', 'Already cancelled');
    if (['sale', 'purchase'].includes(d.type)) {
      const ret = db.get(`SELECT no FROM docs WHERE ref_doc_id = ? AND type IN ('sale_return', 'purchase_return') AND status = 'posted' LIMIT 1`, [id]);
      U.assert(!ret, 'has_returns', `Cancel the return ${ret && ret.no} first`, 400, { no: ret && ret.no });
    }
    return db.tx(() => {
      const touched = d.status === 'posted' ? voidEffects(id) : [];
      // payments: either cancel them (if they only paid this doc) or just release the allocation (credit stays on the account)
      const pays = db.all(`SELECT DISTINCT p.* FROM payment_allocations al JOIN payments p ON p.id = al.payment_id WHERE al.doc_id = ? AND al.voided = 0`, [id]);
      const changes = db.all("SELECT * FROM payments WHERE doc_id = ? AND purpose = 'change' AND status = 'posted'", [id]);
      for (const p of pays) {
        const others = db.val('SELECT COUNT(*) FROM payment_allocations WHERE payment_id = ? AND doc_id <> ? AND voided = 0', [p.id, id]);
        if (opts.cancel_payments && !others) app.payments.cancel(p.id, `${d.no} cancelled`, ctx, { silent: true });
        else db.run('UPDATE payment_allocations SET voided = 1 WHERE payment_id = ? AND doc_id = ?', [p.id, id]);
      }
      if (opts.cancel_payments) for (const c of changes) app.payments.cancel(c.id, `${d.no} cancelled`, ctx, { silent: true });
      db.update('docs', id, { status: 'cancelled', cancelled_by: ctx.user && ctx.user.id, cancelled_at: U.nowIso(), cancel_reason: U.str(reason, 300) });
      if (t.payDir) app.payments.refreshDoc(id);
      for (const pid of touched) app.stock.recalc(pid);
      // re-open the source document if this one came from it
      if (d.ref_doc_id) {
        const src = db.get('SELECT * FROM docs WHERE id = ?', [d.ref_doc_id]);
        if (src && src.type === 'quote' && src.status === 'converted') db.run("UPDATE docs SET status = 'accepted' WHERE id = ?", [src.id]);
        if (src && src.type === 'service' && src.status === 'invoiced') db.run("UPDATE docs SET status = 'done' WHERE id = ?", [src.id]);
        if (src && src.type === 'purchase_order' && src.status === 'received') db.run("UPDATE docs SET status = 'open' WHERE id = ?", [src.id]);
      }
      app.audit(ctx, 'cancel', 'doc', id, { k: 'doc', v: { type: d.type, no: d.no, reason: reason || '' } }, { cancel_payments: !!opts.cancel_payments });
      return { ok: true };
    });
  }

  /** delete a draft (never posted, never paid) */
  function removeDraft(id, ctx) {
    const d = db.get('SELECT * FROM docs WHERE id = ?', [id]);
    U.assert(d, 'not_found', 'Document not found', 404);
    U.assert(d.status === 'draft' || (!TYPES[d.type].posting && ['open'].includes(d.status) && !db.get('SELECT 1 FROM docs WHERE ref_doc_id = ?', [id])), 'not_draft', 'Only drafts can be deleted; cancel posted documents instead');
    requirePerm(ctx, TYPES[d.type].perm.create);
    U.assert(!db.val('SELECT COUNT(*) FROM payment_allocations WHERE doc_id = ? AND voided = 0', [id]), 'has_payments', 'This document has payments');
    db.tx(() => {
      const lines = db.all('SELECT * FROM doc_lines WHERE doc_id = ?', [id]);
      db.run('DELETE FROM doc_lines WHERE doc_id = ?', [id]);
      db.run('DELETE FROM docs WHERE id = ?', [id]);
      app.audit(ctx, 'delete_draft', 'doc', id, { k: 'doc', v: { type: d.type, no: d.no } }, { doc: d, lines });
    });
  }

  /** build an unsaved document from another one (quote→sale/service, service→sale, PO→purchase, sale→return) */
  function draftFrom(sourceId, targetType) {
    const s = get(sourceId);
    const map = { quote: ['sale', 'service'], service: ['sale'], purchase_order: ['purchase'], sale: ['sale_return', 'quote'], purchase: ['purchase_return'] };
    U.assert((map[s.type] || []).includes(targetType), 'bad_conversion', 'This conversion is not possible');
    const lines = s.lines.filter((l) => targetType.endsWith('_return') ? (l.kind === 'product' && l.qty - (l.returned_qty || 0) > 0) : true).map((l) => ({
      kind: l.kind, product_id: l.product_id, code: l.code, description: l.description,
      qty: targetType.endsWith('_return') ? U.round(l.qty - (l.returned_qty || 0), 4) : l.qty,
      max_qty: targetType.endsWith('_return') ? U.round(l.qty - (l.returned_qty || 0), 4) : undefined,
      unit: l.unit, unit_price: targetType.endsWith('_return') && l.qty ? U.round(l.line_total / l.qty * (s.total && (s.total + s.discount) ? s.total / (s.total + s.discount) : 1), 6) : l.unit_price,
      discount: targetType.endsWith('_return') ? 0 : l.discount, discount_pct: targetType.endsWith('_return') ? null : l.discount_pct,
      staff_id: l.staff_id, ref_line_id: targetType.endsWith('_return') ? l.id : null, note: l.note,
    }));
    return {
      type: targetType, ref_doc_id: s.id, ref_no: s.no, partner_id: s.partner_id, partner_name: s.partner_name, currency: s.currency, usd_iqd: s.usd_iqd,
      price_list_id: s.price_list_id, discount: targetType.endsWith('_return') ? 0 : s.discount, warehouse_id: s.warehouse_id,
      vehicle_id: s.vehicle_id, vehicle_plate: s.vehicle_plate || s.v_plate, vehicle_desc: s.vehicle_desc, km: s.km,
      staff_id: s.staff_id, technician_id: s.technician_id, notes: s.notes, complaint: s.complaint, work_done: s.work_done, lines,
    };
  }

  return { TYPES, STATUSES, get, list, save, post, cancel, setStatus, removeDraft, draftFrom, computeLines, computeTotals };
};
