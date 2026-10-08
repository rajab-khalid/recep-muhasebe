'use strict';
/*
 * Payments: money received from (direction 'in') or paid to (direction 'out') a partner.
 *
 * A payment touches three ledgers in one transaction:
 *   money_moves   : the physical money, in the money account's currency
 *   partner_moves : the partner balance, in the "applied" currency (may differ: customer owes $, pays IQD)
 *   payment_allocations : which invoices it pays (amounts in the invoice currency = applied currency)
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  const DOC_DIR = { sale: 'in', purchase_return: 'in', purchase: 'out', sale_return: 'out' };

  /** money allocated to a document plus what returns settled: on the invoice side (amount) and on the return side (credit_amount) */
  function settledOf(docId) {
    return (db.val('SELECT SUM(amount) FROM payment_allocations WHERE doc_id = ? AND voided = 0', [docId]) || 0)
      + (db.val('SELECT SUM(amount) FROM doc_credits WHERE doc_id = ? AND voided = 0', [docId]) || 0)
      + (db.val('SELECT SUM(credit_amount) FROM doc_credits WHERE credit_doc_id = ? AND voided = 0', [docId]) || 0);
  }

  function refreshDoc(docId) {
    const d = db.get('SELECT id, type, total, currency, status FROM docs WHERE id = ?', [docId]);
    if (!d || !DOC_DIR[d.type]) return;
    const paid = app.money(settledOf(docId), d.currency);
    const tol = d.currency === 'IQD' ? 0.5 : 0.005;
    let status = 'unpaid';
    if (d.total <= tol) status = 'paid';
    else if (paid >= d.total - tol) status = 'paid';
    else if (paid > tol) status = 'partial';
    db.run('UPDATE docs SET paid = ?, payment_status = ? WHERE id = ?', [paid, status, docId]);
  }

  function remainingOf(doc) {
    return app.money(doc.total - settledOf(doc.id), doc.currency);
  }

  /**
   * d: { direction, partner_id, account_id, amount, applied_currency?, applied_amount?, usd_iqd?, date, method?, description?,
   *      doc_id?, allocations?: [{doc_id, amount}], auto_allocate?: bool, purpose?: 'sale'|'change'|'refund'|..., rev? }
   */
  function create(d, ctx) {
    U.assert(['in', 'out'].includes(d.direction), 'bad_direction', 'Invalid payment direction');
    U.assert(d.partner_id, 'partner_required', 'Choose an account (customer/supplier)');
    const partner = db.get('SELECT * FROM partners WHERE id = ?', [d.partner_id]);
    U.assert(partner, 'partner_not_found', 'Account not found', 404);
    const acc = app.cash.account(d.account_id);
    U.assert(acc.active, 'account_inactive', 'This cash/bank account is closed', 400, { name: acc.name });
    const amount = app.money(U.num(d.amount), acc.currency);
    U.assert(amount > 0, 'amount_required', 'Amount must be greater than zero');
    const date = U.isDate(d.date) ? d.date : U.today();
    const usdIqd = U.num(d.usd_iqd) > 0 ? U.num(d.usd_iqd) : app.usdIqd();
    const appliedCurrency = d.applied_currency || acc.currency;
    app.currency(appliedCurrency);
    let appliedAmount;
    if (appliedCurrency === acc.currency) appliedAmount = amount;
    else if (U.num(d.applied_amount) > 0) appliedAmount = app.money(U.num(d.applied_amount), appliedCurrency);
    else appliedAmount = app.money(app.convert(amount, acc.currency, appliedCurrency, { usd_iqd: usdIqd }), appliedCurrency);
    const method = d.method || (acc.type === 'bank' ? 'transfer' : acc.type === 'pos' ? 'card' : 'cash');
    const fx = app.fx(acc.currency, usdIqd);

    // allocations
    let allocs = [];
    if (Array.isArray(d.allocations) && d.allocations.length) allocs = d.allocations.map((a) => ({ doc_id: a.doc_id, amount: U.num(a.amount) })).filter((a) => a.amount > 0);
    else if (d.doc_id) allocs = [{ doc_id: d.doc_id, amount: appliedAmount }];
    else if (d.auto_allocate) {
      let left = appliedAmount;
      for (const od of app.partners.openDocs(partner.id, { direction: d.direction, currency: appliedCurrency })) {
        if (left <= 0) break;
        const a = Math.min(left, od.remaining);
        allocs.push({ doc_id: od.id, amount: a });
        left = app.money(left - a, appliedCurrency);
      }
    }

    return db.tx(() => {
      const id = uuid();
      const no = app.nextNo(d.direction === 'in' ? 'payment_in' : 'payment_out', date, 'payments');
      const userId = ctx.user && ctx.user.id;
      const desc = U.str(d.description, 300);
      let totalAlloc = 0;
      const allocRows = [];
      for (const a of allocs) {
        const doc = db.get('SELECT * FROM docs WHERE id = ?', [a.doc_id]);
        U.assert(doc, 'doc_not_found', 'Invoice not found', 404);
        U.assert(doc.partner_id === partner.id, 'doc_partner_mismatch', `Invoice ${doc.no} belongs to another account`, 400, { no: doc.no });
        U.assert(doc.status === 'posted', 'doc_not_posted', `Invoice ${doc.no} is not posted`, 400, { no: doc.no });
        U.assert(DOC_DIR[doc.type] === d.direction, 'doc_direction', `Invoice ${doc.no} cannot be paid with this payment type`, 400, { no: doc.no });
        U.assert(doc.currency === appliedCurrency, 'doc_currency', `Invoice ${doc.no} is in ${doc.currency}; choose ${doc.currency} as the balance currency`, 400, { no: doc.no, currency: doc.currency });
        const rem = remainingOf(doc);
        const tol = doc.currency === 'IQD' ? 1 : 0.01;
        let amt = app.money(a.amount, doc.currency);
        if (amt > rem + tol && !d.allow_over) amt = rem;
        if (amt <= 0) continue;
        totalAlloc += amt;
        allocRows.push({ doc, amt });
      }
      U.assert(totalAlloc <= appliedAmount + (appliedCurrency === 'IQD' ? 1 : 0.01), 'over_allocated', 'Allocated amount is more than the payment');

      db.insert('payments', {
        id, no, date, direction: d.direction, partner_id: partner.id, account_id: acc.id, method,
        currency: acc.currency, amount, rate: fx.rate, usd_iqd: usdIqd, amount_usd: U.round(amount / fx.rate, 6),
        applied_currency: appliedCurrency, applied_amount: appliedAmount,
        applied_rate: appliedCurrency === acc.currency ? 1 : U.round(appliedAmount / amount, 8),
        doc_id: allocRows.length === 1 ? allocRows[0].doc.id : (d.link_doc_id || d.doc_id || null), purpose: d.purpose || null,
        description: desc, status: 'posted', created_by: userId, created_at: U.nowIso(),
      });
      const label = desc || (allocRows.length ? allocRows.map((r) => r.doc.no).join(', ') : null);
      app.cash.addMove({
        date, account_id: acc.id, amount: d.direction === 'in' ? amount : -amount,
        kind: d.purpose === 'change' ? 'change' : d.direction === 'in' ? 'collection' : 'payment', method,
        payment_id: id, doc_id: allocRows.length === 1 ? allocRows[0].doc.id : (d.link_doc_id || d.doc_id || null), partner_id: partner.id,
        description: label ? `${partner.name} — ${label}` : partner.name, user_id: userId, usd_iqd: usdIqd, rev: d.rev,
      });
      app.partners.addMove({
        date, partner_id: partner.id, currency: appliedCurrency, amount: d.direction === 'in' ? -appliedAmount : appliedAmount,
        kind: d.purpose === 'change' ? 'change' : d.direction === 'in' ? 'payment_in' : 'payment_out', payment_id: id,
        doc_id: allocRows.length === 1 ? allocRows[0].doc.id : (d.link_doc_id || null),
        description: appliedCurrency !== acc.currency ? `${amount} ${acc.currency} @ ${usdIqd}${label ? ' — ' + label : ''}` : label,
        user_id: userId, usd_iqd: usdIqd,
      });
      for (const r of allocRows) {
        db.insert('payment_allocations', { id: uuid(), payment_id: id, doc_id: r.doc.id, amount: r.amt, voided: 0, created_at: U.nowIso() });
        refreshDoc(r.doc.id);
      }
      if (!d.silent) app.audit(ctx, 'create', 'payment', id, { k: 'payment', v: { no, direction: d.direction, amount, currency: acc.currency, partner: partner.name } });
      return { id, no, applied_amount: appliedAmount, allocated: totalAlloc };
    });
  }

  function cancel(id, reason, ctx, opts = {}) {
    const p = db.get('SELECT * FROM payments WHERE id = ?', [id]);
    U.assert(p, 'not_found', 'Payment not found', 404);
    if (p.status === 'cancelled') return;
    db.tx(() => {
      app.cash.voidBy('payment_id', id);
      app.partners.voidBy('payment_id', id);
      const docs = db.all('SELECT DISTINCT doc_id FROM payment_allocations WHERE payment_id = ? AND voided = 0', [id]).map((r) => r.doc_id);
      db.run('UPDATE payment_allocations SET voided = 1 WHERE payment_id = ?', [id]);
      db.update('payments', id, { status: 'cancelled', cancelled_by: ctx.user && ctx.user.id, cancelled_at: U.nowIso(), cancel_reason: U.str(reason, 300) });
      for (const dId of docs) refreshDoc(dId);
      if (!opts.silent) app.audit(ctx, 'cancel', 'payment', id, { k: 'no_reason', v: { no: p.no, reason: reason || '' } });
    });
  }

  /** re-point allocations of an existing payment (e.g. after an invoice was edited) */
  function allocate(paymentId, allocations, ctx) {
    const p = db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    U.assert(p && p.status === 'posted', 'not_found', 'Payment not found', 404);
    db.tx(() => {
      const old = db.all('SELECT doc_id FROM payment_allocations WHERE payment_id = ? AND voided = 0', [paymentId]).map((r) => r.doc_id);
      db.run('UPDATE payment_allocations SET voided = 1 WHERE payment_id = ? AND voided = 0', [paymentId]);
      let total = 0;
      for (const a of allocations || []) {
        const doc = db.get('SELECT * FROM docs WHERE id = ?', [a.doc_id]);
        U.assert(doc && doc.status === 'posted' && doc.partner_id === p.partner_id && doc.currency === p.applied_currency && DOC_DIR[doc.type] === p.direction, 'bad_allocation', 'Invalid invoice for this payment');
        const amt = Math.min(app.money(U.num(a.amount), doc.currency), remainingOf(doc));
        if (amt <= 0) continue;
        total += amt;
        db.insert('payment_allocations', { id: uuid(), payment_id: paymentId, doc_id: doc.id, amount: amt, voided: 0, created_at: U.nowIso() });
        old.push(doc.id);
      }
      U.assert(total <= p.applied_amount + 0.01, 'over_allocated', 'Allocated amount is more than the payment');
      for (const dId of new Set(old)) refreshDoc(dId);
      app.audit(ctx, 'allocate', 'payment', paymentId, p.no, allocations);
    });
  }

  function unallocated(paymentRow) {
    const used = db.val('SELECT SUM(amount) FROM payment_allocations WHERE payment_id = ? AND voided = 0', [paymentRow.id]) || 0;
    return app.money(paymentRow.applied_amount - used, paymentRow.applied_currency);
  }

  function get(id) {
    const p = db.get(`SELECT p.*, pa.name AS partner_name, pa.phone AS partner_phone, a.name AS account_name, u.full_name AS user_name
      FROM payments p LEFT JOIN partners pa ON pa.id = p.partner_id LEFT JOIN money_accounts a ON a.id = p.account_id
      LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`, [id]);
    U.assert(p, 'not_found', 'Payment not found', 404);
    p.allocations = db.all(`SELECT al.amount, d.id AS doc_id, d.no, d.type, d.date, d.total, d.currency FROM payment_allocations al
      JOIN docs d ON d.id = al.doc_id WHERE al.payment_id = ? AND al.voided = 0`, [id]);
    p.unallocated = unallocated(p);
    p.partner_balances = p.partner_id ? app.partners.balances(p.partner_id) : {};
    return p;
  }

  function list(f = {}) {
    const where = [];
    const params = [];
    if (f.direction) { where.push('p.direction = ?'); params.push(f.direction); }
    if (f.partner_id) { where.push('p.partner_id = ?'); params.push(f.partner_id); }
    if (f.account_id) { where.push('p.account_id = ?'); params.push(f.account_id); }
    if (f.from) { where.push('p.date >= ?'); params.push(f.from); }
    if (f.to) { where.push('p.date <= ?'); params.push(f.to); }
    if (f.status) { where.push('p.status = ?'); params.push(f.status); } else where.push("p.status = 'posted'");
    if (f.purpose === 'exclude_change') where.push("COALESCE(p.purpose, '') <> 'change'");
    if (f.q) {
      for (const t of U.searchTerms(f.q)) { where.push("(pa.search LIKE ? OR p.no LIKE ? OR COALESCE(p.description, '') LIKE ?)"); params.push(`%${t}%`, `%${t}%`, `%${t}%`); }
    }
    return db.all(`SELECT p.*, pa.name AS partner_name, a.name AS account_name, a.type AS account_type, u.full_name AS user_name,
        (SELECT group_concat(d.no, ', ') FROM payment_allocations al JOIN docs d ON d.id = al.doc_id WHERE al.payment_id = p.id AND al.voided = 0) AS doc_nos
      FROM payments p LEFT JOIN partners pa ON pa.id = p.partner_id LEFT JOIN money_accounts a ON a.id = p.account_id LEFT JOIN users u ON u.id = p.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.date DESC, p.created_at DESC LIMIT ?`, [...params, Math.min(Number(f.limit) || 500, 5000)]);
  }

  return { create, cancel, allocate, refreshDoc, remainingOf, get, list, DOC_DIR };
};
