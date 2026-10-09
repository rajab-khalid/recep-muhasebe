'use strict';

module.exports = (app) => {
  const { db, uuid, U } = app;

  /* ------------------------------------------------------------------ helpers */
  function priceLists() {
    return db.all('SELECT * FROM price_lists WHERE active = 1 ORDER BY sort, name');
  }
  function defaultPriceListId() {
    const pos = app.getSetting('pos');
    if (pos.default_price_list_id && db.get('SELECT 1 FROM price_lists WHERE id = ? AND active = 1', [pos.default_price_list_id])) return pos.default_price_list_id;
    const r = db.get('SELECT id FROM price_lists WHERE active = 1 ORDER BY is_default DESC, sort LIMIT 1');
    return r ? r.id : null;
  }

  function rebuildSearch(id) {
    const p = db.get(`SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, [id]);
    if (!p) return;
    const codes = db.all('SELECT code FROM product_codes WHERE product_id = ?', [id]).map((r) => r.code);
    const fits = db.all(`SELECT mk.name AS make, md.name AS model, f.engine FROM product_fitments f
      LEFT JOIN vehicle_makes mk ON mk.id = f.make_id LEFT JOIN vehicle_models md ON md.id = f.model_id WHERE f.product_id = ?`, [id])
      .map((f) => [f.make, f.model, f.engine].filter(Boolean).join(' '));
    const blob = U.searchBlob(p.name, p.name2, p.code, p.barcode, p.oem_no, p.brand_name, p.category_name, p.color, p.size, p.shelf, ...codes, ...fits);
    db.run('UPDATE products SET search = ? WHERE id = ?', [blob, id]);
  }

  function ensureBrand(name) {
    const n = U.str(name, 80);
    if (!n) return null;
    const r = db.get('SELECT id FROM brands WHERE lower(name) = lower(?)', [n]);
    if (r) return r.id;
    const id = uuid();
    db.insert('brands', { id, name: n, active: 1 });
    return id;
  }

  function ensureCategory(name) {
    const n = U.str(name, 80);
    if (!n) return null;
    const r = db.get('SELECT id FROM categories WHERE lower(name) = lower(?)', [n]);
    if (r) return r.id;
    const id = uuid();
    db.insert('categories', { id, name: n, sort: (db.val('SELECT MAX(sort) FROM categories') || 0) + 1, active: 1 });
    return id;
  }

  /* Interpret a free-text query: years (1980-2039) and known vehicle model names become fitment filters. */
  function parseQuery(q) {
    const terms = U.searchTerms(q);
    const years = [];
    const textTerms = [];
    for (const t of terms) {
      if (/^(19[89]\d|20[0-3]\d)$/.test(t)) years.push(Number(t));
      else textTerms.push(t);
    }
    // detect vehicle model names (single or two-word, e.g. "land cruiser") among the text terms
    const models = db.all('SELECT m.id, m.name, mk.name AS make FROM vehicle_models m JOIN vehicle_makes mk ON mk.id = m.make_id');
    const modelHits = [];
    const used = new Set();
    for (const m of models) {
      const mn = U.normalize(m.name);
      if (!mn || mn.length < 2) continue;
      const parts = mn.split(' ');
      for (let i = 0; i <= textTerms.length - parts.length; i++) {
        if (parts.every((pp, k) => textTerms[i + k] === pp)) {
          modelHits.push({ id: m.id, idx: [...Array(parts.length).keys()].map((k) => i + k) });
        }
      }
    }
    let modelIds = [];
    if (modelHits.length) {
      modelIds = [...new Set(modelHits.map((h) => h.id))];
      for (const h of modelHits) h.idx.forEach((i) => used.add(i));
    }
    const rest = textTerms.filter((t, i) => !used.has(i));
    return { terms, years, modelIds, rest, raw: q };
  }

  function buildWhere(f, params) {
    const where = [];
    if (f.active === 'all') { /* all */ } else if (f.active === '0' || f.active === false) where.push('p.active = 0');
    else where.push('p.active = 1');
    if (f.type) { where.push('p.type = ?'); params.push(f.type); }
    if (f.category_id) { where.push('p.category_id = ?'); params.push(f.category_id); }
    if (f.brand_id) { where.push('p.brand_id = ?'); params.push(f.brand_id); }
    if (f.ids && f.ids.length) { where.push(`p.id IN (${f.ids.map(() => '?').join(',')})`); params.push(...f.ids); }
    if (f.make_id) { where.push('EXISTS (SELECT 1 FROM product_fitments x WHERE x.product_id = p.id AND x.make_id = ?)'); params.push(f.make_id); }
    if (f.model_id) { where.push('EXISTS (SELECT 1 FROM product_fitments x WHERE x.product_id = p.id AND x.model_id = ?)'); params.push(f.model_id); }
    if (f.year) {
      where.push('EXISTS (SELECT 1 FROM product_fitments x WHERE x.product_id = p.id AND (x.year_from IS NULL OR x.year_from <= ?) AND (x.year_to IS NULL OR x.year_to >= ?))');
      params.push(Number(f.year), Number(f.year));
    }
    if (f.q) {
      const raw = String(f.q).trim();
      const pq = parseQuery(raw);
      const conds = [];
      // exact code / barcode / alternative code hit always wins
      conds.push('(p.barcode = ? OR p.code = ? OR EXISTS (SELECT 1 FROM product_codes pc WHERE pc.product_id = p.id AND pc.code = ?))');
      params.push(raw, raw, raw);
      const sub = [];
      const subParams = [];
      for (const t of pq.rest) { sub.push('p.search LIKE ?'); subParams.push(`%${t}%`); }
      if (pq.modelIds.length || pq.years.length) {
        const fw = ['x.product_id = p.id'];
        if (pq.modelIds.length) { fw.push(`x.model_id IN (${pq.modelIds.map(() => '?').join(',')})`); subParams.push(...pq.modelIds); }
        for (const y of pq.years) { fw.push('(x.year_from IS NULL OR x.year_from <= ?) AND (x.year_to IS NULL OR x.year_to >= ?)'); subParams.push(y, y); }
        // either the product is tagged for that vehicle, or the words are literally in its name
        const lit = [];
        const litParams = [];
        for (const t of pq.terms.filter((t) => !pq.rest.includes(t))) { lit.push('p.search LIKE ?'); litParams.push(`%${t}%`); }
        sub.push(`(EXISTS (SELECT 1 FROM product_fitments x WHERE ${fw.join(' AND ')})${lit.length ? ` OR (${lit.join(' AND ')})` : ''})`);
        subParams.push(...litParams);
      }
      if (sub.length) { conds.push(`(${sub.join(' AND ')})`); params.push(...subParams); }
      where.push(`(${conds.join(' OR ')})`);
    }
    return where;
  }

  /**
   * List / search products.
   * f: { q, category_id, brand_id, make_id, model_id, year, stock: 'low'|'out'|'in'|'neg', warehouse_id, active, type, price_list_id, sort, limit, offset }
   */
  function list(f = {}) {
    const params = [];
    const where = buildWhere(f, params);
    const wh = f.warehouse_id || null;
    const plId = f.price_list_id || defaultPriceListId();
    const stockExpr = wh
      ? '(SELECT COALESCE(SUM(qty), 0) FROM stock_levels s WHERE s.product_id = p.id AND s.warehouse_id = ?)'
      : '(SELECT COALESCE(SUM(qty), 0) FROM stock_levels s WHERE s.product_id = p.id)';
    const stockParams = wh ? [wh] : [];
    const lowDefault = app.getSetting('stock').low_stock_default || 0;
    let having = '';
    if (f.stock === 'out') having = 'stock <= 0 AND track_stock = 1';
    else if (f.stock === 'neg') having = 'stock < 0';
    else if (f.stock === 'in') having = 'stock > 0';
    else if (f.stock === 'low') having = `track_stock = 1 AND stock <= (CASE WHEN min_stock > 0 THEN min_stock ELSE ${Number(lowDefault)} END)`;
    else if (f.stock === 'critical') having = 'track_stock = 1 AND stock <= 0';
    const sortMap = {
      name: 'name COLLATE NOCASE', code: 'code', stock: 'stock DESC', stock_asc: 'stock ASC', newest: 'created_at DESC',
      price: 'price DESC', no: 'no',
    };
    const order = sortMap[f.sort] || 'name COLLATE NOCASE';
    const limit = Math.min(Number(f.limit) || 200, 5000);
    const offset = Number(f.offset) || 0;
    const sql = `SELECT * FROM (
        SELECT p.id, p.no, p.code, p.barcode, p.name, p.name2, p.type, p.unit, p.currency, p.price_rate, p.cost_price, p.avg_cost_usd,
          p.min_stock, p.max_stock, p.shelf, p.color, p.size, p.oem_no, p.warranty_months, p.photo_id, p.track_stock, p.active,
          p.category_id, c.name AS category_name, p.brand_id, b.name AS brand_name, p.last_sale_date, p.last_purchase_date, p.created_at,
          ${stockExpr} AS stock,
          (SELECT price FROM product_prices pp WHERE pp.product_id = p.id AND pp.price_list_id = ?) AS price
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN brands b ON b.id = p.brand_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ) ${having ? 'WHERE ' + having : ''}
      ORDER BY ${order} LIMIT ? OFFSET ?`;
    const rows = db.all(sql, [...stockParams, plId, ...params, limit, offset]);
    const countSql = `SELECT COUNT(*) AS n FROM (SELECT p.id, p.track_stock, p.min_stock, ${stockExpr} AS stock FROM products p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}) ${having ? 'WHERE ' + having : ''}`;
    const total = db.val(countSql, [...stockParams, ...params]);
    if (rows.length && f.with_prices) {
      const ids = rows.map((r) => r.id);
      const prices = db.all(`SELECT product_id, price_list_id, price FROM product_prices WHERE product_id IN (${ids.map(() => '?').join(',')})`, ids);
      const map = {};
      for (const pr of prices) (map[pr.product_id] = map[pr.product_id] || {})[pr.price_list_id] = pr.price;
      for (const r of rows) r.prices = map[r.id] || {};
    }
    for (const r of rows) {
      r.low_level = r.min_stock > 0 ? r.min_stock : lowDefault;
      r.stock_state = !r.track_stock ? 'none' : r.stock <= 0 ? 'critical' : r.stock <= r.low_level ? 'low' : 'ok';
    }
    return { rows, total, price_list_id: plId };
  }

  function get(id) {
    const p = db.get(`SELECT p.*, c.name AS category_name, b.name AS brand_name, s.name AS last_supplier_name FROM products p
      LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN partners s ON s.id = p.last_supplier_id WHERE p.id = ?`, [id]);
    U.assert(p, 'not_found', 'Product not found', 404);
    delete p.search;
    p.prices = {};
    for (const r of db.all('SELECT price_list_id, price FROM product_prices WHERE product_id = ?', [id])) p.prices[r.price_list_id] = r.price;
    p.codes = db.all('SELECT id, code, kind, note FROM product_codes WHERE product_id = ? ORDER BY kind, code', [id]);
    p.fitments = db.all(`SELECT f.*, mk.name AS make_name, md.name AS model_name FROM product_fitments f
      LEFT JOIN vehicle_makes mk ON mk.id = f.make_id LEFT JOIN vehicle_models md ON md.id = f.model_id
      WHERE f.product_id = ? ORDER BY mk.name, md.name, f.year_from`, [id]);
    p.levels = app.stock.levels(id);
    p.stock = p.levels.reduce((s, l) => s + l.qty, 0);
    p.recent_purchases = db.all(`SELECT d.id, d.no, d.date, d.currency, l.qty, l.unit_price, l.unit_cost_usd, pa.name AS partner_name
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN partners pa ON pa.id = d.partner_id
      WHERE l.product_id = ? AND d.type = 'purchase' AND d.status = 'posted' ORDER BY d.date DESC, d.created_at DESC LIMIT 10`, [id]);
    p.recent_sales = db.all(`SELECT d.id, d.no, d.date, d.currency, l.qty, l.unit_price, l.discount, l.line_total, l.unit_cost_usd, d.rate,
        COALESCE(pa.name, d.partner_name) AS partner_name
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN partners pa ON pa.id = d.partner_id
      WHERE l.product_id = ? AND d.type = 'sale' AND d.status = 'posted' ORDER BY d.date DESC, d.created_at DESC LIMIT 10`, [id]);
    const s30 = db.get(`SELECT COALESCE(SUM(-m.qty), 0) AS qty FROM stock_moves m WHERE m.product_id = ? AND m.voided = 0 AND m.kind = 'sale' AND m.date >= ?`, [id, U.addDays(U.today(), -30)]);
    p.sold_30d = s30 ? s30.qty : 0;
    return p;
  }

  function nextProductNo() { return (db.val('SELECT MAX(no) FROM products') || 0) + 1; }

  /**
   * Create / update a product.
   * data: { id?, code, barcode, name, name2, type, category_id|category_name, brand_id|brand_name, unit, currency,
   *         cost_price, min_stock, max_stock, shelf, color, size, oem_no, warranty_months, notes, track_stock, active,
   *         prices: {price_list_id: price}, codes: [{code, kind, note}], fitments: [{make_id, model_id, year_from, year_to, engine, note}],
   *         photo (dataURL) | photo_remove, opening_stock: {qty, unit_cost, warehouse_id} }
   */
  function save(data, ctx, opts = {}) {
    const name = U.str(data.name, 250);
    U.assert(name, 'name_required', 'Product name is required');
    const canPrices = opts.skipPerm || app.users.can(ctx.user, 'products.prices');
    return db.tx(() => {
      const now = U.nowIso();
      const barcode = U.str(data.barcode, 60);
      if (barcode) {
        const dup = db.get('SELECT id, name FROM products WHERE barcode = ? AND id <> ? AND active = 1', [barcode, data.id || '']);
        U.assert(!dup, 'barcode_taken', `This barcode is already used by "${dup && dup.name}"`, 400, { product: dup, name: dup && dup.name });
      }
      const currency = data.currency || app.getSetting('general').default_currency || 'IQD';
      app.currency(currency);
      // the product's own rate for turning its price into the other currency (empty = the day's rate)
      let priceRate;
      if (data.price_rate !== undefined) {
        priceRate = data.price_rate === '' || data.price_rate === null ? null : U.num(data.price_rate);
        U.assert(priceRate === null || (priceRate >= 100 && priceRate <= 100000), 'bad_rate', 'Enter a rate between 100 and 100000');
      }
      const fields = {
        code: U.str(data.code, 60), barcode, name, name2: U.str(data.name2, 250),
        type: data.type === 'service' ? 'service' : 'product',
        category_id: data.category_id || (data.category_name ? ensureCategory(data.category_name) : null),
        brand_id: data.brand_id || (data.brand_name ? ensureBrand(data.brand_name) : null),
        unit: U.str(data.unit, 20), currency,
        min_stock: U.num(data.min_stock), max_stock: data.max_stock === '' || data.max_stock == null ? null : U.num(data.max_stock),
        shelf: U.str(data.shelf, 60), color: U.str(data.color, 60), size: U.str(data.size, 60), oem_no: U.str(data.oem_no, 120),
        warranty_months: Math.max(0, Math.round(U.num(data.warranty_months))), notes: U.str(data.notes, 4000),
        track_stock: data.type === 'service' ? 0 : (data.track_stock === undefined ? 1 : (data.track_stock ? 1 : 0)),
        active: data.active === undefined ? 1 : (data.active ? 1 : 0),
        updated_at: now,
      };
      let id = data.id;
      let before = null;
      if (id) {
        before = db.get('SELECT * FROM products WHERE id = ?', [id]);
        U.assert(before, 'not_found', 'Product not found', 404);
        if (canPrices && data.cost_price !== undefined) fields.cost_price = U.num(data.cost_price);
        if (canPrices && priceRate !== undefined) fields.price_rate = priceRate;
        if (!canPrices && fields.currency !== before.currency) fields.currency = before.currency;
        db.update('products', id, fields);
      } else {
        id = uuid();
        fields.cost_price = canPrices ? U.num(data.cost_price) : 0;
        fields.price_rate = canPrices && priceRate !== undefined ? priceRate : null;
        db.insert('products', { id, no: nextProductNo(), ...fields, avg_cost_usd: 0, created_at: now });
      }
      // prices (one per price list)
      if (data.prices && typeof data.prices === 'object') {
        const changes = {};
        for (const [plId, val] of Object.entries(data.prices)) {
          if (!db.get('SELECT 1 FROM price_lists WHERE id = ?', [plId])) continue;
          const old = db.val('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?', [id, plId]);
          if (val === '' || val == null) {
            if (old != null) {
              U.assert(canPrices, 'forbidden_prices', 'You are not allowed to change prices', 403);
              db.run('DELETE FROM product_prices WHERE product_id = ? AND price_list_id = ?', [id, plId]);
              changes[plId] = [old, null];
            }
            continue;
          }
          const price = U.num(val);
          if (old != null && Math.abs(old - price) < 1e-9) continue;
          U.assert(canPrices, 'forbidden_prices', 'You are not allowed to change prices', 403);
          db.run('INSERT INTO product_prices (product_id, price_list_id, price) VALUES (?, ?, ?) ON CONFLICT(product_id, price_list_id) DO UPDATE SET price = excluded.price', [id, plId, price]);
          changes[plId] = [old ?? null, price];
        }
        if (Object.keys(changes).length && before) app.audit(ctx, 'price_change', 'product', id, name, changes);
      }
      if (Array.isArray(data.codes)) {
        db.run('DELETE FROM product_codes WHERE product_id = ?', [id]);
        for (const c of data.codes) {
          const code = U.str(c.code, 80);
          if (!code) continue;
          db.insert('product_codes', { id: uuid(), product_id: id, code, kind: ['oem', 'alt', 'supplier', 'barcode'].includes(c.kind) ? c.kind : 'alt', note: U.str(c.note, 200) });
        }
      }
      if (Array.isArray(data.fitments)) {
        db.run('DELETE FROM product_fitments WHERE product_id = ?', [id]);
        for (const f of data.fitments) {
          let makeId = f.make_id || null;
          let modelId = f.model_id || null;
          if (!makeId && f.make_name) makeId = app.vehicles.ensureMake(f.make_name);
          if (!modelId && f.model_name && makeId) modelId = app.vehicles.ensureModel(makeId, f.model_name);
          if (modelId && !makeId) makeId = db.val('SELECT make_id FROM vehicle_models WHERE id = ?', [modelId]);
          if (!makeId && !modelId) continue;
          db.insert('product_fitments', {
            id: uuid(), product_id: id, make_id: makeId, model_id: modelId,
            year_from: f.year_from ? Math.round(U.num(f.year_from)) : null, year_to: f.year_to ? Math.round(U.num(f.year_to)) : null,
            engine: U.str(f.engine, 60), note: U.str(f.note, 200),
          });
        }
      }
      if (data.photo_remove) {
        const old = db.val('SELECT photo_id FROM products WHERE id = ?', [id]);
        db.run('UPDATE products SET photo_id = NULL WHERE id = ?', [id]);
        app.files.remove(old);
      } else if (data.photo && String(data.photo).startsWith('data:')) {
        const old = db.val('SELECT photo_id FROM products WHERE id = ?', [id]);
        const fid = app.files.saveDataUrl(data.photo, `product-${id}`);
        db.run('UPDATE products SET photo_id = ? WHERE id = ?', [fid, id]);
        app.files.remove(old);
      }
      rebuildSearch(id);
      // opening stock for a new product (creates a stock adjustment document)
      if (!before && data.opening_stock && U.num(data.opening_stock.qty) !== 0 && fields.track_stock) {
        const os = data.opening_stock;
        const fxv = app.fx(currency);
        const unitCostUsd = os.unit_cost != null && os.unit_cost !== '' ? U.num(os.unit_cost) / fxv.rate : (fields.cost_price || 0) / fxv.rate;
        app.docs.save({
          type: 'adjust', date: U.today(), warehouse_id: os.warehouse_id || app.stock.defaultWarehouseId(), currency: 'USD', reason: 'opening',
          lines: [{ product_id: id, qty: U.num(os.qty), unit_cost_usd: unitCostUsd }], post: true,
        }, ctx, { skipPerm: true });
      }
      app.audit(ctx, before ? 'update' : 'create', 'product', id, name, before ? diff(before, fields) : undefined);
      return id;
    });
  }

  function diff(before, after) {
    const out = {};
    for (const k of Object.keys(after)) {
      if (k === 'updated_at') continue;
      if ((before[k] ?? null) !== (after[k] ?? null)) out[k] = [before[k] ?? null, after[k] ?? null];
    }
    return out;
  }

  function remove(id, ctx) {
    const p = db.get('SELECT * FROM products WHERE id = ?', [id]);
    U.assert(p, 'not_found', 'Product not found', 404);
    const used = db.val('SELECT COUNT(*) FROM doc_lines WHERE product_id = ?', [id]) + db.val('SELECT COUNT(*) FROM stock_moves WHERE product_id = ?', [id]);
    return db.tx(() => {
      if (used) {
        db.update('products', id, { active: 0, updated_at: U.nowIso() });
        app.audit(ctx, 'deactivate', 'product', id, p.name);
        return { deactivated: true };
      }
      db.run('DELETE FROM product_prices WHERE product_id = ?', [id]);
      db.run('DELETE FROM product_codes WHERE product_id = ?', [id]);
      db.run('DELETE FROM product_fitments WHERE product_id = ?', [id]);
      db.run('DELETE FROM stock_levels WHERE product_id = ?', [id]);
      db.run('DELETE FROM products WHERE id = ?', [id]);
      app.files.remove(p.photo_id);
      app.audit(ctx, 'delete', 'product', id, p.name, p);
      return { deleted: true };
    });
  }

  /** exact lookup used by barcode scanners */
  function byCode(code) {
    const c = String(code || '').trim();
    if (!c) return null;
    let p = db.get('SELECT id FROM products WHERE barcode = ? AND active = 1', [c])
      || db.get('SELECT p.id FROM product_codes pc JOIN products p ON p.id = pc.product_id WHERE pc.code = ? AND p.active = 1', [c])
      || db.get('SELECT id FROM products WHERE code = ? AND active = 1', [c]);
    if (!p && /^\d+$/.test(c) && c.length > 1) p = db.get('SELECT id FROM products WHERE barcode = ? AND active = 1', [c.replace(/^0+/, '')]);
    return p ? p.id : null;
  }

  /** compact info used by the POS / document editors */
  function forSale(ids, { price_list_id, warehouse_id } = {}) {
    if (!ids.length) return [];
    const rows = db.all(`SELECT p.id, p.code, p.barcode, p.name, p.name2, p.type, p.unit, p.currency, p.price_rate, p.cost_price, p.avg_cost_usd, p.track_stock,
        p.warranty_months, p.photo_id, p.min_stock, b.name AS brand_name
      FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids);
    const prices = db.all(`SELECT product_id, price_list_id, price FROM product_prices WHERE product_id IN (${ids.map(() => '?').join(',')})`, ids);
    const pmap = {};
    for (const pr of prices) (pmap[pr.product_id] = pmap[pr.product_id] || {})[pr.price_list_id] = pr.price;
    const plDefault = price_list_id || defaultPriceListId();
    for (const r of rows) {
      r.prices = pmap[r.id] || {};
      r.price = r.prices[plDefault] ?? r.prices[defaultPriceListId()] ?? 0;
      r.stock = app.stock.qtyOf(r.id, warehouse_id || null);
      r.stock_total = app.stock.qtyOf(r.id);
      r.cost_usd = r.avg_cost_usd || app.stock.standardCostUsd(r);
    }
    return rows;
  }

  /**
   * Bulk price update.
   * opts: { filter (same as list), price_list_id, mode: 'percent' | 'set_margin' | 'copy_list', value, from_list_id, round_to }
   *  - percent:    new = old * (1 + value/100)
   *  - set_margin: new = cost (avg cost converted to product currency) * (1 + value/100)
   *  - copy_list:  new = price in from_list_id * (1 + value/100)
   */
  function bulkPrice(opts, ctx) {
    const plId = opts.price_list_id;
    U.assert(db.get('SELECT 1 FROM price_lists WHERE id = ?', [plId]), 'price_list_required', 'Choose a price list');
    const f = Object.assign({}, opts.filter || {}, { limit: 100000 });
    const { rows } = list(f);
    const roundTo = U.num(opts.round_to);
    const pct = U.num(opts.value);
    let changed = 0;
    db.tx(() => {
      for (const r of rows) {
        let base;
        if (opts.mode === 'percent') base = db.val('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?', [r.id, plId]);
        else if (opts.mode === 'copy_list') base = db.val('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?', [r.id, opts.from_list_id]);
        else if (opts.mode === 'set_margin') {
          const costUsd = r.avg_cost_usd || app.stock.standardCostUsd(r);
          base = costUsd ? costUsd * app.rateOf(r.currency) : null;
        }
        if (base == null || !(base > 0)) continue;
        let np = base * (1 + pct / 100);
        if (roundTo > 0) np = Math.round(np / roundTo) * roundTo;
        else np = app.money(np, r.currency);
        db.run('INSERT INTO product_prices (product_id, price_list_id, price) VALUES (?, ?, ?) ON CONFLICT(product_id, price_list_id) DO UPDATE SET price = excluded.price', [r.id, plId, np]);
        changed++;
      }
      app.audit(ctx, 'bulk_price', 'product', null, { k: 'products_n', v: { n: changed } }, opts);
    });
    return { changed };
  }

  /**
   * Import rows from a spreadsheet (already parsed to objects by the UI).
   * Known keys: code, barcode, name, name2, category, brand, unit, currency, cost_price, min_stock, shelf, color, size, oem_no,
   *             stock (opening qty), price_<price_list_id or code>
   * mode: 'create' (skip existing) | 'upsert' (match by code/barcode and update)
   */
  function importRows(rows, mode, ctx) {
    const lists = priceLists();
    const result = { created: 0, updated: 0, skipped: 0, errors: [] };
    db.tx(() => {
      rows.forEach((r, i) => {
        try {
          const name = U.str(r.name, 250);
          if (!name) { result.skipped++; return; }
          let existing = null;
          if (r.barcode) existing = db.get('SELECT id FROM products WHERE barcode = ?', [String(r.barcode).trim()]);
          if (!existing && r.code) existing = db.get('SELECT id FROM products WHERE code = ? AND name = ?', [String(r.code).trim(), name]);
          if (existing && mode !== 'upsert') { result.skipped++; return; }
          const prices = {};
          for (const pl of lists) {
            const v = r[`price_${pl.id}`] ?? r[`price_${pl.code}`] ?? (pl.is_default ? r.price : undefined);
            if (v !== undefined && v !== '') prices[pl.id] = U.num(v);
          }
          const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
          let data;
          if (existing) {
            // update: start from the product as it is and change only the columns the sheet fills in
            const cur = db.get('SELECT * FROM products WHERE id = ?', [existing.id]);
            data = {
              id: cur.id, name, code: cur.code, barcode: cur.barcode, name2: cur.name2, type: cur.type, category_id: cur.category_id, brand_id: cur.brand_id,
              unit: cur.unit, currency: cur.currency, min_stock: cur.min_stock, max_stock: cur.max_stock, shelf: cur.shelf, color: cur.color, size: cur.size,
              oem_no: cur.oem_no, warranty_months: cur.warranty_months, notes: cur.notes, track_stock: cur.track_stock, active: cur.active, prices,
            };
            for (const k of ['code', 'barcode', 'name2', 'unit', 'currency', 'min_stock', 'shelf', 'color', 'size', 'oem_no']) if (given(r[k])) data[k] = r[k];
            if (given(r.cost_price)) data.cost_price = r.cost_price;
            if (given(r.price_rate)) data.price_rate = r.price_rate;
            if (given(r.category)) { data.category_id = null; data.category_name = r.category; }
            if (given(r.brand)) { data.brand_id = null; data.brand_name = r.brand; }
          } else {
            data = {
              name, code: r.code, barcode: r.barcode, name2: r.name2, category_name: r.category, brand_name: r.brand, unit: r.unit || undefined,
              currency: r.currency || undefined, cost_price: r.cost_price, min_stock: r.min_stock, shelf: r.shelf, color: r.color, size: r.size, oem_no: r.oem_no, prices,
              price_rate: given(r.price_rate) ? r.price_rate : undefined,
            };
          }
          if (!existing && U.num(r.stock)) data.opening_stock = { qty: U.num(r.stock), unit_cost: r.cost_price };
          save(data, ctx, { skipPerm: false });
          existing ? result.updated++ : result.created++;
        } catch (e) {
          result.errors.push({ row: i + 1, error: e.message });
        }
      });
    });
    return result;
  }

  /* ------------------------------------------------------------------ simple lookups */
  function categories() { return db.all('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count FROM categories c ORDER BY c.sort, c.name'); }
  function brands() { return db.all('SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.active = 1) AS product_count FROM brands b ORDER BY b.name'); }

  function saveCategory(d, ctx) {
    const name = U.str(d.name, 80);
    U.assert(name, 'name_required', 'Name is required');
    if (d.id) db.update('categories', d.id, { name, parent_id: d.parent_id || null, active: d.active === false ? 0 : 1 });
    else d.id = ensureCategory(name);
    app.audit(ctx, 'save', 'category', d.id, name);
    db.all('SELECT id FROM products WHERE category_id = ?', [d.id]).forEach((p) => rebuildSearch(p.id));
    return d.id;
  }
  function deleteCategory(id, ctx) {
    db.tx(() => {
      db.run('UPDATE products SET category_id = NULL WHERE category_id = ?', [id]);
      db.run('DELETE FROM categories WHERE id = ?', [id]);
      app.audit(ctx, 'delete', 'category', id);
    });
  }
  function saveBrand(d, ctx) {
    const name = U.str(d.name, 80);
    U.assert(name, 'name_required', 'Name is required');
    if (d.id) {
      const dup = db.get('SELECT id FROM brands WHERE lower(name) = lower(?) AND id <> ?', [name, d.id]);
      U.assert(!dup, 'duplicate', 'A brand with this name exists');
      db.update('brands', d.id, { name, active: d.active === false ? 0 : 1 });
    } else d.id = ensureBrand(name);
    app.audit(ctx, 'save', 'brand', d.id, name);
    db.all('SELECT id FROM products WHERE brand_id = ?', [d.id]).forEach((p) => rebuildSearch(p.id));
    return d.id;
  }
  function deleteBrand(id, ctx) {
    db.tx(() => {
      db.run('UPDATE products SET brand_id = NULL WHERE brand_id = ?', [id]);
      db.run('DELETE FROM brands WHERE id = ?', [id]);
      app.audit(ctx, 'delete', 'brand', id);
    });
  }
  function savePriceList(d, ctx) {
    const name = U.str(d.name, 80);
    U.assert(name, 'name_required', 'Name is required');
    return db.tx(() => {
      let id = d.id;
      if (id) db.update('price_lists', id, { name, active: d.active === false ? 0 : 1, sort: d.sort != null ? U.num(d.sort) : undefined });
      else {
        id = uuid();
        db.insert('price_lists', { id, code: null, name, sort: (db.val('SELECT MAX(sort) FROM price_lists') || 0) + 1, active: 1, is_default: 0 });
      }
      if (d.is_default) {
        db.run('UPDATE price_lists SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
      }
      app.audit(ctx, 'save', 'price_list', id, name);
      return id;
    });
  }

  return {
    list, get, save, remove, byCode, forSale, bulkPrice, importRows, rebuildSearch, parseQuery,
    priceLists, defaultPriceListId, categories, brands, saveCategory, deleteCategory, saveBrand, deleteBrand, savePriceList,
    ensureBrand, ensureCategory,
  };
};
