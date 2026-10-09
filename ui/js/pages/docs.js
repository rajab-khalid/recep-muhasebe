// Documents: list, detail view and the editor for sales invoices, purchases, returns, quotes, work orders,
// purchase orders, warehouse transfers and stock adjustments.
import { html, useState, useEffect, useRef, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api, ApiError } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate, back } from '../core/router.js';
import { money, num, qty as fqty, convert, today, addDays, date as fdate, dateTime, usdIqd, round, decimals, pct as fpct, rateText } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Textarea, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Balances, KV,
  DateRange, periodRange, SearchBox, MenuButton, Combo, useAsync, useDebounced, useHotkeys, openModal, toast, errToast, promptDialog, confirmDialog, DateInput } from '../core/ui.js';
import { DOC_TYPES, MANUAL_STATUSES, ADJUST_REASONS, docType, canDoc, isEditable, isPurchaseSide, usesVehicle, usesWarehouse } from '../core/doctypes.js';
import { printDoc, previewDoc, shareDoc } from '../core/docprint.js';
import { downloadXlsx } from '../core/xlsx.js';
import { printTables } from '../core/print.js';
import { PayPill, StatusPill } from './dashboard.js';
import { actorName } from './audit.js';
import { PaymentDialog, PaymentDrawer } from './payments.js';
import {
  PartnerPicker, ProductSearch, ProductPickerDialog, VehiclePicker, AccountSelect, WarehouseSelect, CurrencySelect, StaffSelect, PriceListSelect,
  defaultAccount, account, defaultWarehouseId, defaultPriceListId, activeWarehouses, loadPartner,
} from './pickers.js';
import { dn } from '../core/names.js';

const HANDOFF_KEY = 'rm_doc_handoff';
/** pass a prepared draft to the editor (e.g. purchase order from suggestions) */
export function handoffDraft(draft) {
  try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(draft)); } catch (e) { /* ignore */ }
  navigate(`/docs/${draft.type}/new`, { handoff: 1 });
}

const tolOf = (cur) => (cur === 'IQD' ? 1 : 0.01);

/* ================================================================== list */
export function DocTable({ rows, showType, showPartner = true, onRow, compact, empty }) {
  const types = new Set(rows.map((r) => r.type));
  const has = (tp) => types.has(tp);
  const trade = rows.some((r) => DOC_TYPES[r.type] && DOC_TYPES[r.type].pay);
  const workflow = rows.some((r) => DOC_TYPES[r.type] && DOC_TYPES[r.type].statuses);
  const stockDocs = rows.some((r) => ['transfer', 'adjust'].includes(r.type));
  const vehicle = rows.some((r) => r.vehicle_plate);
  const profit = can('products.cost') && rows.some((r) => r.type === 'sale' && r.profit_usd != null);
  return html`<${Table} compact=${compact} rows=${rows} empty=${empty} onRow=${onRow || ((r) => navigate(`/doc/${r.id}`))} rowCls=${(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
    columns=${[
      { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong nowrap">${r.no}</span>${r.channel === 'pos' ? html` <${Pill}>POS</${Pill}>` : null}` },
      showType && { key: 'type', label: t('common.type'), render: (r) => t(`doc.type.${r.type}`) },
      { key: 'date', label: t('common.date'), render: (r) => html`<span class="nowrap">${fdate(r.date)}</span>` },
      showPartner && !stockDocs && { key: 'partner', label: t('doc.partner'), render: (r) => html`<span dir="auto">${dn(r.partner_name) || '—'}</span>${r.partner_phone ? html`<div class="sub">${r.partner_phone}</div>` : null}` },
      vehicle && { key: 'veh', label: t('doc.vehicle'), render: (r) => (r.vehicle_plate ? html`<span class="ltr strong">${r.vehicle_plate}</span><div class="sub" dir="auto">${r.vehicle_desc || ''}</div>` : '') },
      has('service') && { key: 'tech', label: t('doc.technician'), render: (r) => r.technician_name || '' },
      has('service') && { key: 'complaint', label: t('doc.complaint'), render: (r) => html`<span class="small ellipsis" style="max-width:260px;display:inline-block" dir="auto">${r.complaint || ''}</span>` },
      stockDocs && { key: 'wh', label: t('doc.warehouse'), render: (r) => (r.type === 'transfer' ? html`${r.warehouse_name} <${Icon} name="chevron-right" size="sm" /> ${r.to_warehouse_name}` : html`${r.warehouse_name || ''}${r.reason ? html`<div class="sub">${t(`adjust.reason.${r.reason}`)}</div>` : null}`) },
      stockDocs && { key: 'lines', label: t('doc.lines'), align: 'r', render: (r) => num(r.line_count) },
      !stockDocs && { key: 'total', label: t('doc.total'), align: 'r', render: (r) => html`<${Money} value=${r.total} cur=${r.currency} strong />` },
      trade && { key: 'rem', label: t('doc.remaining'), align: 'r', render: (r) => (r.remaining > tolOf(r.currency) && r.status === 'posted' ? html`<${Money} value=${r.remaining} cur=${r.currency} cls="neg" />${r.overdue_days ? html`<div class="sub neg">${t('doc.overdue_days', { n: r.overdue_days })}</div>` : null}` : '') },
      profit && { key: 'profit', label: t('doc.profit'), align: 'r', render: (r) => (r.type === 'sale' && r.status === 'posted' && r.profit_usd != null ? html`<span class=${`num small ${r.profit_usd < 0 ? 'neg' : 'muted'}`}>${money(convert(r.profit_usd, 'USD', r.currency, r.usd_iqd), r.currency)}</span>` : '') },
      { key: 'status', label: t('doc.status'), render: (r) => (r.status === 'cancelled' ? html`<${Pill}>${t('doc.status.cancelled')}</${Pill}>`
        : r.status === 'draft' ? html`<${Pill} kind="warn">${t('doc.status.draft')}</${Pill}>`
          : DOC_TYPES[r.type] && DOC_TYPES[r.type].statuses ? html`<${StatusPill} type=${r.type} status=${r.status} />`
            : r.payment_status ? html`<${PayPill} status=${r.payment_status} />` : html`<${Pill} kind="in">${t('doc.status.posted')}</${Pill}>`) },
      { key: 'staff', label: t('doc.staff'), render: (r) => html`<span class="small muted">${r.staff_name || r.created_by_name || ''}</span>` },
    ]} />`;
}

const PAGE = 200;

export function DocList({ type, query = {} }) {
  const def = docType(type);
  useTitle(t(def.list));
  const defaultPeriod = def.statuses ? 'all' : ['transfer', 'adjust'].includes(type) ? '3m' : 'month';
  const r0 = periodRange(query.period || defaultPeriod);
  const [f, setF] = useState({
    from: query.from || r0.from, to: query.to || r0.to, q: query.q || '', payment_status: query.payment_status || '', status: query.status || (def.statuses ? 'active' : ''),
    channel: '', staff_id: '', include_cancelled: false, overdue: query.overdue || '',
  });
  const [extra, setExtra] = useState([]);
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(f.q, 300);
  const statusParam = f.status === 'active' ? def.statuses.filter((s) => !['converted', 'invoiced', 'cancelled', 'rejected', 'delivered', 'received'].includes(s)).join(',') : f.status;
  const params = {
    type, from: f.from, to: f.to, q: dq, payment_status: f.payment_status, status: statusParam, channel: f.channel, staff_id: f.staff_id,
    include_cancelled: f.include_cancelled ? 1 : '', overdue: f.overdue ? 1 : '',
  };
  const { data, loading, error, reload } = useAsync(() => { setOffset(0); setExtra([]); return api.get('/api/docs', { ...params, limit: PAGE }); }, [JSON.stringify(params)]);
  const rows = data ? [...data.rows, ...extra] : [];
  const more = async () => {
    const next = offset + PAGE;
    try { const r = await api.get('/api/docs', { ...params, limit: PAGE, offset: next }); setExtra([...extra, ...r.rows]); setOffset(next); } catch (e) { errToast(e); }
  };
  const exportX = () => downloadXlsx(`${t(def.list)}-${f.from}-${f.to}`, [{
    name: t(def.list),
    headers: [t('doc.no'), t('common.date'), t('doc.partner'), t('doc.vehicle'), t('common.currency'), t('doc.total'), t('doc.paid'), t('doc.remaining'), t('doc.status'), t('doc.staff')],
    rows: rows.map((r) => [r.no, r.date, dn(r.partner_name) || '', r.vehicle_plate || '', r.currency, r.total, r.paid, r.remaining ?? '', r.status === 'posted' && r.payment_status ? t(`doc.pay.${r.payment_status}`) : t(`doc.status.${r.status}`), r.staff_name || '']),
  }]);
  const printList = () => printTables(t(def.list), `${fdate(f.from)} — ${fdate(f.to)}`, [{
    headers: [{ label: t('doc.no') }, { label: t('common.date') }, { label: t('doc.partner') }, { label: t('doc.total'), r: true }, { label: t('doc.remaining'), r: true }, { label: t('doc.status') }],
    rows: rows.filter((r) => r.status !== 'cancelled').map((r) => [r.no, fdate(r.date), dn(r.partner_name) || '', money(r.total, r.currency), r.remaining ? money(r.remaining, r.currency) : '', r.payment_status ? t(`doc.pay.${r.payment_status}`) : t(`doc.status.${r.status}`)]),
    foot: data ? ['', '', '', data.totals.map((x) => money(x.total, x.currency)).join(' + '), data.totals.map((x) => (x.open ? money(x.open, x.currency) : '')).filter(Boolean).join(' + '), ''] : null,
  }]);
  // nothing in the chosen dates: say so and offer the whole history (right after moving from the old program
  // this month is often empty while the earlier months are full)
  const allRange = periodRange('all');
  const filtered = !!(f.q || f.payment_status || f.overdue || f.channel || f.staff_id || (def.statuses && f.status && f.status !== 'active'));
  const emptyState = html`<${Empty} icon="search" title=${filtered ? t('doc.none_filtered') : t('doc.none_in_period')}
    text=${`${fdate(f.from)} — ${fdate(f.to)}`}
    action=${html`<div class="row gap-8 mt-12" style="justify-content:center">
      ${(f.from !== allRange.from || f.to !== allRange.to) && html`<${Btn} size="sm" icon="calendar" onClick=${() => setF({ ...f, ...allRange })}>${t('doc.show_all_dates')}</${Btn}>`}
      ${filtered && html`<${Btn} size="sm" icon="x" onClick=${() => setF({ ...f, q: '', payment_status: '', overdue: '', channel: '', staff_id: '', status: def.statuses ? 'active' : '' })}>${t('doc.clear_filters')}</${Btn}>`}
      ${!filtered && canDoc(type, 'create') && html`<${Btn} size="sm" kind="primary" icon="plus" onClick=${() => navigate(`/docs/${type}/new`)}>${t(`doc.new.${type}`)}</${Btn}>`}
    </div>`} />`;
  const statusOpts = def.statuses ? [{ value: 'active', label: t('doc.status.active') }, { value: '', label: t('common.all') }, ...def.statuses.filter((s) => s !== 'cancelled').map((s) => ({ value: s, label: t(`doc.status.${s}`) }))] : null;
  return html`<div class="page">
    <div class="toolbar">
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" placeholder=${t(usesVehicle(type) ? 'doc.search_ph_vehicle' : 'doc.search_ph')} />
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      ${statusOpts && html`<div style="width:170px"><${Select} value=${f.status} onValue=${(v) => setF({ ...f, status: v })} options=${statusOpts} /></div>`}
      ${def.pay && html`<div style="width:190px"><${Select} value=${f.overdue ? 'overdue' : f.payment_status} onValue=${(v) => setF({ ...f, payment_status: v === 'overdue' ? '' : v, overdue: v === 'overdue' ? 1 : '' })} options=${[
        { value: '', label: t('doc.pay.all') }, { value: 'open', label: t('doc.pay.open') }, { value: 'unpaid', label: t('doc.pay.unpaid') }, { value: 'partial', label: t('doc.pay.partial') },
        { value: 'paid', label: t('doc.pay.paid') }, { value: 'overdue', label: t('doc.pay.overdue') }]} /></div>`}
      ${type === 'sale' && html`<div style="width:140px"><${Select} value=${f.channel} onValue=${(v) => setF({ ...f, channel: v })} options=${[{ value: '', label: t('doc.channel.all') }, { value: 'pos', label: 'POS' }]} /></div>`}
      ${['sale', 'service', 'quote'].includes(type) && html`<div style="width:160px"><${StaffSelect} value=${f.staff_id} onValue=${(v) => setF({ ...f, staff_id: v })} placeholder=${t('doc.all_staff')} /></div>`}
      <${Check} checked=${f.include_cancelled} onValue=${(v) => setF({ ...f, include_cancelled: v })} label=${t('common.show_cancelled')} />
      <div class="toolbar-end">
      <${IconBtn} icon="printer" title=${t('common.print_list')} onClick=${printList} />
      <${IconBtn} icon="file-spreadsheet" title=${t('common.export_excel')} onClick=${exportX} />
      ${type === 'sale' && can('pos.use') && html`<${Btn} icon="shopping-cart" onClick=${() => navigate('/pos')}>${t('nav.pos')}</${Btn}>`}
      ${def.returnOf && canDoc(type, 'create') && html`<${Btn} kind="primary" icon="search" onClick=${() => openModal(FindInvoiceDialog, { type: def.returnOf }).then((d) => d && navigate(`/docs/${type}/new`, { from: d.id }))}>${t('doc.return_from_invoice')}</${Btn}>`}
      ${canDoc(type, def.returnOf ? 'create_unlinked' : 'create') && html`<${Btn} kind=${def.returnOf ? '' : 'primary'} icon="plus" onClick=${() => navigate(`/docs/${type}/new`)}>${t(`doc.new.${type}`)}</${Btn}>`}
      </div>
    </div>
    ${data && data.totals.length > 0 && html`<div class="row wrap gap-16 mb-12 small">
      <span class="muted">${t('doc.count_n', { n: data.count })}</span>
      ${!['transfer', 'adjust'].includes(type) && data.totals.map((x) => html`<span><b><${Money} value=${x.total} cur=${x.currency} /></b>${def.pay && x.open > tolOf(x.currency) ? html` <span class="muted">(${t('doc.remaining')}: <span class="neg num">${money(x.open, x.currency)}</span>)</span>` : null}</span>`)}
    </div>`}
    <div class="panel">
      ${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>`
        : html`<${DocTable} rows=${rows} showPartner=${!['transfer', 'adjust'].includes(type)} empty=${emptyState} />
          ${data && rows.length < data.count && html`<div class="panel-foot"><${Btn} size="sm" onClick=${more}>${t('common.load_more', { n: data.count - rows.length })}</${Btn}></div>`}`}
    </div>
  </div>`;
}

/** search an invoice (to return items from it) */
export function FindInvoiceDialog({ type = 'sale', close }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const { data } = useAsync(() => api.get('/api/docs', { type, q: dq, limit: 30, from: dq ? undefined : addDays(today(), -60) }), [dq]);
  return html`<${Modal} title=${t('doc.find_invoice')} close=${close} size="wide" icon="search">
    <${SearchBox} value=${q} onValue=${setQ} autoFocus placeholder=${t('doc.search_ph_vehicle')} />
    <div class="mt-12">${data ? html`<${DocTable} compact rows=${data.rows.filter((r) => r.status === 'posted')} onRow=${(r) => close(r)} />` : html`<${Loading} />`}</div>
  </${Modal}>`;
}

/* ================================================================== view */
export function DocView({ id }) {
  const { data: d, loading, error, reload } = useAsync(() => api.get(`/api/docs/${id}`), [id]);
  useTitle(d ? `${d.no}` : t('common.loading'), d ? [{ label: t(docType(d.type).list), href: `#/docs/${d.type}` }] : null);
  useHotkeys({ 'ctrl+p': () => { if (d) printDoc(d, d.type === 'service' ? 'job' : 'a4'); } }, [d]);
  if (loading && !d) return html`<${Loading} />`;
  if (error) return html`<div class="page"><${Notice} kind="err">${error.message}</${Notice}></div>`;
  const def = docType(d.type);
  const cur = d.currency;
  const posted = d.status === 'posted';
  const cancelled = d.status === 'cancelled';
  const showCost = can('products.cost') && d.cost_usd !== undefined;
  const canPay = posted && def.pay && d.remaining > tolOf(cur) && can(def.pay === 'in' ? 'payments.collect' : 'payments.pay') && d.partner_id;

  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); reload(); } catch (e) { errToast(e); } };
  const cancelDoc = async () => {
    const r = await openModal(CancelDialog, { doc: d });
    if (r) act(() => api.post(`/api/docs/${d.id}/cancel`, r), t('doc.cancelled_ok'));
  };
  const delDraft = async () => {
    if (!(await confirmDialog({ title: t('doc.delete_draft'), text: t('doc.delete_draft_text', { no: d.no }), danger: true, okText: t('common.delete') }))) return;
    try { await api.del(`/api/docs/${d.id}`); toast(t('common.deleted')); navigate(`/docs/${d.type}`); } catch (e) { errToast(e); }
  };
  const post = () => act(() => api.post(`/api/docs/${d.id}/post`), t('doc.posted_ok'));
  const setStatus = (s) => act(() => api.post(`/api/docs/${d.id}/status`, { status: s }));
  const pay = () => openModal(PaymentDialog, { doc: d }).then((r) => r && reload());

  const menu = [
    { label: t('doc.print_a4'), icon: 'printer', onClick: () => printDoc(d, 'a4') },
    d.type === 'sale' && { label: t('doc.print_receipt'), icon: 'receipt', onClick: () => printDoc(d, 'receipt') },
    d.type === 'service' && { label: t('doc.print_job'), icon: 'clipboard-list', onClick: () => printDoc(d, 'job') },
    { label: t('doc.preview'), icon: 'eye', onClick: () => previewDoc(d, 'a4') },
    { label: t('doc.share_whatsapp'), icon: 'message-circle', onClick: () => shareDoc(d) },
    '-',
    canDoc(d.type, 'create') && !['transfer', 'adjust'].includes(d.type) && { label: t('doc.copy'), icon: 'copy', onClick: () => navigate(`/docs/${d.type}/new`, { copy: d.id }) },
    d.status === 'draft' && canDoc(d.type, 'create') && { label: t('doc.delete_draft'), icon: 'trash-2', danger: true, onClick: delDraft },
    !def.posting && d.status === 'open' && !(d.related || []).some((x) => x.id !== d.ref_doc_id) && canDoc(d.type, 'create') && { label: t('common.delete'), icon: 'trash-2', danger: true, onClick: delDraft },
    !cancelled && d.status !== 'draft' && canDoc(d.type, 'cancel') && !['converted', 'invoiced'].includes(d.status) && { label: t('doc.cancel'), icon: 'ban', danger: true, onClick: cancelDoc },
  ];
  const conv = [];
  if (!cancelled) {
    if (d.type === 'quote' && !['converted', 'rejected'].includes(d.status)) {
      if (canDoc('sale', 'create')) conv.push({ label: t('doc.to_sale'), icon: 'receipt', go: `/docs/sale/new?from=${d.id}` });
      if (canDoc('service', 'create')) conv.push({ label: t('doc.to_service'), icon: 'wrench', go: `/docs/service/new?from=${d.id}` });
    }
    if (d.type === 'service' && d.status !== 'invoiced' && can('service.invoice') && canDoc('sale', 'create')) conv.push({ label: t('doc.to_invoice'), icon: 'receipt', go: `/docs/sale/new?from=${d.id}`, primary: true });
    if (d.type === 'purchase_order' && d.status !== 'received' && canDoc('purchase', 'create')) conv.push({ label: t('doc.to_purchase'), icon: 'truck', go: `/docs/purchase/new?from=${d.id}`, primary: true });
    if (d.type === 'sale' && posted && canDoc('sale_return', 'create') && d.lines.some((l) => l.kind === 'product' && l.qty - (l.returned_qty || 0) > 0)) conv.push({ label: t('doc.make_return'), icon: 'undo-2', go: `/docs/sale_return/new?from=${d.id}` });
    if (d.type === 'purchase' && posted && canDoc('purchase_return', 'create') && d.lines.some((l) => l.kind === 'product' && l.qty - (l.returned_qty || 0) > 0)) conv.push({ label: t('doc.make_purchase_return'), icon: 'rotate-ccw', go: `/docs/purchase_return/new?from=${d.id}` });
  }
  const goto = (u) => { const [p, q] = u.split('?'); navigate(p, Object.fromEntries(new URLSearchParams(q || ''))); };
  const sub = d.lines.reduce((s, l) => s + (l.kind === 'text' ? 0 : l.qty * l.unit_price), 0);
  const costCur = showCost ? d.cost_usd * d.rate : null;

  return html`<div class="page stack">
    <div class="row wrap gap-8">
      <div class="row gap-8 grow wrap">
        <${Pill} kind="dark">${t(`doc.type.${d.type}`)}</${Pill}>
        ${cancelled ? html`<${Pill} kind="out">${t('doc.status.cancelled')}</${Pill}>` : d.status === 'draft' ? html`<${Pill} kind="warn">${t('doc.status.draft')}</${Pill}>` : def.statuses ? html`<${StatusPill} type=${d.type} status=${d.status} />` : null}
        ${posted && d.payment_status && html`<${PayPill} status=${d.payment_status} />`}
        ${d.channel === 'pos' && html`<${Pill}>POS</${Pill}>`}
        ${d.ref_no && html`<span class="small muted">${t('doc.ref')}: <a href=${`#/doc/${d.ref_doc_id}`}>${d.ref_no}</a></span>`}
      </div>
      ${conv.map((c) => html`<${Btn} kind=${c.primary ? 'primary' : ''} icon=${c.icon} onClick=${() => goto(c.go)}>${c.label}</${Btn}>`)}
      ${canPay && html`<${Btn} kind="primary" icon="hand-coins" onClick=${pay}>${t(def.pay === 'in' ? 'pay.collect' : 'pay.pay')}</${Btn}>`}
      ${d.status === 'draft' && canDoc(d.type, 'create') && html`<${Btn} kind="primary" icon="check" onClick=${post}>${t('doc.post')}</${Btn}>`}
      ${isEditable(d) && html`<${Btn} icon="pencil" onClick=${() => navigate(`/doc/${d.id}/edit`)}>${t('common.edit')}</${Btn}>`}
      <${Btn} icon="printer" onClick=${() => printDoc(d, d.type === 'service' && d.status !== 'invoiced' ? 'job' : d.channel === 'pos' ? 'auto' : 'a4')}>${t('common.print')}</${Btn}>
      <${MenuButton} iconOnly icon="ellipsis" title=${t('common.more')} items=${menu} />
    </div>

    ${cancelled && html`<${Notice} kind="err">${t('doc.cancelled_info', { user: d.cancelled_by_name || '', date: dateTime(d.cancelled_at) })}${d.cancel_reason ? ` — ${d.cancel_reason}` : ''}</${Notice}>`}
    ${def.statuses && !cancelled && !['converted', 'invoiced'].includes(d.status) && canDoc(d.type, 'edit') && html`<div class="status-strip">
      ${MANUAL_STATUSES[d.type].map((s) => html`<button type="button" class=${`status-step ${d.status === s ? 'on' : ''}`} onClick=${() => d.status !== s && setStatus(s)}>${t(`doc.status.${s}`)}</button>`)}
    </div>`}

    <div class="split wide-side">
      <div class="stack">
        <${Panel} body=${false} title=${t('doc.lines')} icon="list">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th class="c" style="width:34px">#</th><th>${t('print.col.desc')}</th><th class="r">${t('print.col.qty')}</th><th class="r">${t('print.col.price')}</th>
              <th class="r">${t('print.col.discount')}</th><th class="r">${t('print.col.total')}</th>
              ${showCost && ['sale', 'sale_return', 'purchase'].includes(d.type) && html`<th class="r">${t('doc.unit_cost')}</th>`}</tr></thead>
            <tbody>${d.lines.map((l, i) => html`<tr class=${l.kind === 'text' ? 'kind-text' : ''}>
              <td class="c muted">${i + 1}</td>
              <td><div dir="auto" class=${l.kind === 'text' ? 'muted' : ''}>${l.product_id ? html`<a href=${`#/products/${l.product_id}`}>${l.description}</a>` : l.description}
                ${l.kind === 'labor' && html` <${Pill} kind="info">${t('doc.kind.labor')}</${Pill}>`}</div>
                <div class="sub">${[l.code, l.staff_name, l.warranty_until ? `${t('print.warranty_until')}: ${fdate(l.warranty_until)}` : '', l.returned_qty ? t('doc.returned_qty', { n: fqty(l.returned_qty) }) : '', l.note].filter(Boolean).join(' · ')}</div></td>
              <td class="r num">${l.kind === 'text' ? '' : html`${fqty(l.qty)} <span class="muted small">${dn(l.unit) || ''}</span>`}</td>
              <td class="r">${l.kind === 'text' || ['transfer', 'adjust'].includes(d.type) ? '' : html`<${Money} value=${l.unit_price} cur=${cur} />`}</td>
              <td class="r">${l.discount ? html`<span class="num neg small">${l.discount_pct ? fpct(l.discount_pct) : money(l.discount, cur)}</span>` : ''}</td>
              <td class="r">${l.kind === 'text' || ['transfer', 'adjust'].includes(d.type) ? '' : html`<${Money} value=${l.line_total} cur=${cur} strong />`}</td>
              ${showCost && ['sale', 'sale_return', 'purchase'].includes(d.type) && html`<td class="r small muted num">${l.unit_cost_usd != null && l.kind !== 'text' ? money(convert(l.unit_cost_usd, 'USD', cur, d.usd_iqd), cur) : ''}</td>`}
            </tr>`)}</tbody>
          </table></div>
        </${Panel}>
        <div class="grid-2">
          <div class="stack">
            ${d.type === 'service' && html`<${Panel} title=${t('doc.workshop')} icon="wrench"><div class="col gap-12">
              <div><div class="label">${t('doc.complaint')}</div><div style="white-space:pre-line" dir="auto">${d.complaint || html`<span class="muted">—</span>`}</div></div>
              <div><div class="label">${t('doc.work_done')}</div><div style="white-space:pre-line" dir="auto">${d.work_done || html`<span class="muted">—</span>`}</div></div>
            </div></${Panel}>`}
            ${(d.notes || d.internal_note) && html`<${Panel} title=${t('doc.notes')} icon="notebook-pen">
              ${d.notes && html`<div style="white-space:pre-line" dir="auto">${d.notes}</div>`}
              ${d.internal_note && html`<div class="notice warn mt-8"><${Icon} name="lock" size="sm" /><div style="white-space:pre-line" dir="auto">${d.internal_note}</div></div>`}
            </${Panel}>`}
          </div>
          ${!['transfer', 'adjust'].includes(d.type) && html`<${Panel}><div class="totals-box">
            <div class="tr"><span class="muted">${t('doc.subtotal')}</span><${Money} value=${sub} cur=${cur} /></div>
            ${d.line_discount > 0 && html`<div class="tr"><span class="muted">${t('doc.line_discounts')}</span><span class="neg num">−${money(d.line_discount, cur)}</span></div>`}
            ${d.discount > 0 && html`<div class="tr"><span class="muted">${t('doc.discount')}</span><span class="neg num">−${money(d.discount, cur)}</span></div>`}
            ${d.type === 'purchase' && d.extra_cost > 0 && html`<div class="tr"><span class="muted">${t('doc.extra_cost')}</span><${Money} value=${d.extra_cost} cur=${cur} /></div>`}
            <div class="tr grand"><span>${t('doc.grand_total')}</span><${Money} value=${d.total} cur=${cur} /></div>
            <div class="tr small muted"><span>${t('doc.rate_used')}: ${rateText(d.usd_iqd)}</span><span class="num">≈ ${money(convert(d.total, cur, cur === 'USD' ? 'IQD' : 'USD', d.usd_iqd), cur === 'USD' ? 'IQD' : 'USD')}</span></div>
            ${posted && def.pay && html`<div class="tr"><span class="muted">${t('doc.paid')}</span><${Money} value=${d.paid} cur=${cur} /></div>
              <div class="tr strong"><span>${t('doc.remaining')}</span><${Money} value=${d.remaining} cur=${cur} cls=${d.remaining > tolOf(cur) ? 'neg' : 'pos'} /></div>`}
            ${showCost && d.type === 'sale' && posted && html`<div class="tr small" style="border-top:1px dashed var(--line);padding-top:6px"><span class="muted">${t('doc.cost')}</span><span class="num">${money(costCur, cur)}</span></div>
              <div class="tr small"><span class="muted">${t('doc.profit')}${d.total ? ` (${fpct((d.total - costCur) / d.total * 100)})` : ''}</span><b class=${`num ${d.total - costCur < 0 ? 'neg' : 'pos'}`}>${money(d.total - costCur, cur)}</b></div>`}
          </div></${Panel}>`}
        </div>
      </div>

      <div class="stack">
        <${Panel} title=${t('doc.info')} icon="info"><${KV} items=${[
          [t('common.date'), fdate(d.date)],
          d.due_date && [t('doc.due_date'), html`<span class=${posted && d.payment_status !== 'paid' && d.due_date < today() ? 'neg' : ''}>${fdate(d.due_date)}</span>`],
          d.valid_until && [t('doc.valid_until'), fdate(d.valid_until)],
          d.partner_id && [t(isPurchaseSide(d.type) ? 'doc.supplier' : 'doc.customer'), html`<a href=${`#/partner/${d.partner_id}`} dir="auto">${dn(d.partner_name)}</a>`],
          d.partner_phone && [t('common.phone'), html`<span class="ltr">${d.partner_phone}</span>`],
          d.partner_balances && Object.keys(d.partner_balances).length > 0 && can('partners.balance') && [t('partner.balance'), html`<${Balances} value=${d.partner_balances} />`],
          (d.vehicle_id || d.vehicle_plate) && [t('doc.vehicle'), html`${d.vehicle_id ? html`<a href=${`#/vehicle/${d.vehicle_id}`} class="ltr strong">${d.v_plate || d.vehicle_plate || '—'}</a>` : html`<span class="ltr">${d.vehicle_plate}</span>`}<div class="sub" dir="auto">${d.vehicle_desc || ''}</div>`],
          d.km && [t('vehicle.km'), num(d.km)],
          d.warehouse_name && [t(d.type === 'transfer' ? 'doc.from_warehouse' : 'doc.warehouse'), d.warehouse_name],
          d.to_warehouse_name && [t('doc.to_warehouse'), d.to_warehouse_name],
          d.reason && d.type === 'adjust' && [t('doc.reason'), t(`adjust.reason.${d.reason}`)],
          d.price_list_name && [t('doc.price_list'), d.price_list_name],
          [t('common.currency'), `${cur}${cur !== 'USD' ? ` (${rateText(d.usd_iqd)})` : ''}`],
          d.staff_name && [t('doc.staff'), d.staff_name],
          d.technician_name && [t('doc.technician'), d.technician_name],
          [t('common.created_by'), [d.created_by_name || (d.legacy_id ? t('audit.entity.legacy') : ''), dateTime(d.created_at)].filter(Boolean).join(' · ')],
          d.updated_by_name && d.updated_at !== d.created_at && [t('common.updated_by'), `${d.updated_by_name} · ${dateTime(d.updated_at)}`],
          d.rev > 1 && [t('doc.revision'), d.rev],
        ]} /></${Panel}>

        ${def.pay && html`<${Panel} title=${t('doc.payments')} icon="hand-coins" body=${false}
          tools=${canPay && html`<${Btn} size="sm" icon="plus" onClick=${pay}>${t('common.add')}</${Btn}>`}>
          ${!d.payments.length && !d.change.length ? html`<div class="panel-body small muted">${posted ? t('doc.no_payments') : t('doc.not_posted')}</div>` : html`<div class="mini-list">
            ${d.payments.map((p) => html`<div class="mini-row link" onClick=${() => openModal(PaymentDrawer, { id: p.id }).then((r) => r && reload())}>
              <${Icon} name=${p.method === 'card' ? 'credit-card' : p.method === 'transfer' ? 'landmark' : 'banknote'} />
              <div class="grow"><div class="small strong">${p.no} · ${fdate(p.date)}</div><div class="tiny muted">${p.account_name} · ${t(`pay.method.${p.method}`)}</div></div>
              <div style="text-align:end"><${Money} value=${p.amount} cur=${p.currency} strong />${p.currency !== cur && html`<div class="tiny muted num">→ ${money(p.allocated, cur)}</div>`}</div>
            </div>`)}
            ${d.change.map((c) => html`<div class="mini-row"><${Icon} name="coins" /><div class="grow small">${t('pos.change')} · ${c.account_name}</div><span class="num neg">−${money(c.amount, c.currency)}</span></div>`)}
          </div>`}
        </${Panel}>`}

        ${d.related && d.related.length > 0 && html`<${Panel} title=${t('doc.related')} icon="link" body=${false}><div class="mini-list">
          ${d.related.map((r) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${r.id}`)}>
            <div class="grow"><div class="small strong">${r.no}</div><div class="tiny muted">${t(`doc.type.${r.type}`)} · ${fdate(r.date)}</div></div>
            <${Money} value=${r.total} cur=${r.currency} />${r.status === 'cancelled' && html`<${Pill}>${t('doc.status.cancelled')}</${Pill}>`}
          </div>`)}</div></${Panel}>`}

        ${d.history && d.history.length > 0 && html`<${Panel} title=${t('doc.history')} icon="history"><div class="timeline">
          ${d.history.map((h) => html`<div class="ev"><i></i><div><div class="small"><b>${actorName(h.user_name) || '—'}</b> · ${t(`audit.action.${h.action}`)}</div><div class="tiny muted">${dateTime(h.ts)}</div></div></div>`)}
        </div></${Panel}>`}
      </div>
    </div>
  </div>`;
}

function CancelDialog({ doc, close }) {
  const [reason, setReason] = useState('');
  const hasPays = (doc.payments || []).length > 0;
  const [cancelPays, setCancelPays] = useState(hasPays && !!doc.is_walkin);
  return html`<${Modal} title=${t('doc.cancel_title', { no: doc.no })} close=${close} icon="ban" onSubmit=${() => close({ reason, cancel_payments: cancelPays })}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.back')}</${Btn}><${Btn} type="submit" kind="danger" disabled=${!reason.trim()}>${t('doc.cancel')}</${Btn}>`}>
    <div class="col gap-12">
      <p class="dim">${t('doc.cancel_text')}</p>
      <${Field} label=${t('common.reason')} required><${Input} value=${reason} onValue=${setReason} autoFocus /></${Field}>
      ${hasPays && html`<div class="col gap-8">
        <${Check} checked=${cancelPays} onValue=${setCancelPays} label=${t('doc.cancel_payments')} />
        <p class="small muted" style="margin:0">${cancelPays ? t('doc.cancel_payments_yes') : t('doc.cancel_payments_no')}</p>
      </div>`}
    </div>
  </${Modal}>`;
}

/* ================================================================== editor */
let lineSeq = 0;
const newKey = () => `l${++lineSeq}`;

function lineCalc(l, dec) {
  if (l.kind === 'text') return { gross: 0, disc: 0, total: 0 };
  const gross = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
  let disc = Number(l.discount) || 0;
  if (l.discount_pct > 0) disc = gross * l.discount_pct / 100;
  disc = Math.min(Math.max(disc, 0), Math.abs(gross));
  return { gross, disc, total: round(gross - disc * Math.sign(gross || 1), dec) };
}

function blankDoc(type) {
  const g = boot().settings.general || {};
  return {
    id: null, type, no: '', date: today(), due_date: '', valid_until: type === 'quote' ? addDays(today(), 15) : '', status: '',
    partner: null, currency: ['transfer', 'adjust'].includes(type) ? 'USD' : (g.default_currency || 'IQD'), usd_iqd: usdIqd(),
    price_list_id: isPurchaseSide(type) ? null : defaultPriceListId(), warehouse_id: usesWarehouse(type) ? defaultWarehouseId() : null, to_warehouse_id: '',
    vehicle: null, veh: { make_id: '', model_id: '', year: null }, km: null,
    staff_id: (boot().user || {}).id || '', technician_id: '', complaint: '', work_done: '', notes: '', internal_note: '', reason: type === 'adjust' ? 'correction' : '',
    discount: 0, discount_pct: null, extra_cost: 0, extra_account_id: '', ref_doc_id: null, ref_no: null,
    lines: [], payMode: null, pays: [],
  };
}

function fromServer(src, { keepIds = true } = {}) {
  return {
    ...blankDoc(src.type),
    id: keepIds ? src.id || null : null, type: src.type, no: keepIds ? src.no || '' : '', date: keepIds && src.date ? src.date : today(),
    due_date: keepIds ? src.due_date || '' : '', valid_until: src.valid_until || (src.type === 'quote' ? addDays(today(), 15) : ''), status: keepIds ? src.status || '' : '',
    partner: src.partner_id ? { id: src.partner_id, name: src.partner_name, phone: src.partner_phone, is_walkin: src.is_walkin } : null,
    currency: src.currency, usd_iqd: keepIds ? src.usd_iqd || usdIqd() : usdIqd(), price_list_id: src.price_list_id || (isPurchaseSide(src.type) ? null : defaultPriceListId()),
    warehouse_id: src.warehouse_id || defaultWarehouseId(), to_warehouse_id: src.to_warehouse_id || '',
    vehicle: src.vehicle_id || src.vehicle_plate ? { id: src.vehicle_id || null, plate: src.v_plate || src.vehicle_plate || '', description: src.vehicle_desc || '' } : null,
    km: src.km || null, staff_id: src.staff_id || '', technician_id: src.technician_id || '', complaint: src.complaint || '', work_done: src.work_done || '',
    notes: src.notes || '', internal_note: keepIds ? src.internal_note || '' : '', reason: src.reason || (src.type === 'adjust' ? 'correction' : ''),
    discount: src.discount || 0, discount_pct: null, extra_cost: src.extra_cost || 0, extra_account_id: src.extra_account_id || '',
    ref_doc_id: src.ref_doc_id || null, ref_no: src.ref_no || null,
    lines: (src.lines || []).map((l) => ({
      key: newKey(), id: keepIds ? l.id : undefined, kind: l.kind, product_id: l.product_id, code: l.code, description: l.description, qty: l.qty, unit: l.unit,
      unit_price: l.unit_price, discount: l.discount || 0, discount_pct: l.discount_pct || null, staff_id: l.staff_id || '', ref_line_id: l.ref_line_id || null,
      max_qty: l.max_qty, note: l.note || '', unit_cost_usd: src.type === 'adjust' ? l.unit_cost_usd : undefined, received_qty: l.received_qty,
      track_stock: l.track_stock,
    })),
  };
}

export function DocEditor({ type: typeProp, id, query = {} }) {
  const [d, setD] = useState(null);
  const [info, setInfo] = useState({}); // product_id -> {stock, cost_usd, price, currency, track_stock}
  const [loadErr, setLoadErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [vehMore, setVehMore] = useState(false);
  const searchRef = useRef(null);
  const type = d ? d.type : typeProp;
  const def = docType(type);
  useTitle(d ? (d.id ? `${d.no} — ${t('common.edit')}` : t(`doc.new.${type}`)) : t('common.loading'), [{ label: t(def.list), href: `#/docs/${type}` }]);

  /* ---------- load */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let doc;
        if (id) {
          const src = await api.get(`/api/docs/${id}`);
          if (!isEditable(src)) throw new Error(t('doc.not_editable'));
          doc = fromServer(src);
          doc.status = src.status;
          doc.partner_balances = src.partner_balances;
          // a posted sale already took its items out of stock: count them as available again while editing
          if (src.status === 'posted' && ['sale', 'transfer', 'purchase_return'].includes(src.type)) {
            const q = {};
            for (const l of src.lines) if (l.product_id) q[l.product_id] = (q[l.product_id] || 0) + Number(l.qty || 0);
            doc.orig = { warehouse_id: src.warehouse_id, qty: q };
          }
        } else if (query.from) {
          doc = fromServer(await api.get(`/api/docs/${query.from}/draft-from/${typeProp}`), { keepIds: false });
          doc.ref_doc_id = query.from;
        } else if (query.copy) {
          const src = await api.get(`/api/docs/${query.copy}`);
          doc = fromServer({ ...src, type: typeProp, ref_doc_id: null, ref_no: null }, { keepIds: false });
          doc.lines.forEach((l) => { l.ref_line_id = null; l.max_qty = undefined; });
        } else if (query.handoff) {
          let h = null;
          try { h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null'); sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { /* */ }
          doc = h ? fromServer({ ...blankDoc(typeProp), ...h, type: typeProp }, { keepIds: false }) : blankDoc(typeProp);
        } else doc = blankDoc(typeProp);
        if (!id && !doc.partner && ['sale', 'quote', 'service'].includes(doc.type) && !query.partner) {
          const w = boot().walkin_id;
          if (w) doc.partner = { id: w, name: t('partner.walkin'), is_walkin: 1 };
        }
        if (query.partner) doc.partner = await loadPartner(query.partner);
        if (query.vehicle) {
          const v = await api.get(`/api/vehicles/${query.vehicle}`);
          doc.vehicle = { id: v.id, plate: v.plate, description: v.description, partner_id: v.partner_id };
          doc.km = v.km || null;
          if (v.partner_id && (!doc.partner || doc.partner.is_walkin)) doc.partner = await loadPartner(v.partner_id);
        }
        if (doc.partner && doc.partner.id && !doc.partner.balances && can(['partners.view', 'pos.use', 'sales.create'])) {
          try { doc.partner = await api.get(`/api/partners/${doc.partner.id}`); } catch (e) { /* ignore */ }
        }
        if (query.product) {
          const r = await api.post('/api/products/for-sale', { ids: [query.product], price_list_id: doc.price_list_id, warehouse_id: doc.warehouse_id });
          if (r[0]) addProductTo(doc, r[0]);
        }
        doc.payMode = defaultPayMode(doc);
        if (alive) { setD(doc); setDirty(false); }
      } catch (e) { if (alive) setLoadErr(e); }
    })();
    return () => { alive = false; };
  }, [id, typeProp, query.from, query.copy, query.partner, query.vehicle]);

  /* ---------- product info (stock, cost) for warnings */
  const productIds = d ? [...new Set(d.lines.filter((l) => l.product_id).map((l) => l.product_id))] : [];
  useEffect(() => {
    if (!d) return;
    const missing = productIds.filter((p) => !info[`${p}|${d.warehouse_id}`]);
    if (!missing.length) return;
    api.post('/api/products/for-sale', { ids: missing, price_list_id: d.price_list_id, warehouse_id: d.warehouse_id }).then((rows) => {
      setInfo((old) => { const n = { ...old }; for (const r of rows) n[`${r.id}|${d.warehouse_id}`] = r; return n; });
    }).catch(() => {});
  }, [productIds.join(','), d && d.warehouse_id]);

  const dec = d ? decimals(d.currency) : 0;
  const set = (patch) => { setD((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) })); setDirty(true); };
  const setLine = (key, patch) => set((x) => ({ lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key) => set((x) => ({ lines: x.lines.filter((l) => l.key !== key) }));
  const moveLine = (key, dir) => set((x) => {
    const i = x.lines.findIndex((l) => l.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= x.lines.length) return {};
    const lines = [...x.lines];
    [lines[i], lines[j]] = [lines[j], lines[i]];
    return { lines };
  });

  function priceFor(doc, p) {
    if (isPurchaseSide(doc.type)) return round(convert(p.cost_price || 0, p.currency, doc.currency, doc.usd_iqd), Math.max(decimals(doc.currency), 2));
    const pl = doc.price_list_id && p.prices ? p.prices[doc.price_list_id] : undefined;
    const base = pl ?? p.price ?? 0;
    return round(convert(base, p.currency, doc.currency, doc.usd_iqd), Math.max(decimals(doc.currency), 2));
  }

  function addProductTo(doc, p, qty = 1) {
    const n = Math.abs(Number(qty)) || 1;
    const existing = doc.lines.find((l) => l.product_id === p.id && !l.ref_line_id && l.kind !== 'text');
    if (existing && doc.type !== 'adjust') { existing.qty = round((Number(existing.qty) || 0) + n, 3); return; }
    const negReason = doc.type === 'adjust' && ['damage', 'loss', 'gift', 'own_use'].includes(doc.reason);
    doc.lines.push({
      key: newKey(), kind: p.type === 'service' ? 'service' : 'product', product_id: p.id, code: p.code, description: p.name, qty: negReason ? -n : n, unit: p.unit,
      unit_price: ['transfer', 'adjust'].includes(doc.type) ? 0 : priceFor(doc, p), discount: 0, discount_pct: null, staff_id: '', track_stock: p.track_stock,
      unit_cost_usd: doc.type === 'adjust' && !negReason && p.cost_usd ? round(p.cost_usd, 4) : undefined,
    });
  }

  const addProduct = (p) => {
    setD((x) => { const doc = { ...x, lines: x.lines.map((l) => ({ ...l })) }; addProductTo(doc, p); return doc; });
    setDirty(true);
  };
  /** the product list: several products, each with its own quantity */
  const openProductList = (text = '') => {
    const purchase = isPurchaseSide(d.type);
    const prices = !['transfer', 'adjust'].includes(d.type) && (!purchase || can('products.cost'));
    openModal(ProductPickerDialog, {
      q: text, priceListId: d.price_list_id, warehouseId: d.warehouse_id, type: ['transfer', 'adjust'].includes(d.type) ? 'product' : undefined,
      currency: d.currency, showPrices: prices, priceOf: prices ? (p) => priceFor(d, p) : null,
      priceLabel: purchase ? t('doc.unit_cost_price') : t('print.col.price'),
    }).then((items) => {
      if (!items || !items.length) return;
      setD((x) => { const doc = { ...x, lines: x.lines.map((l) => ({ ...l })) }; for (const it of items) addProductTo(doc, it.product, it.qty); return doc; });
      setDirty(true);
      toast(t('picker.added_n', { n: items.length }));
      setTimeout(() => searchRef.current && searchRef.current.focus(), 50);
    });
  };
  const addFree = (kind) => {
    set((x) => ({ lines: [...x.lines, { key: newKey(), kind, product_id: null, code: '', description: '', qty: kind === 'text' ? 0 : 1, unit: '', unit_price: 0, discount: 0, discount_pct: null, staff_id: kind === 'labor' ? (x.technician_id || '') : '' }] }));
    setTimeout(() => { const el = document.querySelectorAll('.lines-tbl .desc-input'); if (el.length) el[el.length - 1].focus(); }, 30);
  };

  /* ---------- currency / price list changes */
  const changeCurrency = (cur) => {
    if (!d || cur === d.currency) return;
    const from = d.currency;
    const cv = (v) => round(convert(v || 0, from, cur, d.usd_iqd), Math.max(decimals(cur), 2));
    set((x) => ({
      currency: cur,
      lines: x.lines.map((l) => ({ ...l, unit_price: cv(l.unit_price), discount: l.discount_pct ? l.discount : cv(l.discount) })),
      discount: x.discount_pct ? x.discount : cv(x.discount), extra_cost: cv(x.extra_cost), pays: [],
    }));
    if (d.lines.length) toast(t('doc.prices_converted', { from, to: cur }), 'warn');
  };
  const changePriceList = async (plId) => {
    if (!d) return;
    set({ price_list_id: plId });
    const prodLines = d.lines.filter((l) => l.product_id && !l.ref_line_id);
    if (!prodLines.length) return;
    if (!(await confirmDialog({ title: t('doc.reprice_title'), text: t('doc.reprice_text'), okText: t('doc.reprice_ok') }))) return;
    try {
      const rows = await api.post('/api/products/for-sale', { ids: prodLines.map((l) => l.product_id), price_list_id: plId, warehouse_id: d.warehouse_id });
      const map = Object.fromEntries(rows.map((r) => [r.id, r]));
      set((x) => ({ lines: x.lines.map((l) => (l.product_id && map[l.product_id] && !l.ref_line_id ? { ...l, unit_price: priceFor({ ...x, price_list_id: plId }, map[l.product_id]) } : l)) }));
    } catch (e) { errToast(e); }
  };
  const changePartner = async (p) => {
    let full = p;
    if (p && p.id && !p.balances) full = (await loadPartner(p.id)) || p;
    set((x) => {
      const patch = { partner: full };
      if (full && full.price_list_id && !isPurchaseSide(x.type) && !x.lines.length) patch.price_list_id = full.price_list_id;
      if (full && full.payment_days && ['sale', 'purchase'].includes(x.type) && !x.due_date) patch.due_date = addDays(x.date, full.payment_days);
      if (x.payMode && !x.id) patch.payMode = defaultPayMode({ ...x, partner: full });
      return patch;
    });
  };

  /* ---------- totals */
  const calc = useMemo(() => {
    if (!d) return null;
    let subtotal = 0; let lineDisc = 0; let sum = 0;
    for (const l of d.lines) { const c = lineCalc(l, dec); subtotal += c.gross; lineDisc += c.disc; sum += c.total; }
    let discount = Number(d.discount) || 0;
    if (d.discount_pct > 0) discount = sum * d.discount_pct / 100;
    discount = round(Math.min(Math.max(discount, 0), Math.max(sum, 0)), dec);
    const total = round(sum - discount, dec);
    return { subtotal, lineDisc, sum, discount, total };
  }, [d]);

  /* ---------- payments now */
  function defaultPayMode(doc) {
    if (!def.pay && !DOC_TYPES[doc.type].pay) return null;
    if (doc.id && doc.status === 'posted') return null; // existing posted document: payments are managed on the document page
    const walkin = doc.partner && doc.partner.is_walkin;
    if (doc.type === 'sale' || doc.type === 'sale_return') return walkin ? 'full' : 'credit';
    return 'credit';
  }
  const payDir = def.pay;
  const payAccount = d && d.pays[0] ? d.pays[0].account_id : (d && (defaultAccount(d.currency) || {}).id) || '';
  const paysEffective = !d || !d.payMode || d.payMode === 'credit' ? []
    : d.payMode === 'full' ? [{ account_id: payAccount, amount: calc ? round(convert(calc.total, d.currency, (account(payAccount) || { currency: d.currency }).currency, d.usd_iqd), decimals((account(payAccount) || { currency: d.currency }).currency)) : 0 }]
      : d.pays;
  const paidInDoc = d ? paysEffective.reduce((s, p) => s + convert(p.amount || 0, (account(p.account_id) || { currency: d.currency }).currency, d.currency, d.usd_iqd), 0) : 0;

  /* ---------- warnings */
  const stockOf = (l) => {
    const i = info[`${l.product_id}|${d.warehouse_id}`];
    if (!i) return null;
    const back = d.orig && d.orig.warehouse_id === d.warehouse_id ? d.orig.qty[l.product_id] || 0 : 0;
    return i.stock + back;
  };
  const costOf = (l) => { const i = info[`${l.product_id}|${d.warehouse_id}`]; return i && i.cost_usd != null ? i.cost_usd : null; };
  const docRate = d ? (d.currency === 'USD' ? 1 : d.currency === 'IQD' ? d.usd_iqd : convert(1, 'USD', d.currency)) : 1;

  /* ---------- save */
  const save = async ({ post = true, print = false, confirmCredit = false } = {}) => {
    if (!d || busy) return;
    if (!d.lines.some((l) => l.kind !== 'text' && (l.product_id || l.description))) { toast(t('doc.need_lines'), 'err'); return; }
    if (['sale', 'sale_return', 'purchase', 'purchase_return', 'purchase_order'].includes(type) && !(d.partner && d.partner.id)) { toast(t(isPurchaseSide(type) ? 'doc.need_supplier' : 'doc.need_customer'), 'err'); return; }
    if (type === 'transfer' && (!d.to_warehouse_id || d.to_warehouse_id === d.warehouse_id)) { toast(t('doc.need_two_warehouses'), 'err'); return; }
    const badReturn = d.lines.find((l) => l.max_qty != null && l.qty > l.max_qty + 1e-9);
    if (badReturn) { toast(t('doc.return_too_much', { name: badReturn.description, n: fqty(badReturn.max_qty) }), 'err'); return; }
    if (d.payMode && d.payMode !== 'credit' && paidInDoc > calc.total + tolOf(d.currency) && d.payMode !== 'full') {
      if (!(await confirmDialog({ title: t('doc.overpaid_title'), text: t('doc.overpaid_text', { amount: money(paidInDoc - calc.total, d.currency) }) }))) return;
    }
    const v = d.vehicle;
    const body = {
      id: d.id || undefined, type, date: d.date, due_date: d.due_date || null, valid_until: d.valid_until || null,
      partner_id: d.partner ? d.partner.id : null, currency: d.currency, usd_iqd: d.usd_iqd, price_list_id: d.price_list_id || null,
      warehouse_id: d.warehouse_id || null, to_warehouse_id: d.to_warehouse_id || null,
      vehicle_id: v && v.id ? v.id : null, vehicle_plate: v ? v.plate || null : null, vehicle_desc: v ? (v.description || null) : null, km: d.km || null,
      vehicle: v && !v.id && (d.veh.make_id || d.veh.model_id || d.veh.year || d.veh.make_text || d.veh.model_text) ? { ...d.veh } : undefined,
      staff_id: d.staff_id || null, technician_id: d.technician_id || null, complaint: d.complaint, work_done: d.work_done, notes: d.notes, internal_note: d.internal_note,
      reason: d.reason || null, discount: d.discount_pct ? 0 : d.discount, discount_pct: d.discount_pct || null, extra_cost: d.extra_cost || 0, extra_account_id: d.extra_account_id || null,
      ref_doc_id: d.ref_doc_id || null,
      lines: d.lines.map((l) => ({
        id: l.id, kind: l.kind, product_id: l.product_id || null, code: l.code, description: l.description, qty: l.kind === 'text' ? 0 : l.qty, unit: l.unit,
        unit_price: l.unit_price, discount: l.discount_pct ? 0 : l.discount, discount_pct: l.discount_pct || null, staff_id: l.staff_id || null,
        ref_line_id: l.ref_line_id || null, note: l.note || null, unit_cost_usd: type === 'adjust' ? (l.unit_cost_usd ?? null) : undefined, received_qty: l.received_qty,
      })),
      post: def.posting ? post : undefined,
      status: def.statuses ? (d.status || def.statuses[0]) : undefined,
      payments: def.pay && post && d.payMode && d.payMode !== 'credit' ? paysEffective.filter((p) => p.account_id && p.amount > 0).map((p) => ({ account_id: p.account_id, amount: p.amount, method: (account(p.account_id) || {}).type === 'pos' ? 'card' : undefined })) : undefined,
      confirm_credit_limit: confirmCredit || undefined,
    };
    if (type === 'adjust') body.currency = 'USD';
    setBusy(true);
    try {
      const saved = await api.post('/api/docs', body);
      setDirty(false);
      toast(t(d.id ? 'doc.updated_ok' : 'doc.saved_ok', { no: saved.no }));
      if (print) printDoc(saved, saved.type === 'service' ? 'job' : 'a4');
      navigate(`/doc/${saved.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'credit_limit') {
        const ok = await confirmDialog({ title: t('doc.credit_limit_title'), text: e.message + '\n\n' + t('doc.credit_limit_text'), okText: t('doc.save_anyway'), danger: true });
        setBusy(false);
        if (ok) save({ post, print, confirmCredit: true });
        return;
      }
      errToast(e);
    } finally { setBusy(false); }
  };

  const free = () => !document.querySelector('.overlay, .drawer');
  useHotkeys({ 'ctrl+s': () => { if (!free()) return false; save({ post: true }); return undefined; }, f9: () => { if (!free()) return false; save({ post: true }); return undefined; } }, [d, busy, calc]);

  if (loadErr) return html`<div class="page"><${Notice} kind="err">${loadErr.message}</${Notice}><div class="mt-12"><${Btn} onClick=${() => back(`/docs/${typeProp}`)}>${t('common.back')}</${Btn}></div></div>`;
  if (!d) return html`<${Loading} />`;

  const isReturn = !!def.returnOf;
  const showPrices = !['transfer', 'adjust'].includes(type);
  const showCost = can('products.cost');
  const multiWh = activeWarehouses().length > 1;
  const cancelEdit = async () => {
    if (dirty && !(await confirmDialog({ title: t('doc.discard_title'), text: t('doc.discard_text'), okText: t('doc.discard_ok'), danger: true }))) return;
    if (d.id) navigate(`/doc/${d.id}`); else back(`/docs/${type}`);
  };
  const partnerKind = def.partner;
  const lockedPartner = isReturn && !!d.ref_doc_id;

  return html`<div class="page stack">
    ${d.ref_no && html`<${Notice} icon="link">${t('doc.based_on', { no: d.ref_no })}</${Notice}>`}
    ${d.id && d.status === 'posted' && html`<${Notice} kind="warn">${t('doc.editing_posted')}</${Notice}>`}

    <${Panel}>
      <div class="doc-head">
        ${partnerKind && html`<div style="grid-column: span 2; min-width: 0">
          <${Field} label=${t(isPurchaseSide(type) ? 'doc.supplier' : 'doc.customer')} required=${type !== 'quote' && type !== 'service'}>
            <${PartnerPicker} value=${d.partner} onChange=${changePartner} kind=${partnerKind} disabled=${lockedPartner} autoFocus=${!d.partner} />
          </${Field}></div>`}
        <${Field} label=${t('common.date')}><${DateInput} value=${d.date} onValue=${(v) => set({ date: v })} /></${Field}>
        ${['sale', 'purchase'].includes(type) && html`<${Field} label=${t('doc.due_date')}><${DateInput} clearable value=${d.due_date} onValue=${(v) => set({ due_date: v })} /></${Field}>`}
        ${type === 'quote' && html`<${Field} label=${t('doc.valid_until')}><${DateInput} clearable value=${d.valid_until} onValue=${(v) => set({ valid_until: v })} /></${Field}>`}
        ${showPrices && html`<${Field} label=${t('common.currency')}><${CurrencySelect} value=${d.currency} onValue=${changeCurrency} /></${Field}>`}
        ${showPrices && html`<${Field} label=${t('rate.label')} hint=${d.usd_iqd !== usdIqd() ? t('doc.rate_now', { rate: num(usdIqd(), 2) }) : null}><${NumInput} value=${d.usd_iqd} onValue=${(v) => set({ usd_iqd: v || usdIqd() })} dec=${2} /></${Field}>`}
        ${!isPurchaseSide(type) && showPrices && html`<${Field} label=${t('doc.price_list')}><${PriceListSelect} value=${d.price_list_id} onValue=${changePriceList} /></${Field}>`}
        ${usesWarehouse(type) && (multiWh || ['transfer', 'adjust'].includes(type)) && html`<${Field} label=${t(type === 'transfer' ? 'doc.from_warehouse' : 'doc.warehouse')}><${WarehouseSelect} value=${d.warehouse_id} onValue=${(v) => set({ warehouse_id: v })} /></${Field}>`}
        ${type === 'transfer' && html`<${Field} label=${t('doc.to_warehouse')} required><${WarehouseSelect} value=${d.to_warehouse_id} onValue=${(v) => set({ to_warehouse_id: v })} placeholder="—" /></${Field}>`}
        ${type === 'adjust' && html`<${Field} label=${t('doc.reason')}><${Select} value=${d.reason} onValue=${(v) => set({ reason: v })} options=${ADJUST_REASONS.map((r) => ({ value: r, label: t(`adjust.reason.${r}`) }))} /></${Field}>`}
        ${['sale', 'quote', 'service', 'sale_return'].includes(type) && html`<${Field} label=${t('doc.staff')}><${StaffSelect} value=${d.staff_id} onValue=${(v) => set({ staff_id: v })} /></${Field}>`}
        ${type === 'service' && html`<${Field} label=${t('doc.technician')}><${StaffSelect} value=${d.technician_id} onValue=${(v) => set({ technician_id: v })} /></${Field}>`}
        ${def.statuses && html`<${Field} label=${t('doc.status')}><${Select} value=${d.status || def.statuses[0]} onValue=${(v) => set({ status: v })} options=${MANUAL_STATUSES[type].map((s) => ({ value: s, label: t(`doc.status.${s}`) }))} /></${Field}>`}
        ${type === 'purchase' && html`<${Field} label=${t('doc.extra_cost')} hint=${t('doc.extra_cost_hint')}><${NumInput} value=${d.extra_cost} onValue=${(v) => set({ extra_cost: v || 0 })} dec=${dec} /></${Field}>`}
        ${type === 'purchase' && d.extra_cost > 0 && html`<${Field} label=${t('doc.extra_account')}><${AccountSelect} value=${d.extra_account_id} onValue=${(v) => set({ extra_account_id: v })} placeholder=${t('doc.extra_unpaid')} /></${Field}>`}
      </div>
      ${d.partner && d.partner.balances && Object.keys(d.partner.balances).length > 0 && can('partners.balance') && html`<div class="row small mt-8 gap-8"><span class="muted">${t('partner.balance')}:</span><${Balances} value=${d.partner.balances} />
        ${d.partner.credit_limit ? html`<span class="muted">· ${t('partner.credit_limit')}: ${money(d.partner.credit_limit, d.partner.credit_currency || d.currency)}</span>` : null}</div>`}
    </${Panel}>

    ${usesVehicle(type) && html`<${Panel} title=${t('doc.vehicle')} icon="car">
      <div class="doc-head">
        <div style="grid-column: span 2"><${Field} label=${t('vehicle.plate')}>
          <div class="row gap-4"><div class="grow"><${VehiclePicker} value=${d.vehicle} partnerId=${d.partner && !d.partner.is_walkin ? d.partner.id : null}
            onChange=${async (v) => {
              const patch = { vehicle: v.id ? { id: v.id, plate: v.plate, description: v.description, partner_id: v.partner_id } : { id: null, plate: v.plate, description: '' } };
              if (v.id && v.km) patch.km = v.km;
              set(patch);
              if (v.id && v.partner_id && (!d.partner || d.partner.is_walkin) && !lockedPartner) changePartner(await loadPartner(v.partner_id));
              if (!v.id) setVehMore(true);
            }} /></div>
            ${d.vehicle && html`<${IconBtn} icon="x" title=${t('common.clear')} onClick=${() => set({ vehicle: null })} />`}</div>
        </${Field}></div>
        ${d.vehicle && d.vehicle.id ? html`<${Field} label=${t('vehicle.model')}><div class="input" style="display:flex;align-items:center;background:var(--surface-2)" dir="auto">${d.vehicle.description || '—'}</div></${Field}>`
          : d.vehicle && html`<${VehicleQuickFields} veh=${d.veh} onChange=${(veh) => set({ veh, vehicle: { ...d.vehicle, description: veh._desc || d.vehicle.description } })} more=${vehMore} />`}
        ${d.vehicle && html`<${Field} label=${t('vehicle.km')}><${NumInput} value=${d.km} onValue=${(v) => set({ km: v })} dec=${0} /></${Field}>`}
      </div>
      ${type === 'service' && html`<div class="form-2 mt-12">
        <${Field} label=${t('doc.complaint')}><${Textarea} value=${d.complaint} onValue=${(v) => set({ complaint: v })} rows=${3} /></${Field}>
        <${Field} label=${t('doc.work_done')}><${Textarea} value=${d.work_done} onValue=${(v) => set({ work_done: v })} rows=${3} /></${Field}>
      </div>`}
    </${Panel}>`}

    <${Panel} body=${false} title=${t('doc.lines')} icon="list"
      tools=${html`${!['transfer', 'adjust', 'purchase', 'purchase_order', 'purchase_return'].includes(type) && html`<${Btn} size="sm" icon="wrench" onClick=${() => addFree('labor')}>${t('doc.add_labor')}</${Btn}>`}
        <${Btn} size="sm" icon="type" onClick=${() => addFree('text')}>${t('doc.add_text')}</${Btn}>`}>
      <div class="panel-body" style="padding-bottom:8px">
        <div class="row gap-8">
          <${ProductSearch} onPick=${addProduct} priceListId=${d.price_list_id} warehouseId=${d.warehouse_id} currency=${showPrices ? d.currency : null} usdIqd=${d.usd_iqd} inputRef=${searchRef}
            type=${['transfer', 'adjust'].includes(type) ? 'product' : undefined} autoFocus=${!!d.partner && !d.lines.length}
            browse onMore=${openProductList} priceOf=${showPrices && (!isPurchaseSide(type) || showCost) ? (p) => priceFor(d, p) : undefined} />
          <${Btn} icon="list-checks" onClick=${() => openProductList()} title=${t('picker.all_list')}>${t('picker.open')}</${Btn}>
        </div>
      </div>
      ${!d.lines.length ? html`<${Empty} icon="package-search" title=${t('doc.no_lines')} text=${t('doc.no_lines_hint')} />` : html`<div class="table-wrap"><table class="tbl lines-tbl">
        <thead><tr><th class="col-no">#</th><th>${t('print.col.desc')}</th>
          <th class="col-qty r">${t('print.col.qty')}</th>
          ${showPrices && html`<th class="col-price r">${t(isPurchaseSide(type) ? 'doc.unit_cost_price' : 'print.col.price')}</th><th class="col-disc r">${t('print.col.discount')}</th><th class="col-total r">${t('print.col.total')}</th>`}
          ${type === 'adjust' && showCost && html`<th class="col-price r">${t('doc.unit_cost_usd')}</th>`}
          <th class="col-x"></th></tr></thead>
        <tbody>${d.lines.map((l, i) => {
          const c = lineCalc(l, dec);
          const st = l.product_id ? stockOf(l) : null;
          const cost = l.product_id && showCost ? costOf(l) : null;
          const netUnit = l.qty ? (c.total * (calc.sum ? calc.total / calc.sum : 1)) / l.qty : 0;
          const below = cost && type === 'sale' && l.kind === 'product' && netUnit < cost * docRate - 1e-6;
          const short = st !== null && l.track_stock !== 0 && ['sale', 'transfer', 'purchase_return'].includes(type) && l.kind === 'product' && Number(l.qty) > st + 1e-9;
          return html`<tr key=${l.key} class=${`kind-${l.kind}`}>
            <td class="col-no">${i + 1}</td>
            <td>
              <input class="input desc-input" value=${l.description} dir="auto" placeholder=${l.kind === 'labor' ? t('doc.labor_ph') : l.kind === 'text' ? t('doc.text_ph') : ''} onInput=${(e) => setLine(l.key, { description: e.target.value })} />
              <div class="row gap-8 tiny muted" style="margin-top:3px; flex-wrap:wrap">
                ${l.code && html`<span class="ltr">${l.code}</span>`}
                ${l.kind === 'labor' && html`<${Pill} kind="info">${t('doc.kind.labor')}</${Pill}>`}
                ${l.kind === 'service' && html`<${Pill} kind="info">${t('product.type.service')}</${Pill}>`}
                ${st !== null && l.track_stock !== 0 && l.kind === 'product' && html`<span class=${short ? 'neg strong' : ''}>${t('doc.in_stock', { n: fqty(st) })}</span>`}
                ${l.max_qty != null && html`<span>${t('doc.returnable', { n: fqty(l.max_qty) })}</span>`}
                ${cost !== null && showPrices && html`<span title=${t('doc.unit_cost')}>${t('doc.cost_short')}: ${money(cost * docRate, d.currency)}</span>`}
                ${below && html`<span class="neg strong"><${Icon} name="triangle-alert" size="sm" /> ${t('doc.below_cost')}</span>`}
                ${(l.kind === 'labor' || (type === 'service' && l.kind !== 'text')) && html`<span style="width:150px;display:inline-block"><${StaffSelect} size="sm" value=${l.staff_id} onValue=${(v) => setLine(l.key, { staff_id: v })} placeholder=${t('doc.who_did')} /></span>`}
              </div>
            </td>
            <td class="col-qty">${l.kind !== 'text' && html`<${NumInput} size="sm" value=${l.qty} onValue=${(v) => setLine(l.key, { qty: v ?? 0 })} dec=${3} cls=${short ? 'invalid' : ''} />${l.unit ? html`<div class="tiny muted" style="text-align:end">${dn(l.unit)}</div>` : null}`}</td>
            ${showPrices && html`<td class="col-price">${l.kind !== 'text' && html`<${NumInput} size="sm" value=${l.unit_price} onValue=${(v) => setLine(l.key, { unit_price: v ?? 0 })} dec=${Math.max(dec, 2)} cls=${below ? 'invalid' : ''} />`}</td>
              <td class="col-disc">${l.kind !== 'text' && html`<${DiscountInput} amount=${l.discount} pct=${l.discount_pct} dec=${dec} onChange=${(a, p) => setLine(l.key, { discount: a, discount_pct: p })} />`}</td>
              <td class="col-total r num strong">${l.kind !== 'text' && money(c.total, d.currency)}</td>`}
            ${type === 'adjust' && showCost && html`<td class="col-price">${Number(l.qty) > 0 && html`<${NumInput} size="sm" value=${l.unit_cost_usd} onValue=${(v) => setLine(l.key, { unit_cost_usd: v })} dec=${4} placeholder=${t('doc.cost_auto')} />`}</td>`}
            <td class="col-x"><div class="col gap-4" style="align-items:center">
              <${IconBtn} icon="x" danger title=${t('common.remove')} onClick=${() => removeLine(l.key)} />
              ${d.lines.length > 1 && html`<div class="row" style="gap:0">${i > 0 && html`<button type="button" class="icon-btn" style="width:18px;height:18px" title=${t('common.move_up')} onClick=${() => moveLine(l.key, -1)}><${Icon} name="chevron-up" size="sm" /></button>`}</div>`}
            </div></td>
          </tr>`;
        })}</tbody>
      </table></div>`}
    </${Panel}>

    <div class="grid-2">
      <${Panel} title=${t('doc.notes')} icon="notebook-pen"><div class="col gap-12">
        <${Field} label=${t('doc.notes_print')}><${Textarea} value=${d.notes} onValue=${(v) => set({ notes: v })} rows=${3} /></${Field}>
        <${Field} label=${t('doc.internal_note')} hint=${t('doc.internal_note_hint')}><${Textarea} value=${d.internal_note} onValue=${(v) => set({ internal_note: v })} rows=${2} /></${Field}>
      </div></${Panel}>
      ${showPrices ? html`<${Panel}><div class="totals-box">
        <div class="tr"><span class="muted">${t('doc.subtotal')}</span><span class="num">${money(calc.subtotal, d.currency)}</span></div>
        ${calc.lineDisc > 0 && html`<div class="tr"><span class="muted">${t('doc.line_discounts')}</span><span class="num neg">−${money(calc.lineDisc, d.currency)}</span></div>`}
        <div class="tr" style="align-items:center"><span class="muted">${t('doc.discount')}</span>
          <div style="width:150px"><${DiscountInput} amount=${d.discount} pct=${d.discount_pct} dec=${dec} onChange=${(a, p) => set({ discount: a, discount_pct: p })} /></div></div>
        <div class="tr grand"><span>${t('doc.grand_total')}</span><span class="money">${money(calc.total, d.currency)}</span></div>
        <div class="tr small muted"><span></span><span class="num">≈ ${money(convert(calc.total, d.currency, d.currency === 'USD' ? 'IQD' : 'USD', d.usd_iqd), d.currency === 'USD' ? 'IQD' : 'USD')}</span></div>
        ${d.payMode && html`<div class="form-section" style="margin-top:8px; padding-bottom:0">
          <div class="row between mb-8"><b class="small">${t(payDir === 'in' ? 'doc.payment_now_in' : 'doc.payment_now_out')}</b>
            <${Segmented} value=${d.payMode} onValue=${(v) => set({ payMode: v, pays: v === 'split' ? [{ key: newKey(), account_id: payAccount, amount: round(convert(calc.total, d.currency, (account(payAccount) || { currency: d.currency }).currency, d.usd_iqd), 2) }] : [] })}
              options=${[{ value: 'full', label: t('doc.pay_full') }, { value: 'credit', label: t(payDir === 'in' ? 'doc.pay_credit' : 'doc.pay_later') }, { value: 'split', label: t('doc.pay_split') }]} /></div>
          ${d.payMode === 'full' && html`<${AccountSelect} value=${payAccount} onValue=${(v) => set({ pays: [{ key: newKey(), account_id: v, amount: 0 }] })} />`}
          ${d.payMode === 'credit' && html`<p class="small muted" style="margin:0">${d.partner && d.partner.is_walkin && type === 'sale' ? html`<span class="neg">${t('doc.walkin_no_credit')}</span>` : t(payDir === 'in' ? 'doc.credit_hint' : 'doc.later_hint')}</p>`}
          ${d.payMode === 'split' && html`<div class="col gap-8">
            ${d.pays.map((p) => html`<div class="row gap-8" key=${p.key}>
              <div class="grow"><${AccountSelect} size="sm" value=${p.account_id} onValue=${(v) => set((x) => ({ pays: x.pays.map((y) => (y.key === p.key ? { ...y, account_id: v } : y)) }))} /></div>
              <div style="width:140px"><${NumInput} size="sm" value=${p.amount} onValue=${(v) => set((x) => ({ pays: x.pays.map((y) => (y.key === p.key ? { ...y, amount: v } : y)) }))} dec=${decimals((account(p.account_id) || { currency: d.currency }).currency)} /></div>
              <span class="tiny muted" style="width:34px">${(account(p.account_id) || {}).currency || ''}</span>
              <${IconBtn} icon="x" onClick=${() => set((x) => ({ pays: x.pays.filter((y) => y.key !== p.key) }))} />
            </div>`)}
            <div class="row between"><button type="button" class="link-btn small" onClick=${() => set((x) => ({ pays: [...x.pays, { key: newKey(), account_id: (defaultAccount(x.currency === 'USD' ? 'IQD' : 'USD') || {}).id || payAccount, amount: null }] }))}>+ ${t('doc.add_payment_row')}</button>
              <span class="small">${t('doc.paid')}: <b class="num">${money(paidInDoc, d.currency)}</b> · ${t('doc.remaining')}: <b class=${`num ${calc.total - paidInDoc > tolOf(d.currency) ? 'neg' : ''}`}>${money(Math.max(0, calc.total - paidInDoc), d.currency)}</b></span></div>
          </div>`}
        </div>`}
        ${d.id && d.status === 'posted' && def.pay && html`<p class="small muted mt-8">${t('doc.payments_on_view')}</p>`}
      </div></${Panel}>` : html`<div></div>`}
    </div>

    <div class="editor-bar">
      <${Btn} onClick=${cancelEdit}>${t('common.cancel')}</${Btn}>
      <div class="grow small muted">${showPrices && html`${t('doc.lines_n', { n: d.lines.filter((l) => l.kind !== 'text').length })} · <b class="num" style="color:var(--ink)">${money(calc.total, d.currency)}</b>`}</div>
      ${def.posting && (!d.id || d.status === 'draft') && html`<${Btn} icon="save" disabled=${busy} onClick=${() => save({ post: false })}>${t('doc.save_draft')}</${Btn}>`}
      <${Btn} icon="printer" disabled=${busy} onClick=${() => save({ post: true, print: true })}>${t('doc.save_print')}</${Btn}>
      <${Btn} kind="primary" icon="check" disabled=${busy} onClick=${() => save({ post: true })} kbd="F9">${d.id && d.status === 'posted' ? t('doc.update') : def.posting ? t('doc.save_post') : t('common.save')}</${Btn}>
    </div>
  </div>`;
}

/** discount input: type "10%" for a percentage or a plain amount */
export function DiscountInput({ amount, pct, dec = 2, onChange, size = 'sm' }) {
  const [focus, setFocus] = useState(false);
  const [text, setText] = useState('');
  const shown = focus ? text : pct ? `${num(pct, 2)}%` : amount ? num(amount, dec) : '';
  const commit = (s) => {
    const v = String(s || '').trim();
    if (!v) { onChange(0, null); return; }
    if (v.endsWith('%')) {
      const p = Number(v.slice(0, -1).replace(',', '.'));
      onChange(0, Number.isFinite(p) && p > 0 ? Math.min(p, 100) : null);
    } else {
      const n = Number(v.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      onChange(Number.isFinite(n) && n > 0 ? n : 0, null);
    }
  };
  return html`<input class=${`input num-input ${size}`} value=${shown} placeholder="0 / %" title=${t('doc.discount_hint')}
    onFocus=${(e) => {
      const el = e.target;
      const v = pct ? `${pct}%` : amount ? String(amount) : '';
      setFocus(true);
      setText(v);
      el.value = v;
      try { el.select(); } catch (x) { /* */ }
      setTimeout(() => { if (document.activeElement === el && el.value === v) { try { el.select(); } catch (x) { /* */ } } }, 0);
    }}
    onInput=${(e) => setText(e.target.value)}
    onBlur=${() => { setFocus(false); commit(text); }}
    onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(text); e.target.blur(); } }} />`;
}

/** make / model / year for a vehicle that is not registered yet */
function VehicleQuickFields({ veh, onChange }) {
  const makes = boot().vehicle_makes || [];
  const [models, setModels] = useState([]);
  useEffect(() => {
    if (!veh.make_id) { setModels([]); return; }
    api.get('/api/vehicle-models', { make_id: veh.make_id }).then(setModels).catch(() => setModels([]));
  }, [veh.make_id]);
  const desc = (patch) => {
    const v = { ...veh, ...patch };
    const mk = makes.find((m) => m.id === v.make_id);
    const md = models.find((m) => m.id === v.model_id);
    v._desc = [mk && mk.name, md ? md.name : v.model_text, v.year].filter(Boolean).join(' ');
    onChange(v);
  };
  return html`<${Field} label=${t('vehicle.make')}><${Select} value=${veh.make_id} onValue=${(v) => desc({ make_id: v, model_id: '' })} placeholder="—" options=${makes.map((m) => ({ value: m.id, label: m.name }))} /></${Field}>
    <${Field} label=${t('vehicle.model')}>${models.length
      ? html`<${Select} value=${veh.model_id} onValue=${(v) => desc({ model_id: v })} placeholder="—" options=${models.map((m) => ({ value: m.id, label: m.name }))} />`
      : html`<${Input} value=${veh.model_text || ''} onValue=${(v) => desc({ model_text: v })} />`}</${Field}>
    <${Field} label=${t('vehicle.year')}><${NumInput} value=${veh.year} onValue=${(v) => desc({ year: v })} dec=${0} /></${Field}>`;
}
