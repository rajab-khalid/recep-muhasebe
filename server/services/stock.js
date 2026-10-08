'use strict';
/*
 * Stock ledger + perpetual weighted-average costing.
 *
 * Stock is never stored as "a number on the product": every change is a row in stock_moves and the
 * current quantity is their sum (a trigger keeps stock_levels in sync for fast reads).
 *
 * Costing: avg cost per product in USD. recalc(productId) replays the product's moves in date order,
 * so back-dated purchases, edits and cancellations always end with consistent costs, and every sale
 * line keeps the cost that was valid at its own date (stored on the line and the move).
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function defaultWarehouseId() {
    const w = db.get('SELECT id FROM warehouses WHERE active = 1 ORDER BY is_default DESC, sort, name LIMIT 1');
    U.assert(w, 'no_warehouse', 'No warehouse defined');
    return w.id;
  }

  function addMove(m) {
    const row = {
      id: uuid(), seq: app.nextSeq(), date: m.date, product_id: m.product_id, warehouse_id: m.warehouse_id,
      qty: U.round(m.qty, 4), unit_cost_usd: U.round(m.unit_cost_usd || 0, 6), cost_fixed: m.cost_fixed ? 1 : 0,
      kind: m.kind, doc_id: m.doc_id || null, line_id: m.line_id || null, rev: m.rev || 1, voided: 0,
      note: m.note || null, user_id: m.user_id || null, created_at: U.nowIso(),
    };
    db.insert('stock_moves', row);
    return row;
  }

  /** void all live moves of a document; returns affected product ids */
  function voidDoc(docId) {
    const prods = db.all('SELECT DISTINCT product_id FROM stock_moves WHERE doc_id = ? AND voided = 0', [docId]).map((r) => r.product_id);
    db.run('UPDATE stock_moves SET voided = 1 WHERE doc_id = ? AND voided = 0', [docId]);
    return prods;
  }

  function qtyOf(productId, warehouseId) {
    if (warehouseId) return db.val('SELECT qty FROM stock_levels WHERE product_id = ? AND warehouse_id = ?', [productId, warehouseId]) || 0;
    return db.val('SELECT SUM(qty) FROM stock_levels WHERE product_id = ?', [productId]) || 0;
  }

  /** quantity at the end of a given day (moves dated on or before it) */
  function qtyAsOf(productId, warehouseId, date) {
    const params = [productId, date];
    if (warehouseId) params.push(warehouseId);
    return db.val(`SELECT COALESCE(SUM(qty), 0) FROM stock_moves WHERE product_id = ? AND voided = 0 AND date <= ?${warehouseId ? ' AND warehouse_id = ?' : ''}`, params) || 0;
  }

  function levels(productId) {
    return db.all(`SELECT w.id AS warehouse_id, w.name, COALESCE(l.qty, 0) AS qty
      FROM warehouses w LEFT JOIN stock_levels l ON l.warehouse_id = w.id AND l.product_id = ?
      WHERE w.active = 1 OR COALESCE(l.qty, 0) <> 0 ORDER BY w.is_default DESC, w.sort, w.name`, [productId]);
  }

  /** fallback cost (USD) for a product that was never purchased in the system */
  function standardCostUsd(p) {
    if (!p || !p.cost_price) return 0;
    try { return p.cost_price / app.rateOf(p.currency); } catch (e) { return 0; }
  }

  /**
   * Replay all live moves of a product and fix average cost, outgoing move costs, sale-line costs,
   * and the cost totals of the affected documents.
   */
  function recalc(productId) {
    const p = db.get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!p) return;
    const moves = db.all(`SELECT m.*, l.ref_line_id AS ref_line_id FROM stock_moves m LEFT JOIN doc_lines l ON l.id = m.line_id
      WHERE m.product_id = ? AND m.voided = 0 ORDER BY m.date, m.seq`, [productId]);
    let qty = 0;
    let avg = 0;
    const fallback = standardCostUsd(p);
    const lineCost = new Map(); // line_id -> unit cost (for returns referencing a sale line)
    const touchedDocs = new Set();
    const updMove = db.stmt('UPDATE stock_moves SET unit_cost_usd = ? WHERE id = ?');
    const updLine = db.stmt('UPDATE doc_lines SET unit_cost_usd = ? WHERE id = ?');
    for (const m of moves) {
      let unit;
      if (m.qty > 0) {
        if (m.cost_fixed) unit = m.unit_cost_usd;
        else if (m.kind === 'sale_return' && m.ref_line_id) {
          unit = lineCost.has(m.ref_line_id) ? lineCost.get(m.ref_line_id)
            : (db.val('SELECT unit_cost_usd FROM doc_lines WHERE id = ?', [m.ref_line_id]) ?? (avg || fallback));
        } else unit = avg || fallback;
        if (qty <= 0.0000001) avg = unit;
        else avg = (qty * avg + m.qty * unit) / (qty + m.qty);
      } else if (m.cost_fixed && m.unit_cost_usd != null) {
        // goods sent back to the supplier leave at the credited price; the rest keeps the remaining value
        unit = m.unit_cost_usd;
        const left = qty + m.qty;
        if (left > 0.0000001) avg = Math.max(0, (qty * avg + m.qty * unit) / left);
      } else {
        unit = avg || fallback;
      }
      unit = U.round(unit, 6);
      if (Math.abs((m.unit_cost_usd || 0) - unit) > 1e-7) {
        updMove.run(unit, m.id);
        if (m.line_id && m.qty < 0) { updLine.run(unit, m.line_id); }
        if (m.doc_id) touchedDocs.add(m.doc_id);
      }
      if (m.line_id) {
        lineCost.set(m.line_id, unit);
        if (m.kind === 'sale_return' && m.qty > 0) {
          const cur = db.val('SELECT unit_cost_usd FROM doc_lines WHERE id = ?', [m.line_id]);
          if (cur == null || Math.abs(cur - unit) > 1e-7) { updLine.run(unit, m.line_id); if (m.doc_id) touchedDocs.add(m.doc_id); }
        }
      }
      qty += m.qty;
    }
    db.run('UPDATE products SET avg_cost_usd = ? WHERE id = ?', [U.round(avg, 6), productId]);
    for (const docId of touchedDocs) refreshDocCost(docId);
  }

  /** docs.cost_usd = sum of product line costs (sales, returns) */
  function refreshDocCost(docId) {
    const d = db.get('SELECT id, type FROM docs WHERE id = ?', [docId]);
    if (!d || !['sale', 'sale_return'].includes(d.type)) return;
    const c = db.val(`SELECT SUM(qty * COALESCE(unit_cost_usd, 0)) FROM doc_lines WHERE doc_id = ? AND kind IN ('product', 'service')`, [docId]) || 0;
    db.run('UPDATE docs SET cost_usd = ? WHERE id = ?', [U.round(c, 6), docId]);
  }

  /** current unit cost (USD) used for a new outgoing move */
  function currentCost(productId) {
    const p = db.get('SELECT avg_cost_usd, cost_price, currency FROM products WHERE id = ?', [productId]);
    if (!p) return 0;
    return p.avg_cost_usd || standardCostUsd(p);
  }

  function movesOf(productId, { from, to, warehouse_id, limit = 500 } = {}) {
    const where = ['m.product_id = ?', 'm.voided = 0'];
    const params = [productId];
    if (from) { where.push('m.date >= ?'); params.push(from); }
    if (to) { where.push('m.date <= ?'); params.push(to); }
    if (warehouse_id) { where.push('m.warehouse_id = ?'); params.push(warehouse_id); }
    const rows = db.all(`SELECT m.id, m.date, m.qty, m.unit_cost_usd, m.kind, m.doc_id, m.note, m.warehouse_id, w.name AS warehouse_name,
        d.no AS doc_no, d.type AS doc_type, d.partner_name, p2.name AS partner
      FROM stock_moves m
      LEFT JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN docs d ON d.id = m.doc_id
      LEFT JOIN partners p2 ON p2.id = d.partner_id
      WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.seq DESC LIMIT ?`, [...params, limit]);
    // running balance (computed newest -> oldest from the current level)
    let bal = warehouse_id ? qtyOf(productId, warehouse_id) : qtyOf(productId);
    if (to) {
      const after = db.val(`SELECT SUM(qty) FROM stock_moves WHERE product_id = ? AND voided = 0 AND date > ? ${warehouse_id ? 'AND warehouse_id = ?' : ''}`,
        warehouse_id ? [productId, to, warehouse_id] : [productId, to]) || 0;
      bal -= after;
    }
    for (const r of rows) { r.balance = U.round(bal, 4); bal -= r.qty; }
    return rows;
  }

  return { defaultWarehouseId, addMove, voidDoc, qtyOf, qtyAsOf, levels, recalc, refreshDocCost, currentCost, standardCostUsd, movesOf };
};
