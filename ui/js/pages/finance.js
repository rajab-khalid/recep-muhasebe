// Income & expenses (gelir / gider) with categories and monthly recurring templates (rent, salaries...).
import { html, useState, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { setQuery } from '../core/router.js';
import { money, today, date as fdate, usdIqd, decimals, display } from '../core/format.js';
import {
  Btn, IconBtn, Modal, Field, Input, NumInput, Select, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Tabs,
  DateRange, periodRange, SearchBox, useAsync, useDebounced, openModal, toast, errToast, promptDialog, confirmDialog, DateInput } from '../core/ui.js';
import { downloadXlsx } from '../core/xlsx.js';
import { printTables } from '../core/print.js';
import { refreshBoot } from '../core/session.js';
import { AccountSelect, account, defaultAccount, accountOptions, StaffSelect, PartnerPicker, CurrencySelect } from './pickers.js';

function categoryOptions(kind, includeId) {
  return (boot().finance_categories || []).filter((c) => c.kind === kind && (c.active || c.id === includeId)).map((c) => ({ value: c.id, label: c.name }));
}

/** FinanceEntryDialog props: kind ('expense'|'income'), entry (edit), close -> resolves with the saved id */
export function FinanceEntryDialog({ kind: initialKind = 'expense', entry, close }) {
  const e0 = entry || {};
  const [kind, setKind] = useState(e0.kind || initialKind);
  const [date, setDate] = useState(e0.date || today());
  const [categoryId, setCategoryId] = useState(e0.category_id || '');
  const [desc, setDesc] = useState(e0.description || '');
  const [mode, setMode] = useState(e0.id && !e0.account_id && e0.partner_id ? 'owed' : 'paid');
  const startAcc = e0.account_id || (defaultAccount((boot().settings.general || {}).default_currency || 'IQD') || {}).id || '';
  const [accountId, setAccountId] = useState(startAcc);
  const [currency, setCurrency] = useState(e0.currency || (account(startAcc) || {}).currency || 'IQD');
  const [amount, setAmount] = useState(e0.amount ?? null);
  const [partner, setPartner] = useState(e0.partner_id ? { id: e0.partner_id, name: e0.partner_name } : null);
  const [staffId, setStaffId] = useState(e0.staff_id || '');
  const [rate, setRate] = useState(e0.usd_iqd || usdIqd());
  const [busy, setBusy] = useState(false);
  const acc = account(accountId);
  const cats = categoryOptions(kind, categoryId);
  const save = async () => {
    if (!(amount > 0)) { toast(t('pay.enter_amount'), 'err'); return; }
    if (mode === 'paid' && !accountId) { toast(t('fin.choose_account'), 'err'); return; }
    if (mode === 'owed' && !partner) { toast(t('pay.choose_partner'), 'err'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/finance/entries', {
        id: e0.id, kind, date, category_id: categoryId || null, description: desc, currency, amount,
        account_id: mode === 'paid' ? accountId : null, partner_id: partner ? partner.id : null, staff_id: staffId || null, usd_iqd: rate,
      });
      toast(t('common.saved'));
      close(r.id);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${e0.id ? `${e0.no} — ${t('common.edit')}` : t(kind === 'expense' ? 'fin.new_expense' : 'fin.new_income')} icon="receipt-text" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      ${!e0.id && html`<${Segmented} value=${kind} onValue=${(v) => { setKind(v); setCategoryId(''); }} options=${[{ value: 'expense', label: t('fin.expense') }, { value: 'income', label: t('fin.income') }]} />`}
      <div class="form-2">
        <${Field} label=${t('fin.category')}><${Select} value=${categoryId} onValue=${setCategoryId} placeholder="—" options=${cats} /></${Field}>
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
      </div>
      <${Field} label=${t('common.description')}><${Input} value=${desc} onValue=${setDesc} placeholder=${t(kind === 'expense' ? 'fin.desc_ph_expense' : 'fin.desc_ph_income')} autoFocus /></${Field}>
      <${Segmented} value=${mode} onValue=${setMode} options=${[{ value: 'paid', label: t(kind === 'expense' ? 'fin.paid_from' : 'fin.received_to') }, { value: 'owed', label: t(kind === 'expense' ? 'fin.owed_to' : 'fin.owed_by') }]} />
      <div class="form-3">
        ${mode === 'paid'
          ? html`<${Field} label=${t('pay.account')}><${AccountSelect} value=${accountId} onValue=${(v) => { setAccountId(v); const a = account(v); if (a) setCurrency(a.currency); }} /></${Field}>`
          : html`<${Field} label=${t('doc.partner')}><${PartnerPicker} value=${partner} onChange=${setPartner} kind="supplier" /></${Field}>`}
        <${Field} label=${t('common.currency')}><${CurrencySelect} value=${currency} onValue=${setCurrency} /></${Field}>
        <${Field} label=${t('pay.amount')} required><div class="input-wrap"><${NumInput} value=${amount} onValue=${setAmount} dec=${decimals(currency)} cls="has-suffix" /><span class="suffix">${currency}</span></div></${Field}>
      </div>
      ${mode === 'paid' && acc && acc.currency !== currency && html`<${Notice} kind="warn">${t('fin.converted_note', { amount: money((amount || 0) * (currency === 'USD' ? rate : 1 / rate), acc.currency), account: acc.name })}</${Notice}>`}
      <div class="form-2">
        <${Field} label=${t('fin.staff')} hint=${t('fin.staff_hint')}><${StaffSelect} value=${staffId} onValue=${setStaffId} /></${Field}>
        <${Field} label=${t('rate.label')}><${NumInput} value=${rate} onValue=${setRate} dec=${2} /></${Field}>
      </div>
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ recurring template */
function RecurringDialog({ item, close }) {
  const r0 = item || {};
  const [kind, setKind] = useState(r0.kind || 'expense');
  const [categoryId, setCategoryId] = useState(r0.category_id || '');
  const [desc, setDesc] = useState(r0.description || '');
  const [accountId, setAccountId] = useState(r0.account_id || '');
  const [currency, setCurrency] = useState(r0.currency || 'IQD');
  const [amount, setAmount] = useState(r0.amount ?? null);
  const [day, setDay] = useState(r0.day_of_month || 1);
  const [active, setActive] = useState(r0.active === undefined ? true : !!r0.active);
  const save = async () => {
    try {
      await api.post('/api/finance/recurring', { id: r0.id, kind, category_id: categoryId || null, description: desc, account_id: accountId || null, currency, amount, day_of_month: day, active });
      toast(t('common.saved'));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${r0.id ? t('fin.recurring_edit') : t('fin.recurring_new')} close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!(amount > 0)}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Segmented} value=${kind} onValue=${(v) => { setKind(v); setCategoryId(''); }} options=${[{ value: 'expense', label: t('fin.expense') }, { value: 'income', label: t('fin.income') }]} />
      <div class="form-2">
        <${Field} label=${t('fin.category')}><${Select} value=${categoryId} onValue=${setCategoryId} placeholder="—" options=${categoryOptions(kind, categoryId)} /></${Field}>
        <${Field} label=${t('fin.day_of_month')} hint=${t('fin.day_hint')}><${NumInput} value=${day} onValue=${(v) => setDay(Math.min(28, Math.max(1, Math.round(v || 1))))} dec=${0} /></${Field}>
      </div>
      <${Field} label=${t('common.description')}><${Input} value=${desc} onValue=${setDesc} /></${Field}>
      <div class="form-3">
        <${Field} label=${t('pay.account')} hint=${t('fin.recurring_account_hint')}><${AccountSelect} value=${accountId} placeholder="—" onValue=${(v) => { setAccountId(v); const a = account(v); if (a) setCurrency(a.currency); }} /></${Field}>
        <${Field} label=${t('common.currency')}><${CurrencySelect} value=${currency} onValue=${setCurrency} /></${Field}>
        <${Field} label=${t('pay.amount')}><${NumInput} value=${amount} onValue=${setAmount} dec=${decimals(currency)} /></${Field}>
      </div>
      <${Check} checked=${active} onValue=${setActive} label=${t('common.active')} />
    </div>
  </${Modal}>`;
}

function CategoryDialog({ item, kind, close }) {
  const c0 = item || {};
  const [name, setName] = useState(c0.name || '');
  const [k, setK] = useState(c0.kind || kind || 'expense');
  const [inPl, setInPl] = useState(c0.in_pl === undefined ? true : !!c0.in_pl);
  const [active, setActive] = useState(c0.active === undefined ? true : !!c0.active);
  const save = async () => {
    try {
      await api.post('/api/finance/categories', { id: c0.id, name, kind: k, in_pl: inPl, active });
      await refreshBoot();
      toast(t('common.saved'));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${c0.id ? t('fin.category_edit') : t('fin.category_new')} close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      ${!c0.id && html`<${Segmented} value=${k} onValue=${setK} options=${[{ value: 'expense', label: t('fin.expense') }, { value: 'income', label: t('fin.income') }]} />`}
      <${Field} label=${t('common.name')}><${Input} value=${name} onValue=${setName} autoFocus /></${Field}>
      <${Check} checked=${inPl} onValue=${setInPl} label=${t('fin.in_pl')} />
      <p class="small muted" style="margin-top:-6px">${t('fin.in_pl_hint')}</p>
      <${Check} checked=${active} onValue=${setActive} label=${t('common.active')} />
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ page */
export function Finance({ query = {} }) {
  useTitle(t('nav.finance'));
  const tab = query.tab || 'entries';
  return html`<div class="page">
    <${Tabs} value=${tab} onValue=${(v) => setQuery({ tab: v === 'entries' ? undefined : v })} tabs=${[
      { id: 'entries', label: t('fin.entries'), icon: 'receipt-text' },
      { id: 'summary', label: t('fin.summary'), icon: 'chart-pie' },
      { id: 'recurring', label: t('fin.recurring'), icon: 'refresh-cw' },
      { id: 'categories', label: t('fin.categories'), icon: 'tag' },
    ]} />
    ${tab === 'entries' && html`<${Entries} query=${query} />`}
    ${tab === 'summary' && html`<${Summary} />`}
    ${tab === 'recurring' && html`<${Recurring} />`}
    ${tab === 'categories' && html`<${Categories} />`}
  </div>`;
}

function Entries({ query }) {
  const def = periodRange('month');
  const [f, setF] = useState({ kind: query.kind || '', from: def.from, to: def.to, category_id: '', account_id: '', q: '', status: '' });
  const dq = useDebounced(f.q, 300);
  const { data, loading, error, reload } = useAsync(() => api.get('/api/finance/entries', { ...f, q: dq, status: f.status || undefined }), [f.kind, f.from, f.to, f.category_id, f.account_id, dq, f.status]);
  const add = (kind) => openModal(FinanceEntryDialog, { kind }).then((r) => r && reload());
  const edit = (e) => { if (e.status !== 'posted' || !can('finance.manage')) return; openModal(FinanceEntryDialog, { entry: e }).then((r) => r && reload()); };
  const cancel = async (e) => {
    const reason = await promptDialog({ title: t('fin.cancel_title', { no: e.no }), inputLabel: t('common.reason'), okText: t('common.cancel_doc'), danger: true });
    if (reason === null || reason === undefined) return;
    try { await api.post(`/api/finance/entries/${e.id}/cancel`, { reason }); toast(t('common.cancelled')); reload(); } catch (x) { errToast(x); }
  };
  const rows = (data && data.rows) || [];
  const exportX = () => downloadXlsx(`${t('nav.finance')}-${f.from}-${f.to}`, [{
    name: t('nav.finance'),
    headers: [t('doc.no'), t('common.date'), t('common.type'), t('fin.category'), t('common.description'), t('pay.account'), t('common.currency'), t('pay.amount'), 'USD', t('common.user')],
    rows: rows.filter((r) => r.status === 'posted').map((r) => [r.no, r.date, t(`fin.${r.kind}`), r.category_name || '', r.description || '', r.account_name || r.partner_name || '', r.currency, r.amount, r.amount_usd, r.user_name || '']),
  }]);
  const catOpts = [...categoryOptions('expense'), ...categoryOptions('income')];
  return html`<div>
    <div class="toolbar">
      <${Segmented} value=${f.kind} onValue=${(v) => setF({ ...f, kind: v, category_id: '' })} options=${[{ value: '', label: t('common.all') }, { value: 'expense', label: t('fin.expenses') }, { value: 'income', label: t('fin.incomes') }]} />
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      <div style="width:190px"><${Select} value=${f.category_id} onValue=${(v) => setF({ ...f, category_id: v })} placeholder=${t('fin.all_categories')} options=${f.kind ? categoryOptions(f.kind) : catOpts} /></div>
      <div style="width:190px"><${Select} value=${f.account_id} onValue=${(v) => setF({ ...f, account_id: v })} placeholder=${t('pay.all_accounts')} options=${accountOptions({ includeInactive: true })} /></div>
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
      <${Check} checked=${f.status === 'all'} onValue=${(v) => setF({ ...f, status: v ? 'all' : '' })} label=${t('common.show_cancelled')} />
      <div class="toolbar-end">
      <${IconBtn} icon="file-spreadsheet" title=${t('common.export_excel')} onClick=${exportX} />
      ${can('finance.manage') && html`<${Btn} icon="plus" onClick=${() => add('income')}>${t('fin.new_income')}</${Btn}><${Btn} kind="primary" icon="plus" onClick=${() => add('expense')}>${t('fin.new_expense')}</${Btn}>`}
      </div>
    </div>
    ${data && html`<div class="row wrap gap-16 mb-12 small">
      ${Object.entries(data.by_currency).map(([c, v]) => html`<span><span class="muted">${c}:</span> <${Money} value=${v} cur=${c} strong /></span>`)}
      <span class="muted">≈ ${display(data.total_usd)}</span>
    </div>`}
    <div class="panel">
      ${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table}
        rows=${rows} onRow=${edit} rowCls=${(r) => (r.status !== 'posted' ? 'cancelled' : '')}
        empty=${html`<${Empty} icon="receipt-text" title=${t('fin.none')} action=${can('finance.manage') && html`<${Btn} kind="primary" icon="plus" onClick=${() => add('expense')}>${t('fin.new_expense')}</${Btn}>`} />`}
        columns=${[
          { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
          { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
          { key: 'kind', label: t('common.type'), render: (r) => html`<${Pill} kind=${r.kind === 'expense' ? 'out' : 'in'}>${t(`fin.${r.kind}`)}</${Pill}>` },
          { key: 'cat', label: t('fin.category'), render: (r) => html`<span>${r.category_name || '—'}</span>${r.in_pl === 0 ? html` <${Pill} title=${t('fin.not_in_pl')}>${t('fin.not_pl_short')}</${Pill}>` : null}` },
          { key: 'desc', label: t('common.description'), render: (r) => html`<span dir="auto">${r.description || ''}</span>${r.staff_name ? html`<div class="sub">${r.staff_name}</div>` : null}` },
          { key: 'acc', label: t('pay.account'), render: (r) => html`<span class="small">${r.account_name || (r.partner_name ? html`<span class="warn-text">${t('fin.owed')}: ${r.partner_name}</span>` : '—')}</span>` },
          { key: 'amount', label: t('pay.amount'), align: 'r', render: (r) => html`<${Money} value=${r.kind === 'expense' ? -r.amount : r.amount} cur=${r.currency} colored strong />` },
          { key: 'user', label: t('common.user'), render: (r) => html`<span class="small muted">${r.user_name || ''}</span>` },
          can('finance.manage') && { key: 'act', label: '', cls: 'w-actions', render: (r) => r.status === 'posted' && html`<${IconBtn} icon="ban" danger title=${t('common.cancel_doc')} onClick=${() => cancel(r)} />` },
        ]} />`}
    </div>
  </div>`;
}

function Summary() {
  const def = periodRange('month');
  const [f, setF] = useState({ from: def.from, to: def.to });
  const { data, loading } = useAsync(() => (can('reports.finance') ? api.get('/api/reports/incomeExpense', { ...f, mode: 'IQD' }) : api.get('/api/finance/entries', f).then((r) => ({ rows: r.by_category.map((c) => ({ ...c, category_name: c.name, amount: c.amount_usd })), mode: 'USD' }))), [f.from, f.to]);
  const rows = (data && data.rows) || [];
  const exp = rows.filter((r) => r.kind === 'expense');
  const inc = rows.filter((r) => r.kind === 'income');
  const mode = (data && data.mode) || 'USD';
  const totalE = exp.reduce((s, r) => s + r.amount, 0);
  const totalI = inc.reduce((s, r) => s + r.amount, 0);
  const block = (title, list, total, color) => html`<${Panel} title=${title} tools=${html`<b class="num">${money(total, mode)}</b>`}>
    ${!list.length ? html`<p class="small muted">${t('common.empty')}</p>` : html`<div class="col gap-12">${list.map((r) => html`<div>
      <div class="row between small"><span dir="auto">${r.category_name || t('fin.uncategorized')}${r.in_pl === 0 ? html` <span class="muted">(${t('fin.not_pl_short')})</span>` : ''}</span><span class="num strong">${money(r.amount, mode)}</span></div>
      <div class="meter mt-8"><i style=${`width:${total ? Math.max(2, r.amount / total * 100) : 0}%;background:${color}`}></i></div>
    </div>`)}</div>`}
  </${Panel}>`;
  return html`<div>
    <div class="toolbar"><${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF(r)} /></div>
    ${loading && !data ? html`<${Loading} />` : html`<div class="grid-2">${block(t('fin.expenses'), exp, totalE, 'var(--series-1)')}${block(t('fin.incomes'), inc, totalI, 'var(--series-2)')}</div>`}
  </div>`;
}

function Recurring() {
  const { data, loading, reload } = useAsync(() => api.get('/api/finance/recurring'), []);
  const edit = (item) => openModal(RecurringDialog, { item }).then((r) => r && reload());
  const del = async (r) => {
    if (!(await confirmDialog({ title: t('common.delete'), text: t('fin.recurring_delete', { name: r.description || r.category_name || '' }), danger: true, okText: t('common.delete') }))) return;
    try { await api.del(`/api/finance/recurring/${r.id}`); reload(); } catch (e) { errToast(e); }
  };
  const generate = async (ids) => {
    try { const r = await api.post('/api/finance/recurring/generate', { ids }); toast(r.created ? t('fin.generated', { n: r.created }) : t('fin.nothing_to_generate')); reload(); } catch (e) { errToast(e); }
  };
  const rows = data || [];
  const day = Number(today().slice(8, 10));
  const pending = rows.filter((r) => r.active && !r.this_month_entry);
  return html`<div>
    <div class="toolbar">
      <p class="small muted grow" style="margin:0">${t('fin.recurring_text')}</p>
      ${can('finance.manage') && html`<${Btn} icon="refresh-cw" disabled=${!pending.length} onClick=${() => generate(pending.map((r) => r.id))}>${t('fin.generate_all', { n: pending.length })}</${Btn}>
        <${Btn} kind="primary" icon="plus" onClick=${() => edit(null)}>${t('fin.recurring_new')}</${Btn}>`}
    </div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${rows} onRow=${can('finance.manage') ? edit : null}
      empty=${html`<${Empty} icon="refresh-cw" title=${t('fin.recurring_none')} />`}
      columns=${[
        { key: 'day', label: t('fin.day_of_month'), render: (r) => html`<span class="num strong">${r.day_of_month}</span>` },
        { key: 'desc', label: t('common.description'), render: (r) => html`<span dir="auto">${r.description || r.category_name || '—'}</span><div class="sub">${r.category_name || ''}</div>` },
        { key: 'acc', label: t('pay.account'), render: (r) => r.account_name || html`<span class="muted">${t('fin.default_cash')}</span>` },
        { key: 'amount', label: t('pay.amount'), align: 'r', render: (r) => html`<${Money} value=${r.kind === 'expense' ? -r.amount : r.amount} cur=${r.currency} colored />` },
        { key: 'state', label: t('fin.this_month'), render: (r) => !r.active ? html`<${Pill}>${t('common.inactive')}</${Pill}>` : r.this_month_entry ? html`<${Pill} kind="in" dot>${t('fin.generated_short')}</${Pill}>` : r.day_of_month <= day ? html`<${Pill} kind="warn" dot>${t('fin.due')}</${Pill}>` : html`<${Pill} dot>${t('fin.upcoming')}</${Pill}>` },
        can('finance.manage') && { key: 'act', label: '', cls: 'w-actions', render: (r) => html`<div class="row gap-4">
          ${r.active && !r.this_month_entry && html`<${Btn} size="sm" onClick=${() => generate([r.id])}>${t('fin.generate')}</${Btn}>`}
          <${IconBtn} icon="trash-2" danger title=${t('common.delete')} onClick=${() => del(r)} /></div>` },
      ]} />`}</div>
  </div>`;
}

function Categories() {
  const { data, loading, reload } = useAsync(() => api.get('/api/finance/categories', { include_inactive: 1 }), []);
  const edit = (item, kind) => openModal(CategoryDialog, { item, kind }).then((r) => r && reload());
  const rows = data || [];
  const list = (kind) => html`<${Panel} title=${t(kind === 'expense' ? 'fin.expense_categories' : 'fin.income_categories')} body=${false}
    tools=${can('finance.manage') && html`<${Btn} size="sm" icon="plus" onClick=${() => edit(null, kind)}>${t('common.add')}</${Btn}>`}>
    <${Table} rows=${rows.filter((r) => r.kind === kind)} onRow=${can('finance.manage') ? (r) => edit(r) : null} rowCls=${(r) => (r.active ? '' : 'cancelled')}
      columns=${[
        { key: 'name', label: t('common.name'), render: (r) => html`<span dir="auto">${r.name}</span>` },
        { key: 'pl', label: t('fin.in_pl_short'), render: (r) => (r.in_pl ? html`<${Pill} kind="in">${t('common.yes')}</${Pill}>` : html`<${Pill}>${t('common.no')}</${Pill}>`) },
      ]} />
  </${Panel}>`;
  return loading && !data ? html`<${Loading} />` : html`<div class="grid-2">${list('expense')}${list('income')}</div>`;
}
