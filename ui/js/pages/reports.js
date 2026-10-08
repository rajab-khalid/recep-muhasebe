// Report centre: every report renders the same table model on screen, on paper and in Excel.
import { html, useState, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { money, num, qty as fqty, pct as fpct, date as fdate, dateTime, today, monthName, shortMonth, addDays, compact } from '../core/format.js';
import { Icon, Btn, IconBtn, Field, Input, Select, Segmented, Panel, Empty, Loading, Notice, Pill, DateRange, periodRange, useAsync, DateInput } from '../core/ui.js';
import { printTables } from '../core/print.js';
import { downloadXlsx } from '../core/xlsx.js';
import { BarChart } from '../core/charts.js';
import { StaffSelect, CategorySelect, BrandSelect, WarehouseSelect } from './pickers.js';

/* ------------------------------------------------------------------ cell helpers */
const M = (v, cur) => ({ text: money(v || 0, cur), v: Number(v) || 0, cls: v < 0 ? 'neg' : '' });
const N = (v, d = 2) => ({ text: num(v || 0, d), v: Number(v) || 0 });
const Q = (v) => ({ text: fqty(v || 0), v: Number(v) || 0 });
const P = (v) => ({ text: v === null || v === undefined ? '' : fpct(v), v: v === null || v === undefined ? '' : v / 100, cls: v < 0 ? 'neg' : '' });
const L = (text, href) => ({ text: text || '—', href });
const D = (d) => ({ text: d ? fdate(d) : '', v: d || '' });
const cellText = (c) => (c && typeof c === 'object' ? c.text : c ?? '');
const cellVal = (c) => (c && typeof c === 'object' ? (c.v !== undefined ? c.v : c.text) : c ?? '');

const profitOK = () => can('reports.profit');

/* ------------------------------------------------------------------ definitions */
const REPORTS = {
  salesSummary: {
    group: 'sales', icon: 'chart-column', perm: 'reports.sales', filters: ['range', 'mode', 'group', 'staff'],
    chart: (d) => ({ labels: d.rows.map((r) => r.period), labelFmt: (l) => (d.group === 'month' ? shortMonth(l) : d.group === 'week' ? l.slice(5) : l.slice(5).replace('-', '.')),
      series: [{ label: t('report.col.net'), values: d.rows.map((r) => r.net), color: 'var(--series-1)' }, ...(profitOK() ? [{ label: t('report.col.profit'), values: d.rows.map((r) => r.profit), color: 'var(--series-2)' }] : [])] }),
    tables: (d) => [{
      headers: [h('period'), h('count', 1), h('gross', 1), h('returns', 1), h('discount', 1), h('net', 1), ...(profitOK() ? [h('cost', 1), h('profit', 1), h('margin', 1)] : []), h('avg', 1)],
      rows: d.rows.map((r) => [d.group === 'month' ? monthName(r.period) : d.group === 'week' ? r.period : fdate(r.period), N(r.count, 0), M(r.gross, d.mode), M(r.returns, d.mode), M(r.discount, d.mode), M(r.net, d.mode),
        ...(profitOK() ? [M(r.cost, d.mode), M(r.profit, d.mode), P(r.margin)] : []), M(r.avg, d.mode)]),
      foot: [t('common.total'), N(d.totals.count, 0), M(d.totals.gross, d.mode), M(d.totals.returns, d.mode), M(d.totals.discount, d.mode), M(d.totals.net, d.mode),
        ...(profitOK() ? [M(d.totals.cost, d.mode), M(d.totals.profit, d.mode), P(d.totals.margin)] : []), ''],
    }, d.by_currency && d.by_currency.length > 1 && {
      title: t('report.by_doc_currency'), headers: [h('currency'), h('count', 1), h('total', 1)],
      rows: d.by_currency.map((c) => [c.currency, N(c.count, 0), M(c.total, c.currency)]),
    }].filter(Boolean),
  },
  salesByProduct: { group: 'sales', icon: 'package', perm: 'reports.sales', filters: ['range', 'mode', 'category', 'brand', 'staff'], tables: (d) => [lineTable(d, (r) => L(r.name, r.key && !String(r.key).startsWith('labor:') ? `#/products/${r.key}` : null))] },
  salesByCategory: { group: 'sales', icon: 'layout-grid', perm: 'reports.sales', filters: ['range', 'mode'], tables: (d) => [lineTable(d, (r) => r.name || t('report.uncategorized'))], bars: true },
  salesByBrand: { group: 'sales', icon: 'tag', perm: 'reports.sales', filters: ['range', 'mode'], tables: (d) => [lineTable(d, (r) => r.name || t('report.no_brand'))], bars: true },
  salesByKind: { group: 'sales', icon: 'wrench', perm: 'reports.sales', filters: ['range', 'mode'], tables: (d) => [lineTable(d, (r) => t(`doc.kind.${r.key}`))], bars: true },
  salesByCustomer: {
    group: 'sales', icon: 'users', perm: 'reports.sales', filters: ['range', 'mode'],
    tables: (d) => [{
      headers: [h('customer'), h('docs', 1), h('revenue', 1), ...(profitOK() ? [h('profit', 1), h('margin', 1)] : []), h('last_date'), h('balance', 1)],
      rows: d.rows.map((r) => [L(r.name, r.key ? `#/partner/${r.key}` : null), N(r.doc_count, 0), M(r.revenue, d.mode), ...(profitOK() ? [M(r.profit, d.mode), P(r.margin)] : []), D(r.last_date),
        Object.entries(r.balances || {}).map(([c, v]) => money(v, c)).join(' + ')]),
      foot: [t('common.total'), N(d.totals.doc_count, 0), M(d.totals.revenue, d.mode), ...(profitOK() ? [M(d.totals.profit, d.mode), ''] : []), '', ''],
    }],
  },
  bestSellers: {
    group: 'sales', icon: 'star', perm: 'reports.sales', filters: ['range', 'mode', 'by', 'category'], defaults: { by: 'qty', limit: 100 },
    tables: (d) => [lineTable(d, (r) => L(r.name, `#/products/${r.key}`))],
  },
  staffPerformance: {
    group: 'sales', icon: 'user-cog', perm: 'reports.sales', filters: ['range', 'mode'],
    tables: (d) => [{
      note: t('report.commission_basis', { basis: t(`report.basis.${d.basis}`) }),
      headers: [h('staff'), h('docs', 1), h('revenue', 1), ...(profitOK() ? [h('profit', 1)] : []), h('labor', 1), h('jobs', 1), h('sales_pct', 1), h('labor_pct', 1), ...(profitOK() ? [h('commission', 1)] : [])],
      rows: d.rows.map((r) => [r.name, N(r.doc_count, 0), M(r.revenue, d.mode), ...(profitOK() ? [M(r.profit, d.mode)] : []), M(r.labor, d.mode), N(r.jobs, 0), P(r.sales_pct), P(r.labor_pct), ...(profitOK() ? [M(r.commission, d.mode)] : [])]),
    }],
  },
  stockValueBy: {
    group: 'stock', icon: 'boxes', perm: 'reports.stock', filters: ['mode', 'stockBy', 'warehouse'], defaults: { by: 'category' },
    tables: (d) => [{
      headers: [h(d.by === 'brand' ? 'brand' : 'category'), h('products', 1), h('qty', 1), ...(d.rows.some((r) => r.value !== undefined) ? [h('stock_value', 1), h('retail_value', 1)] : [])],
      rows: d.rows.map((r) => [r.name || '—', N(r.products, 0), Q(r.qty), ...(r.value !== undefined ? [M(r.value, d.mode), M(r.retail_value, d.mode)] : [])]),
      foot: [t('common.total'), N(d.totals.products, 0), Q(d.totals.qty), ...(d.totals.value !== undefined ? [M(d.totals.value, d.mode), M(d.totals.retail_value, d.mode)] : [])],
    }],
  },
  deadStock: {
    group: 'stock', icon: 'hourglass', perm: 'reports.stock', filters: ['days', 'mode'],
    tables: (d) => [{
      note: t('report.dead_note', { days: d.days }),
      headers: [h('product'), h('code'), h('qty', 1), ...(d.rows.some((r) => r.value !== undefined) ? [h('stock_value', 1)] : []), h('last_sale'), h('idle_days', 1)],
      rows: d.rows.map((r) => [L(r.name, `#/products/${r.id}`), r.code || '', Q(r.qty), ...(r.value !== undefined ? [M(r.value, d.mode)] : []), D(r.last_sale_date), r.idle_days === null ? t('report.never_sold') : N(r.idle_days, 0)]),
      foot: d.total !== undefined ? [t('common.total'), '', '', M(d.total, d.mode), '', ''] : null,
    }],
  },
  stockLevels: { group: 'stock', icon: 'boxes', perm: 'reports.stock', link: '/stock' },
  purchaseSuggestions: { group: 'stock', icon: 'clipboard-list', perm: 'reports.stock', link: '/stock/suggestions' },
  stockMoves: { group: 'stock', icon: 'arrow-left-right', perm: 'reports.stock', link: '/stock/moves' },
  dayEnd: {
    group: 'finance', icon: 'calendar', perm: 'reports.finance', filters: ['date'],
    tables: (d) => [
      { title: t('report.day.sales'), headers: [h('currency'), h('channel'), h('count', 1), h('total', 1), h('paid', 1), h('discount', 1)],
        rows: d.sales.map((r) => [r.currency, r.channel === 'pos' ? 'POS' : t('report.channel_invoice'), N(r.count, 0), M(r.total, r.currency), M(r.paid, r.currency), M(r.discount, r.currency)]) },
      d.returns.length > 0 && { title: t('report.day.returns'), headers: [h('currency'), h('count', 1), h('total', 1)], rows: d.returns.map((r) => [r.currency, N(r.count, 0), M(r.total, r.currency)]) },
      { title: t('report.day.accounts'), headers: [h('account'), h('currency'), h('opening', 1), h('closing', 1), h('change', 1)],
        rows: d.accounts.map((a) => [a.name, a.currency, M(a.opening, a.currency), M(a.closing, a.currency), M(a.closing - a.opening, a.currency)]) },
      { title: t('report.day.money'), headers: [h('account'), h('type'), h('in', 1), h('out', 1), h('count', 1)],
        rows: d.money.map((r) => [r.account_name, t(`move.money.${r.kind}`), M(r.tin, r.currency), M(r.tout, r.currency), N(r.n, 0)]) },
      d.by_user.length > 0 && { title: t('report.day.by_user'), headers: [h('staff'), h('currency'), h('count', 1), h('total', 1)], rows: d.by_user.map((r) => [r.name || '—', r.currency, N(r.count, 0), M(r.total, r.currency)]) },
      d.expenses.length > 0 && { title: t('report.day.expenses'), headers: [h('category'), h('count', 1), h('amount', 1)], rows: d.expenses.map((r) => [r.category_name || '—', N(r.n, 0), M(r.amount, r.currency)]) },
      d.credit_sales.length > 0 && { title: t('report.day.credit'), headers: [h('no'), h('customer'), h('open', 1)], rows: d.credit_sales.map((r) => [r.no, r.partner_name || '', M(r.open, r.currency)]) },
      d.cancelled.length > 0 && { title: t('report.day.cancelled'), headers: [h('no'), h('total', 1), h('user'), h('reason')], rows: d.cancelled.map((r) => [r.no, M(r.total, r.currency), r.user_name || '', r.cancel_reason || '']) },
    ].filter(Boolean),
  },
  cashReport: {
    group: 'finance', icon: 'wallet', perm: 'reports.finance', filters: ['range'],
    tables: (d) => [{
      headers: [h('account'), h('type'), h('currency'), h('opening', 1), h('in', 1), h('out', 1), h('closing', 1)],
      rows: d.rows.map((r) => [L(r.name, `#/cash/${r.id}`), t(`cash.type.${r.type}`), r.currency, M(r.opening, r.currency), M(r.total_in, r.currency), M(r.total_out, r.currency), M(r.closing, r.currency)]),
    }, ...d.rows.filter((r) => r.by_kind.length).map((r) => ({
      title: `${r.name} (${r.currency})`, headers: [h('type'), h('count', 1), h('in', 1), h('out', 1)],
      rows: r.by_kind.map((k) => [t(`move.money.${k.kind}`), N(k.n, 0), M(k.tin, r.currency), M(k.tout, r.currency)]),
    }))],
  },
  payments: {
    group: 'finance', icon: 'hand-coins', perm: 'reports.finance', filters: ['range'],
    tables: (d) => [{
      headers: [h('direction'), h('method'), h('account'), h('count', 1), h('amount', 1), h('usd', 1)],
      rows: d.rows.map((r) => [t(r.direction === 'in' ? 'pay.dir.in' : 'pay.dir.out'), t(`pay.method.${r.method}`), r.account_name, N(r.count, 0), M(r.amount, r.currency), M(r.amount_usd, 'USD')]),
    }],
  },
  receivables: { group: 'finance', icon: 'users', perm: 'reports.finance', api: 'balances', defaults: { kind: 'receivable' }, filters: [], tables: (d) => [agingTable(d)] },
  payables: { group: 'finance', icon: 'building-2', perm: 'reports.finance', api: 'balances', defaults: { kind: 'payable' }, filters: [], tables: (d) => [agingTable(d)] },
  incomeExpense: {
    group: 'finance', icon: 'receipt-text', perm: 'reports.finance', filters: ['range', 'mode'],
    tables: (d) => ['expense', 'income'].map((k) => {
      const rows = d.rows.filter((r) => r.kind === k);
      return rows.length && { title: t(k === 'expense' ? 'fin.expenses' : 'fin.incomes'), headers: [h('category'), h('in_pl'), h('count', 1), h('amount', 1)],
        rows: rows.map((r) => [r.category_name || t('fin.uncategorized'), r.in_pl === 0 ? t('common.no') : t('common.yes'), N(r.count, 0), M(r.amount, d.mode)]),
        foot: [t('common.total'), '', '', M(rows.reduce((s, r) => s + r.amount, 0), d.mode)] };
    }).filter(Boolean),
  },
  profitLoss: { group: 'finance', icon: 'trending-up', perm: 'reports.profit', filters: ['range', 'mode'], tables: (d) => [plTable(d)], custom: 'pl' },
  profitTrend: {
    group: 'finance', icon: 'chart-column', perm: 'reports.profit', filters: ['months', 'mode'], defaults: { months: 12 },
    chart: (d) => ({ labels: d.rows.map((r) => r.month), labelFmt: shortMonth, series: [
      { label: t('report.col.net_sales'), values: d.rows.map((r) => r.net_sales), color: 'var(--series-1)' },
      { label: t('report.col.net_profit'), values: d.rows.map((r) => r.net_profit), color: 'var(--series-2)' }] }),
    tables: (d) => [{
      headers: [h('month'), h('net_sales', 1), h('gross_profit', 1), h('opex', 1), h('net_profit', 1)],
      rows: d.rows.map((r) => [monthName(r.month), M(r.net_sales, d.mode), M(r.gross_profit, d.mode), M(r.opex, d.mode), M(r.net_profit, d.mode)]),
      foot: [t('common.total'), ...['net_sales', 'gross_profit', 'opex', 'net_profit'].map((k) => M(d.rows.reduce((s, r) => s + r[k], 0), d.mode))],
    }],
  },
  rateHistory: {
    group: 'finance', icon: 'coins', perm: 'reports.finance', filters: [],
    tables: (d) => [{ headers: [h('time'), h('rate', 1), h('source'), h('user')], rows: d.map((r) => [dateTime(r.ts), N(r.rate, 2), t(`rate.src.${String(r.source).replace('v2-', '')}`), r.user_name || (String(r.source).startsWith('v2-') ? t('audit.entity.legacy') : r.source === 'setup' ? t('audit.actor.setup') : r.source === 'import' ? t('audit.actor.import') : '')]) }],
  },
};

function h(key, right) { return { label: t(`report.col.${key}`), r: !!right }; }

function lineTable(d, nameCell) {
  const prof = profitOK() && d.rows.some((r) => r.profit !== undefined);
  return {
    headers: [h('name'), h('qty', 1), h('docs', 1), h('revenue', 1), ...(prof ? [h('cost', 1), h('profit', 1), h('margin', 1)] : [])],
    rows: d.rows.map((r) => [nameCell(r), Q(r.qty), N(r.doc_count, 0), M(r.revenue, d.mode), ...(prof ? [M(r.cost, d.mode), M(r.profit, d.mode), P(r.margin)] : [])]),
    foot: d.totals ? [t('common.total'), Q(d.totals.qty), '', M(d.totals.revenue, d.mode), ...(prof ? [M(d.totals.cost, d.mode), M(d.totals.profit, d.mode), P(d.totals.margin)] : [])] : null,
  };
}

function agingTable(d) {
  return {
    note: t('report.aging_note'),
    headers: [h(d.kind === 'payable' ? 'supplier' : 'customer'), h('phone'), h('balance', 1), h('current', 1), h('d30', 1), h('d60', 1), h('d90', 1), h('d90p', 1), h('oldest')],
    rows: d.rows.map((r) => [L(r.name, `#/partner/${r.id}`), r.phone || '', Object.entries(r.balances).map(([c, v]) => money(v, c)).join(' + '),
      M(r.buckets.current, 'USD'), M(r.buckets.d30, 'USD'), M(r.buckets.d60, 'USD'), M(r.buckets.d90, 'USD'), { ...M(r.buckets.d90p, 'USD'), cls: r.buckets.d90p > 0 ? 'neg strong' : '' }, D(r.oldest)]),
    foot: [t('common.total'), '', Object.entries(d.totals).map(([c, v]) => money(v, c)).join(' + '),
      ...['current', 'd30', 'd60', 'd90', 'd90p'].map((k) => M(d.rows.reduce((s, r) => s + r.buckets[k], 0), 'USD')), ''],
  };
}

function plTable(d) {
  const m = (v) => M(v, d.mode);
  const rows = [
    [{ text: t('report.pl.sales') }, m(d.sales), ''],
    [{ text: t('report.pl.returns') }, m(-d.returns), ''],
    [{ text: t('report.pl.net_sales'), cls: 'strong' }, { ...m(d.net_sales), cls: 'strong' }, ''],
    ...Object.entries(d.revenue_by_kind || {}).map(([k, v]) => [{ text: `   ${t(`doc.kind.${k}`)}`, cls: 'muted' }, { ...m(v), cls: 'muted' }, '']),
    [{ text: t('report.pl.cogs') }, m(-d.cogs), ''],
    [{ text: t('report.pl.gross_profit'), cls: 'strong' }, { ...m(d.gross_profit), cls: `strong ${d.gross_profit < 0 ? 'neg' : 'pos'}` }, P(d.gross_margin)],
    ...d.expenses.map((x) => [{ text: `   ${x.category_name || t('fin.uncategorized')}`, cls: 'muted' }, m(-x.amount), '']),
    [{ text: t('report.pl.opex') }, m(-d.opex), ''],
    ...d.incomes.map((x) => [{ text: `   ${x.category_name || t('fin.uncategorized')}`, cls: 'muted' }, m(x.amount), '']),
    d.other_income ? [{ text: t('report.pl.other_income') }, m(d.other_income), ''] : null,
    d.stock_adjustments ? [{ text: t('report.pl.stock_adjustments') }, m(d.stock_adjustments), ''] : null,
    d.cash_differences ? [{ text: t('report.pl.cash_differences') }, m(d.cash_differences), ''] : null,
  ].filter(Boolean);
  return {
    note: t('report.pl.note', { n: d.sale_count, discounts: money(d.discounts, d.mode) }),
    headers: [{ label: '' }, { label: d.mode, r: true }, { label: t('report.col.margin'), r: true }],
    rows,
    foot: [t('report.pl.net_profit'), { ...m(d.net_profit), cls: d.net_profit < 0 ? 'neg' : 'pos' }, P(d.net_margin)],
  };
}

/* ------------------------------------------------------------------ report centre */
const GROUPS = [['sales', 'chart-column'], ['stock', 'boxes'], ['finance', 'wallet']];
export function Reports() {
  useTitle(t('nav.reports'));
  return html`<div class="page stack">
    ${GROUPS.map(([g, icon]) => {
      const list = Object.entries(REPORTS).filter(([, r]) => r.group === g && can(r.perm));
      if (!list.length) return null;
      return html`<section><h3 class="row gap-8 mb-12" style="font-size:15px"><${Icon} name=${icon} />${t(`report.group.${g}`)}</h3>
        <div class="report-grid">${list.map(([name, r]) => html`<button type="button" class="report-card" onClick=${() => navigate(r.link || `/reports/${name}`)}>
          <div class="ic"><${Icon} name=${r.icon} /></div><div><h4>${t(`report.${name}.title`)}</h4><p>${t(`report.${name}.desc`)}</p></div></button>`)}</div></section>`;
    })}
  </div>`;
}

export function ReportPage({ name, query = {} }) {
  const def = REPORTS[name];
  useTitle(def ? t(`report.${name}.title`) : t('common.not_found'), [{ label: t('nav.reports'), href: '#/reports' }]);
  const dc = useStore((s) => s.displayCurrency);
  const r0 = periodRange(name === 'deadStock' ? 'all' : 'month');
  const [f, setF] = useState({ from: query.from || r0.from, to: query.to || r0.to, date: today(), mode: dc, group: 'day', staff_id: '', category_id: '', brand_id: '', warehouse_id: '', days: 90, months: 12, by: (def && def.defaults && def.defaults.by) || '', ...(def && def.defaults) });
  const params = useMemo(() => {
    if (!def) return null;
    const p = { ...(def.defaults || {}) };
    for (const k of def.filters || []) {
      if (k === 'range') { p.from = f.from; p.to = f.to; }
      if (k === 'date') p.date = f.date;
      if (k === 'mode') p.mode = f.mode;
      if (k === 'group') p.group = f.group;
      if (k === 'staff') p.staff_id = f.staff_id;
      if (k === 'category') p.category_id = f.category_id;
      if (k === 'brand') p.brand_id = f.brand_id;
      if (k === 'warehouse') p.warehouse_id = f.warehouse_id;
      if (k === 'days') p.days = f.days;
      if (k === 'months') p.months = f.months;
      if (k === 'by' || k === 'stockBy') p.by = f.by;
    }
    return p;
  }, [JSON.stringify(f), name]);
  const { data, loading, error } = useAsync(() => (def && !def.link ? api.get(`/api/reports/${def.api || name}`, params) : Promise.resolve(null)), [JSON.stringify(params), name]);
  if (!def) return html`<${Empty} title=${t('common.not_found')} />`;
  if (def.link) { setTimeout(() => navigate(def.link), 0); return null; }
  const tables = data ? def.tables(data, f) : [];
  const subtitle = (def.filters || []).includes('range') ? `${fdate(f.from)} — ${fdate(f.to)}` : (def.filters || []).includes('date') ? fdate(f.date) : fdate(today());
  const title = t(`report.${name}.title`);
  const doPrint = () => printTables(title, `${subtitle}${(def.filters || []).includes('mode') ? ` · ${f.mode}` : ''}`, tables.map((tb) => ({
    title: tb.title, headers: tb.headers, rows: tb.rows.map((r) => r.map(cellText)), foot: tb.foot ? tb.foot.map(cellText) : null,
  })));
  const doExcel = () => downloadXlsx(`${title}-${today()}`, tables.map((tb, i) => ({
    name: tb.title || (i ? `${title} ${i + 1}` : title), headers: tb.headers.map((x) => x.label),
    rows: [...tb.rows.map((r) => r.map(cellVal)), ...(tb.foot ? [tb.foot.map(cellVal)] : [])],
  })));
  const chart = data && def.chart ? def.chart(data) : null;
  const fmtAxis = (v) => compact(v);
  const has = (k) => (def.filters || []).includes(k);
  return html`<div class="page stack">
    <div class="toolbar" style="margin:0">
      ${has('range') && html`<${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />`}
      ${has('date') && html`<${DateInput} value=${f.date} onValue=${(v) => setF({ ...f, date: v })} style="width:170px" />`}
      ${has('mode') && html`<${Segmented} value=${f.mode} onValue=${(v) => setF({ ...f, mode: v })} options=${[{ value: 'IQD', label: 'IQD' }, { value: 'USD', label: 'USD' }]} />`}
      ${has('group') && html`<${Segmented} value=${f.group} onValue=${(v) => setF({ ...f, group: v })} options=${['day', 'week', 'month'].map((g) => ({ value: g, label: t(`report.group_by.${g}`) }))} />`}
      ${has('staff') && html`<div style="width:170px"><${StaffSelect} value=${f.staff_id} onValue=${(v) => setF({ ...f, staff_id: v })} placeholder=${t('doc.all_staff')} /></div>`}
      ${has('category') && html`<div style="width:170px"><${CategorySelect} value=${f.category_id} onValue=${(v) => setF({ ...f, category_id: v })} placeholder=${t('product.all_categories')} /></div>`}
      ${has('brand') && html`<div style="width:150px"><${BrandSelect} value=${f.brand_id} onValue=${(v) => setF({ ...f, brand_id: v })} placeholder=${t('product.all_brands')} /></div>`}
      ${has('warehouse') && (boot().warehouses || []).length > 1 && html`<div style="width:170px"><${WarehouseSelect} value=${f.warehouse_id} onValue=${(v) => setF({ ...f, warehouse_id: v })} placeholder=${t('product.all_warehouses')} /></div>`}
      ${has('by') && html`<${Segmented} value=${f.by} onValue=${(v) => setF({ ...f, by: v })} options=${[{ value: 'qty', label: t('report.by_qty') }, { value: 'revenue', label: t('report.by_revenue') }]} />`}
      ${has('stockBy') && html`<${Segmented} value=${f.by} onValue=${(v) => setF({ ...f, by: v })} options=${[{ value: 'category', label: t('report.col.category') }, { value: 'brand', label: t('report.col.brand') }]} />`}
      ${has('days') && html`<div style="width:210px"><${Select} value=${String(f.days)} onValue=${(v) => setF({ ...f, days: Number(v) })} options=${[30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: t('report.no_sale_days', { n: d }) }))} /></div>`}
      ${has('months') && html`<div style="width:150px"><${Select} value=${String(f.months)} onValue=${(v) => setF({ ...f, months: Number(v) })} options=${[6, 12, 18, 24].map((d) => ({ value: String(d), label: t('report.last_months', { n: d }) }))} /></div>`}
      <div class="toolbar-end">
      <${Btn} icon="printer" onClick=${doPrint} disabled=${!data}>${t('common.print')}</${Btn}>
      <${Btn} icon="file-spreadsheet" onClick=${doExcel} disabled=${!data}>Excel</${Btn}>
      </div>
    </div>
    ${loading && !data ? html`<${Loading} />` : error ? html`<${Notice} kind="err">${error.message}</${Notice}>` : html`
      ${def.custom === 'pl' && data && html`<${PlCards} d=${data} />`}
      ${chart && chart.labels.length > 0 && html`<${Panel}><${BarChart} labels=${chart.labels} series=${chart.series} labelFmt=${chart.labelFmt} fmt=${fmtAxis} unit=${data.mode || f.mode} /></${Panel}>`}
      ${def.bars && data && data.rows.length > 0 && html`<${Panel}><${ShareBars} rows=${data.rows.slice(0, 12)} names=${tables[0].rows.slice(0, 12).map((r) => cellText(r[0]))} mode=${data.mode} /></${Panel}>`}
      ${!tables.length || tables.every((tb) => !tb.rows.length) ? html`<div class="panel"><${Empty} icon="chart-column" title=${t('report.empty')} /></div>` : tables.map((tb) => html`<${ReportTable} tb=${tb} />`)}`}
  </div>`;
}

function ReportTable({ tb }) {
  return html`<div class="panel">
    ${(tb.title || tb.note) && html`<div class="panel-head">${tb.title && html`<h2>${tb.title}</h2>`}${tb.note && html`<div class="tools small muted" style="white-space:normal">${tb.note}</div>`}</div>`}
    ${!tb.rows.length ? html`<div class="panel-body small muted">${t('report.empty')}</div>` : html`<div class="table-wrap"><table class="tbl compact">
      <thead><tr>${tb.headers.map((x) => html`<th class=${x.r ? 'r' : ''}>${x.label}</th>`)}</tr></thead>
      <tbody>${tb.rows.map((r) => html`<tr>${r.map((c, i) => {
        const o = c && typeof c === 'object' ? c : { text: c };
        return html`<td class=${`${tb.headers[i] && tb.headers[i].r ? 'r num' : ''} ${o.cls || ''}`} dir=${tb.headers[i] && tb.headers[i].r ? undefined : 'auto'}>${o.href ? html`<a href=${o.href}>${o.text}</a>` : o.text}</td>`;
      })}</tr>`)}</tbody>
      ${tb.foot && html`<tfoot><tr>${tb.foot.map((c, i) => { const o = c && typeof c === 'object' ? c : { text: c }; return html`<td class=${`${tb.headers[i] && tb.headers[i].r ? 'r num' : ''} ${o.cls || ''}`}>${o.text}</td>`; })}</tr></tfoot>`}
    </table></div>`}
  </div>`;
}

/** horizontal share bars (top 12) for category / brand / kind reports */
function ShareBars({ rows, mode, names }) {
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  const total = rows.reduce((s, r) => s + Math.max(r.revenue, 0), 0) || 1;
  return html`<div class="col gap-8">${rows.map((r, i) => html`<div class="share-row">
    <span class="ellipsis small" dir="auto">${names[i]}</span>
    <div class="meter" style="height:10px"><i style=${`width:${Math.max(1, r.revenue / max * 100)}%;background:var(--series-1)`}></i></div>
    <span class="num small strong">${money(r.revenue, mode)}</span><span class="num tiny muted">${fpct(r.revenue / total * 100, 0)}</span>
  </div>`)}</div>`;
}

function PlCards({ d }) {
  const m = (v) => money(v, d.mode);
  return html`<div class="grid-4">
    <div class="panel stat"><div class="k">${t('report.pl.net_sales')}</div><div class="v">${m(d.net_sales)}</div><div class="s">${t('report.pl.docs_n', { n: d.sale_count })}</div></div>
    <div class="panel stat"><div class="k">${t('report.pl.gross_profit')}</div><div class=${`v ${d.gross_profit < 0 ? 'neg' : 'pos'}`}>${m(d.gross_profit)}</div><div class="s">${t('report.col.margin')}: ${fpct(d.gross_margin)}</div></div>
    <div class="panel stat"><div class="k">${t('report.pl.opex')}</div><div class="v">${m(d.opex)}</div></div>
    <div class="panel stat"><div class="k">${t('report.pl.net_profit')}</div><div class=${`v ${d.net_profit < 0 ? 'neg' : 'pos'}`}>${m(d.net_profit)}</div><div class="s">${t('report.col.margin')}: ${fpct(d.net_margin)}</div></div>
  </div>`;
}
