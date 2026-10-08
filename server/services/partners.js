'use strict';
/*
 * Partners (cari hesaplar): customers and suppliers share one table.
 * Balances are kept PER CURRENCY in partner_moves (+ = they owe us, - = we owe them).
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function addMove(m) {
    const fx = m.rate ? { rate: m.rate, usd_iqd: m.usd_iqd || app.usdIqd() } : app.fx(m.currency, m.usd_iqd);
    const amount = app.money(m.amount, m.currency);
    const row = {
      id: uuid(), seq: app.nextSeq(), date: m.date, partner_id: m.partner_id, currency: m.currency,
      amount, rate: fx.rate, usd_iqd: fx.usd_iqd, amount_usd: U.round(amount / fx.rate, 6),
      kind: m.kind, doc_id: m.doc_id || null, payment_id: m.payment_id || null, entry_id: m.entry_id || null,
      description: m.description || null, due_date: m.due_date || null, rev: m.rev || 1, voided: 0,
      user_id: m.user_id || null, created_at: U.nowIso(),
    };
    if (Math.abs(amount) < 1e-9) return null;
    db.insert('partner_moves', row);
    return row;
  }

  function voidBy(col, id) {
    db.run(`UPDATE partner_moves SET voided = 1 WHERE ${col} = ? AND voided = 0`, [id]);
  }

  /** { IQD: 12000, USD: -50 } */
  function balances(partnerId, { to } = {}) {
    const rows = db.all(`SELECT currency, SUM(amount) AS bal FROM partner_moves WHERE partner_id = ? AND voided = 0 ${to ? 'AND date <= ?' : ''} GROUP BY currency`,
      to ? [partnerId, to] : [partnerId]);
    const out = {};
    for (const r of rows) {
      const v = app.money(r.bal, r.currency);
      if (Math.abs(v) > 0) out[r.currency] = v;
    }
    return out;
  }

  function balanceUsd(bals, fxRates) {
    let s = 0;
    for (const [c, v] of Object.entries(bals)) s += v / (fxRates && fxRates[c] ? fxRates[c] : app.rateOf(c));
    return s;
  }

  function list(f = {}) {
    const where = [];
    const params = [];
    if (f.kind === 'customer') where.push("p.kind IN ('customer', 'both')");
    else if (f.kind === 'supplier') where.push("p.kind IN ('supplier', 'both')");
    if (f.active === 'all') { /* */ } else if (f.active === '0') where.push('p.active = 0'); else where.push('p.active = 1');
    if (f.q) {
      for (const t of U.searchTerms(f.q)) { where.push('(p.search LIKE ? OR p.phone LIKE ?)'); params.push(`%${t}%`, `%${t}%`); }
    }
    if (f.walkin === false) where.push('p.is_walkin = 0');
    const rows = db.all(`SELECT p.id, p.no, p.kind, p.name, p.company, p.phone, p.phone2, p.city, p.price_list_id, p.is_walkin, p.active,
        p.due_date, p.credit_limit, p.credit_currency, p.payment_days, p.created_at
      FROM partners p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.is_walkin DESC, p.name COLLATE NOCASE LIMIT ?`,
      [...params, Math.min(Number(f.limit) || 1000, 10000)]);
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const bals = db.all(`SELECT partner_id, currency, SUM(amount) AS bal FROM partner_moves WHERE voided = 0 AND partner_id IN (${ids.map(() => '?').join(',')}) GROUP BY partner_id, currency`, ids);
      const map = {};
      for (const b of bals) {
        const v = app.money(b.bal, b.currency);
        if (Math.abs(v) > 0) (map[b.partner_id] = map[b.partner_id] || {})[b.currency] = v;
      }
      const last = db.all(`SELECT partner_id, MAX(date) AS d FROM partner_moves WHERE voided = 0 AND partner_id IN (${ids.map(() => '?').join(',')}) GROUP BY partner_id`, ids);
      const lmap = Object.fromEntries(last.map((r) => [r.partner_id, r.d]));
      const today = U.today();
      const overdue = db.all(`SELECT partner_id, COUNT(*) AS n FROM docs WHERE status = 'posted' AND type IN ('sale', 'purchase') AND payment_status <> 'paid'
        AND due_date IS NOT NULL AND due_date < ? AND partner_id IN (${ids.map(() => '?').join(',')}) GROUP BY partner_id`, [today, ...ids]);
      const omap = Object.fromEntries(overdue.map((r) => [r.partner_id, r.n]));
      for (const r of rows) {
        r.balances = map[r.id] || {};
        r.balance_usd = U.round(balanceUsd(r.balances), 2);
        r.last_move = lmap[r.id] || null;
        r.overdue_docs = omap[r.id] || 0;
        r.overdue = !!(r.overdue_docs || (r.due_date && r.due_date < today && Object.keys(r.balances).length));
      }
    }
    let out = rows;
    if (f.balance === 'debtors') out = rows.filter((r) => Object.values(r.balances).some((v) => v > 0));
    else if (f.balance === 'creditors') out = rows.filter((r) => Object.values(r.balances).some((v) => v < 0));
    else if (f.balance === 'nonzero') out = rows.filter((r) => Object.keys(r.balances).length);
    else if (f.balance === 'overdue') out = rows.filter((r) => r.overdue);
    return out;
  }

  function get(id) {
    const p = db.get(`SELECT p.*, pl.name AS price_list_name FROM partners p LEFT JOIN price_lists pl ON pl.id = p.price_list_id WHERE p.id = ?`, [id]);
    U.assert(p, 'not_found', 'Account not found', 404);
    delete p.search;
    p.balances = balances(id);
    p.balance_usd = U.round(balanceUsd(p.balances), 2);
    p.vehicles = db.all(`SELECT v.*, mk.name AS make_name, md.name AS model_name FROM vehicles v
      LEFT JOIN vehicle_makes mk ON mk.id = v.make_id LEFT JOIN vehicle_models md ON md.id = v.model_id
      WHERE v.partner_id = ? AND v.active = 1 ORDER BY v.updated_at DESC`, [id]);
    for (const v of p.vehicles) v.description = app.vehicles.describe(v);
    p.stats = db.get(`SELECT
        (SELECT COUNT(*) FROM docs WHERE partner_id = ? AND type = 'sale' AND status = 'posted') AS sale_count,
        (SELECT SUM(total_usd) FROM docs WHERE partner_id = ? AND type = 'sale' AND status = 'posted') AS sale_usd,
        (SELECT COUNT(*) FROM docs WHERE partner_id = ? AND type = 'purchase' AND status = 'posted') AS purchase_count,
        (SELECT SUM(total_usd) FROM docs WHERE partner_id = ? AND type = 'purchase' AND status = 'posted') AS purchase_usd,
        (SELECT MAX(date) FROM docs WHERE partner_id = ? AND type = 'sale' AND status = 'posted') AS last_sale,
        (SELECT MAX(date) FROM payments WHERE partner_id = ? AND status = 'posted') AS last_payment`, [id, id, id, id, id, id]);
    p.open_docs = openDocs(id);
    return p;
  }

  function nextNo() { return (db.val('SELECT MAX(no) FROM partners') || 0) + 1; }

  function save(d, ctx) {
    const name = U.str(d.name, 200);
    U.assert(name, 'name_required', 'Name is required');
    const kind = ['customer', 'supplier', 'both'].includes(d.kind) ? d.kind : 'customer';
    return db.tx(() => {
      const now = U.nowIso();
      const fields = {
        kind, name, company: U.str(d.company, 200), phone: U.str(d.phone, 40), phone2: U.str(d.phone2, 40),
        email: U.str(d.email, 120), address: U.str(d.address, 500), city: U.str(d.city, 80), tax_no: U.str(d.tax_no, 40),
        price_list_id: d.price_list_id || null,
        credit_limit: d.credit_limit === '' || d.credit_limit == null ? null : U.num(d.credit_limit),
        credit_currency: d.credit_currency || null,
        payment_days: d.payment_days === '' || d.payment_days == null ? null : Math.round(U.num(d.payment_days)),
        due_date: U.isDate(d.due_date) ? d.due_date : null, notes: U.str(d.notes, 4000),
        active: d.active === false || d.active === 0 ? 0 : 1, updated_at: now,
      };
      fields.search = U.searchBlob(fields.name, fields.company, fields.phone, fields.phone2, fields.city, fields.tax_no);
      let id = d.id;
      if (id) {
        const before = db.get('SELECT * FROM partners WHERE id = ?', [id]);
        U.assert(before, 'not_found', 'Account not found', 404);
        if (before.is_walkin) fields.active = 1;
        db.update('partners', id, fields);
        app.audit(ctx, 'update', 'partner', id, name);
      } else {
        id = uuid();
        db.insert('partners', { id, no: nextNo(), ...fields, is_walkin: d.is_walkin ? 1 : 0, created_at: now });
        app.audit(ctx, 'create', 'partner', id, name);
        // opening balance(s): [{currency, amount, date}] amount + = they owe us — needs the balance permission
        if (Array.isArray(d.opening) && d.opening.some((o) => U.num(o.amount))) {
          U.assert(ctx.skipPerm || !ctx.user || app.users.can(ctx.user, 'partners.adjust'), 'forbidden', 'You are not allowed to enter opening balances', 403, { permission: 'partners.adjust' });
          for (const o of d.opening) {
            if (!U.num(o.amount)) continue;
            addOpening(id, o, ctx);
          }
        }
      }
      return id;
    });
  }

  function addOpening(partnerId, o, ctx) {
    app.currency(o.currency);
    return addMove({
      date: U.isDate(o.date) ? o.date : U.today(), partner_id: partnerId, currency: o.currency, amount: U.num(o.amount),
      kind: 'opening', description: U.str(o.description, 300) || null, user_id: ctx.user && ctx.user.id, usd_iqd: o.usd_iqd,
    });
  }

  /** manual balance adjustment (devir / düzeltme) */
  function adjust(partnerId, o, ctx) {
    U.assert(db.get('SELECT 1 FROM partners WHERE id = ?', [partnerId]), 'not_found', 'Account not found', 404);
    U.assert(U.num(o.amount) !== 0, 'amount_required', 'Amount is required');
    return db.tx(() => {
      const m = addMove({
        date: U.isDate(o.date) ? o.date : U.today(), partner_id: partnerId, currency: o.currency, amount: U.num(o.amount),
        kind: o.kind === 'opening' ? 'opening' : 'adjust', description: U.str(o.description, 300), user_id: ctx.user && ctx.user.id, usd_iqd: o.usd_iqd,
      });
      app.audit(ctx, 'balance_adjust', 'partner', partnerId, { k: 'amount', v: { amount: o.amount, currency: o.currency, desc: o.description || '' } }, o);
      return m;
    });
  }

  function cancelMove(moveId, reason, ctx) {
    const m = db.get('SELECT * FROM partner_moves WHERE id = ?', [moveId]);
    U.assert(m, 'not_found', 'Not found', 404);
    U.assert(['opening', 'adjust', 'convert'].includes(m.kind), 'not_manual', 'Only manual entries can be cancelled here; cancel the document instead');
    db.tx(() => {
      if (m.kind === 'convert' && m.entry_id) {
        db.run("UPDATE partner_moves SET voided = 1 WHERE kind = 'convert' AND entry_id = ? AND voided = 0", [m.entry_id]);
      } else db.run('UPDATE partner_moves SET voided = 1 WHERE id = ?', [moveId]);
      app.audit(ctx, 'cancel', 'partner_move', moveId, reason, m);
    });
  }

  /**
   * Convert part of a balance from one currency to another (e.g. customer's 500,000 IQD debt becomes $328.95).
   * from_amount is positive and is taken out of the from_currency balance in the direction of the balance.
   */
  function convert(partnerId, { from_currency, to_currency, from_amount, rate, date, description }, ctx) {
    U.assert(from_currency !== to_currency, 'same_currency', 'Choose two different currencies');
    const amt = U.num(from_amount);
    U.assert(amt !== 0, 'amount_required', 'Amount is required');
    const bals = balances(partnerId);
    const sign = (bals[from_currency] || 0) < 0 ? -1 : 1;
    // rate = how many units of to_currency per 1 unit of from_currency, defaults from current rates
    const r = U.num(rate) > 0 ? U.num(rate) : app.convert(1, from_currency, to_currency);
    const toAmount = app.money(Math.abs(amt) * r, to_currency);
    const d = U.isDate(date) ? date : U.today();
    return db.tx(() => {
      const desc = U.str(description, 300) || `${Math.abs(amt)} ${from_currency} → ${toAmount} ${to_currency}`;
      const group = uuid();
      addMove({ date: d, partner_id: partnerId, currency: from_currency, amount: -sign * Math.abs(amt), kind: 'convert', entry_id: group, description: desc, user_id: ctx.user && ctx.user.id });
      addMove({ date: d, partner_id: partnerId, currency: to_currency, amount: sign * toAmount, kind: 'convert', entry_id: group, description: desc, user_id: ctx.user && ctx.user.id });
      app.audit(ctx, 'currency_convert', 'partner', partnerId, desc);
      return { to_amount: toAmount };
    });
  }

  /**
   * Account statement (ekstre) per currency with opening balance and running balance.
   */
  function statement(partnerId, { from, to, currency } = {}) {
    const p = db.get('SELECT id, name, phone, kind FROM partners WHERE id = ?', [partnerId]);
    U.assert(p, 'not_found', 'Account not found', 404);
    const curs = currency ? [currency] : db.all('SELECT DISTINCT currency FROM partner_moves WHERE partner_id = ? AND voided = 0 ORDER BY currency', [partnerId]).map((r) => r.currency);
    const sections = [];
    for (const c of curs) {
      const opening = from ? (db.val('SELECT SUM(amount) FROM partner_moves WHERE partner_id = ? AND currency = ? AND voided = 0 AND date < ?', [partnerId, c, from]) || 0) : 0;
      const where = ['m.partner_id = ?', 'm.currency = ?', 'm.voided = 0'];
      const params = [partnerId, c];
      if (from) { where.push('m.date >= ?'); params.push(from); }
      if (to) { where.push('m.date <= ?'); params.push(to); }
      const rows = db.all(`SELECT m.id, m.date, m.amount, m.kind, m.description, m.doc_id, m.payment_id, m.due_date, m.rate, m.usd_iqd,
          d.no AS doc_no, d.type AS doc_type, d.currency AS doc_currency, py.no AS payment_no, py.method, py.currency AS paid_currency, py.amount AS paid_amount,
          a.name AS account_name
        FROM partner_moves m LEFT JOIN docs d ON d.id = m.doc_id LEFT JOIN payments py ON py.id = m.payment_id
        LEFT JOIN money_accounts a ON a.id = py.account_id
        WHERE ${where.join(' AND ')} ORDER BY m.date, m.seq`, params);
      let run = opening;
      let debit = 0;
      let credit = 0;
      for (const r of rows) {
        run += r.amount;
        r.balance = app.money(run, c);
        if (r.amount > 0) debit += r.amount; else credit -= r.amount;
      }
      sections.push({ currency: c, opening: app.money(opening, c), debit: app.money(debit, c), credit: app.money(credit, c), closing: app.money(run, c), rows });
    }
    return { partner: p, from: from || null, to: to || null, sections };
  }

  /** unpaid / partially paid posted invoices of a partner (for payment allocation) */
  function openDocs(partnerId, { direction, currency } = {}) {
    const types = direction === 'out' ? ['purchase', 'sale_return'] : direction === 'in' ? ['sale', 'purchase_return'] : ['sale', 'purchase', 'sale_return', 'purchase_return'];
    const rows = db.all(`SELECT id, type, no, date, due_date, currency, total, paid, payment_status FROM docs
      WHERE partner_id = ? AND status = 'posted' AND type IN (${types.map(() => '?').join(',')}) AND COALESCE(payment_status, 'unpaid') <> 'paid'
      ${currency ? 'AND currency = ?' : ''} ORDER BY date, created_at`, currency ? [partnerId, ...types, currency] : [partnerId, ...types]);
    const today = U.today();
    for (const r of rows) {
      r.remaining = app.money(r.total - r.paid, r.currency);
      r.overdue_days = r.due_date && r.due_date < today ? U.daysBetween(r.due_date, today) : 0;
    }
    return rows.filter((r) => r.remaining > 0);
  }

  function remove(id, ctx) {
    const p = db.get('SELECT * FROM partners WHERE id = ?', [id]);
    U.assert(p, 'not_found', 'Account not found', 404);
    U.assert(!p.is_walkin, 'walkin_locked', 'The walk-in customer cannot be removed');
    const used = db.val('SELECT COUNT(*) FROM partner_moves WHERE partner_id = ?', [id]) + db.val('SELECT COUNT(*) FROM docs WHERE partner_id = ?', [id]);
    return db.tx(() => {
      if (used) {
        db.update('partners', id, { active: 0, updated_at: U.nowIso() });
        app.audit(ctx, 'deactivate', 'partner', id, p.name);
        return { deactivated: true };
      }
      db.run('UPDATE vehicles SET partner_id = NULL WHERE partner_id = ?', [id]);
      db.run('DELETE FROM partners WHERE id = ?', [id]);
      app.audit(ctx, 'delete', 'partner', id, p.name, p);
      return { deleted: true };
    });
  }

  function walkinId() {
    const pos = app.getSetting('pos');
    if (pos.default_partner_id && db.get('SELECT 1 FROM partners WHERE id = ? AND active = 1', [pos.default_partner_id])) return pos.default_partner_id;
    const w = db.get('SELECT id FROM partners WHERE is_walkin = 1 ORDER BY created_at LIMIT 1');
    return w ? w.id : null;
  }

  /** totals of receivables and payables per currency (for dashboard / reports) */
  function totals() {
    const rows = db.all(`SELECT partner_id, currency, SUM(amount) AS bal FROM partner_moves WHERE voided = 0 GROUP BY partner_id, currency`);
    const recv = {};
    const pay = {};
    let recvCount = 0;
    let payCount = 0;
    const rp = new Set();
    const pp = new Set();
    for (const r of rows) {
      const v = app.money(r.bal, r.currency);
      if (v > 0) { recv[r.currency] = (recv[r.currency] || 0) + v; rp.add(r.partner_id); } else if (v < 0) { pay[r.currency] = (pay[r.currency] || 0) - v; pp.add(r.partner_id); }
    }
    recvCount = rp.size;
    payCount = pp.size;
    return { receivable: recv, payable: pay, receivable_count: recvCount, payable_count: payCount };
  }

  return { addMove, voidBy, balances, balanceUsd, list, get, save, addOpening, adjust, cancelMove, convert, statement, openDocs, remove, walkinId, totals };
};
