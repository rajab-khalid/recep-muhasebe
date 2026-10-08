'use strict';
/* Stock counts (sayım): snapshot expected quantities, enter counted quantities, post the differences as an adjustment. */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function create(d, ctx) {
    const warehouseId = d.warehouse_id || app.stock.defaultWarehouseId();
    const date = U.isDate(d.date) ? d.date : U.today();
    return db.tx(() => {
      const id = uuid();
      const no = app.nextNo('stock_count', date, 'stock_counts');
      db.insert('stock_counts', {
        id, no, date, warehouse_id: warehouseId, status: 'draft', scope: d.scope ? JSON.stringify(d.scope) : null,
        note: U.str(d.note, 500), created_by: ctx.user && ctx.user.id, created_at: U.nowIso(),
      });
      // pre-fill with products of the scope (all stock-tracked products, or a category/brand)
      const where = ['p.active = 1', 'p.track_stock = 1'];
      const params = [];
      const s = d.scope || {};
      if (s.category_id) { where.push('p.category_id = ?'); params.push(s.category_id); }
      if (s.brand_id) { where.push('p.brand_id = ?'); params.push(s.brand_id); }
      if (s.only_in_stock) where.push('(SELECT COALESCE(SUM(qty),0) FROM stock_levels l WHERE l.product_id = p.id AND l.warehouse_id = ?) <> 0');
      if (s.only_in_stock) params.push(warehouseId);
      if (!s.empty) {
        const prods = db.all(`SELECT p.id FROM products p WHERE ${where.join(' AND ')} ORDER BY p.name`, params);
        for (const p of prods) {
          db.insert('stock_count_lines', { id: uuid(), count_id: id, product_id: p.id, expected: app.stock.qtyOf(p.id, warehouseId), counted: null });
        }
      }
      app.audit(ctx, 'create', 'stock_count', id, no);
      return { id, no };
    });
  }

  function get(id) {
    const c = db.get(`SELECT c.*, w.name AS warehouse_name, u.full_name AS user_name, d.no AS adjust_no FROM stock_counts c
      LEFT JOIN warehouses w ON w.id = c.warehouse_id LEFT JOIN users u ON u.id = c.created_by LEFT JOIN docs d ON d.id = c.adjust_doc_id WHERE c.id = ?`, [id]);
    U.assert(c, 'not_found', 'Count not found', 404);
    c.lines = db.all(`SELECT l.*, p.name, p.code, p.barcode, p.unit, p.shelf, p.avg_cost_usd, p.cost_price, p.currency
      FROM stock_count_lines l JOIN products p ON p.id = l.product_id WHERE l.count_id = ? ORDER BY p.shelf, p.name`, [id]);
    if (c.status === 'draft') {
      for (const l of c.lines) l.current = app.stock.qtyOf(l.product_id, c.warehouse_id);
    }
    return c;
  }

  function list() {
    return db.all(`SELECT c.*, w.name AS warehouse_name, u.full_name AS user_name,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS line_count,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL) AS counted_count,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL AND ABS(l.counted - l.expected) > 0.0001) AS diff_count
      FROM stock_counts c LEFT JOIN warehouses w ON w.id = c.warehouse_id LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC LIMIT 200`);
  }

  /** lines: [{product_id, counted}] (null counted = not counted yet). Adding an unknown product adds a line. */
  function setLines(id, lines, ctx) {
    const c = db.get('SELECT * FROM stock_counts WHERE id = ?', [id]);
    U.assert(c && c.status === 'draft', 'not_draft', 'This count is already posted');
    db.tx(() => {
      for (const l of lines || []) {
        const ex = db.get('SELECT id FROM stock_count_lines WHERE count_id = ? AND product_id = ?', [id, l.product_id]);
        const counted = l.counted === '' || l.counted == null ? null : U.num(l.counted);
        if (ex) db.update('stock_count_lines', ex.id, { counted, note: l.note !== undefined ? U.str(l.note, 200) : undefined });
        else {
          U.assert(db.get('SELECT 1 FROM products WHERE id = ?', [l.product_id]), 'product_not_found', 'Product not found');
          db.insert('stock_count_lines', { id: uuid(), count_id: id, product_id: l.product_id, expected: app.stock.qtyOf(l.product_id, c.warehouse_id), counted, note: U.str(l.note, 200) });
        }
      }
    });
    return get(id);
  }

  /**
   * Post the count. Uncounted lines are ignored (unless zero_uncounted). The correction is dated on the count day and
   * measured against the stock at the end of that day: sales made during a same-day count are respected, and a count
   * posted days later does not undo the sales made after it.
   */
  function post(id, { zero_uncounted } = {}, ctx) {
    const c = get(id);
    U.assert(c.status === 'draft', 'not_draft', 'This count is already posted');
    return db.tx(() => {
      const adj = [];
      for (const l of c.lines) {
        let counted = l.counted;
        if (counted == null) { if (!zero_uncounted) continue; counted = 0; }
        const cur = c.date < U.today() ? app.stock.qtyAsOf(l.product_id, c.warehouse_id, c.date) : app.stock.qtyOf(l.product_id, c.warehouse_id);
        const diff = U.round(counted - cur, 4);
        if (Math.abs(diff) > 0.00001) adj.push({ product_id: l.product_id, qty: diff });
      }
      let docId = null;
      if (adj.length) {
        const r = app.docs.save({ type: 'adjust', date: c.date, warehouse_id: c.warehouse_id, reason: 'count', notes: `${c.no}`, currency: 'USD', lines: adj, post: true }, ctx, { skipPerm: true });
        docId = r.id;
      }
      db.update('stock_counts', id, { status: 'posted', adjust_doc_id: docId, posted_by: ctx.user && ctx.user.id, posted_at: U.nowIso() });
      app.audit(ctx, 'post', 'stock_count', id, { k: 'count_post', v: { no: c.no, n: adj.length } });
      return { adjusted: adj.length, doc_id: docId };
    });
  }

  function remove(id, ctx) {
    const c = db.get('SELECT * FROM stock_counts WHERE id = ?', [id]);
    U.assert(c && c.status === 'draft', 'not_draft', 'Only draft counts can be deleted');
    db.tx(() => {
      db.run('DELETE FROM stock_count_lines WHERE count_id = ?', [id]);
      db.run('DELETE FROM stock_counts WHERE id = ?', [id]);
      app.audit(ctx, 'delete', 'stock_count', id, c.no);
    });
  }

  return { create, get, list, setLines, post, remove };
};
