'use strict';
/*
 * Money accounts (cash boxes per currency, bank accounts, card/POS accounts) and their ledger.
 * money_moves.amount is signed in the account's own currency: + in, - out.
 */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function account(id) {
    const a = db.get('SELECT * FROM money_accounts WHERE id = ?', [id]);
    U.assert(a, 'account_not_found', 'Cash/bank account not found', 404);
    return a;
  }

  function balance(accountId, { to, before } = {}) {
    const a = account(accountId);
    let sql = 'SELECT SUM(amount) FROM money_moves WHERE account_id = ? AND voided = 0';
    const params = [accountId];
    if (to) { sql += ' AND date <= ?'; params.push(to); }
    if (before) { sql += ' AND date < ?'; params.push(before); }
    const opening = (!a.opening_date || !(to || before) || a.opening_date <= (to || before)) ? a.opening_balance || 0 : 0;
    return app.money(opening + (db.val(sql, params) || 0), a.currency);
  }

  function accounts({ include_inactive, type } = {}) {
    const where = [];
    const params = [];
    if (!include_inactive) where.push('a.active = 1');
    if (type) { where.push('a.type = ?'); params.push(type); }
    const rows = db.all(`SELECT a.*, COALESCE((SELECT SUM(amount) FROM money_moves m WHERE m.account_id = a.id AND m.voided = 0), 0) AS moves_sum,
        (SELECT MAX(date) FROM money_moves m WHERE m.account_id = a.id AND m.voided = 0) AS last_move
      FROM money_accounts a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.type, a.sort, a.name`, params);
    for (const r of rows) {
      r.balance = app.money((r.opening_balance || 0) + r.moves_sum, r.currency);
      const lc = db.get('SELECT date, counted, diff FROM cash_counts WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', [r.id]);
      r.last_count = lc || null;
      delete r.moves_sum;
    }
    return rows;
  }

  function accountSave(d, ctx) {
    const name = U.str(d.name, 120);
    U.assert(name, 'name_required', 'Name is required');
    app.currency(d.currency);
    return db.tx(() => {
      const fields = {
        type: ['cash', 'bank', 'pos'].includes(d.type) ? d.type : 'cash', name, currency: d.currency,
        bank_name: U.str(d.bank_name, 120), branch: U.str(d.branch, 120), account_no: U.str(d.account_no, 60), iban: U.str(d.iban, 60),
        opening_balance: U.num(d.opening_balance), opening_date: U.isDate(d.opening_date) ? d.opening_date : null,
        notes: U.str(d.notes, 1000), active: d.active === false ? 0 : 1, sort: d.sort != null ? U.num(d.sort) : undefined,
      };
      let id = d.id;
      if (id) {
        const before = account(id);
        if (before.currency !== fields.currency) {
          U.assert(!db.val('SELECT COUNT(*) FROM money_moves WHERE account_id = ?', [id]), 'currency_locked', 'Currency cannot change once the account has movements');
        }
        db.update('money_accounts', id, fields);
        app.audit(ctx, 'update', 'money_account', id, name, { before: { opening_balance: before.opening_balance }, after: { opening_balance: fields.opening_balance } });
      } else {
        id = uuid();
        db.insert('money_accounts', { id, ...fields, sort: fields.sort ?? ((db.val('SELECT MAX(sort) FROM money_accounts') || 0) + 1), is_default: 0, created_at: U.nowIso() });
        app.audit(ctx, 'create', 'money_account', id, name);
      }
      if (d.is_default) {
        db.run('UPDATE money_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE type = ? AND currency = ?', [id, fields.type, fields.currency]);
      }
      return id;
    });
  }

  function accountRemove(id, ctx) {
    const a = account(id);
    const used = db.val('SELECT COUNT(*) FROM money_moves WHERE account_id = ?', [id]);
    if (used || a.opening_balance) {
      U.assert(Math.abs(balance(id)) < 0.005, 'account_not_empty', 'The account balance must be zero before closing it');
      db.update('money_accounts', id, { active: 0 });
      app.audit(ctx, 'deactivate', 'money_account', id, a.name);
      return { deactivated: true };
    }
    db.run('DELETE FROM money_accounts WHERE id = ?', [id]);
    app.audit(ctx, 'delete', 'money_account', id, a.name);
    return { deleted: true };
  }

  /** default cash box for a currency (used by the POS) */
  function defaultAccount(currency, type = 'cash') {
    const a = db.get('SELECT * FROM money_accounts WHERE active = 1 AND type = ? AND currency = ? ORDER BY is_default DESC, sort LIMIT 1', [type, currency]);
    return a || null;
  }

  function addMove(m) {
    const a = account(m.account_id);
    U.assert(a.active, 'account_inactive', `Account "${a.name}" is closed`, 400, { name: a.name });
    const fx = app.fx(a.currency, m.usd_iqd);
    const amount = app.money(m.amount, a.currency);
    if (Math.abs(amount) < 1e-9) return null;
    const row = {
      id: uuid(), seq: app.nextSeq(), date: m.date, account_id: a.id, amount, currency: a.currency,
      rate: fx.rate, usd_iqd: fx.usd_iqd, amount_usd: U.round(amount / fx.rate, 6),
      kind: m.kind, method: m.method || null, doc_id: m.doc_id || null, payment_id: m.payment_id || null,
      entry_id: m.entry_id || null, transfer_id: m.transfer_id || null, count_id: m.count_id || null,
      partner_id: m.partner_id || null, description: m.description || null, rev: m.rev || 1, voided: 0,
      user_id: m.user_id || null, created_at: U.nowIso(),
    };
    db.insert('money_moves', row);
    return row;
  }

  function voidBy(col, id) {
    db.run(`UPDATE money_moves SET voided = 1 WHERE ${col} = ? AND voided = 0`, [id]);
  }

  function statement(accountId, { from, to, kind, q, limit = 2000 } = {}) {
    const a = account(accountId);
    const opening = from ? balance(accountId, { before: from }) : (a.opening_balance || 0);
    const where = ['m.account_id = ?', 'm.voided = 0'];
    const params = [accountId];
    if (from) { where.push('m.date >= ?'); params.push(from); }
    if (to) { where.push('m.date <= ?'); params.push(to); }
    const rows = db.all(`SELECT m.*, u.full_name AS user_name, p.name AS partner_name, d.no AS doc_no, d.type AS doc_type,
        py.no AS payment_no, fe.no AS entry_no, fc.name AS category_name, t.no AS transfer_no
      FROM money_moves m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN partners p ON p.id = m.partner_id
      LEFT JOIN docs d ON d.id = m.doc_id LEFT JOIN payments py ON py.id = m.payment_id
      LEFT JOIN finance_entries fe ON fe.id = m.entry_id LEFT JOIN finance_categories fc ON fc.id = fe.category_id
      LEFT JOIN transfers t ON t.id = m.transfer_id
      WHERE ${where.join(' AND ')} ORDER BY m.date, m.seq LIMIT ?`, [...params, limit]);
    let run = opening;
    let tin = 0;
    let tout = 0;
    for (const r of rows) {
      run += r.amount;
      r.balance = app.money(run, a.currency);
      if (r.amount > 0) tin += r.amount; else tout -= r.amount;
    }
    let out = rows;
    if (kind) out = out.filter((r) => r.kind === kind);
    if (q) {
      const t = U.normalize(q);
      out = out.filter((r) => U.normalize([r.description, r.partner_name, r.doc_no, r.payment_no, r.entry_no, r.category_name].join(' ')).includes(t));
    }
    return {
      account: { ...a, balance: balance(accountId) }, from: from || null, to: to || null,
      opening: app.money(opening, a.currency), total_in: app.money(tin, a.currency), total_out: app.money(tout, a.currency),
      closing: app.money(run, a.currency), rows: out,
    };
  }

  /**
   * Transfer between two money accounts. If the currencies differ it is a currency exchange (döviz bozdurma).
   * d: { from_account_id, to_account_id, from_amount, to_amount?, rate?, fee?, date, description, usd_iqd? }
   */
  function transfer(d, ctx) {
    const from = account(d.from_account_id);
    const to = account(d.to_account_id);
    U.assert(from.id !== to.id, 'same_account', 'Choose two different accounts');
    const fromAmount = app.money(U.num(d.from_amount), from.currency);
    U.assert(fromAmount > 0, 'amount_required', 'Amount is required');
    let toAmount;
    const exchange = from.currency !== to.currency;
    if (!exchange) toAmount = fromAmount;
    else if (U.num(d.to_amount) > 0) toAmount = app.money(U.num(d.to_amount), to.currency);
    else {
      const usdIqd = U.num(d.usd_iqd) > 0 ? U.num(d.usd_iqd) : app.usdIqd();
      toAmount = app.money(app.convert(fromAmount, from.currency, to.currency, { usd_iqd: usdIqd }), to.currency);
    }
    const fee = app.money(U.num(d.fee), from.currency);
    const date = U.isDate(d.date) ? d.date : U.today();
    // effective USD/IQD rate of an exchange between USD and IQD
    let usdIqd = U.num(d.usd_iqd) > 0 ? U.num(d.usd_iqd) : app.usdIqd();
    if (exchange && ['USD', 'IQD'].includes(from.currency) && ['USD', 'IQD'].includes(to.currency)) {
      usdIqd = from.currency === 'USD' ? toAmount / fromAmount : fromAmount / toAmount;
    }
    return db.tx(() => {
      const id = uuid();
      const no = app.nextNo('money_transfer', date, 'transfers');
      db.insert('transfers', {
        id, no, date, kind: exchange ? 'exchange' : 'transfer', from_account_id: from.id, to_account_id: to.id,
        from_amount: fromAmount, to_amount: toAmount, rate: exchange ? U.round(toAmount / fromAmount, 8) : 1, usd_iqd: usdIqd, fee,
        description: U.str(d.description, 300), status: 'posted', created_by: ctx.user && ctx.user.id, created_at: U.nowIso(),
      });
      const desc = U.str(d.description, 300) || `${from.name} → ${to.name}`;
      const kind = exchange ? 'exchange' : 'transfer';
      addMove({ date, account_id: from.id, amount: -fromAmount, kind, transfer_id: id, description: desc, user_id: ctx.user && ctx.user.id, usd_iqd: usdIqd });
      addMove({ date, account_id: to.id, amount: toAmount, kind, transfer_id: id, description: desc, user_id: ctx.user && ctx.user.id, usd_iqd: usdIqd });
      if (fee) addMove({ date, account_id: from.id, amount: -fee, kind: 'fee', transfer_id: id, description: `${desc} (fee)`, user_id: ctx.user && ctx.user.id, usd_iqd: usdIqd });
      app.audit(ctx, 'create', 'transfer', id, { k: 'transfer', v: { no, from_amount: fromAmount, from_currency: from.currency, to_amount: toAmount, to_currency: to.currency } });
      return { id, no, to_amount: toAmount };
    });
  }

  function cancelTransfer(id, reason, ctx) {
    const t = db.get('SELECT * FROM transfers WHERE id = ?', [id]);
    U.assert(t, 'not_found', 'Transfer not found', 404);
    U.assert(t.status !== 'cancelled', 'already_cancelled', 'Already cancelled');
    db.tx(() => {
      voidBy('transfer_id', id);
      db.update('transfers', id, { status: 'cancelled', cancelled_by: ctx.user && ctx.user.id, cancelled_at: U.nowIso(), cancel_reason: U.str(reason, 300) });
      app.audit(ctx, 'cancel', 'transfer', id, { k: 'no_reason', v: { no: t.no, reason: reason || '' } });
    });
  }

  function transfers({ from, to, account_id, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push('t.date >= ?'); params.push(from); }
    if (to) { where.push('t.date <= ?'); params.push(to); }
    if (account_id) { where.push('(t.from_account_id = ? OR t.to_account_id = ?)'); params.push(account_id, account_id); }
    return db.all(`SELECT t.*, fa.name AS from_name, fa.currency AS from_currency, ta.name AS to_name, ta.currency AS to_currency, u.full_name AS user_name
      FROM transfers t JOIN money_accounts fa ON fa.id = t.from_account_id JOIN money_accounts ta ON ta.id = t.to_account_id
      LEFT JOIN users u ON u.id = t.created_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.date DESC, t.created_at DESC LIMIT ?`, [...params, limit]);
  }

  /** manual correction / opening entry on an account */
  function manual(d, ctx) {
    const a = account(d.account_id);
    const amt = app.money(U.num(d.amount), a.currency);
    U.assert(amt !== 0, 'amount_required', 'Amount is required');
    return db.tx(() => {
      const m = addMove({
        date: U.isDate(d.date) ? d.date : U.today(), account_id: a.id, amount: amt, kind: d.kind === 'opening' ? 'opening' : 'adjust',
        description: U.str(d.description, 300), user_id: ctx.user && ctx.user.id,
      });
      app.audit(ctx, 'manual_move', 'money_account', a.id, { k: 'amount', v: { account: a.name, amount: amt, currency: a.currency, desc: d.description || '' } });
      return m;
    });
  }

  function cancelMove(moveId, reason, ctx) {
    const m = db.get('SELECT * FROM money_moves WHERE id = ?', [moveId]);
    U.assert(m, 'not_found', 'Not found', 404);
    U.assert(['adjust', 'opening', 'count_diff'].includes(m.kind), 'not_manual', 'Only manual entries can be cancelled here; cancel the source document instead');
    db.tx(() => {
      db.run('UPDATE money_moves SET voided = 1 WHERE id = ?', [moveId]);
      if (m.count_id) db.run('UPDATE cash_counts SET posted = 0 WHERE id = ?', [m.count_id]);
      app.audit(ctx, 'cancel', 'money_move', moveId, reason, m);
    });
  }

  /**
   * Cash count (kasa sayımı): compares the physical count with the system balance.
   * d: { account_id, counted, details: {denominations}, post_diff: bool, note, date }
   */
  function count(d, ctx) {
    const a = account(d.account_id);
    const date = U.isDate(d.date) ? d.date : U.today();
    const sys = balance(a.id, { to: date });
    const counted = app.money(U.num(d.counted), a.currency);
    const diff = app.money(counted - sys, a.currency);
    return db.tx(() => {
      const id = uuid();
      db.insert('cash_counts', {
        id, date, account_id: a.id, system_balance: sys, counted, diff, details: d.details ? JSON.stringify(d.details) : null,
        posted: 0, note: U.str(d.note, 500), created_by: ctx.user && ctx.user.id, created_at: U.nowIso(),
      });
      if (d.post_diff && Math.abs(diff) > 0) {
        // 'opening' = correction of a missing opening balance (not profit/loss); default = real cash difference
        const kind = d.diff_kind === 'opening' ? 'opening' : 'count_diff';
        addMove({ date, account_id: a.id, amount: diff, kind, count_id: id, description: U.str(d.note, 300) || (kind === 'opening' ? 'Opening balance correction' : 'Cash count difference'), user_id: ctx.user && ctx.user.id });
        db.update('cash_counts', id, { posted: 1 });
      }
      app.audit(ctx, 'cash_count', 'money_account', a.id, { k: 'cash_count', v: { account: a.name, system: sys, counted, diff, currency: a.currency } });
      return { id, system_balance: sys, counted, diff };
    });
  }

  function counts({ account_id, limit = 200 } = {}) {
    return db.all(`SELECT c.*, a.name AS account_name, a.currency, u.full_name AS user_name FROM cash_counts c
      JOIN money_accounts a ON a.id = c.account_id LEFT JOIN users u ON u.id = c.created_by
      ${account_id ? 'WHERE c.account_id = ?' : ''} ORDER BY c.created_at DESC LIMIT ?`, account_id ? [account_id, limit] : [limit]);
  }

  /** total balances grouped by currency and type */
  function summary() {
    const accs = accounts();
    const byCurrency = {};
    for (const a of accs) {
      const k = a.currency;
      byCurrency[k] = byCurrency[k] || { cash: 0, bank: 0, pos: 0, total: 0 };
      byCurrency[k][a.type] += a.balance;
      byCurrency[k].total += a.balance;
    }
    return { accounts: accs, by_currency: byCurrency };
  }

  return { account, balance, accounts, accountSave, accountRemove, defaultAccount, addMove, voidBy, statement, transfer, cancelTransfer, transfers, manual, cancelMove, count, counts, summary };
};
