// Stock: levels per warehouse, movements, counts (sayım), transfers, adjustments, purchase suggestions.
import { html, useState, useEffect, useRef, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { money, num, qty as fqty, convert, today, date as fdate, dateTime, round, display } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Tabs, KV,
  DateRange, periodRange, SearchBox, useAsync, useDebounced, openModal, toast, errToast, confirmDialog, DateInput } from '../core/ui.js';
import { printTables } from '../core/print.js';
import { downloadXlsx } from '../core/xlsx.js';
import { whatsapp } from '../core/docprint.js';
import { WarehouseSelect, CategorySelect, BrandSelect, defaultWarehouseId, PartnerPicker } from './pickers.js';
import { DocTable, handoffDraft } from './docs.js';
import { dn } from '../core/names.js';

const TABS = ['levels', 'moves', 'counts', 'transfers', 'adjustments', 'suggestions'];
const MOVE_KINDS = ['purchase', 'sale', 'sale_return', 'purchase_return', 'transfer_in', 'transfer_out', 'adjust', 'opening', 'count'];

export function Stock({ tab, query = {} }) {
  useTitle(t('nav.stock'));
  const cur = TABS.includes(tab) ? tab : 'levels';
  const tabs = [
    { id: 'levels', label: t('stock.levels'), icon: 'boxes' },
    can('reports.stock') && { id: 'moves', label: t('stock.moves'), icon: 'arrow-left-right' },
    can(['stock.count', 'stock.view']) && { id: 'counts', label: t('stock.counts'), icon: 'clipboard-check' },
    { id: 'transfers', label: t('stock.transfers'), icon: 'warehouse' },
    { id: 'adjustments', label: t('stock.adjustments'), icon: 'scale' },
    can('reports.stock') && { id: 'suggestions', label: t('stock.suggestions'), icon: 'clipboard-list' },
  ];
  return html`<div class="page">
    <${Tabs} value=${cur} onValue=${(v) => navigate(v === 'levels' ? '/stock' : `/stock/${v}`)} tabs=${tabs} />
    ${cur === 'levels' && html`<${Levels} />`}
    ${cur === 'moves' && html`<${Moves} query=${query} />`}
    ${cur === 'counts' && html`<${Counts} />`}
    ${cur === 'transfers' && html`<${StockDocs} type="transfer" />`}
    ${cur === 'adjustments' && html`<${StockDocs} type="adjust" />`}
    ${cur === 'suggestions' && html`<${Suggestions} />`}
  </div>`;
}

/* ------------------------------------------------------------------ levels */
function Levels() {
  const [f, setF] = useState({ warehouse_id: '', category_id: '', brand_id: '', only_in_stock: false, q: '', state: '' });
  const viaReport = can('reports.stock');
  const dc = useStore((s) => s.displayCurrency);
  const { data, loading, error } = useAsync(() => (viaReport
    ? api.get('/api/reports/stockCurrent', { warehouse_id: f.warehouse_id, category_id: f.category_id, brand_id: f.brand_id, only_in_stock: f.only_in_stock ? 1 : '', mode: dc })
    : api.get('/api/products', { warehouse_id: f.warehouse_id, category_id: f.category_id, brand_id: f.brand_id, stock: f.only_in_stock ? 'in' : '', limit: 5000, type: 'product' })
      .then((r) => ({ rows: r.rows.filter((p) => p.track_stock).map((p) => ({ ...p, qty: p.stock, state: p.stock_state })), totals: null, mode: dc }))),
  [f.warehouse_id, f.category_id, f.brand_id, f.only_in_stock, dc]);
  const dq = useDebounced(f.q, 200);
  const rows = useMemo(() => {
    let r = (data && data.rows) || [];
    if (f.state) r = r.filter((x) => x.state === f.state);
    if (dq.trim()) {
      const terms = dq.toLowerCase().split(/\s+/).filter(Boolean);
      r = r.filter((x) => { const s = `${x.name} ${x.code || ''} ${x.barcode || ''} ${x.shelf || ''} ${x.brand_name || ''}`.toLowerCase(); return terms.every((tm) => s.includes(tm)); });
    }
    return r;
  }, [data, f.state, dq]);
  const hasValue = rows.some((r) => r.value !== undefined);
  const mode = (data && data.mode) || 'USD';
  const sumValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  const sumRetail = rows.reduce((s, r) => s + (r.retail_value || 0), 0);
  const counts = { critical: 0, low: 0, ok: 0 };
  for (const r of (data && data.rows) || []) counts[r.state] = (counts[r.state] || 0) + 1;
  const wname = f.warehouse_id ? ((boot().warehouses || []).find((w) => w.id === f.warehouse_id) || {}).name : t('product.all_warehouses');
  const exportX = () => downloadXlsx(`${t('stock.levels')}-${today()}`, [{
    name: t('stock.levels'),
    headers: [t('product.code'), t('product.name'), t('product.category'), t('product.brand'), t('product.shelf'), t('product.unit'), t('product.stock'), t('product.min_stock'), ...(hasValue ? [`${t('stock.value')} (${mode})`, `${t('stock.retail_value')} (${mode})`] : [])],
    rows: rows.map((r) => [r.code || '', r.name, r.category_name || '', r.brand_name || '', r.shelf || '', r.unit || '', r.qty, r.min_stock || 0, ...(hasValue ? [r.value, r.retail_value ?? ''] : [])]),
  }]);
  const printSheet = () => printTables(t('stock.count_sheet'), `${wname} · ${fdate(today())}`, [{
    headers: [{ label: t('product.shelf') }, { label: t('product.code') }, { label: t('product.name') }, { label: t('product.unit') }, { label: t('stock.system_qty'), r: true }, { label: t('stock.counted'), r: true }],
    rows: [...rows].sort((a, b) => String(a.shelf || '').localeCompare(String(b.shelf || '')) || a.name.localeCompare(b.name)).map((r) => [r.shelf || '', r.code || '', r.name, r.unit || '', fqty(r.qty), '']),
  }]);
  return html`<div>
    <div class="toolbar">
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
      ${(boot().warehouses || []).length > 1 && html`<div style="width:170px"><${WarehouseSelect} value=${f.warehouse_id} onValue=${(v) => setF({ ...f, warehouse_id: v })} placeholder=${t('product.all_warehouses')} /></div>`}
      <div style="width:160px"><${CategorySelect} value=${f.category_id} onValue=${(v) => setF({ ...f, category_id: v })} placeholder=${t('product.all_categories')} /></div>
      <div style="width:150px"><${BrandSelect} value=${f.brand_id} onValue=${(v) => setF({ ...f, brand_id: v })} placeholder=${t('product.all_brands')} /></div>
      <${Segmented} value=${f.state} onValue=${(v) => setF({ ...f, state: v })} options=${[
        { value: '', label: t('common.all') }, { value: 'critical', label: `${t('stock.state.critical')} (${counts.critical || 0})` }, { value: 'low', label: `${t('stock.state.low')} (${counts.low || 0})` }]} />
      <${Check} checked=${f.only_in_stock} onValue=${(v) => setF({ ...f, only_in_stock: v })} label=${t('stock.only_in_stock')} />
      <div class="toolbar-end">
      <${IconBtn} icon="printer" title=${t('stock.count_sheet')} onClick=${printSheet} />
      <${IconBtn} icon="file-spreadsheet" title=${t('common.export_excel')} onClick=${exportX} />
      </div>
    </div>
    ${hasValue && html`<div class="grid-4 mb-16">
      <div class="panel stat"><div class="k">${t('stock.products')}</div><div class="v">${num(rows.length)}</div></div>
      <div class="panel stat"><div class="k">${t('stock.total_qty')}</div><div class="v">${fqty(rows.reduce((s, r) => s + Math.max(r.qty, 0), 0))}</div></div>
      <div class="panel stat"><div class="k">${t('stock.value')}</div><div class="v">${money(sumValue, mode)}</div><div class="s">${t('stock.value_hint')}</div></div>
      <div class="panel stat"><div class="k">${t('stock.retail_value')}</div><div class="v">${money(sumRetail, mode)}</div><div class="s">${sumValue ? t('stock.potential', { amount: money(sumRetail - sumValue, mode) }) : ''}</div></div>
    </div>`}
    <div class="panel">${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table}
      rows=${rows.slice(0, 1500)} onRow=${(r) => navigate(`/products/${r.id}`)}
      columns=${[
        { key: 'name', label: t('product.name'), render: (r) => html`<div class="cell-name" dir="auto">${r.name}</div><div class="sub">${[r.code, r.brand_name, r.category_name].filter(Boolean).join(' · ')}</div>` },
        { key: 'shelf', label: t('product.shelf'), render: (r) => r.shelf || '' },
        { key: 'qty', label: t('product.stock'), align: 'r', render: (r) => html`<span class=${`num strong ${r.state === 'critical' ? 'neg' : r.state === 'low' ? 'warn-text' : ''}`}>${fqty(r.qty)}</span> <span class="tiny muted">${dn(r.unit) || ''}</span>` },
        { key: 'min', label: t('product.min_stock'), align: 'r', render: (r) => html`<span class="num muted">${r.min_stock ? fqty(r.min_stock) : '—'}</span>` },
        { key: 'state', label: t('doc.status'), render: (r) => html`<${Pill} kind=${r.state === 'critical' ? 'out' : r.state === 'low' ? 'warn' : 'in'} dot>${t(`stock.state.${r.state}`)}</${Pill}>` },
        hasValue && { key: 'value', label: `${t('stock.value')} (${mode})`, align: 'r', render: (r) => html`<span class="num">${money(r.value, mode)}</span>` },
      ]} />${rows.length > 1500 ? html`<div class="panel-foot small muted">${t('stock.showing_first', { n: 1500, total: rows.length })}</div>` : null}`}</div>
  </div>`;
}

/* ------------------------------------------------------------------ moves */
function Moves({ query }) {
  const r0 = periodRange('month');
  const [f, setF] = useState({ from: r0.from, to: r0.to, kind: '', warehouse_id: '', q: '' });
  const { data, loading } = useAsync(() => api.get('/api/reports/stockMoves', { from: f.from, to: f.to, kind: f.kind, warehouse_id: f.warehouse_id, product_id: query.product_id }), [f.from, f.to, f.kind, f.warehouse_id]);
  const dq = useDebounced(f.q, 200);
  const rows = ((data && data.rows) || []).filter((r) => !dq || `${r.product_name} ${r.code || ''} ${r.doc_no || ''}`.toLowerCase().includes(dq.toLowerCase()));
  const showCost = can('products.cost');
  return html`<div>
    <div class="toolbar">
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      <div style="width:170px"><${Select} value=${f.kind} onValue=${(v) => setF({ ...f, kind: v })} options=${[{ value: '', label: t('stock.all_kinds') }, ...MOVE_KINDS.map((k) => ({ value: k, label: t(`move.stock.${k}`) }))]} /></div>
      ${(boot().warehouses || []).length > 1 && html`<div style="width:170px"><${WarehouseSelect} value=${f.warehouse_id} onValue=${(v) => setF({ ...f, warehouse_id: v })} placeholder=${t('product.all_warehouses')} /></div>`}
    </div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${rows.slice(0, 2000)} onRow=${(r) => r.doc_id && navigate(`/doc/${r.doc_id}`)}
      columns=${[
        { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
        { key: 'product', label: t('product.name'), render: (r) => html`<span dir="auto">${r.product_name}</span><div class="sub">${r.code || ''}</div>` },
        { key: 'kind', label: t('common.type'), render: (r) => html`${t(`move.stock.${r.kind}`)}${r.reason && r.kind === 'adjust' ? html`<div class="sub">${t(`adjust.reason.${r.reason}`)}</div>` : null}` },
        { key: 'doc', label: t('doc.no'), render: (r) => r.doc_no || '' },
        (boot().warehouses || []).length > 1 && { key: 'wh', label: t('doc.warehouse'), render: (r) => r.warehouse_name },
        { key: 'qty', label: t('print.col.qty'), align: 'r', render: (r) => html`<span class=${`num strong ${r.qty > 0 ? 'pos' : 'neg'}`}>${r.qty > 0 ? '+' : ''}${fqty(r.qty)}</span>` },
        showCost && { key: 'cost', label: t('doc.unit_cost'), align: 'r', render: (r) => html`<span class="num small muted">${money(r.unit_cost_usd, 'USD')}</span>` },
      ]} />`}</div>
  </div>`;
}

/* ------------------------------------------------------------------ stock documents (transfer / adjust) */
function StockDocs({ type }) {
  const r0 = periodRange('3m');
  const [f, setF] = useState({ from: r0.from, to: r0.to });
  const { data, loading } = useAsync(() => api.get('/api/docs', { type, from: f.from, to: f.to, include_cancelled: 1, limit: 500 }), [f.from, f.to]);
  const canNew = can(type === 'transfer' ? 'stock.transfer' : 'stock.adjust');
  return html`<div>
    <div class="toolbar">
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF(r)} />
      <div class="toolbar-end">
      ${canNew && html`<${Btn} kind="primary" icon="plus" disabled=${type === 'transfer' && (boot().warehouses || []).filter((w) => w.active).length < 2} onClick=${() => navigate(`/docs/${type}/new`)}>${t(`doc.new.${type}`)}</${Btn}>`}
      </div>
    </div>
    ${type === 'transfer' && (boot().warehouses || []).filter((w) => w.active).length < 2 && html`<${Notice} cls="mb-12">${t('stock.one_warehouse')}</${Notice}>`}
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${DocTable} rows=${data.rows} showPartner=${false} />`}</div>
  </div>`;
}

/* ------------------------------------------------------------------ counts */
function Counts() {
  const { data, loading, reload } = useAsync(() => api.get('/api/stock/counts'), []);
  const create = () => openModal(NewCountDialog).then((r) => r && navigate(`/stock/count/${r.id}`));
  return html`<div>
    <div class="toolbar"><p class="small muted grow" style="margin:0">${t('stock.counts_text')}</p>
      ${can('stock.count') && html`<${Btn} kind="primary" icon="plus" onClick=${create}>${t('stock.new_count')}</${Btn}>`}</div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} onRow=${(r) => navigate(`/stock/count/${r.id}`)}
      empty=${html`<${Empty} icon="clipboard-check" title=${t('stock.no_counts')} />`}
      columns=${[
        { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
        { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
        { key: 'wh', label: t('doc.warehouse'), render: (r) => r.warehouse_name },
        { key: 'progress', label: t('stock.progress'), render: (r) => html`<div class="row gap-8"><div class="meter" style="width:120px"><i style=${`width:${r.line_count ? r.counted_count / r.line_count * 100 : 0}%`}></i></div><span class="small num">${r.counted_count}/${r.line_count}</span></div>` },
        { key: 'diff', label: t('stock.differences'), align: 'r', render: (r) => (r.diff_count ? html`<span class="num warn-text strong">${r.diff_count}</span>` : html`<span class="muted">0</span>`) },
        { key: 'status', label: t('doc.status'), render: (r) => html`<${Pill} kind=${r.status === 'posted' ? 'in' : 'warn'}>${t(`stock.count_status.${r.status}`)}</${Pill}>` },
        { key: 'user', label: t('common.user'), render: (r) => html`<span class="small muted">${r.user_name || ''}</span>` },
      ]} />`}</div>
  </div>`;
}

function NewCountDialog({ close }) {
  const [wh, setWh] = useState(defaultWarehouseId());
  const [date, setDate] = useState(today());
  const [scope, setScope] = useState('all');
  const [cat, setCat] = useState('');
  const [brand, setBrand] = useState('');
  const [onlyIn, setOnlyIn] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/stock/counts', {
        warehouse_id: wh, date, note,
        scope: scope === 'empty' ? { empty: true } : { category_id: scope === 'category' ? cat : undefined, brand_id: scope === 'brand' ? brand : undefined, only_in_stock: onlyIn },
      });
      close(r);
    } catch (e) { errToast(e); setBusy(false); }
  };
  return html`<${Modal} title=${t('stock.new_count')} icon="clipboard-check" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy}>${t('stock.start_count')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="form-2">
        <${Field} label=${t('doc.warehouse')}><${WarehouseSelect} value=${wh} onValue=${setWh} /></${Field}>
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
      </div>
      <${Field} label=${t('stock.count_scope')}><${Select} value=${scope} onValue=${setScope} options=${['all', 'category', 'brand', 'empty'].map((s) => ({ value: s, label: t(`stock.scope.${s}`) }))} /></${Field}>
      ${scope === 'category' && html`<${Field} label=${t('product.category')}><${CategorySelect} value=${cat} onValue=${setCat} placeholder="—" /></${Field}>`}
      ${scope === 'brand' && html`<${Field} label=${t('product.brand')}><${BrandSelect} value=${brand} onValue=${setBrand} placeholder="—" /></${Field}>`}
      ${scope !== 'empty' && html`<${Check} checked=${onlyIn} onValue=${setOnlyIn} label=${t('stock.only_in_stock')} />`}
      <${Field} label=${t('common.note')}><${Input} value=${note} onValue=${setNote} /></${Field}>
      <p class="small muted">${t('stock.count_help')}</p>
    </div>
  </${Modal}>`;
}

export function CountPage({ id }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [scan, setScan] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef({});
  const timer = useRef(null);
  const scanRef = useRef(null);
  useTitle(c ? `${t('stock.count')} ${c.no}` : t('common.loading'), [{ label: t('stock.counts'), href: '#/stock/counts' }]);
  const load = () => api.get(`/api/stock/counts/${id}`).then(setC).catch(setErr);
  useEffect(() => { load(); }, [id]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); flush(); } }, []);

  const flush = async () => {
    const lines = Object.entries(pending.current).map(([product_id, counted]) => ({ product_id, counted }));
    pending.current = {};
    if (!lines.length) return;
    setSaving(true);
    try { await api.post(`/api/stock/counts/${id}/lines`, { lines }); } catch (e) { errToast(e); } finally { setSaving(false); }
  };
  const setCounted = (productId, v) => {
    setC((x) => ({ ...x, lines: x.lines.map((l) => (l.product_id === productId ? { ...l, counted: v } : l)) }));
    pending.current[productId] = v === null || v === undefined ? '' : v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };
  const onScan = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan('');
    let line = c.lines.find((l) => l.barcode === code || l.code === code);
    if (!line) {
      try {
        const r = await api.get(`/api/products/by-code/${encodeURIComponent(code)}`);
        if (r.product) line = c.lines.find((l) => l.product_id === r.product.id);
        if (r.product && !line) {
          // product not in this count yet: add it
          await flush();
          const n = await api.post(`/api/stock/counts/${id}/lines`, { lines: [{ product_id: r.product.id, counted: 1 }] });
          setC(n);
          toast(t('stock.added_to_count', { name: r.product.name }));
          return;
        }
      } catch (x) { /* not found */ }
    }
    if (!line) { toast(t('pos.not_found', { code }), 'err'); return; }
    setCounted(line.product_id, (Number(line.counted) || 0) + 1);
    setTimeout(() => { const el = document.getElementById(`cnt-${line.product_id}`); if (el) el.scrollIntoView({ block: 'center' }); }, 30);
  };

  if (err) return html`<div class="page"><${Notice} kind="err">${err.message}</${Notice}></div>`;
  if (!c) return html`<${Loading} />`;
  const draft = c.status === 'draft';
  const showCost = can('products.cost');
  const cur = (l) => (draft ? l.current : l.expected);
  const diffOf = (l) => (l.counted === null || l.counted === undefined || l.counted === '' ? null : round(Number(l.counted) - cur(l), 4));
  const lines = c.lines.filter((l) => {
    if (filter === 'uncounted' && !(l.counted === null || l.counted === undefined)) return false;
    if (filter === 'diff') { const d = diffOf(l); if (d === null || Math.abs(d) < 1e-9) return false; }
    if (q.trim()) { const s = `${l.name} ${l.code || ''} ${l.barcode || ''} ${l.shelf || ''}`.toLowerCase(); if (!q.toLowerCase().split(/\s+/).every((x) => s.includes(x))) return false; }
    return true;
  });
  const counted = c.lines.filter((l) => l.counted !== null && l.counted !== undefined).length;
  const diffs = c.lines.filter((l) => { const d = diffOf(l); return d !== null && Math.abs(d) > 1e-9; });
  const diffValue = diffs.reduce((s, l) => s + diffOf(l) * (l.avg_cost_usd || 0), 0);
  const post = async () => {
    await flush();
    const r = await openModal(PostCountDialog, { count: c, counted, diffs: diffs.length, uncounted: c.lines.length - counted, diffValue: showCost ? diffValue : null });
    if (!r) return;
    try {
      const res = await api.post(`/api/stock/counts/${id}/post`, { zero_uncounted: r.zero_uncounted });
      toast(t('stock.count_posted', { n: res.adjusted }));
      load();
    } catch (e) { errToast(e); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('stock.delete_count'), text: t('stock.delete_count_text'), danger: true, okText: t('common.delete') }))) return;
    try { await api.del(`/api/stock/counts/${id}`); navigate('/stock/counts'); } catch (e) { errToast(e); }
  };
  const printSheet = () => printTables(`${t('stock.count')} ${c.no}`, `${c.warehouse_name} · ${fdate(c.date)}`, [{
    headers: [{ label: t('product.shelf') }, { label: t('product.code') }, { label: t('product.name') }, { label: t('stock.system_qty'), r: true }, { label: t('stock.counted'), r: true }, { label: t('stock.diff'), r: true }],
    rows: c.lines.map((l) => [l.shelf || '', l.code || '', l.name, fqty(cur(l)), l.counted != null ? fqty(l.counted) : '', diffOf(l) ? fqty(diffOf(l)) : '']),
  }]);
  return html`<div class="page stack">
    <div class="row wrap gap-8">
      <div class="grow row gap-8 wrap"><${Pill} kind=${draft ? 'warn' : 'in'}>${t(`stock.count_status.${c.status}`)}</${Pill}>
        <span class="small muted">${c.warehouse_name} · ${fdate(c.date)} · ${c.user_name || ''}</span>
        ${c.adjust_no && html`<a class="small" href=${`#/doc/${c.adjust_doc_id}`}>${t('stock.adjust_doc')}: ${c.adjust_no}</a>`}
        ${saving && html`<span class="tiny muted">${t('common.saving')}</span>`}</div>
      <${Btn} icon="printer" onClick=${printSheet}>${t('stock.count_sheet')}</${Btn}>
      ${draft && can('stock.count') && html`<${Btn} kind="ghost" icon="trash-2" onClick=${remove}>${t('common.delete')}</${Btn}>`}
      ${draft && can('stock.adjust') && html`<${Btn} kind="primary" icon="check" onClick=${post}>${t('stock.post_count')}</${Btn}>`}
    </div>
    <div class="grid-4">
      <div class="panel stat"><div class="k">${t('stock.lines')}</div><div class="v">${num(c.lines.length)}</div></div>
      <div class="panel stat"><div class="k">${t('stock.counted_n')}</div><div class="v">${num(counted)}</div><div class="meter mt-8"><i style=${`width:${c.lines.length ? counted / c.lines.length * 100 : 0}%;background:var(--in)`}></i></div></div>
      <div class="panel stat"><div class="k">${t('stock.differences')}</div><div class="v warn-text">${num(diffs.length)}</div></div>
      ${showCost && html`<div class="panel stat"><div class="k">${t('stock.diff_value')}</div><div class=${`v ${diffValue < 0 ? 'neg' : diffValue > 0 ? 'pos' : ''}`}>${display(diffValue, { sign: true })}</div></div>`}
    </div>
    ${draft && html`<div class="panel"><div class="panel-body row gap-12 wrap">
      <div class="input-wrap" style="flex:1 1 320px"><${Icon} name="scan-barcode" /><input ref=${scanRef} class="input lg" value=${scan} onInput=${(e) => setScan(e.target.value)} onKeyDown=${onScan} placeholder=${t('stock.scan_ph')} autoFocus /></div>
      <span class="small muted" style="max-width:420px">${t('stock.scan_hint')}</span>
    </div></div>`}
    <div class="toolbar" style="margin:0">
      <${SearchBox} value=${q} onValue=${setQ} cls="search" />
      <${Segmented} value=${filter} onValue=${setFilter} options=${[{ value: 'all', label: t('common.all') }, { value: 'uncounted', label: t('stock.uncounted') }, { value: 'diff', label: t('stock.differences') }]} />
    </div>
    <div class="panel"><div class="table-wrap"><table class="tbl compact">
      <thead><tr><th>${t('product.shelf')}</th><th>${t('product.name')}</th><th class="r">${draft ? t('stock.system_now') : t('stock.system_qty')}</th><th class="r" style="width:140px">${t('stock.counted')}</th><th class="r">${t('stock.diff')}</th></tr></thead>
      <tbody>${lines.slice(0, 2000).map((l) => {
        const d = diffOf(l);
        return html`<tr id=${`cnt-${l.product_id}`} key=${l.product_id}>
          <td class="small">${l.shelf || ''}</td>
          <td><div dir="auto">${l.name}</div><div class="sub">${[l.code, l.barcode].filter(Boolean).join(' · ')}</div></td>
          <td class="r num">${fqty(cur(l))}${draft && Math.abs(l.current - l.expected) > 1e-9 ? html`<div class="tiny muted" title=${t('stock.changed_since')}>(${fqty(l.expected)})</div>` : null}</td>
          <td>${draft ? html`<${NumInput} size="sm" value=${l.counted} onValue=${(v) => setCounted(l.product_id, v)} dec=${3} />` : html`<div class="r num">${l.counted != null ? fqty(l.counted) : '—'}</div>`}</td>
          <td class=${`r num strong ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`}>${d === null ? '' : d === 0 ? '0' : `${d > 0 ? '+' : ''}${fqty(d)}`}</td>
        </tr>`;
      })}</tbody></table></div></div>
  </div>`;
}

function PostCountDialog({ count, counted, diffs, uncounted, diffValue, close }) {
  const [zero, setZero] = useState(false);
  return html`<${Modal} title=${t('stock.post_count')} icon="clipboard-check" close=${close} onSubmit=${() => close({ zero_uncounted: zero })}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary">${t('stock.post_count')}</${Btn}>`}>
    <div class="col gap-12">
      <${KV} items=${[[t('stock.counted_n'), num(counted)], [t('stock.differences'), num(diffs)], [t('stock.uncounted'), num(uncounted)], diffValue !== null && [t('stock.diff_value'), display(diffValue, { sign: true })]]} />
      <p class="small dim">${t('stock.post_text')}</p>
      ${uncounted > 0 && html`<${Check} checked=${zero} onValue=${setZero} label=${t('stock.zero_uncounted', { n: uncounted })} />`}
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ purchase suggestions */
function Suggestions() {
  const [days, setDays] = useState(30);
  const [cover, setCover] = useState(30);
  const [supplier, setSupplier] = useState(null);
  const [qty, setQty] = useState({});
  const [sel, setSel] = useState(new Set());
  const { data, loading } = useAsync(() => api.get('/api/reports/purchaseSuggestions', { days, cover_days: cover, supplier_id: supplier ? supplier.id : undefined }), [days, cover, supplier && supplier.id]);
  const rows = (data && data.rows) || [];
  useEffect(() => { setQty(Object.fromEntries(rows.map((r) => [r.id, r.suggested]))); setSel(new Set(rows.filter((r) => r.suggested > 0).map((r) => r.id))); }, [data]);
  const chosen = rows.filter((r) => sel.has(r.id) && (qty[r.id] || 0) > 0);
  const suppliers = [...new Set(chosen.map((r) => r.last_supplier_id).filter(Boolean))];
  const createOrder = () => {
    if (!chosen.length) return;
    const g = boot().settings.general || {};
    const curCount = {};
    for (const r of chosen) curCount[r.currency] = (curCount[r.currency] || 0) + 1;
    const currency = Object.entries(curCount).sort((a, b) => b[1] - a[1])[0][0] || g.default_currency;
    const sup = supplier || (suppliers.length === 1 ? { id: suppliers[0], name: chosen.find((r) => r.last_supplier_id === suppliers[0]).supplier_name } : null);
    handoffDraft({
      type: 'purchase_order', currency, partner_id: sup ? sup.id : null, partner_name: sup ? sup.name : null,
      lines: chosen.filter((r) => !sup || !r.last_supplier_id || r.last_supplier_id === sup.id || supplier).map((r) => ({
        kind: 'product', product_id: r.id, code: r.code, description: r.name, qty: qty[r.id], unit: r.unit,
        unit_price: round(convert(r.cost_price || 0, r.currency, currency), 2), discount: 0,
      })),
    });
  };
  /** several suppliers: one purchase order per supplier (products without a known supplier go into one more order) */
  const createOrders = async () => {
    const groups = new Map();
    for (const r of chosen) {
      const k = r.last_supplier_id || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    if (!(await confirmDialog({ title: t('stock.create_orders_title'), text: t('stock.create_orders_text', { n: groups.size, items: chosen.length }), okText: t('stock.create_orders_ok', { n: groups.size }) }))) return;
    const rate = (boot().currencies || []).find((c) => c.code === 'IQD');
    let made = 0;
    try {
      for (const [sid, list] of groups) {
        const cc = {};
        for (const r of list) cc[r.currency] = (cc[r.currency] || 0) + 1;
        const currency = Object.entries(cc).sort((a, b) => b[1] - a[1])[0][0];
        await api.post('/api/docs', {
          type: 'purchase_order', date: today(), partner_id: sid || null, currency, usd_iqd: rate ? rate.rate : undefined, status: 'open',
          lines: list.map((r) => ({ kind: 'product', product_id: r.id, code: r.code, description: r.name, qty: qty[r.id], unit: r.unit, unit_price: round(convert(r.cost_price || 0, r.currency, currency), 2), discount: 0 })),
        });
        made++;
      }
      toast(t('stock.orders_created', { n: made }));
      navigate('/docs/purchase_order');
    } catch (e) { errToast(e); if (made) navigate('/docs/purchase_order'); }
  };
  const share = () => {
    const sup = chosen.find((r) => r.supplier_phone);
    const text = `${(boot().company || {}).name || ''}\n${t('stock.order_message')}\n${chosen.map((r) => `• ${r.name}${r.code ? ` (${r.code})` : ''}: ${fqty(qty[r.id])} ${r.unit || ''}`).join('\n')}`;
    whatsapp(supplier && supplier.phone ? supplier.phone : sup && suppliers.length === 1 ? sup.supplier_phone : '', text);
  };
  const printIt = () => printTables(t('stock.suggestions'), fdate(today()), [{
    headers: [{ label: t('product.code') }, { label: t('product.name') }, { label: t('product.stock'), r: true }, { label: t('stock.daily'), r: true }, { label: t('stock.order_qty'), r: true }, { label: t('stock.supplier') }],
    rows: chosen.map((r) => [r.code || '', r.name, fqty(r.qty), num(r.daily, 2), fqty(qty[r.id]), r.supplier_name || '']),
  }]);
  return html`<div>
    <div class="toolbar">
      <${Field} label=${t('stock.sales_period')}><${Select} value=${String(days)} onValue=${(v) => setDays(Number(v))} options=${[14, 30, 60, 90, 180].map((d) => ({ value: String(d), label: t('stock.last_days', { n: d }) }))} /></${Field}>
      <${Field} label=${t('stock.cover_days')}><${Select} value=${String(cover)} onValue=${(v) => setCover(Number(v))} options=${[14, 30, 45, 60, 90].map((d) => ({ value: String(d), label: t('stock.days_n', { n: d }) }))} /></${Field}>
      <div style="width:260px"><${Field} label=${t('stock.supplier')}><${PartnerPicker} value=${supplier} onChange=${setSupplier} kind="supplier" allowCreate=${false} showBalance=${false} /></${Field}></div>
      ${supplier && html`<${IconBtn} icon="x" onClick=${() => setSupplier(null)} />`}
      <div class="toolbar-end">
      <${Btn} icon="printer" onClick=${printIt} disabled=${!chosen.length}>${t('common.print')}</${Btn}>
      <${Btn} icon="message-circle" onClick=${share} disabled=${!chosen.length}>WhatsApp</${Btn}>
      ${can('orders.manage') && (suppliers.length > 1 && !supplier
        ? html`<${Btn} kind="primary" icon="file-plus" onClick=${createOrders} disabled=${!chosen.length}>${t('stock.create_orders', { n: suppliers.length + (chosen.some((r) => !r.last_supplier_id) ? 1 : 0) })}</${Btn}>`
        : html`<${Btn} kind="primary" icon="file-plus" onClick=${createOrder} disabled=${!chosen.length}>${t('stock.create_order', { n: chosen.length })}</${Btn}>`)}
      </div>
    </div>
    ${suppliers.length > 1 && !supplier && html`<${Notice} kind="warn" cls="mb-12">${t('stock.many_suppliers')}</${Notice}>`}
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${rows}
      empty=${html`<${Empty} icon="circle-check" title=${t('stock.no_suggestions')} />`}
      columns=${[
        { key: 'sel', label: '', cls: 'w-actions', render: (r) => html`<input type="checkbox" checked=${sel.has(r.id)} onChange=${() => { const n = new Set(sel); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSel(n); }} />` },
        { key: 'name', label: t('product.name'), render: (r) => html`<a href=${`#/products/${r.id}`} dir="auto">${r.name}</a><div class="sub">${r.code || ''}</div>` },
        { key: 'qty', label: t('product.stock'), align: 'r', render: (r) => html`<span class=${`num strong ${r.state === 'critical' ? 'neg' : 'warn-text'}`}>${fqty(r.qty)}</span><div class="sub">${t('product.min')}: ${fqty(r.min_level)}</div>` },
        { key: 'sold', label: t('stock.sold_in', { n: days }), align: 'r', render: (r) => html`<span class="num">${fqty(r.sold)}</span><div class="sub">${t('stock.per_day', { n: num(r.daily, 2) })}</div>` },
        { key: 'left', label: t('stock.days_left'), align: 'r', render: (r) => (r.days_left === null ? html`<span class="muted">—</span>` : html`<span class=${`num ${r.days_left < 7 ? 'neg strong' : ''}`}>${r.days_left}</span>`) },
        { key: 'order', label: t('stock.on_order'), align: 'r', render: (r) => (r.on_order ? html`<span class="num">${fqty(r.on_order)}</span>` : '') },
        { key: 'sug', label: t('stock.order_qty'), align: 'r', render: (r) => html`<div style="width:100px;margin-inline-start:auto"><${NumInput} size="sm" value=${qty[r.id]} onValue=${(v) => setQty({ ...qty, [r.id]: v || 0 })} dec=${0} /></div>` },
        { key: 'sup', label: t('stock.supplier'), render: (r) => html`<span class="small" dir="auto">${r.supplier_name || '—'}</span>` },
        can('products.cost') && { key: 'cost', label: t('product.cost_price'), align: 'r', render: (r) => (r.cost_price ? html`<${Money} value=${r.cost_price} cur=${r.currency} />` : '') },
      ]} />`}</div>
    <p class="small muted mt-12">${t('stock.suggestion_logic', { days, cover })}</p>
  </div>`;
}
