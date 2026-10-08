'use strict';
/* Income / expense entries (gelir-gider) with categories and monthly recurring templates. */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function categories({ kind, include_inactive } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (!include_inactive) where.push('active = 1');
    return db.all(`SELECT * FROM finance_categories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY kind, sort, name`, params);
  }

  function categorySave(d, ctx) {
    const name = U.str(d.name, 100);
    U.assert(name, 'name_required', 'Name is required');
    const kind = d.kind === 'income' ? 'income' : 'expense';
    if (d.id) {
      db.update('finance_categories', d.id, { name, in_pl: d.in_pl === false || d.in_pl === 0 ? 0 : 1, active: d.active === false ? 0 : 1 });
      app.audit(ctx, 'update', 'finance_category', d.id, name);
      return d.id;
    }
    const id = uuid();
    db.insert('finance_categories', { id, kind, code: null, name, in_pl: d.in_pl === false || d.in_pl === 0 ? 0 : 1, active: 1, sort: (db.val('SELECT MAX(sort) FROM finance_categories') || 0) + 1 });
    app.audit(ctx, 'create', 'finance_category', id, name);
    return id;
  }

  function effects(e, ctx, rev) {
    const sign = e.kind === 'expense' ? -1 : 1;
    if (e.account_id) {
      app.cash.addMove({
        date: e.date, account_id: e.account_id, amount: sign * app.convert(e.amount, e.currency, app.cash.account(e.account_id).currency, { usd_iqd: e.usd_iqd }),
        kind: e.kind, entry_id: e.id, partner_id: e.partner_id, description: e.description || null, user_id: ctx.user && ctx.user.id, usd_iqd: e.usd_iqd, rev,
      });
    } else if (e.partner_id) {
      // not paid yet: we owe the partner (expense) / the partner owes us (income)
      app.partners.addMove({
        date: e.date, partner_id: e.partner_id, currency: e.currency, amount: e.kind === 'expense' ? -e.amount : e.amount,
        kind: e.kind, entry_id: e.id, description: e.description || e.no, user_id: ctx.user && ctx.user.id, usd_iqd: e.usd_iqd, rev,
      });
    }
  }

  function voidEffects(id) {
    app.cash.voidBy('entry_id', id);
    db.run("UPDATE partner_moves SET voided = 1 WHERE entry_id = ? AND voided = 0 AND kind IN ('expense', 'income')", [id]);
  }

  /** d: { id?, kind, date, category_id, description, currency, amount, account_id?, partner_id?, staff_id?, usd_iqd?, recurring_id? } */
  function save(d, ctx) {
    const kind = d.kind === 'income' ? 'income' : 'expense';
    const amount = U.num(d.amount);
    U.assert(amount > 0, 'amount_required', 'Amount must be greater than zero');
    U.assert(d.account_id || d.partner_id, 'account_required', 'Choose the cash/bank account it is paid from (or an account to owe)');
    const currency = d.account_id ? (d.currency || app.cash.account(d.account_id).currency) : d.currency;
    app.currency(currency);
    if (d.category_id) U.assert(db.get('SELECT 1 FROM finance_categories WHERE id = ?', [d.category_id]), 'category_not_found', 'Category not found');
    const date = U.isDate(d.date) ? d.date : U.today();
    const fx = app.fx(currency, d.usd_iqd);
    return db.tx(() => {
      const now = U.nowIso();
      const fields = {
        kind, date, category_id: d.category_id || null, description: U.str(d.description, 500), currency,
        amount: app.money(amount, currency), rate: fx.rate, usd_iqd: fx.usd_iqd, amount_usd: U.round(amount / fx.rate, 6),
        account_id: d.account_id || null, partner_id: d.partner_id || null, staff_id: d.staff_id || null, recurring_id: d.recurring_id || null,
        updated_by: ctx.user && ctx.user.id, updated_at: now,
      };
      let id = d.id;
      if (id) {
        const before = db.get('SELECT * FROM finance_entries WHERE id = ?', [id]);
        U.assert(before, 'not_found', 'Entry not found', 404);
        U.assert(before.status === 'posted', 'cancelled', 'This entry is cancelled');
        voidEffects(id);
        db.update('finance_entries', id, fields);
        effects({ ...fields, id, no: before.no }, ctx, 2);
        app.audit(ctx, 'update', 'finance_entry', id, { k: 'no_amount', v: { no: before.no, amount, currency } }, { before });
      } else {
        id = uuid();
        const no = app.nextNo(kind, date, 'finance_entries');
        db.insert('finance_entries', { id, no, ...fields, status: 'posted', created_by: ctx.user && ctx.user.id, created_at: now });
        effects({ ...fields, id, no }, ctx, 1);
        app.audit(ctx, 'create', 'finance_entry', id, { k: 'no_amount', v: { no, amount, currency } });
      }
      return id;
    });
  }

  function cancel(id, reason, ctx) {
    const e = db.get('SELECT * FROM finance_entries WHERE id = ?', [id]);
    U.assert(e, 'not_found', 'Entry not found', 404);
    U.assert(e.status === 'posted', 'already_cancelled', 'Already cancelled');
    db.tx(() => {
      voidEffects(id);
      db.update('finance_entries', id, { status: 'cancelled', cancelled_by: ctx.user && ctx.user.id, cancelled_at: U.nowIso(), cancel_reason: U.str(reason, 300) });
      app.audit(ctx, 'cancel', 'finance_entry', id, { k: 'no_reason', v: { no: e.no, reason: reason || '' } });
    });
  }

  function list(f = {}) {
    const where = [];
    const params = [];
    if (f.kind) { where.push('e.kind = ?'); params.push(f.kind); }
    if (f.category_id) { where.push('e.category_id = ?'); params.push(f.category_id); }
    if (f.account_id) { where.push('e.account_id = ?'); params.push(f.account_id); }
    if (f.from) { where.push('e.date >= ?'); params.push(f.from); }
    if (f.to) { where.push('e.date <= ?'); params.push(f.to); }
    if (f.status === 'all') { /* */ } else where.push("e.status = 'posted'");
    if (f.q) { const t = `%${U.normalize(f.q)}%`; where.push("(lower(COALESCE(e.description,'')) LIKE ? OR e.no LIKE ? OR lower(c.name) LIKE ?)"); params.push(t, `%${f.q}%`, t); }
    const rows = db.all(`SELECT e.*, c.name AS category_name, c.code AS category_code, c.in_pl, a.name AS account_name, p.name AS partner_name, s.full_name AS staff_name, u.full_name AS user_name
      FROM finance_entries e LEFT JOIN finance_categories c ON c.id = e.category_id LEFT JOIN money_accounts a ON a.id = e.account_id
      LEFT JOIN partners p ON p.id = e.partner_id LEFT JOIN users s ON s.id = e.staff_id LEFT JOIN users u ON u.id = e.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.created_at DESC LIMIT ?`, [...params, Math.min(Number(f.limit) || 1000, 10000)]);
    const byCat = {};
    const byCur = {};
    let usd = 0;
    for (const r of rows) {
      if (r.status !== 'posted') continue;
      const k = r.category_id || '-';
      byCat[k] = byCat[k] || { category_id: r.category_id, name: r.category_name, kind: r.kind, amount_usd: 0, count: 0 };
      byCat[k].amount_usd += r.amount_usd;
      byCat[k].count++;
      byCur[r.currency] = (byCur[r.currency] || 0) + r.amount;
      usd += r.amount_usd;
    }
    return { rows, by_category: Object.values(byCat).sort((a, b) => b.amount_usd - a.amount_usd), by_currency: byCur, total_usd: U.round(usd, 2) };
  }

  /* ---------------------------------------------------------------- recurring */
  function recurringList() {
    const ym = U.today().slice(0, 7);
    return db.all(`SELECT r.*, c.name AS category_name, a.name AS account_name,
        (SELECT id FROM finance_entries e WHERE e.recurring_id = r.id AND substr(e.date, 1, 7) = ? AND e.status = 'posted' LIMIT 1) AS this_month_entry
      FROM recurring_entries r LEFT JOIN finance_categories c ON c.id = r.category_id LEFT JOIN money_accounts a ON a.id = r.account_id
      ORDER BY r.active DESC, r.day_of_month`, [ym]);
  }

  function recurringSave(d, ctx) {
    const amount = U.num(d.amount);
    U.assert(amount > 0, 'amount_required', 'Amount must be greater than zero');
    app.currency(d.currency);
    const fields = {
      kind: d.kind === 'income' ? 'income' : 'expense', category_id: d.category_id || null, description: U.str(d.description, 300),
      currency: d.currency, amount, day_of_month: Math.min(28, Math.max(1, Math.round(U.num(d.day_of_month, 1)))),
      account_id: d.account_id || null, active: d.active === false ? 0 : 1,
    };
    if (d.id) { db.update('recurring_entries', d.id, fields); app.audit(ctx, 'update', 'recurring', d.id, fields.description); return d.id; }
    const id = uuid();
    db.insert('recurring_entries', { id, ...fields, created_at: U.nowIso() });
    app.audit(ctx, 'create', 'recurring', id, fields.description);
    return id;
  }

  function recurringDelete(id, ctx) {
    db.run('DELETE FROM recurring_entries WHERE id = ?', [id]);
    app.audit(ctx, 'delete', 'recurring', id);
  }

  /** templates due this month (day reached) and not generated yet */
  function recurringPending() {
    const today = U.today();
    const day = Number(today.slice(8, 10));
    return recurringList().filter((r) => r.active && !r.this_month_entry && r.day_of_month <= day);
  }

  /** create this month's entries for the given (or all due) templates */
  function recurringGenerate(ids, ctx) {
    const today = U.today();
    const ym = today.slice(0, 7);
    const list = recurringList().filter((r) => r.active && !r.this_month_entry && (!ids || !ids.length || ids.includes(r.id)));
    const out = [];
    db.tx(() => {
      for (const r of list) {
        const accountId = r.account_id || (app.cash.defaultAccount(r.currency) || {}).id;
        if (!accountId) continue;
        const id = save({
          kind: r.kind, date: `${ym}-${String(r.day_of_month).padStart(2, '0')}`, category_id: r.category_id, description: r.description,
          currency: r.currency, amount: r.amount, account_id: accountId, recurring_id: r.id,
        }, ctx);
        out.push(id);
      }
    });
    return { created: out.length };
  }

  return { categories, categorySave, save, cancel, list, recurringList, recurringSave, recurringDelete, recurringPending, recurringGenerate };
};
