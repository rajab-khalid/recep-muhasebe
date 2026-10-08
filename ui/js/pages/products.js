// Products: list with vehicle-aware search, product card (prices per list, vehicle fitment, alternative codes,
// stock per warehouse, movements), barcode labels, bulk price update, Excel import / export.
import { html, useState, useEffect, useRef, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate, setQuery } from '../core/router.js';
import { refreshBoot } from '../core/session.js';
import { money, num, qty as fqty, convert, date as fdate, today, usdIqd, round, decimals, display, pct as fpct } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Textarea, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Tabs, KV,
  SearchBox, MenuButton, Combo, useAsync, useDebounced, openModal, toast, errToast, confirmDialog, promptDialog, readImage, pickFile, sortRows,
} from '../core/ui.js';
import { barcodeSvg, generateEan13, isEan13 } from '../core/barcode.js';
import { printHtml, escapeHtml } from '../core/print.js';
import { downloadXlsx, readSheet } from '../core/xlsx.js';
import { CategorySelect, BrandSelect, CurrencySelect, WarehouseSelect, PriceListSelect, defaultWarehouseId, defaultPriceListId } from './pickers.js';
import { DocTable } from './docs.js';
import { dn } from '../core/names.js';

const UNITS = ['adet', 'takım', 'set', 'çift', 'kutu', 'metre', 'litre', 'kg', 'paket', 'rulo'];
const CODE_KINDS = ['oem', 'alt', 'supplier', 'barcode'];

/* ------------------------------------------------------------------ vehicle models cache */
const modelCache = new Map();
export async function modelsOf(makeId) {
  if (!makeId) return [];
  if (!modelCache.has(makeId)) modelCache.set(makeId, api.get('/api/vehicle-models', { make_id: makeId }).catch(() => []));
  return modelCache.get(makeId);
}
export function clearModelCache() { modelCache.clear(); }

function StockPill({ p }) {
  if (!p.track_stock) return html`<span class="muted small">${t('product.no_stock_tracking')}</span>`;
  const st = p.stock_state || (p.stock <= 0 ? 'critical' : 'ok');
  return html`<span class=${`num strong ${st === 'critical' ? 'neg' : st === 'low' ? 'warn-text' : ''}`}>${fqty(p.stock)}</span>${p.unit ? html` <span class="tiny muted">${dn(p.unit)}</span>` : null}`;
}

/* ================================================================== list */
const PAGE = 100;
export function Products({ query = {} }) {
  useTitle(t('nav.products'));
  const [f, setF] = useState({
    q: query.q || '', category_id: query.category_id || '', brand_id: query.brand_id || '', stock: query.stock || '', active: '', type: '',
    make_id: '', model_id: '', year: null, sort: 'name', price_list_id: defaultPriceListId(), warehouse_id: '',
  });
  const [showVeh, setShowVeh] = useState(false);
  const [models, setModels] = useState([]);
  const [sel, setSel] = useState(new Set());
  const [extra, setExtra] = useState([]);
  const dq = useDebounced(f.q, 250);
  useEffect(() => { modelsOf(f.make_id).then(setModels); }, [f.make_id]);
  const params = { ...f, q: dq, year: f.year || undefined };
  const { data, loading, error, reload } = useAsync(() => { setExtra([]); return api.get('/api/products', { ...params, limit: PAGE }); }, [JSON.stringify(params)]);
  const rows = data ? [...data.rows, ...extra] : [];
  const more = async () => { try { const r = await api.get('/api/products', { ...params, limit: PAGE, offset: rows.length }); setExtra([...extra, ...r.rows]); } catch (e) { errToast(e); } };
  const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const selected = rows.filter((r) => sel.has(r.id));
  const showCost = can('products.cost');
  const makes = boot().vehicle_makes || [];

  const exportX = async () => {
    try {
      const r = await api.get('/api/products', { ...params, limit: 5000, with_prices: 1 });
      const pls = (boot().price_lists || []).filter((p) => p.active);
      downloadXlsx(`${t('nav.products')}-${today()}`, [{
        name: t('nav.products'),
        headers: [t('product.code'), t('product.barcode'), t('product.name'), t('product.name2'), t('product.category'), t('product.brand'), t('product.unit'), t('common.currency'),
          ...(showCost ? [t('product.cost_price'), t('product.avg_cost_usd')] : []), ...pls.map((p) => p.name), t('product.stock'), t('product.min_stock'), t('product.shelf'), t('product.oem_no')],
        rows: r.rows.map((p) => [p.code || '', p.barcode || '', p.name, p.name2 || '', p.category_name || '', p.brand_name || '', p.unit || '', p.currency,
          ...(showCost ? [p.cost_price || 0, round(p.avg_cost_usd || 0, 4)] : []), ...pls.map((pl) => (p.prices && p.prices[pl.id] != null ? p.prices[pl.id] : '')), p.track_stock ? p.stock : '', p.min_stock || 0, p.shelf || '', p.oem_no || '']),
      }]);
    } catch (e) { errToast(e); }
  };

  return html`<div class="page">
    <div class="toolbar">
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" placeholder=${t('product.search_ph')} autoFocus />
      <div style="width:170px"><${CategorySelect} value=${f.category_id} onValue=${(v) => setF({ ...f, category_id: v })} placeholder=${t('product.all_categories')} /></div>
      <div style="width:150px"><${BrandSelect} value=${f.brand_id} onValue=${(v) => setF({ ...f, brand_id: v })} placeholder=${t('product.all_brands')} /></div>
      <div style="width:150px"><${Select} value=${f.stock} onValue=${(v) => setF({ ...f, stock: v })} options=${[
        { value: '', label: t('product.stock_all') }, { value: 'in', label: t('product.stock_in') }, { value: 'low', label: t('product.stock_low') },
        { value: 'out', label: t('product.stock_out') }, { value: 'neg', label: t('product.stock_neg') }]} /></div>
      <${Btn} icon="car" kind=${showVeh || f.make_id ? 'dark' : ''} onClick=${() => setShowVeh(!showVeh)}>${t('product.vehicle_filter')}</${Btn}>
      <div class="toolbar-end">
      <${MenuButton} label=${t('common.more')} icon="sliders-horizontal" items=${[
        { label: t('common.export_excel'), icon: 'file-spreadsheet', onClick: exportX },
        can('products.manage') && { label: t('product.import'), icon: 'upload', onClick: () => openModal(ImportDialog).then((r) => r && reload()) },
        can('products.prices') && { label: t('product.bulk_price'), icon: 'percent', onClick: () => openModal(BulkPriceDialog, { filter: params, count: data ? data.total : 0 }).then((r) => r && reload()) },
        { label: t('product.print_labels_all'), icon: 'tag', onClick: () => openModal(LabelDialog, { products: rows }) },
      ]} />
      ${can('products.manage') && html`<${Btn} kind="primary" icon="plus" onClick=${() => navigate('/products/new')}>${t('product.new')}</${Btn}>`}
      </div>
    </div>
    ${showVeh && html`<div class="panel mb-12"><div class="panel-body row wrap gap-12">
      <div style="width:180px"><${Select} value=${f.make_id} onValue=${(v) => setF({ ...f, make_id: v, model_id: '' })} placeholder=${t('vehicle.make')} options=${makes.map((m) => ({ value: m.id, label: m.name }))} /></div>
      <div style="width:180px"><${Select} value=${f.model_id} onValue=${(v) => setF({ ...f, model_id: v })} placeholder=${t('vehicle.model')} options=${models.map((m) => ({ value: m.id, label: m.name }))} /></div>
      <div style="width:110px"><${NumInput} value=${f.year} onValue=${(v) => setF({ ...f, year: v })} dec=${0} placeholder=${t('vehicle.year')} /></div>
      <${Btn} size="sm" kind="ghost" onClick=${() => setF({ ...f, make_id: '', model_id: '', year: null })}>${t('common.clear')}</${Btn}>
      <span class="small muted">${t('product.vehicle_filter_hint')}</span>
    </div></div>`}
    <div class="row wrap gap-12 mb-12 small">
      ${data && html`<span class="muted">${t('product.count_n', { n: num(data.total) })}</span>`}
      <span class="grow"></span>
      ${selected.length > 0 && html`<span class="strong">${t('common.selected_n', { n: selected.length })}</span>
        <${Btn} size="sm" icon="tag" onClick=${() => openModal(LabelDialog, { products: selected })}>${t('product.print_labels')}</${Btn}>
        <${Btn} size="sm" kind="ghost" onClick=${() => setSel(new Set())}>${t('common.clear')}</${Btn}>`}
      <span class="muted">${t('doc.price_list')}:</span><div style="width:160px"><${PriceListSelect} size="sm" value=${f.price_list_id} onValue=${(v) => setF({ ...f, price_list_id: v })} /></div>
      ${(boot().warehouses || []).filter((w) => w.active).length > 1 && html`<div style="width:160px"><${WarehouseSelect} size="sm" value=${f.warehouse_id} onValue=${(v) => setF({ ...f, warehouse_id: v })} placeholder=${t('product.all_warehouses')} /></div>`}
      <div style="width:150px"><${Select} size="sm" value=${f.sort} onValue=${(v) => setF({ ...f, sort: v })} options=${['name', 'code', 'stock', 'stock_asc', 'newest', 'price'].map((s) => ({ value: s, label: t(`product.sort.${s}`) }))} /></div>
    </div>
    <div class="panel">
      ${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table}
        rows=${rows} onRow=${(r) => navigate(`/products/${r.id}`)}
        empty=${html`<${Empty} icon="package-search" title=${f.q ? t('common.no_results') : t('product.none')} action=${can('products.manage') && !f.q && html`<${Btn} kind="primary" icon="plus" onClick=${() => navigate('/products/new')}>${t('product.new')}</${Btn}>`} />`}
        columns=${[
          { key: 'sel', label: html`<input type="checkbox" checked=${allOn} onChange=${() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label=${t('common.select_all')} />`, cls: 'w-actions',
            render: (r) => html`<input type="checkbox" checked=${sel.has(r.id)} onChange=${() => toggle(r.id)} />` },
          { key: 'img', label: '', cls: 'w-actions', render: (r) => (r.photo_id ? html`<img class="thumb" src=${`/api/files/${r.photo_id}`} alt="" loading="lazy" />` : html`<div class="thumb" style="display:grid;place-items:center"><${Icon} name=${r.type === 'service' ? 'wrench' : 'package'} size="sm" cls="muted" /></div>`) },
          { key: 'name', label: t('product.name'), render: (r) => html`<div class="cell-name" dir="auto">${r.name}${!r.active ? html` <${Pill}>${t('common.inactive')}</${Pill}>` : null}</div>
            <div class="sub">${[r.code, r.brand_name, r.category_name, r.name2].filter(Boolean).join(' · ')}</div>` },
          { key: 'stock', label: t('product.stock'), align: 'r', render: (r) => html`<${StockPill} p=${r} />${r.track_stock && r.stock_state !== 'ok' && r.stock_state !== 'none' ? html`<div class="sub">${t('product.min')}: ${fqty(r.low_level)}</div>` : null}` },
          { key: 'price', label: t('print.col.price'), align: 'r', render: (r) => (r.price != null && Number(r.price) !== 0 ? html`<${Money} value=${r.price} cur=${r.currency} strong />`
            : html`<span class="warn-text small" title=${t('product.no_price_hint')}><${Icon} name="triangle-alert" size="sm" /> ${t('product.no_price')}</span>`) },
          showCost && { key: 'cost', label: t('product.avg_cost'), align: 'r', render: (r) => (r.avg_cost_usd ? html`<span class="num small">${money(r.avg_cost_usd, 'USD')}</span>` : r.cost_price ? html`<span class="num small muted">${money(r.cost_price, r.currency)}</span>` : '') },
          { key: 'shelf', label: t('product.shelf'), render: (r) => html`<span class="small">${r.shelf || ''}</span>` },
        ]} />
        ${data && rows.length < data.total && html`<div class="panel-foot"><${Btn} size="sm" onClick=${more}>${t('common.load_more', { n: data.total - rows.length })}</${Btn}></div>`}`}
    </div>
  </div>`;
}

/* ================================================================== product card */
function blankProduct() {
  const g = boot().settings.general || {};
  return {
    id: null, name: '', name2: '', code: '', barcode: '', type: 'product', category_id: '', brand_id: '', brand_name: '', unit: 'adet', currency: g.default_currency || 'IQD',
    cost_price: null, min_stock: 0, max_stock: null, shelf: '', color: '', size: '', oem_no: '', warranty_months: 0, notes: '', track_stock: 1, active: 1,
    prices: {}, codes: [], fitments: [], photo: null, photo_url: null, opening: { qty: null, unit_cost: null, warehouse_id: defaultWarehouseId() },
  };
}

export function ProductPage({ id, query = {} }) {
  const isNew = id === 'new';
  const [p, setP] = useState(null);
  const [orig, setOrig] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('info');
  const [ver, setVer] = useState(0);
  const editable = can('products.manage');
  const canPrices = can('products.prices');
  const showCost = can('products.cost');
  const lowDefault = ((boot().settings || {}).stock || {}).low_stock_default || 0;
  useTitle(p ? (isNew ? t('product.new') : p.name) : t('common.loading'), [{ label: t('nav.products'), href: '#/products' }]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let prod;
        if (isNew) {
          prod = blankProduct();
          if (query.copy) {
            const src = await api.get(`/api/products/${query.copy}`);
            prod = { ...prod, ...src, id: null, barcode: '', code: src.code ? `${src.code}-2` : '', codes: src.codes.map((c) => ({ ...c, id: undefined })), fitments: src.fitments.map((x) => ({ ...x, id: undefined })), photo_url: null, photo_id: null };
          }
          if (query.name) prod.name = query.name;
          if (query.barcode) prod.barcode = query.barcode;
        } else {
          prod = await api.get(`/api/products/${id}`);
          prod.photo_url = prod.photo_id ? `/api/files/${prod.photo_id}` : null;
          prod.brand_name = prod.brand_name || '';
        }
        if (alive) { setP(prod); setOrig(JSON.stringify(prod)); }
      } catch (e) { if (alive) setErr(e); }
    })();
    return () => { alive = false; };
  }, [id, ver]);

  if (err) return html`<div class="page"><${Notice} kind="err">${err.message}</${Notice}></div>`;
  if (!p) return html`<${Loading} />`;
  const dirty = JSON.stringify(p) !== orig;
  const set = (patch) => setP({ ...p, ...patch });
  const costCur = p.currency;
  const avgInCur = p.avg_cost_usd ? convert(p.avg_cost_usd, 'USD', costCur) : null;
  const costBase = avgInCur || p.cost_price || null;

  const save = async () => {
    if (!p.name.trim()) { toast(t('product.name_required'), 'err'); return; }
    setBusy(true);
    try {
      const body = {
        id: p.id || undefined, name: p.name, name2: p.name2, code: p.code, barcode: p.barcode, type: p.type, category_id: p.category_id || null,
        brand_id: p.brand_id || null, brand_name: !p.brand_id && p.brand_name ? p.brand_name : undefined, unit: p.unit, currency: p.currency,
        cost_price: canPrices ? p.cost_price || 0 : undefined, min_stock: p.min_stock || 0, max_stock: p.max_stock, shelf: p.shelf, color: p.color, size: p.size, oem_no: p.oem_no,
        warranty_months: p.warranty_months || 0, notes: p.notes, track_stock: p.type === 'service' ? 0 : p.track_stock ? 1 : 0, active: p.active ? 1 : 0,
        prices: canPrices ? p.prices : undefined, codes: p.codes.filter((c) => c.code), fitments: p.fitments.filter((x) => x.make_id || x.model_id || x.make_name),
        photo: p.photo || undefined, photo_remove: p.photo_remove || undefined,
        opening_stock: isNew && p.opening && p.opening.qty ? { qty: p.opening.qty, unit_cost: p.opening.unit_cost, warehouse_id: p.opening.warehouse_id } : undefined,
      };
      const r = await api.post('/api/products', body);
      toast(t('common.saved'));
      if (body.brand_name) refreshBoot();
      if (isNew) navigate(`/products/${r.id}`);
      else setVer(ver + 1);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('product.delete'), text: t('product.delete_text', { name: p.name }), danger: true, okText: t('common.delete') }))) return;
    try {
      const r = await api.del(`/api/products/${p.id}`);
      toast(r.deactivated ? t('product.deactivated') : t('common.deleted'));
      navigate('/products');
    } catch (e) { errToast(e); }
  };
  const photo = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    const url = await readImage(file, 900, 0.85);
    set({ photo: url, photo_url: url, photo_remove: false });
  };
  const addCategory = async () => {
    const name = await promptDialog({ title: t('product.new_category'), inputLabel: t('common.name'), requireText: true });
    if (!name) return;
    try { const r = await api.post('/api/categories', { name }); await refreshBoot(); set({ category_id: r.id }); } catch (e) { errToast(e); }
  };
  const ro = !editable;

  return html`<div class="page stack">
    ${!isNew && html`<div class="row wrap gap-8">
      <div class="row gap-8 grow">
        ${p.type === 'service' ? html`<${Pill} kind="info">${t('product.type.service')}</${Pill}>` : null}
        ${!p.active ? html`<${Pill} kind="out">${t('common.inactive')}</${Pill}>` : null}
        <span class="small muted">#${p.no}</span>
      </div>
      <${Btn} icon="tag" onClick=${() => openModal(LabelDialog, { products: [{ ...p, stock: p.stock }] })}>${t('product.print_label')}</${Btn}>
      ${can('purchases.create') && html`<${Btn} icon="truck" onClick=${() => navigate('/docs/purchase/new', { product: p.id })}>${t('product.buy')}</${Btn}>`}
      ${can('stock.adjust') && p.track_stock ? html`<${Btn} icon="scale" onClick=${() => navigate('/docs/adjust/new', { product: p.id })}>${t('product.adjust')}</${Btn}>` : null}
      <${MenuButton} iconOnly icon="ellipsis" title=${t('common.more')} items=${[
        editable && { label: t('product.duplicate'), icon: 'copy', onClick: () => navigate('/products/new', { copy: p.id }) },
        can('sales.view') && { label: t('product.sales_docs'), icon: 'receipt', onClick: () => setTab('sales') },
        editable && '-',
        editable && { label: t('product.delete'), icon: 'trash-2', danger: true, onClick: remove },
      ]} />
    </div>`}

    ${!isNew && html`<${Tabs} value=${tab} onValue=${setTab} tabs=${[
      { id: 'info', label: t('product.tab_info'), icon: 'package' },
      can('stock.view') && p.track_stock && { id: 'moves', label: t('product.tab_moves'), icon: 'arrow-left-right' },
      { id: 'sales', label: t('product.tab_history'), icon: 'history' },
    ]} />`}

    ${tab === 'moves' && html`<${ProductMoves} product=${p} />`}
    ${tab === 'sales' && html`<${ProductHistory} product=${p} />`}

    ${tab === 'info' && html`<div class="split wide-side">
      <div class="stack">
        <${Panel} title=${t('product.general')} icon="package">
          <div class="row top gap-16">
            <div class="col gap-8" style="align-items:center">
              <div class="photo-box" onClick=${ro ? null : photo} title=${t('product.photo')}>
                ${p.photo_url ? html`<img src=${p.photo_url} alt="" />` : html`<${Icon} name="camera" size="lg" cls="muted" />`}
              </div>
              ${p.photo_url && !ro && html`<button type="button" class="link-btn tiny" onClick=${() => set({ photo: null, photo_url: null, photo_remove: true })}>${t('common.remove')}</button>`}
            </div>
            <div class="grow grid-form">
              <${Field} label=${t('product.name')} required cls="span-2"><${Input} value=${p.name} onValue=${(v) => set({ name: v })} disabled=${ro} autoFocus=${isNew} dir="auto" /></${Field}>
              <${Field} label=${t('product.name2')} hint=${t('product.name2_hint')} cls="span-2"><${Input} value=${p.name2} onValue=${(v) => set({ name2: v })} disabled=${ro} dir="auto" /></${Field}>
              <${Field} label=${t('product.code')}><${Input} value=${p.code} onValue=${(v) => set({ code: v })} disabled=${ro} /></${Field}>
              <${Field} label=${t('product.barcode')}>
                <div class="row gap-4"><${Input} value=${p.barcode} onValue=${(v) => set({ barcode: v.trim() })} disabled=${ro} />
                  ${!ro && html`<${IconBtn} icon="refresh-cw" title=${t('product.generate_barcode')} onClick=${() => set({ barcode: generateEan13() })} />`}</div>
              </${Field}>
              <${Field} label=${t('product.type')}><${Select} value=${p.type} onValue=${(v) => set({ type: v, track_stock: v === 'service' ? 0 : p.track_stock })} disabled=${ro} options=${[{ value: 'product', label: t('product.type.product') }, { value: 'service', label: t('product.type.service') }]} /></${Field}>
              <${Field} label=${t('product.unit')}>
                <input class="input" list="rm-units" value=${p.unit || ''} onInput=${(e) => set({ unit: e.target.value })} disabled=${ro} />
                <datalist id="rm-units">${UNITS.map((u) => html`<option value=${u} />`)}</datalist>
              </${Field}>
              <${Field} label=${t('product.category')}>
                <div class="row gap-4"><${CategorySelect} value=${p.category_id} onValue=${(v) => set({ category_id: v })} placeholder="—" />${!ro && html`<${IconBtn} icon="plus" title=${t('product.new_category')} onClick=${addCategory} />`}</div>
              </${Field}>
              <${Field} label=${t('product.brand')}>
                <${Combo} value=${p.brand_id ? ((boot().brands || []).find((b) => b.id === p.brand_id) || {}).name : p.brand_name} placeholder="—" disabled=${ro}
                  search=${async (q) => (boot().brands || []).filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30)}
                  renderItem=${(b) => b.name} onSelect=${(b) => set({ brand_id: b.id, brand_name: b.name })}
                  onCreate=${(text) => set({ brand_id: '', brand_name: text })} createLabel=${t('product.new_brand')} />
              </${Field}>
            </div>
          </div>
        </${Panel}>

        <${Panel} title=${t('product.prices')} icon="tag" tools=${!canPrices && html`<span class="small muted">${t('product.prices_readonly')}</span>`}>
          <div class="grid-form">
            <${Field} label=${t('product.price_currency')} hint=${t('product.price_currency_hint')}><${CurrencySelect} value=${p.currency} onValue=${(v) => set({ currency: v })} disabled=${!canPrices && !isNew} /></${Field}>
            ${(showCost || canPrices) && html`<${Field} label=${t('product.cost_price')} hint=${t('product.cost_price_hint')}><div class="input-wrap"><${NumInput} value=${p.cost_price} onValue=${(v) => set({ cost_price: v })} dec=${Math.max(decimals(costCur), 2)} disabled=${!canPrices} cls="has-suffix" /><span class="suffix">${costCur}</span></div></${Field}>`}
            ${showCost && p.avg_cost_usd > 0 && html`<${Field} label=${t('product.avg_cost')} hint=${t('product.avg_cost_hint')}><div class="input" style="display:flex;align-items:center;background:var(--surface-2)"><span class="num">${money(p.avg_cost_usd, 'USD')}</span><span class="muted small" style="margin-inline-start:8px">≈ ${money(avgInCur, costCur)}</span></div></${Field}>`}
          </div>
          <table class="tbl compact mt-16"><thead><tr><th>${t('doc.price_list')}</th><th class="r" style="width:200px">${t('print.col.price')} (${costCur})</th>${showCost && html`<th class="r">${t('product.margin')}</th>`}<th class="r">${costCur === 'USD' ? 'IQD' : 'USD'}</th></tr></thead>
            <tbody>${(boot().price_lists || []).filter((pl) => pl.active).map((pl) => {
              const v = p.prices[pl.id];
              const margin = showCost && costBase && v ? (v - costBase) / v * 100 : null;
              return html`<tr><td>${pl.name}${pl.is_default ? html` <${Pill} kind="brass">${t('common.default')}</${Pill}>` : null}</td>
                <td class="r"><${NumInput} size="sm" value=${v ?? null} onValue=${(nv) => set({ prices: { ...p.prices, [pl.id]: nv === null ? '' : nv } })} dec=${Math.max(decimals(costCur), 2)} disabled=${!canPrices} /></td>
                ${showCost && html`<td class="r small num ${margin !== null && margin < 0 ? 'neg' : 'muted'}">${margin !== null ? fpct(margin) : ''}</td>`}
                <td class="r small muted num">${v ? money(convert(v, costCur, costCur === 'USD' ? 'IQD' : 'USD'), costCur === 'USD' ? 'IQD' : 'USD') : ''}</td></tr>`;
            })}</tbody></table>
          ${showCost && canPrices && costBase ? html`<div class="row wrap gap-8 mt-12 small"><span class="muted">${t('product.quick_margin')}:</span>
            ${[20, 30, 40, 50, 75, 100].map((m) => html`<button type="button" class="chip" onClick=${() => { const dl = (boot().price_lists || []).find((x) => x.is_default) || (boot().price_lists || [])[0]; if (dl) set({ prices: { ...p.prices, [dl.id]: round(costBase * (1 + m / 100), costCur === 'IQD' ? -2 : 2) } }); }}>+${m}%</button>`)}</div>` : null}
        </${Panel}>

        ${p.type !== 'service' && html`<${Panel} title=${t('product.stock_settings')} icon="boxes">
          <div class="grid-form">
            <div class="span-all"><${Check} checked=${!!p.track_stock} onValue=${(v) => set({ track_stock: v ? 1 : 0 })} disabled=${ro} label=${t('product.track_stock')} /></div>
            <${Field} label=${t('product.min_stock')} hint=${t('product.min_stock_hint_default', { n: fqty(lowDefault) })}><${NumInput} value=${p.min_stock || null} onValue=${(v) => set({ min_stock: v || 0 })} dec=${3} disabled=${ro} placeholder=${fqty(lowDefault)} /></${Field}>
            <${Field} label=${t('product.max_stock')}><${NumInput} value=${p.max_stock} onValue=${(v) => set({ max_stock: v })} dec=${3} disabled=${ro} /></${Field}>
            <${Field} label=${t('product.shelf')}><${Input} value=${p.shelf} onValue=${(v) => set({ shelf: v })} disabled=${ro} /></${Field}>
            ${isNew && !!p.track_stock && html`<div class="span-all form-section" style="padding-bottom:0"><h3>${t('product.opening_stock')}</h3><div class="grid-form">
              <${Field} label=${t('print.col.qty')}><${NumInput} value=${p.opening.qty} onValue=${(v) => set({ opening: { ...p.opening, qty: v } })} dec=${3} /></${Field}>
              ${showCost && html`<${Field} label=${`${t('product.unit_cost')} (${costCur})`} hint=${t('product.opening_cost_hint')}><${NumInput} value=${p.opening.unit_cost} onValue=${(v) => set({ opening: { ...p.opening, unit_cost: v } })} dec=${Math.max(decimals(costCur), 2)} /></${Field}>`}
              ${(boot().warehouses || []).filter((w) => w.active).length > 1 && html`<${Field} label=${t('doc.warehouse')}><${WarehouseSelect} value=${p.opening.warehouse_id} onValue=${(v) => set({ opening: { ...p.opening, warehouse_id: v } })} /></${Field}>`}
            </div></div>`}
          </div>
        </${Panel}>`}

        <${Panel} title=${t('product.fitments')} icon="car" tools=${!ro && html`<${Btn} size="sm" icon="plus" onClick=${() => set({ fitments: [...p.fitments, { make_id: '', model_id: '', year_from: null, year_to: null, engine: '', note: '' }] })}>${t('common.add')}</${Btn}>`}>
          ${!p.fitments.length ? html`<p class="small muted" style="margin:0">${t('product.fitments_none')}</p>` : html`<div class="col gap-8">
            ${p.fitments.map((x, i) => html`<${FitmentRow} key=${i} row=${x} disabled=${ro} onChange=${(nx) => set({ fitments: p.fitments.map((y, j) => (j === i ? nx : y)) })} onRemove=${() => set({ fitments: p.fitments.filter((y, j) => j !== i) })} />`)}
          </div>`}
        </${Panel}>

        <${Panel} title=${t('product.codes')} icon="hash" tools=${!ro && html`<${Btn} size="sm" icon="plus" onClick=${() => set({ codes: [...p.codes, { code: '', kind: 'oem', note: '' }] })}>${t('common.add')}</${Btn}>`}>
          <div class="grid-form mb-12">
            <${Field} label=${t('product.oem_no')}><${Input} value=${p.oem_no} onValue=${(v) => set({ oem_no: v })} disabled=${ro} /></${Field}>
          </div>
          ${!p.codes.length ? html`<p class="small muted" style="margin:0">${t('product.codes_hint')}</p>` : html`<div class="col gap-8">${p.codes.map((c, i) => html`<div class="row gap-8">
            <div style="width:130px"><${Select} size="sm" value=${c.kind} disabled=${ro} onValue=${(v) => set({ codes: p.codes.map((y, j) => (j === i ? { ...y, kind: v } : y)) })} options=${CODE_KINDS.map((k) => ({ value: k, label: t(`product.code_kind.${k}`) }))} /></div>
            <div style="width:220px"><${Input} size="sm" value=${c.code} disabled=${ro} onValue=${(v) => set({ codes: p.codes.map((y, j) => (j === i ? { ...y, code: v } : y)) })} placeholder=${t('product.code')} /></div>
            <div class="grow"><${Input} size="sm" value=${c.note || ''} disabled=${ro} onValue=${(v) => set({ codes: p.codes.map((y, j) => (j === i ? { ...y, note: v } : y)) })} placeholder=${t('common.note')} /></div>
            ${!ro && html`<${IconBtn} icon="x" onClick=${() => set({ codes: p.codes.filter((y, j) => j !== i) })} />`}
          </div>`)}</div>`}
        </${Panel}>

        <${Panel} title=${t('product.other')} icon="sliders-horizontal">
          <div class="grid-form">
            <${Field} label=${t('product.color')}><${Input} value=${p.color} onValue=${(v) => set({ color: v })} disabled=${ro} /></${Field}>
            <${Field} label=${t('product.size')}><${Input} value=${p.size} onValue=${(v) => set({ size: v })} disabled=${ro} /></${Field}>
            <${Field} label=${t('product.warranty_months')}><${NumInput} value=${p.warranty_months} onValue=${(v) => set({ warranty_months: v || 0 })} dec=${0} disabled=${ro} /></${Field}>
            <div class="span-all"><${Field} label=${t('doc.notes')}><${Textarea} value=${p.notes} onValue=${(v) => set({ notes: v })} rows=${2} disabled=${ro} /></${Field}></div>
            <div class="span-all"><${Check} checked=${!!p.active} onValue=${(v) => set({ active: v ? 1 : 0 })} disabled=${ro} label=${t('product.active')} /></div>
          </div>
        </${Panel}>
      </div>

      ${!isNew ? html`<div class="stack">
        ${p.track_stock ? html`<${Panel} title=${t('product.stock')} icon="boxes">
          <div class="row between"><span class="muted small">${t('product.total_stock')}</span><span style="font-family:var(--font-cond);font-size:26px;font-weight:600" class=${`num ${p.stock <= 0 ? 'neg' : ''}`}>${fqty(p.stock)} <span class="small muted">${dn(p.unit) || ''}</span></span></div>
          ${p.levels.length > 1 && html`<table class="tbl compact mt-8"><tbody>${p.levels.map((l) => html`<tr><td>${l.name}</td><td class="r num">${fqty(l.qty)}</td></tr>`)}</tbody></table>`}
          <${KV} items=${[
            [t('product.min_stock'), p.min_stock > 0 ? fqty(p.min_stock) : html`${fqty(lowDefault)} <span class="muted small">(${t('common.default')})</span>`],
            [t('product.sold_30d'), fqty(p.sold_30d)],
            showCost && p.avg_cost_usd > 0 && [t('product.stock_value'), display(Math.max(p.stock, 0) * p.avg_cost_usd)],
            [t('product.last_sale'), p.last_sale_date ? fdate(p.last_sale_date) : '—'],
            [t('product.last_purchase'), p.last_purchase_date ? fdate(p.last_purchase_date) : '—'],
            p.last_supplier_name && [t('product.last_supplier'), html`<a href=${`#/partner/${p.last_supplier_id}`} dir="auto">${p.last_supplier_name}</a>`],
          ]} />
        </${Panel}>` : null}
        ${p.recent_purchases && p.recent_purchases.length > 0 && html`<${Panel} title=${t('product.recent_purchases')} icon="truck" body=${false}><div class="mini-list">
          ${p.recent_purchases.map((r) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${r.id}`)}><div class="grow"><div class="small" dir="auto">${r.partner_name}</div><div class="tiny muted">${r.no} · ${fdate(r.date)} · ${fqty(r.qty)} ${p.unit || ''}</div></div>
            <div style="text-align:end"><${Money} value=${r.unit_price} cur=${r.currency} strong />${r.unit_cost_usd != null && showCost ? html`<div class="tiny muted num">${t('product.landed')}: ${money(r.unit_cost_usd, 'USD')}</div>` : null}</div></div>`)}
        </div></${Panel}>`}
        ${p.recent_sales && p.recent_sales.length > 0 && html`<${Panel} title=${t('product.recent_sales')} icon="receipt" body=${false}><div class="mini-list">
          ${p.recent_sales.map((r) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${r.id}`)}><div class="grow"><div class="small" dir="auto">${r.partner_name}</div><div class="tiny muted">${r.no} · ${fdate(r.date)} · ${fqty(r.qty)} ${p.unit || ''}</div></div>
            <${Money} value=${r.qty ? r.line_total / r.qty : r.unit_price} cur=${r.currency} /></div>`)}
        </div></${Panel}>`}
        ${p.barcode && html`<${Panel} title=${t('product.barcode')} icon="scan-barcode"><div style="max-width:260px" dangerouslySetInnerHTML=${{ __html: barcodeSvg(p.barcode, { height: 44 }) }}></div>${!isEan13(p.barcode) && /^\d{13}$/.test(p.barcode) ? html`<p class="tiny warn-text mt-8">${t('product.ean_check_wrong')}</p>` : null}</${Panel}>`}
      </div>` : html`<div></div>`}
    </div>`}

    ${tab === 'info' && (dirty || isNew) && editable && html`<div class="editor-bar">
      <${Btn} onClick=${() => (isNew ? navigate('/products') : setP(JSON.parse(orig)))}>${isNew ? t('common.cancel') : t('common.discard')}</${Btn}>
      <div class="grow small muted">${dirty && !isNew ? t('common.unsaved') : ''}</div>
      <${Btn} kind="primary" icon="check" disabled=${busy} onClick=${save}>${t('common.save')}</${Btn}>
    </div>`}
  </div>`;
}

function FitmentRow({ row, onChange, onRemove, disabled }) {
  const makes = boot().vehicle_makes || [];
  const [models, setModels] = useState([]);
  useEffect(() => { modelsOf(row.make_id).then(setModels); }, [row.make_id]);
  return html`<div class="row gap-8 wrap">
    <div style="width:160px"><${Select} size="sm" value=${row.make_id} disabled=${disabled} onValue=${(v) => onChange({ ...row, make_id: v, model_id: '' })} placeholder=${t('vehicle.make')} options=${makes.map((m) => ({ value: m.id, label: m.name }))} /></div>
    <div style="width:170px"><${Select} size="sm" value=${row.model_id} disabled=${disabled || !row.make_id} onValue=${(v) => onChange({ ...row, model_id: v })} placeholder=${t('product.all_models')} options=${models.map((m) => ({ value: m.id, label: m.name }))} /></div>
    <div style="width:84px"><${NumInput} size="sm" value=${row.year_from} disabled=${disabled} onValue=${(v) => onChange({ ...row, year_from: v })} dec=${0} placeholder=${t('product.year_from')} /></div>
    <span class="muted">–</span>
    <div style="width:84px"><${NumInput} size="sm" value=${row.year_to} disabled=${disabled} onValue=${(v) => onChange({ ...row, year_to: v })} dec=${0} placeholder=${t('product.year_to')} /></div>
    <div style="width:110px"><${Input} size="sm" value=${row.engine || ''} disabled=${disabled} onValue=${(v) => onChange({ ...row, engine: v })} placeholder=${t('vehicle.engine')} /></div>
    <div class="grow" style="min-width:120px"><${Input} size="sm" value=${row.note || ''} disabled=${disabled} onValue=${(v) => onChange({ ...row, note: v })} placeholder=${t('common.note')} /></div>
    ${!disabled && html`<${IconBtn} icon="x" onClick=${onRemove} />`}
  </div>`;
}

function ProductMoves({ product }) {
  const [wh, setWh] = useState('');
  const { data, loading } = useAsync(() => api.get(`/api/products/${product.id}/moves`, { warehouse_id: wh || undefined, limit: 1000 }), [wh]);
  const showCost = can('products.cost');
  return html`<div>
    ${(boot().warehouses || []).length > 1 && html`<div class="toolbar"><div style="width:200px"><${WarehouseSelect} value=${wh} onValue=${setWh} placeholder=${t('product.all_warehouses')} /></div></div>`}
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} onRow=${(r) => r.doc_id && navigate(`/doc/${r.doc_id}`)}
      columns=${[
        { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
        { key: 'kind', label: t('common.type'), render: (r) => html`${t(`move.stock.${r.kind}`)}${r.doc_no ? html` <span class="muted small">${r.doc_no}</span>` : null}` },
        { key: 'partner', label: t('doc.partner'), render: (r) => html`<span dir="auto">${r.partner || r.partner_name || ''}</span>` },
        (boot().warehouses || []).length > 1 && { key: 'wh', label: t('doc.warehouse'), render: (r) => r.warehouse_name },
        { key: 'in', label: t('stock.in'), align: 'r', render: (r) => (r.qty > 0 ? html`<span class="num pos">+${fqty(r.qty)}</span>` : '') },
        { key: 'out', label: t('stock.out'), align: 'r', render: (r) => (r.qty < 0 ? html`<span class="num neg">${fqty(r.qty)}</span>` : '') },
        { key: 'bal', label: t('partner.balance'), align: 'r', render: (r) => html`<span class="num strong">${fqty(r.balance)}</span>` },
        showCost && { key: 'cost', label: t('doc.unit_cost'), align: 'r', render: (r) => html`<span class="num small muted">${money(r.unit_cost_usd, 'USD')}</span>` },
      ]} />`}</div>
  </div>`;
}

function ProductHistory({ product }) {
  const { data, loading } = useAsync(() => api.get('/api/docs', { type: ['sale', 'purchase', 'sale_return', 'purchase_return', 'quote', 'service'].filter((tp) => can({ sale: 'sales.view', purchase: 'purchases.view', sale_return: 'returns.view', purchase_return: 'returns.view', quote: 'quotes.view', service: 'service.view' }[tp])).join(','), product_id: product.id, limit: 200, from: '2000-01-01' }), [product.id]);
  return html`<div class="panel">${loading && !data ? html`<${Loading} />` : html`<${DocTable} rows=${data ? data.rows : []} showType />`}</div>`;
}

/* ================================================================== labels */
/** one shelf label (used for printing and for the preview in the settings) */
export function labelHtml(p, { showName = true, showCode = false, showPrice = true } = {}) {
  const e = escapeHtml;
  const code = p.barcode || p.code;
  return `<div class="lb">
    ${showName ? `<div class="nm" dir="auto">${e(p.name)}</div>` : ''}
    ${code ? `<div class="bc">${barcodeSvg(code, { height: 40, showText: true })}</div>` : ''}
    <div class="ft">${showCode && p.code ? `<span>${e(p.code)}</span>` : '<span></span>'}${showPrice && p.price != null ? `<b dir="ltr">${money(p.price, p.currency)}</b>` : ''}</div>
  </div>`;
}

export function labelCss(w, h) {
  return `.lb { width:${w}mm; height:${h}mm; box-sizing:border-box; padding:1.2mm 1.6mm; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; page-break-after:always; break-after:page; font-family:'Plex','Plex Arabic',Arial,sans-serif; background:#fff; color:#000; }
    .lb:last-child { page-break-after:auto; break-after:auto; }
    .nm { font-size:${h < 26 ? 7.5 : 9}px; font-weight:600; line-height:1.15; max-height:2.3em; overflow:hidden; }
    .bc { flex:1; display:flex; align-items:center; min-height:0; } .bc svg { width:100%; height:100%; max-height:${Math.max(8, h - 12)}mm; }
    .ft { display:flex; justify-content:space-between; align-items:baseline; font-size:8px; line-height:1.1; } .ft b { font-size:${h < 26 ? 10 : 12}px; }`;
}

export function LabelDialog({ products, close }) {
  const cfg = (boot().settings || {}).labels || {};
  const [w, setW] = useState(cfg.width_mm || 50);
  const [h, setH] = useState(cfg.height_mm || 30);
  const [showPrice, setShowPrice] = useState(cfg.show_price !== false);
  const [showName, setShowName] = useState(cfg.show_name !== false);
  const [showCode, setShowCode] = useState(!!cfg.show_code);
  const [plId, setPlId] = useState(cfg.price_list_id || defaultPriceListId());
  const [qty, setQty] = useState(() => Object.fromEntries(products.map((p) => [p.id, 1])));
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.post('/api/products/for-sale', { ids: products.map((p) => p.id), price_list_id: plId }).then((rows) => setInfo(Object.fromEntries(rows.map((r) => [r.id, r])))).catch(errToast);
  }, [plId]);
  const list = products.map((p) => ({ ...p, ...(info && info[p.id] ? info[p.id] : {}) }));
  const noBarcode = list.filter((p) => !p.barcode);
  const genMissing = async () => {
    setBusy(true);
    try {
      for (const p of noBarcode) {
        const full = await api.get(`/api/products/${p.id}`);
        await api.post('/api/products', { ...full, barcode: generateEan13(), prices: undefined, codes: full.codes, fitments: full.fitments });
      }
      const rows = await api.post('/api/products/for-sale', { ids: products.map((p) => p.id), price_list_id: plId });
      setInfo(Object.fromEntries(rows.map((r) => [r.id, r])));
      toast(t('product.barcodes_generated', { n: noBarcode.length }));
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  const doPrint = () => {
    const labels = [];
    for (const p of list) {
      const n = Math.max(0, Math.round(qty[p.id] || 0));
      const price = p.prices && p.prices[plId] != null ? p.prices[plId] : p.price;
      const one = labelHtml({ name: p.name, code: p.code, barcode: p.barcode, price, currency: p.currency }, { showName, showCode, showPrice });
      for (let i = 0; i < n; i++) labels.push(one);
    }
    if (!labels.length) return;
    printHtml(labels.join(''), { title: t('product.labels'), page: 'label', w, h, css: labelCss(w, h) });
  };
  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);
  return html`<${Modal} title=${t('product.labels')} icon="tag" close=${close} size="wide"
    left=${html`<span class="small muted">${t('product.labels_total', { n: total })}</span>`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.close')}</${Btn}><${Btn} kind="primary" icon="printer" onClick=${doPrint} disabled=${!total}>${t('common.print')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="row wrap gap-12">
        <${Field} label=${t('product.label_size')}><div class="row gap-4"><div style="width:80px"><${NumInput} value=${w} onValue=${(v) => setW(v || 50)} dec=${0} /></div>×<div style="width:80px"><${NumInput} value=${h} onValue=${(v) => setH(v || 30)} dec=${0} /></div><span class="small muted">mm</span></div></${Field}>
        <${Field} label=${t('doc.price_list')}><div style="width:180px"><${PriceListSelect} value=${plId} onValue=${setPlId} /></div></${Field}>
        <div class="col gap-4" style="justify-content:flex-end"><${Check} checked=${showName} onValue=${setShowName} label=${t('product.label_name')} /><${Check} checked=${showPrice} onValue=${setShowPrice} label=${t('product.label_price')} /><${Check} checked=${showCode} onValue=${setShowCode} label=${t('product.label_code')} /></div>
      </div>
      ${noBarcode.length > 0 && html`<${Notice} kind="warn">${t('product.no_barcode_n', { n: noBarcode.length })} ${can('products.manage') && html`<button class="link-btn" disabled=${busy} onClick=${genMissing}>${t('product.generate_missing')}</button>`}</${Notice}>`}
      <div class="table-wrap" style="max-height:340px"><table class="tbl compact"><thead><tr><th>${t('product.name')}</th><th>${t('product.barcode')}</th><th class="r">${t('product.stock')}</th><th class="r" style="width:110px">${t('product.label_qty')}</th></tr></thead>
        <tbody>${list.map((p) => html`<tr><td dir="auto">${p.name}</td><td class="small ltr">${p.barcode || html`<span class="muted">${p.code || '—'}</span>`}</td><td class="r num small">${p.track_stock ? fqty(p.stock) : ''}</td>
          <td><${NumInput} size="sm" value=${qty[p.id]} onValue=${(v) => setQty({ ...qty, [p.id]: v || 0 })} dec=${0} /></td></tr>`)}</tbody></table></div>
      <div class="row gap-8"><button type="button" class="link-btn small" onClick=${() => setQty(Object.fromEntries(list.map((p) => [p.id, Math.max(1, Math.round(p.stock || 0))])))}>${t('product.qty_as_stock')}</button>
        <button type="button" class="link-btn small" onClick=${() => setQty(Object.fromEntries(list.map((p) => [p.id, 1])))}>${t('product.qty_one_each')}</button></div>
    </div>
  </${Modal}>`;
}

/* ================================================================== bulk price */
function BulkPriceDialog({ filter, count, close }) {
  const pls = (boot().price_lists || []).filter((p) => p.active);
  const [plId, setPlId] = useState(defaultPriceListId());
  const [mode, setMode] = useState('percent');
  const [value, setValue] = useState(10);
  const [fromList, setFromList] = useState((pls.find((p) => p.id !== plId) || {}).id || '');
  const [roundTo, setRoundTo] = useState(0);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!(await confirmDialog({ title: t('product.bulk_price'), text: t('product.bulk_confirm', { n: count }), okText: t('common.apply') }))) return;
    setBusy(true);
    try {
      const { limit, offset, sort, price_list_id, with_prices, ...flt } = filter;
      const r = await api.post('/api/products/bulk-price', { filter: flt, price_list_id: plId, mode, value, from_list_id: fromList, round_to: roundTo });
      toast(t('product.bulk_done', { n: r.changed }));
      close(true);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${t('product.bulk_price')} icon="percent" close=${close} onSubmit=${run}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy}>${t('common.apply')}</${Btn}>`}>
    <div class="col gap-12">
      <${Notice}>${t('product.bulk_scope', { n: count })}</${Notice}>
      <${Field} label=${t('product.bulk_target_list')}><${PriceListSelect} value=${plId} onValue=${setPlId} /></${Field}>
      <${Field} label=${t('product.bulk_mode')}><${Select} value=${mode} onValue=${setMode} options=${['percent', 'set_margin', 'copy_list'].map((m) => ({ value: m, label: t(`product.bulk.${m}`) }))} /></${Field}>
      ${mode === 'copy_list' && html`<${Field} label=${t('product.bulk_from_list')}><${Select} value=${fromList} onValue=${setFromList} options=${pls.filter((p) => p.id !== plId).map((p) => ({ value: p.id, label: p.name }))} /></${Field}>`}
      <div class="form-2">
        <${Field} label=${t(mode === 'set_margin' ? 'product.bulk_margin' : 'product.bulk_percent')} hint=${t(`product.bulk_hint.${mode}`)}><${NumInput} value=${value} onValue=${setValue} dec=${2} /></${Field}>
        <${Field} label=${t('product.bulk_round')} hint=${t('product.bulk_round_hint')}><${Select} value=${String(roundTo)} onValue=${(v) => setRoundTo(Number(v))} options=${[0, 0.25, 0.5, 1, 5, 100, 250, 500, 1000].map((v) => ({ value: String(v), label: v ? num(v, 2) : t('product.bulk_no_round') }))} /></${Field}>
      </div>
    </div>
  </${Modal}>`;
}

/* ================================================================== import */
const IMPORT_FIELDS = ['code', 'barcode', 'name', 'name2', 'category', 'brand', 'unit', 'currency', 'cost_price', 'min_stock', 'shelf', 'color', 'size', 'oem_no', 'stock'];
const GUESS = {
  code: ['code', 'kod', 'stok kodu', 'ürün kodu', 'item code', 'sku', 'كود', 'رمز', 'kod'],
  barcode: ['barcode', 'barkod', 'ean', 'باركود'],
  name: ['name', 'ad', 'adı', 'ürün', 'ürün adı', 'product', 'description', 'açıklama', 'اسم', 'الاسم', 'nav', 'navê'],
  name2: ['name2', 'arapça', 'arabic', 'kurdish', 'ikinci ad'],
  category: ['category', 'kategori', 'grup', 'فئة', 'الفئة'],
  brand: ['brand', 'marka', 'ماركة', 'العلامة'],
  unit: ['unit', 'birim', 'وحدة'],
  currency: ['currency', 'döviz', 'para birimi', 'عملة'],
  cost_price: ['cost', 'maliyet', 'alış', 'alış fiyatı', 'purchase price', 'كلفة', 'سعر الشراء'],
  min_stock: ['min', 'minimum', 'kritik', 'min stok'],
  shelf: ['shelf', 'raf', 'رف'],
  color: ['color', 'renk', 'لون'],
  size: ['size', 'beden', 'ölçü', 'حجم'],
  oem_no: ['oem', 'oem no', 'parça no'],
  stock: ['stock', 'stok', 'miktar', 'qty', 'quantity', 'adet', 'كمية', 'المخزون'],
};
function guessField(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return '';
  for (const pl of boot().price_lists || []) if (h === String(pl.name).toLowerCase() || h === `price_${pl.code}`) return `price_${pl.id}`;
  if (['price', 'fiyat', 'satış fiyatı', 'sale price', 'سعر', 'السعر', 'buha', 'biha'].includes(h)) return 'price';
  for (const [k, words] of Object.entries(GUESS)) if (words.includes(h)) return k;
  for (const [k, words] of Object.entries(GUESS)) if (words.some((w) => w.length > 3 && h.includes(w))) return k;
  return '';
}

function ImportDialog({ close }) {
  const [rows, setRows] = useState(null);
  const [map, setMap] = useState([]);
  const [mode, setMode] = useState('create');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const pls = (boot().price_lists || []).filter((p) => p.active);
  const targets = [{ value: '', label: t('product.import_ignore') }, ...IMPORT_FIELDS.map((f) => ({ value: f, label: t(`product.import_field.${f}`) })),
    { value: 'price', label: `${t('print.col.price')} (${(pls.find((p) => p.is_default) || {}).name || ''})` }, ...pls.map((p) => ({ value: `price_${p.id}`, label: `${t('print.col.price')}: ${p.name}` }))];
  const choose = async () => {
    const file = await pickFile('.xlsx,.csv,.txt');
    if (!file) return;
    try {
      const r = await readSheet(file);
      if (!r.length) { toast(t('product.import_empty'), 'err'); return; }
      setRows(r);
      setMap(r[0].map(guessField));
    } catch (e) { toast(`${t('product.import_read_error')}: ${e.message}`, 'err'); }
  };
  const template = () => downloadXlsx('urun-sablonu', [{ name: 'Ürünler', headers: ['code', 'barcode', 'name', 'name2', 'category', 'brand', 'unit', 'currency', 'cost_price', 'price', 'min_stock', 'shelf', 'stock'], rows: [['FR-001', '', 'Fren balatası ön Corolla 2019', '', 'Fren', 'Bosch', 'takım', 'USD', 18, 30, 4, 'A-12', 10]] }]);
  const objects = rows ? rows.slice(1).map((r) => {
    const o = {};
    map.forEach((f, i) => { if (f) o[f] = typeof r[i] === 'string' ? r[i].trim() : r[i]; });
    return o;
  }).filter((o) => o.name) : [];
  const run = async () => {
    setBusy(true);
    try { setResult(await api.post('/api/products/import', { rows: objects, mode })); } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${t('product.import')} icon="upload" close=${() => close(!!result)} size="xwide"
    foot=${result ? html`<${Btn} kind="primary" onClick=${() => close(true)}>${t('common.close')}</${Btn}>` : html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}>
      <${Btn} kind="primary" icon="upload" disabled=${busy || !objects.length || !map.includes('name')} onClick=${run}>${t('product.import_run', { n: objects.length })}</${Btn}>`}>
    ${result ? html`<div class="col gap-12">
      <${Notice} kind="ok">${t('product.import_result', { created: result.created, updated: result.updated, skipped: result.skipped })}</${Notice}>
      ${result.errors.length > 0 && html`<${Notice} kind="err"><div>${t('product.import_errors', { n: result.errors.length })}</div><ul style="margin:6px 0 0;padding-inline-start:18px">${result.errors.slice(0, 20).map((e) => html`<li>${t('product.import_row', { n: e.row })}: ${e.error}</li>`)}</ul></${Notice}>`}
    </div>` : !rows ? html`<div class="col gap-12">
      <p class="dim">${t('product.import_text')}</p>
      <div class="row gap-8"><${Btn} kind="primary" icon="upload" onClick=${choose}>${t('product.import_choose')}</${Btn}><${Btn} icon="file-down" onClick=${template}>${t('product.import_template')}</${Btn}></div>
    </div>` : html`<div class="col gap-12">
      <div class="row gap-12 wrap"><${Segmented} value=${mode} onValue=${setMode} options=${[{ value: 'create', label: t('product.import_mode_create') }, { value: 'upsert', label: t('product.import_mode_upsert') }]} />
        <span class="small muted">${t(`product.import_mode_hint.${mode}`)}</span></div>
      ${!map.includes('name') && html`<${Notice} kind="warn">${t('product.import_need_name')}</${Notice}>`}
      <div class="table-wrap" style="max-height:52vh"><table class="tbl compact">
        <thead><tr>${rows[0].map((hd, i) => html`<th style="min-width:150px"><div class="tiny muted mb-8" dir="auto">${String(hd)}</div>
          <${Select} size="sm" value=${map[i]} onValue=${(v) => setMap(map.map((m, j) => (j === i ? v : m)))} options=${targets} /></th>`)}</tr></thead>
        <tbody>${rows.slice(1, 9).map((r) => html`<tr>${rows[0].map((_, i) => html`<td class=${`small ${map[i] ? '' : 'muted'}`} dir="auto">${String(r[i] ?? '')}</td>`)}</tr>`)}</tbody>
      </table></div>
      <p class="small muted">${t('product.import_preview_n', { n: rows.length - 1 })}</p>
    </div>`}
  </${Modal}>`;
}
