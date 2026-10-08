'use strict';
/*
 * Reports. Amounts are computed in USD (base) and can be shown in IQD using each row's own historical
 * USD/IQD rate (mode 'IQD'), so old documents keep the dinar values they had.
 */
module.exports = (app) => {
  const { db, U } = app;

  const conv = (mode, usdExpr, rateExpr) => (mode === 'IQD' ? `(${usdExpr}) * (${rateExpr})` : `(${usdExpr})`);
  const R = (v, mode) => U.round(v || 0, mode === 'IQD' ? 0 : 2);
  function range(f) {
    const to = U.isDate(f.to) ? f.to : U.today();
    const from = U.isDate(f.from) ? f.from : `${to.slice(0, 7)}-01`;
    return { from, to };
  }

  // revenue share of a line inside its document (doc-level discount spread proportionally)
  const LINE_SHARE = `(CASE WHEN ls.s > 0 THEN l.line_total * d.total / ls.s ELSE l.line_total END)`;
  const LINES_SUM_JOIN = `JOIN (SELECT doc_id, SUM(line_total) AS s FROM doc_lines WHERE kind <> 'text' GROUP BY doc_id) ls ON ls.doc_id = d.id`;

  /* ---------------------------------------------------------------- sales */
  function salesSummary(f = {}) {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const group = f.group || 'day';
    const key = group === 'month' ? "substr(d.date, 1, 7)" : group === 'week' ? "strftime('%Y-W%W', d.date)" : 'd.date';
    const where = ["d.status = 'posted'", "d.type IN ('sale', 'sale_return')", 'd.date >= ?', 'd.date <= ?'];
    const params = [from, to];
    if (f.staff_id) { where.push('d.staff_id = ?'); params.push(f.staff_id); }
    if (f.channel) { where.push('d.channel = ?'); params.push(f.channel); }
    const rows = db.all(`SELECT ${key} AS period,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN d.type = 'sale_return' THEN 1 ELSE 0 END) AS return_count,
        SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, 'd.total_usd', 'd.usd_iqd')} ELSE 0 END) AS gross,
        SUM(CASE WHEN d.type = 'sale_return' THEN ${conv(mode, 'd.total_usd', 'd.usd_iqd')} ELSE 0 END) AS returns,
        SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, '(d.discount + d.line_discount) / d.rate', 'd.usd_iqd')} ELSE 0 END) AS discount,
        SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, 'd.cost_usd', 'd.usd_iqd')} ELSE -${conv(mode, 'd.cost_usd', 'd.usd_iqd')} END) AS cost
      FROM docs d WHERE ${where.join(' AND ')} GROUP BY period ORDER BY period`, params);
    const tot = { count: 0, return_count: 0, gross: 0, returns: 0, discount: 0, cost: 0, net: 0, profit: 0 };
    for (const r of rows) {
      r.net = r.gross - r.returns;
      r.profit = r.net - r.cost;
      r.margin = r.net ? U.round(r.profit / r.net * 100, 1) : 0;
      r.avg = r.count ? r.gross / r.count : 0;
      for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
      for (const k of ['gross', 'returns', 'discount', 'cost', 'net', 'profit', 'avg']) r[k] = R(r[k], mode);
    }
    for (const k of Object.keys(tot)) tot[k] = k.includes('count') ? tot[k] : R(tot[k], mode);
    tot.margin = tot.net ? U.round(tot.profit / tot.net * 100, 1) : 0;
    const byCurrency = db.all(`SELECT d.currency, COUNT(*) AS count, SUM(d.total) AS total FROM docs d WHERE d.status = 'posted' AND d.type = 'sale' AND d.date >= ? AND d.date <= ? GROUP BY d.currency`, [from, to]);
    return { from, to, mode, group, rows, totals: tot, by_currency: byCurrency };
  }

  function lineAgg(f, groupExpr, nameExpr, extraJoin = '') {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const where = ["d.status = 'posted'", "d.type IN ('sale', 'sale_return')", 'd.date >= ?', 'd.date <= ?', "l.kind <> 'text'"];
    const params = [from, to];
    if (f.category_id) { where.push('p.category_id = ?'); params.push(f.category_id); }
    if (f.brand_id) { where.push('p.brand_id = ?'); params.push(f.brand_id); }
    if (f.partner_id) { where.push('d.partner_id = ?'); params.push(f.partner_id); }
    if (f.staff_id) { where.push('d.staff_id = ?'); params.push(f.staff_id); }
    if (f.kind) { where.push('l.kind = ?'); params.push(f.kind); }
    const sign = "(CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END)";
    const rows = db.all(`SELECT ${groupExpr} AS key, ${nameExpr} AS name,
        SUM(${sign} * l.qty) AS qty,
        SUM(${sign} * ${conv(mode, `${LINE_SHARE} / d.rate`, 'd.usd_iqd')}) AS revenue,
        SUM(${sign} * ${conv(mode, 'l.qty * COALESCE(l.unit_cost_usd, 0)', 'd.usd_iqd')}) AS cost,
        COUNT(DISTINCT CASE WHEN d.type = 'sale' THEN d.id END) AS doc_count
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id ${LINES_SUM_JOIN}
      LEFT JOIN products p ON p.id = l.product_id ${extraJoin}
      WHERE ${where.join(' AND ')} GROUP BY key ORDER BY revenue DESC`, params);
    const tot = { qty: 0, revenue: 0, cost: 0, profit: 0 };
    for (const r of rows) {
      r.profit = r.revenue - r.cost;
      r.margin = r.revenue ? U.round(r.profit / r.revenue * 100, 1) : 0;
      tot.qty += r.qty; tot.revenue += r.revenue; tot.cost += r.cost; tot.profit += r.profit;
      for (const k of ['revenue', 'cost', 'profit']) r[k] = R(r[k], mode);
      r.qty = U.round(r.qty, 3);
    }
    tot.margin = tot.revenue ? U.round(tot.profit / tot.revenue * 100, 1) : 0;
    for (const k of ['revenue', 'cost', 'profit']) tot[k] = R(tot[k], mode);
    return { from, to, mode, rows, totals: tot };
  }

  const salesByProduct = (f = {}) => lineAgg(f, "COALESCE(l.product_id, 'labor:' || COALESCE(l.description, ''))", "COALESCE(p.name, l.description)");
  const salesByCategory = (f = {}) => lineAgg(f, "COALESCE(p.category_id, '-')", 'COALESCE(c.name, NULL)', 'LEFT JOIN categories c ON c.id = p.category_id');
  const salesByBrand = (f = {}) => lineAgg(f, "COALESCE(p.brand_id, '-')", 'COALESCE(b.name, NULL)', 'LEFT JOIN brands b ON b.id = p.brand_id');
  const salesByKind = (f = {}) => lineAgg(f, 'l.kind', 'l.kind');

  function salesByCustomer(f = {}) {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const rows = db.all(`SELECT d.partner_id AS key, COALESCE(p.name, d.partner_name) AS name, p.phone,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE 0 END) AS doc_count,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END * ${conv(mode, 'd.total_usd', 'd.usd_iqd')}) AS revenue,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END * ${conv(mode, 'd.cost_usd', 'd.usd_iqd')}) AS cost,
        MAX(d.date) AS last_date
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.status = 'posted' AND d.type IN ('sale', 'sale_return') AND d.date >= ? AND d.date <= ?
      GROUP BY d.partner_id ORDER BY revenue DESC`, [from, to]);
    const tot = { revenue: 0, cost: 0, profit: 0, doc_count: 0 };
    for (const r of rows) {
      r.profit = r.revenue - r.cost;
      r.margin = r.revenue ? U.round(r.profit / r.revenue * 100, 1) : 0;
      r.balances = r.key ? app.partners.balances(r.key) : {};
      tot.revenue += r.revenue; tot.cost += r.cost; tot.profit += r.profit; tot.doc_count += r.doc_count;
      for (const k of ['revenue', 'cost', 'profit']) r[k] = R(r[k], mode);
    }
    for (const k of ['revenue', 'cost', 'profit']) tot[k] = R(tot[k], mode);
    return { from, to, mode, rows, totals: tot };
  }

  /** staff sales + commission (sales % on revenue or profit, labour % on labour lines they did) */
  function staffPerformance(f = {}) {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const basis = app.getSetting('general').commission_basis === 'revenue' ? 'revenue' : 'profit';
    const users = db.all('SELECT id, full_name, commission_sales_pct, commission_labor_pct, active FROM users ORDER BY full_name');
    const sales = db.all(`SELECT d.staff_id AS uid, COUNT(*) AS doc_count,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END * ${conv(mode, 'd.total_usd', 'd.usd_iqd')}) AS revenue,
        SUM(CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END * ${conv(mode, 'd.cost_usd', 'd.usd_iqd')}) AS cost
      FROM docs d WHERE d.status = 'posted' AND d.type IN ('sale', 'sale_return') AND d.date >= ? AND d.date <= ? GROUP BY d.staff_id`, [from, to]);
    const labor = db.all(`SELECT COALESCE(l.staff_id, d.technician_id) AS uid, SUM(${conv(mode, `${LINE_SHARE} / d.rate`, 'd.usd_iqd')}) AS labor, COUNT(*) AS jobs
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id ${LINES_SUM_JOIN}
      WHERE d.status = 'posted' AND d.type = 'sale' AND l.kind = 'labor' AND d.date >= ? AND d.date <= ? GROUP BY uid`, [from, to]);
    const smap = Object.fromEntries(sales.map((s) => [s.uid, s]));
    const lmap = Object.fromEntries(labor.map((s) => [s.uid, s]));
    const rows = users.map((u) => {
      const s = smap[u.id] || { doc_count: 0, revenue: 0, cost: 0 };
      const l = lmap[u.id] || { labor: 0, jobs: 0 };
      const profit = s.revenue - s.cost;
      const commission = ((basis === 'profit' ? profit : s.revenue) * (u.commission_sales_pct || 0) / 100) + (l.labor * (u.commission_labor_pct || 0) / 100);
      return {
        user_id: u.id, name: u.full_name, active: !!u.active, doc_count: s.doc_count, revenue: R(s.revenue, mode), profit: R(profit, mode),
        labor: R(l.labor, mode), jobs: l.jobs, sales_pct: u.commission_sales_pct, labor_pct: u.commission_labor_pct, commission: R(commission, mode),
      };
    }).filter((r) => r.doc_count || r.labor || r.active);
    return { from, to, mode, basis, rows };
  }

  /** money received / paid in the period by account, method and currency */
  function payments(f = {}) {
    const { from, to } = range(f);
    const rows = db.all(`SELECT p.direction, p.method, a.name AS account_name, p.currency, COUNT(*) AS count, SUM(p.amount) AS amount, SUM(p.amount_usd) AS amount_usd
      FROM payments p JOIN money_accounts a ON a.id = p.account_id
      WHERE p.status = 'posted' AND p.date >= ? AND p.date <= ? AND COALESCE(p.purpose, '') <> 'change'
      GROUP BY p.direction, p.method, a.id ORDER BY p.direction, amount_usd DESC`, [from, to]);
    return { from, to, rows };
  }

  /* ---------------------------------------------------------------- stock */
  function stockCurrent(f = {}) {
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const rate = mode === 'IQD' ? app.usdIqd() : 1;
    const where = ['p.active = 1', 'p.track_stock = 1'];
    const params = [];
    if (f.category_id) { where.push('p.category_id = ?'); params.push(f.category_id); }
    if (f.brand_id) { where.push('p.brand_id = ?'); params.push(f.brand_id); }
    const qtyExpr = f.warehouse_id ? '(SELECT COALESCE(SUM(qty),0) FROM stock_levels s WHERE s.product_id = p.id AND s.warehouse_id = ?)' : '(SELECT COALESCE(SUM(qty),0) FROM stock_levels s WHERE s.product_id = p.id)';
    const qParams = f.warehouse_id ? [f.warehouse_id] : [];
    const pl = app.products.defaultPriceListId();
    const rows = db.all(`SELECT p.id, p.code, p.barcode, p.name, p.unit, p.shelf, p.currency, p.min_stock, c.name AS category_name, b.name AS brand_name,
        ${qtyExpr} AS qty, p.avg_cost_usd, p.cost_price,
        (SELECT price FROM product_prices pp WHERE pp.product_id = p.id AND pp.price_list_id = ?) AS price
      FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
      WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE`, [...qParams, pl, ...params]);
    const tot = { qty: 0, value: 0, retail_value: 0, products: 0 };
    const low = app.getSetting('stock').low_stock_default || 0;
    const out = [];
    for (const r of rows) {
      if (f.only_in_stock && !(r.qty > 0)) continue;
      const unit = r.avg_cost_usd || app.stock.standardCostUsd(r);
      r.unit_cost = R(unit * rate, mode === 'IQD' ? 'IQD' : 'USD4');
      r.value = R(Math.max(r.qty, 0) * unit * rate, mode);
      r.retail_value = r.price != null ? R(Math.max(r.qty, 0) * app.convert(r.price, r.currency, 'USD') * rate, mode) : null;
      r.state = r.qty <= 0 ? 'critical' : r.qty <= (r.min_stock > 0 ? r.min_stock : low) ? 'low' : 'ok';
      tot.qty += r.qty; tot.value += r.value; tot.retail_value += r.retail_value || 0; tot.products++;
      out.push(r);
    }
    tot.value = R(tot.value, mode); tot.retail_value = R(tot.retail_value, mode);
    return { mode, rows: out, totals: tot };
  }

  function stockValueBy(f = {}) {
    const { rows, totals, mode } = stockCurrent(f);
    const by = f.by === 'brand' ? 'brand_name' : 'category_name';
    const m = {};
    for (const r of rows) {
      const k = r[by] || '—';
      m[k] = m[k] || { name: r[by] || null, products: 0, qty: 0, value: 0, retail_value: 0 };
      m[k].products++; m[k].qty += Math.max(r.qty, 0); m[k].value += r.value; m[k].retail_value += r.retail_value || 0;
    }
    return { mode, rows: Object.values(m).sort((a, b) => b.value - a.value).map((r) => ({ ...r, value: R(r.value, mode), retail_value: R(r.retail_value, mode) })), totals };
  }

  /** products at or below their minimum, with a suggested order quantity based on recent sales */
  function purchaseSuggestions(f = {}) {
    const days = Math.max(7, Number(f.days) || 30);
    const cover = Math.max(7, Number(f.cover_days) || 30);
    const since = U.addDays(U.today(), -days);
    const low = app.getSetting('stock').low_stock_default || 0;
    const rows = db.all(`SELECT p.id, p.code, p.name, p.unit, p.min_stock, p.max_stock, p.currency, p.cost_price, p.avg_cost_usd,
        p.last_supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
        (SELECT COALESCE(SUM(qty),0) FROM stock_levels l WHERE l.product_id = p.id) AS qty,
        (SELECT COALESCE(-SUM(m.qty),0) FROM stock_moves m WHERE m.product_id = p.id AND m.voided = 0 AND m.kind = 'sale' AND m.date >= ?) AS sold,
        (SELECT COALESCE(SUM(l.qty - COALESCE(l.received_qty, 0)), 0) FROM doc_lines l JOIN docs d ON d.id = l.doc_id
          WHERE l.product_id = p.id AND d.type = 'purchase_order' AND d.status IN ('open', 'sent')) AS on_order
      FROM products p LEFT JOIN partners s ON s.id = p.last_supplier_id
      WHERE p.active = 1 AND p.track_stock = 1 ${f.supplier_id ? 'AND p.last_supplier_id = ?' : ''}`, f.supplier_id ? [since, f.supplier_id] : [since]);
    const out = [];
    for (const r of rows) {
      const minLevel = r.min_stock > 0 ? r.min_stock : low;
      const daily = r.sold / days;
      const target = Math.max(r.max_stock || 0, minLevel * 2, Math.ceil(daily * cover));
      const available = r.qty + r.on_order;
      if (!(r.qty <= minLevel || (daily > 0 && r.qty < daily * 7))) continue;
      const suggested = Math.max(0, Math.ceil(target - available));
      if (suggested <= 0 && r.qty > 0) continue;
      out.push({ ...r, min_level: minLevel, daily: U.round(daily, 2), days_left: daily > 0 ? Math.floor(Math.max(r.qty, 0) / daily) : null, suggested, state: r.qty <= 0 ? 'critical' : 'low' });
    }
    out.sort((a, b) => (a.state === b.state ? (a.days_left ?? 9999) - (b.days_left ?? 9999) : a.state === 'critical' ? -1 : 1));
    return { days, cover_days: cover, rows: out };
  }

  function bestSellers(f = {}) {
    const r = salesByProduct({ ...f, kind: 'product' });
    const by = f.by === 'qty' ? 'qty' : 'revenue';
    r.rows.sort((a, b) => b[by] - a[by]);
    r.rows = r.rows.slice(0, Number(f.limit) || 50);
    return r;
  }

  /** products in stock with no sale for N days (or never sold) */
  function deadStock(f = {}) {
    const days = Math.max(1, Number(f.days) || app.getSetting('stock').dead_stock_days || 90);
    const since = U.addDays(U.today(), -days);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const rate = mode === 'IQD' ? app.usdIqd() : 1;
    const rows = db.all(`SELECT p.id, p.code, p.name, p.unit, p.currency, p.cost_price, p.avg_cost_usd, p.last_sale_date, p.created_at,
        (SELECT COALESCE(SUM(qty),0) FROM stock_levels l WHERE l.product_id = p.id) AS qty
      FROM products p WHERE p.active = 1 AND p.track_stock = 1 AND (p.last_sale_date IS NULL OR p.last_sale_date < ?)`, [since]);
    const out = rows.filter((r) => r.qty > 0).map((r) => ({
      ...r, value: R(r.qty * (r.avg_cost_usd || app.stock.standardCostUsd(r)) * rate, mode),
      idle_days: r.last_sale_date ? U.daysBetween(r.last_sale_date, U.today()) : null,
    })).sort((a, b) => b.value - a.value);
    return { days, mode, rows: out, total: R(out.reduce((s, r) => s + r.value, 0), mode) };
  }

  function stockMoves(f = {}) {
    const { from, to } = range(f);
    const where = ['m.voided = 0', 'm.date >= ?', 'm.date <= ?'];
    const params = [from, to];
    if (f.kind) { where.push('m.kind = ?'); params.push(f.kind); }
    if (f.product_id) { where.push('m.product_id = ?'); params.push(f.product_id); }
    if (f.warehouse_id) { where.push('m.warehouse_id = ?'); params.push(f.warehouse_id); }
    const rows = db.all(`SELECT m.date, m.qty, m.unit_cost_usd, m.kind, m.note, p.name AS product_name, p.code, w.name AS warehouse_name,
        d.id AS doc_id, d.no AS doc_no, d.type AS doc_type, d.reason
      FROM stock_moves m JOIN products p ON p.id = m.product_id LEFT JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN docs d ON d.id = m.doc_id
      WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.seq DESC LIMIT 5000`, params);
    return { from, to, rows };
  }

  /* ---------------------------------------------------------------- money */
  function cashReport(f = {}) {
    const { from, to } = range(f);
    const accs = app.cash.accounts({ include_inactive: true });
    const rows = [];
    for (const a of accs) {
      const opening = app.cash.balance(a.id, { before: from });
      const mv = db.get(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS tin, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS tout
        FROM money_moves WHERE account_id = ? AND voided = 0 AND date >= ? AND date <= ?`, [a.id, from, to]);
      const closing = app.cash.balance(a.id, { to });
      if (!a.active && !opening && !closing && !mv.tin && !mv.tout) continue;
      const byKind = db.all(`SELECT kind, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS tin, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS tout, COUNT(*) AS n
        FROM money_moves WHERE account_id = ? AND voided = 0 AND date >= ? AND date <= ? GROUP BY kind ORDER BY kind`, [a.id, from, to]);
      rows.push({ id: a.id, name: a.name, type: a.type, currency: a.currency, opening, total_in: app.money(mv.tin, a.currency), total_out: app.money(mv.tout, a.currency), closing, by_kind: byKind });
    }
    return { from, to, rows };
  }

  /** day-end (Z) report */
  function dayEnd(f = {}) {
    const date = U.isDate(f.date) ? f.date : U.today();
    const sales = db.all(`SELECT d.currency, d.channel, COUNT(*) AS count, SUM(d.total) AS total, SUM(d.paid) AS paid, SUM(d.total_usd) AS total_usd, SUM(d.cost_usd) AS cost_usd,
        SUM(d.discount + d.line_discount) AS discount
      FROM docs d WHERE d.type = 'sale' AND d.status = 'posted' AND d.date = ? GROUP BY d.currency, d.channel`, [date]);
    const returns = db.all(`SELECT d.currency, COUNT(*) AS count, SUM(d.total) AS total FROM docs d WHERE d.type = 'sale_return' AND d.status = 'posted' AND d.date = ? GROUP BY d.currency`, [date]);
    const cancelled = db.all(`SELECT d.no, d.total, d.currency, d.cancel_reason, u.full_name AS user_name FROM docs d LEFT JOIN users u ON u.id = d.cancelled_by
      WHERE d.type IN ('sale', 'sale_return') AND d.status = 'cancelled' AND substr(d.cancelled_at, 1, 10) = ?`, [date]);
    const money = db.all(`SELECT a.name AS account_name, a.currency, m.kind, SUM(CASE WHEN m.amount > 0 THEN m.amount ELSE 0 END) AS tin,
        SUM(CASE WHEN m.amount < 0 THEN -m.amount ELSE 0 END) AS tout, COUNT(*) AS n
      FROM money_moves m JOIN money_accounts a ON a.id = m.account_id WHERE m.voided = 0 AND m.date = ? GROUP BY a.id, m.kind ORDER BY a.sort, m.kind`, [date]);
    const accounts = app.cash.accounts().map((a) => ({ name: a.name, type: a.type, currency: a.currency, opening: app.cash.balance(a.id, { before: date }), closing: app.cash.balance(a.id, { to: date }) }));
    const byUser = db.all(`SELECT u.full_name AS name, d.currency, COUNT(*) AS count, SUM(d.total) AS total FROM docs d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.type = 'sale' AND d.status = 'posted' AND d.date = ? GROUP BY d.created_by, d.currency`, [date]);
    const expenses = db.all(`SELECT c.name AS category_name, e.currency, SUM(e.amount) AS amount, COUNT(*) AS n FROM finance_entries e LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.status = 'posted' AND e.date = ? GROUP BY e.kind, e.category_id, e.currency`, [date]);
    const credit = db.all(`SELECT d.no, COALESCE(p.name, d.partner_name) AS partner_name, d.currency, d.total - d.paid AS open FROM docs d LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.type = 'sale' AND d.status = 'posted' AND d.date = ? AND d.payment_status <> 'paid'`, [date]);
    return { date, sales, returns, cancelled, money, accounts, by_user: byUser, expenses, credit_sales: credit };
  }

  /** receivables / payables with ageing of open invoices */
  function balances(f = {}) {
    const kind = f.kind === 'payable' ? 'payable' : 'receivable';
    // everyone who owes us / whom we owe, whatever their kind: a customer who paid in advance is a payable too
    const partners = app.partners.list({ balance: kind === 'receivable' ? 'debtors' : 'creditors', limit: 10000 });
    const today = U.today();
    const docTypes = kind === 'receivable' ? ['sale', 'purchase_return'] : ['purchase', 'sale_return'];
    const rows = partners.map((p) => {
      const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
      const docs = db.all(`SELECT date, due_date, currency, total - paid AS open FROM docs WHERE partner_id = ? AND status = 'posted' AND type IN (${docTypes.map(() => '?').join(',')})
        AND payment_status <> 'paid'`, [p.id, ...docTypes]);
      let oldest = null;
      for (const d of docs) {
        const ref = d.due_date || d.date;
        const age = U.daysBetween(ref, today);
        const usd = d.open / app.rateOf(d.currency);
        const k = age <= 0 ? 'current' : age <= 30 ? 'd30' : age <= 60 ? 'd60' : age <= 90 ? 'd90' : 'd90p';
        buckets[k] += usd;
        if (!oldest || ref < oldest) oldest = ref;
      }
      for (const k of Object.keys(buckets)) buckets[k] = U.round(buckets[k], 2);
      const filtered = {};
      for (const [c, v] of Object.entries(p.balances)) if ((kind === 'receivable' && v > 0) || (kind === 'payable' && v < 0)) filtered[c] = Math.abs(v);
      return { id: p.id, name: p.name, phone: p.phone, balances: filtered, balance_usd: U.round(Math.abs(p.balance_usd), 2), buckets, oldest, overdue: p.overdue, last_move: p.last_move };
    }).sort((a, b) => b.balance_usd - a.balance_usd);
    const totals = {};
    for (const r of rows) for (const [c, v] of Object.entries(r.balances)) totals[c] = (totals[c] || 0) + v;
    return { kind, rows, totals };
  }

  function incomeExpense(f = {}) {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const rows = db.all(`SELECT e.kind, c.id AS category_id, c.name AS category_name, c.code, c.in_pl, COUNT(*) AS count, SUM(${conv(mode, 'e.amount_usd', 'e.usd_iqd')}) AS amount
      FROM finance_entries e LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.status = 'posted' AND e.date >= ? AND e.date <= ? GROUP BY e.kind, c.id ORDER BY e.kind, amount DESC`, [from, to]);
    for (const r of rows) r.amount = R(r.amount, mode);
    return { from, to, mode, rows };
  }

  /** profit & loss */
  function profitLoss(f = {}) {
    const { from, to } = range(f);
    const mode = f.mode === 'IQD' ? 'IQD' : 'USD';
    const s = db.get(`SELECT
        COALESCE(SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, 'd.total_usd', 'd.usd_iqd')} END), 0) AS sales,
        COALESCE(SUM(CASE WHEN d.type = 'sale_return' THEN ${conv(mode, 'd.total_usd', 'd.usd_iqd')} END), 0) AS returns,
        COALESCE(SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, 'd.cost_usd', 'd.usd_iqd')} END), 0) AS cogs,
        COALESCE(SUM(CASE WHEN d.type = 'sale_return' THEN ${conv(mode, 'd.cost_usd', 'd.usd_iqd')} END), 0) AS cogs_returned,
        COALESCE(SUM(CASE WHEN d.type = 'sale' THEN ${conv(mode, '(d.discount + d.line_discount) / d.rate', 'd.usd_iqd')} END), 0) AS discounts,
        COUNT(CASE WHEN d.type = 'sale' THEN 1 END) AS sale_count
      FROM docs d WHERE d.status = 'posted' AND d.type IN ('sale', 'sale_return') AND d.date >= ? AND d.date <= ?`, [from, to]);
    const kinds = db.all(`SELECT l.kind, SUM((CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END) * ${conv(mode, `${LINE_SHARE} / d.rate`, 'd.usd_iqd')}) AS revenue
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id ${LINES_SUM_JOIN}
      WHERE d.status = 'posted' AND d.type IN ('sale', 'sale_return') AND d.date >= ? AND d.date <= ? AND l.kind <> 'text' GROUP BY l.kind`, [from, to]);
    const revByKind = Object.fromEntries(kinds.map((k) => [k.kind, R(k.revenue, mode)]));
    const rateNow = app.usdIqd();
    const adj = db.get(`SELECT COALESCE(SUM(m.qty * m.unit_cost_usd), 0) AS v FROM stock_moves m
      WHERE m.voided = 0 AND m.kind IN ('adjust', 'count') AND m.date >= ? AND m.date <= ?`, [from, to]);
    const fin = db.all(`SELECT e.kind, c.name AS category_name, c.code, SUM(${conv(mode, 'e.amount_usd', 'e.usd_iqd')}) AS amount
      FROM finance_entries e LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.status = 'posted' AND COALESCE(c.in_pl, 1) = 1 AND e.date >= ? AND e.date <= ? GROUP BY e.kind, c.id ORDER BY amount DESC`, [from, to]);
    const other = db.all(`SELECT kind, SUM(${conv(mode, 'amount_usd', 'usd_iqd')}) AS amount FROM money_moves
      WHERE voided = 0 AND kind IN ('count_diff', 'fee') AND date >= ? AND date <= ? GROUP BY kind`, [from, to]);
    const sales = s.sales - s.returns;
    const cogs = s.cogs - s.cogs_returned;
    const gross = sales - cogs;
    const expenses = fin.filter((x) => x.kind === 'expense');
    const incomes = fin.filter((x) => x.kind === 'income');
    const opex = expenses.reduce((a, x) => a + x.amount, 0);
    const otherIncome = incomes.reduce((a, x) => a + x.amount, 0);
    const stockAdj = (adj.v || 0) * (mode === 'IQD' ? rateNow : 1);
    const countDiff = other.reduce((a, x) => a + x.amount, 0);
    const net = gross - opex + otherIncome + stockAdj + countDiff;
    return {
      from, to, mode,
      sales: R(s.sales, mode), returns: R(s.returns, mode), net_sales: R(sales, mode), discounts: R(s.discounts, mode), sale_count: s.sale_count,
      revenue_by_kind: revByKind, cogs: R(cogs, mode), gross_profit: R(gross, mode), gross_margin: sales ? U.round(gross / sales * 100, 1) : 0,
      expenses: expenses.map((x) => ({ ...x, amount: R(x.amount, mode) })), opex: R(opex, mode),
      incomes: incomes.map((x) => ({ ...x, amount: R(x.amount, mode) })), other_income: R(otherIncome, mode),
      stock_adjustments: R(stockAdj, mode), cash_differences: R(countDiff, mode),
      net_profit: R(net, mode), net_margin: sales ? U.round(net / sales * 100, 1) : 0,
    };
  }

  function profitTrend(f = {}) {
    const months = Math.min(24, Math.max(3, Number(f.months) || 12));
    const out = [];
    const t = U.today();
    for (let i = months - 1; i >= 0; i--) {
      const first = U.addMonths(`${t.slice(0, 7)}-01`, -i);
      const last = U.addDays(U.addMonths(first, 1), -1);
      const pl = profitLoss({ from: first, to: last, mode: f.mode });
      out.push({ month: first.slice(0, 7), net_sales: pl.net_sales, gross_profit: pl.gross_profit, opex: pl.opex, net_profit: pl.net_profit });
    }
    return { mode: f.mode === 'IQD' ? 'IQD' : 'USD', rows: out };
  }

  function rateHistory(f = {}) {
    return db.all(`SELECT h.*, u.full_name AS user_name FROM rate_history h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.currency = ? ORDER BY h.ts DESC LIMIT 500`, [f.currency || 'IQD']);
  }

  function audit(f = {}) {
    const where = [];
    const params = [];
    if (f.from) { where.push('a.ts >= ?'); params.push(`${f.from}T00:00:00`); }
    if (f.to) { where.push('a.ts <= ?'); params.push(`${f.to}T23:59:59.999`); }
    if (f.user_id) { where.push('a.user_id = ?'); params.push(f.user_id); }
    if (f.entity) { where.push('a.entity = ?'); params.push(f.entity); }
    if (f.entity_id) { where.push('a.entity_id = ?'); params.push(f.entity_id); }
    if (f.action) { where.push('a.action = ?'); params.push(f.action); }
    if (f.q) { where.push("(a.summary LIKE ? OR a.user_name LIKE ?)"); params.push(`%${f.q}%`, `%${f.q}%`); }
    return db.all(`SELECT a.id, a.ts, a.user_id, a.user_name, a.action, a.entity, a.entity_id, a.summary, a.msg, a.ip,
        CASE WHEN a.data IS NOT NULL THEN 1 ELSE 0 END AS has_data
      FROM audit_log a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.ts DESC LIMIT ?`, [...params, Math.min(Number(f.limit) || 500, 5000)]);
  }
  function auditEntry(id) {
    const r = db.get('SELECT * FROM audit_log WHERE id = ?', [id]);
    U.assert(r, 'not_found', 'Not found', 404);
    r.data = U.parseJson(r.data, r.data);
    return r;
  }

  /* ---------------------------------------------------------------- dashboard */
  function dashboard(user) {
    const today = U.today();
    const monthStart = `${today.slice(0, 7)}-01`;
    const canProfit = app.users.can(user, 'dashboard.profit');
    const daySales = db.all(`SELECT currency, COUNT(*) AS count, SUM(total) AS total, SUM(total_usd) AS total_usd, SUM(cost_usd) AS cost_usd
      FROM docs WHERE type = 'sale' AND status = 'posted' AND date = ? GROUP BY currency`, [today]);
    const dayReturns = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total_usd), 0) AS total_usd, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM docs WHERE type = 'sale_return' AND status = 'posted' AND date = ?`, [today]);
    const dayPurch = db.all(`SELECT currency, COUNT(*) AS count, SUM(total) AS total, SUM(total_usd) AS total_usd FROM docs
      WHERE type = 'purchase' AND status = 'posted' AND date = ? GROUP BY currency`, [today]);
    const collections = db.all(`SELECT a.currency, SUM(p.amount) AS amount FROM payments p JOIN money_accounts a ON a.id = p.account_id
      WHERE p.status = 'posted' AND p.direction = 'in' AND p.date = ? AND COALESCE(p.purpose, '') <> 'change' GROUP BY a.currency`, [today]);
    const pl = canProfit ? profitLoss({ from: monthStart, to: today }) : null;
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(U.addDays(today, -i));
    const series = db.all(`SELECT date, SUM(CASE WHEN type = 'sale' THEN total_usd ELSE -total_usd END) AS sales_usd,
        SUM(CASE WHEN type = 'sale' THEN total_usd - cost_usd ELSE -(total_usd - cost_usd) END) AS profit_usd, SUM(CASE WHEN type = 'sale' THEN 1 ELSE 0 END) AS count
      FROM docs WHERE type IN ('sale', 'sale_return') AND status = 'posted' AND date >= ? GROUP BY date`, [days[0]]);
    const smap = Object.fromEntries(series.map((r) => [r.date, r]));
    const chart = days.map((d) => ({ date: d, sales_usd: U.round((smap[d] || {}).sales_usd || 0, 2), profit_usd: canProfit ? U.round((smap[d] || {}).profit_usd || 0, 2) : null, count: (smap[d] || {}).count || 0 }));
    const usdIqdNow = app.usdIqd();
    const low = app.getSetting('stock').low_stock_default || 0;
    const stockStates = db.get(`SELECT
        SUM(CASE WHEN q <= 0 THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN q > 0 AND q <= lvl THEN 1 ELSE 0 END) AS low
      FROM (SELECT (SELECT COALESCE(SUM(qty), 0) FROM stock_levels l WHERE l.product_id = p.id) AS q, CASE WHEN p.min_stock > 0 THEN p.min_stock ELSE ? END AS lvl
        FROM products p WHERE p.active = 1 AND p.track_stock = 1)`, [low]);
    const criticalList = app.products.list({ stock: 'low', sort: 'stock_asc', limit: 8 }).rows.map((r) => ({ id: r.id, name: r.name, code: r.code, stock: r.stock, min: r.low_level, state: r.stock_state }));
    const openService = db.all(`SELECT d.id, d.no, d.date, d.status, COALESCE(p.name, d.partner_name) AS partner_name, COALESCE(v.plate, d.vehicle_plate) AS plate, d.vehicle_desc, t.full_name AS technician_name
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN users t ON t.id = d.technician_id
      WHERE d.type = 'service' AND d.status IN ('open', 'in_progress', 'waiting_parts', 'done') ORDER BY d.date LIMIT 10`);
    const quotes = db.val("SELECT COUNT(*) FROM docs WHERE type = 'quote' AND status IN ('open', 'accepted')");
    const overdue = db.all(`SELECT d.id, d.no, d.due_date, d.currency, d.total - d.paid AS open, COALESCE(p.name, d.partner_name) AS partner_name, p.phone
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.type = 'sale' AND d.status = 'posted' AND d.payment_status <> 'paid' AND d.due_date IS NOT NULL AND d.due_date < ? ORDER BY d.due_date LIMIT 8`, [today]);
    const recent = db.all(`SELECT d.id, d.type, d.no, d.date, d.currency, d.total, d.payment_status, d.status, COALESCE(p.name, d.partner_name) AS partner_name, d.created_at
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id WHERE d.type IN ('sale', 'purchase', 'sale_return', 'purchase_return') ORDER BY d.created_at DESC LIMIT 8`);
    const top = canProfit || app.users.can(user, 'reports.sales') ? bestSellers({ from: monthStart, to: today, limit: 6, by: 'revenue' }).rows : [];
    const pending = app.finance.recurringPending().length;
    const totals = app.partners.totals();
    const cash = app.users.can(user, 'cash.view') || app.users.can(user, 'bank.view') ? app.cash.accounts() : [];
    const monthSales = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN type = 'sale' THEN total_usd ELSE -total_usd END), 0) AS total_usd
      FROM docs WHERE type IN ('sale', 'sale_return') AND status = 'posted' AND date >= ? AND date <= ?`, [monthStart, today]);
    // reference values for the gauges: average day of the last 30 days, last month to the same day
    const d30 = U.addDays(today, -30);
    const avg30 = (db.val(`SELECT SUM(CASE WHEN type = 'sale' THEN total_usd ELSE -total_usd END) FROM docs WHERE type IN ('sale', 'sale_return') AND status = 'posted' AND date >= ? AND date < ?`, [d30, today]) || 0) / 30;
    const lmStart = U.addMonths(monthStart, -1);
    const lmSameDay = U.addMonths(today, -1);
    const lastMonthSame = db.val(`SELECT SUM(CASE WHEN type = 'sale' THEN total_usd ELSE -total_usd END) FROM docs WHERE type IN ('sale', 'sale_return') AND status = 'posted' AND date >= ? AND date <= ?`, [lmStart, lmSameDay]) || 0;
    const lastMonthTotal = db.val(`SELECT SUM(CASE WHEN type = 'sale' THEN total_usd ELSE -total_usd END) FROM docs WHERE type IN ('sale', 'sale_return') AND status = 'posted' AND date >= ? AND date < ?`, [lmStart, monthStart]) || 0;
    return {
      date: today, usd_iqd: app.usdIqd(),
      today: {
        // costs only for people who may see profit
        sales: canProfit ? daySales : daySales.map(({ cost_usd, ...r }) => r), sales_usd: U.round(daySales.reduce((s, r) => s + r.total_usd, 0) - dayReturns.total_usd, 2),
        sales_count: daySales.reduce((s, r) => s + r.count, 0), returns: canProfit ? dayReturns : { count: dayReturns.count, total_usd: dayReturns.total_usd },
        profit_usd: canProfit ? U.round(daySales.reduce((s, r) => s + r.total_usd - r.cost_usd, 0) - (dayReturns.total_usd - dayReturns.cost_usd), 2) : null,
        purchases: dayPurch, collections,
      },
      month: { sales_usd: U.round(monthSales.total_usd, 2), count: monthSales.count, pl, last_month_same_usd: U.round(lastMonthSame, 2), last_month_usd: U.round(lastMonthTotal, 2) },
      avg_daily_usd: U.round(avg30, 2),
      chart, cash: cash.map((a) => ({ id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance })),
      receivable: app.users.can(user, 'partners.balance') ? totals.receivable : null, payable: app.users.can(user, 'partners.balance') ? totals.payable : null,
      receivable_count: totals.receivable_count, payable_count: totals.payable_count,
      stock: { critical: stockStates.critical || 0, low: stockStates.low || 0, list: criticalList },
      service: openService, quotes_open: quotes, overdue, recent, recurring_pending: pending,
      top_products: canProfit ? top : top.map(({ cost_usd, profit_usd, margin, ...r }) => r),
    };
  }

  /** notification centre */
  function notifications(user) {
    const today = U.today();
    const list = [];
    if (app.users.can(user, 'stock.view')) {
      const low = app.products.list({ stock: 'low', limit: 50, sort: 'stock_asc' }).rows;
      for (const p of low) list.push({ key: `stock:${p.id}:${p.stock}`, kind: p.stock <= 0 ? 'stock_out' : 'stock_low', level: p.stock <= 0 ? 'danger' : 'warn', ref: p.id, name: p.name, value: p.stock });
    }
    if (app.users.can(user, 'partners.balance')) {
      const od = db.all(`SELECT d.id, d.no, d.due_date, COALESCE(p.name, d.partner_name) AS partner_name FROM docs d LEFT JOIN partners p ON p.id = d.partner_id
        WHERE d.type IN ('sale', 'purchase') AND d.status = 'posted' AND d.payment_status <> 'paid' AND d.due_date IS NOT NULL AND d.due_date < ? ORDER BY d.due_date LIMIT 30`, [today]);
      for (const d of od) list.push({ key: `overdue:${d.id}`, kind: 'overdue', level: 'danger', ref: d.id, name: `${d.partner_name} — ${d.no}`, value: U.daysBetween(d.due_date, today) });
    }
    if (app.users.can(user, 'finance.manage')) {
      for (const r of app.finance.recurringPending()) list.push({ key: `rec:${r.id}:${today.slice(0, 7)}`, kind: 'recurring', level: 'warn', ref: r.id, name: r.description || r.category_name, value: r.amount, currency: r.currency });
    }
    if (app.users.can(user, 'service.view')) {
      const svc = db.all("SELECT id, no, date, status FROM docs WHERE type = 'service' AND status = 'done' ORDER BY date LIMIT 20");
      for (const s of svc) list.push({ key: `svc:${s.id}`, kind: 'service_done', level: 'info', ref: s.id, name: s.no });
    }
    if (app.users.can(user, 'backup.manage')) {
      const b = app.getSetting('backup');
      if (!b.last_at || U.daysBetween(U.today(new Date(b.last_at)), today) > 7) list.push({ key: `backup:${today}`, kind: 'backup_old', level: 'warn', value: b.last_at });
    }
    const read = new Set(db.all('SELECT key FROM notifications_read WHERE user_id = ?', [user.id]).map((r) => r.key));
    for (const n of list) n.read = read.has(n.key);
    return list;
  }

  function markRead(user, keys) {
    const now = U.nowIso();
    db.tx(() => { for (const k of keys || []) db.run('INSERT OR IGNORE INTO notifications_read (user_id, key, ts) VALUES (?, ?, ?)', [user.id, k, now]); });
  }

  return {
    salesSummary, salesByProduct, salesByCategory, salesByBrand, salesByKind, salesByCustomer, staffPerformance, payments,
    stockCurrent, stockValueBy, purchaseSuggestions, bestSellers, deadStock, stockMoves,
    cashReport, dayEnd, balances, incomeExpense, profitLoss, profitTrend, rateHistory, audit, auditEntry,
    dashboard, notifications, markRead,
  };
};
