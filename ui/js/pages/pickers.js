// Shared pickers used by many screens: partner, product, vehicle search; account / warehouse / staff selects.
import { html, useState, useEffect, useRef } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { boot, can } from '../core/store.js';
import { money, num, convert } from '../core/format.js';
import { Icon, IconBtn, Combo, Select, Balances, Pill, openModal, errToast, Modal, Btn, NumInput, Check, Loading, Empty, useAsync, useDebounced } from '../core/ui.js';
import { PartnerDialog } from './partners.js';
import { VehicleDialog } from './vehicles.js';
import { dn } from '../core/names.js';

/* ------------------------------------------------------------------ partner */
export function PartnerPicker({ value, onChange, kind, placeholder, autoFocus, allowCreate = true, size = '', disabled, showBalance = true, inputRef }) {
  const [editing, setEditing] = useState(!value);
  useEffect(() => { setEditing(!value); }, [value && value.id]);
  if (value && !editing) {
    return html`<div class=${`partner-chip ${size}`}>
      <${Icon} name=${value.is_walkin ? 'user' : value.kind === 'supplier' ? 'building-2' : 'users'} />
      <div class="grow" style="min-width:0">
        <div class="ellipsis strong" dir="auto">${dn(value.name)}</div>
        <div class="tiny muted ellipsis">${[value.phone, value.city].filter(Boolean).join(' · ')}</div>
      </div>
      ${showBalance && value.balances && html`<${Balances} value=${value.balances} emptyText=" " />`}
      ${!disabled && html`<${IconBtn} icon="pencil" title=${t('common.change')} onClick=${() => setEditing(true)} />`}
    </div>`;
  }
  const search = async (q) => api.get('/api/partners', { q, kind, limit: 20 });
  const create = allowCreate && can('partners.manage') ? async (text) => {
    const p = await openModal(PartnerDialog, { initial: { name: text, kind: kind || 'customer' } });
    if (p) { onChange(p); setEditing(false); }
  } : undefined;
  return html`<div class="row gap-4">
    <div class="grow"><${Combo} placeholder=${placeholder || t('partner.search')} autoFocus=${autoFocus || (!!value && editing)} size=${size} inputRef=${inputRef} disabled=${disabled}
      search=${search} onCreate=${create} createLabel=${t('partner.new')}
      renderItem=${(p) => html`<${Icon} name=${p.is_walkin ? 'user' : p.kind === 'supplier' ? 'building-2' : 'users'} size="sm" />
        <div class="grow" style="min-width:0"><div class="ellipsis" dir="auto">${dn(p.name)}</div><div class="sub ellipsis">${[p.phone, p.city, p.company].filter(Boolean).join(' · ')}</div></div>
        ${p.balances && html`<${Balances} value=${p.balances} emptyText=" " />`}`}
      onSelect=${(p) => { onChange(p); setEditing(false); }} /></div>
    ${value && html`<${IconBtn} icon="x" title=${t('common.cancel')} onClick=${() => setEditing(false)} />`}
  </div>`;
}

/* ------------------------------------------------------------------ product search with barcode support */
/**
 * onPick(product) receives the /api/products row (+ prices when found by code).
 * Enter with a code typed/scanned looks it up exactly first (barcode scanners end with Enter).
 * browse: an empty box shows the most sold products; onMore(text) opens the full product list.
 * priceOf(product): the price shown next to each product (e.g. the purchase cost on purchase documents).
 */
export function ProductSearch({ onPick, priceListId, warehouseId, currency, usdIqd, placeholder, autoFocus, inputRef, size = '', type, extraParams, browse, onMore, priceOf }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [suggest, setSuggest] = useState(null); // most sold products, for an empty box
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const box = useRef(null);
  const ref = useRef(null);
  // the latest results, also for an Enter pressed before the screen has caught up (fast typing, scanners)
  const latest = useRef({ items: [], hi: 0, forQ: null });
  latest.current.items = items;
  latest.current.hi = hi;
  const search = (text) => api.get('/api/products', { q: text, limit: 15, price_list_id: priceListId, warehouse_id: warehouseId, type, ...(extraParams || {}) });
  useEffect(() => { if (inputRef) inputRef.current = ref.current; });
  useEffect(() => {
    if (!open || q.trim().length < 1) { setItems([]); return undefined; }
    const my = ++seq.current;
    const text = q.trim();
    setBusy(true);
    const tm = setTimeout(async () => {
      try {
        const r = await search(text);
        if (my === seq.current) { setItems(r.rows); setHi(0); Object.assign(latest.current, { items: r.rows, hi: 0, forQ: text }); }
      } catch (e) { /* ignore */ } finally { if (my === seq.current) setBusy(false); }
    }, 180);
    return () => clearTimeout(tm);
  }, [q, open]);
  useEffect(() => {
    if (!browse || !open || q.trim() || suggest) return;
    const params = { limit: 10, price_list_id: priceListId, warehouse_id: warehouseId };
    const keep = (rows) => (type ? rows.filter((p) => p.type === type) : rows);
    api.get('/api/products/popular', params)
      .catch(() => api.get('/api/products', { ...params, type, sort: 'name' }))
      .then((r) => { setSuggest(keep(r.rows || [])); setHi(0); })
      .catch(() => setSuggest([]));
  }, [browse, open, q, priceListId, warehouseId]);
  useEffect(() => { setSuggest(null); }, [priceListId, warehouseId]);
  useEffect(() => {
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const pick = (p) => { setQ(''); setItems([]); setOpen(false); onPick(p); setTimeout(() => ref.current && ref.current.focus(), 0); };
  const shown = q.trim() ? items : (browse && suggest) || [];
  const more = () => { const text = q.trim(); setOpen(false); setQ(''); if (onMore) onMore(text); };
  const byCode = async (code) => {
    try {
      const r = await api.get(`/api/products/by-code/${encodeURIComponent(code)}`, { price_list_id: priceListId, warehouse_id: warehouseId });
      return r.product;
    } catch (e) { return null; }
  };
  const onKey = async (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return; }
    if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = q.trim();
    if (!text) { if (open && shown[hi]) pick(shown[hi]); return; }
    if (/^\S+$/.test(text)) {
      const p = await byCode(text);
      if (p) { pick(p); return; }
    }
    let { items: list, hi: at } = latest.current;
    if (latest.current.forQ !== text) {
      // Enter came before the results for this text were on screen: look it up now
      try { list = (await search(text)).rows; at = 0; } catch (x) { list = []; }
    }
    if (list[at]) pick(list[at]);
  };
  const priceIn = (p) => (currency ? convert(p.price || 0, p.currency, currency, usdIqd) : p.price);
  const priceText = (p) => {
    if (priceOf) { const v = priceOf(p); return v == null ? '—' : money(v, currency || p.currency); }
    return p.price != null ? money(priceIn(p), currency || p.currency) : '—';
  };
  const showList = open && (q.trim() || (browse && suggest && (suggest.length || onMore)));
  return html`<div class="combo grow" ref=${box}>
    <div class="input-wrap"><${Icon} name="scan-barcode" />
      <input ref=${ref} class=${`input ${size}`} value=${q} placeholder=${placeholder || t('product.search_scan')} autoFocus=${autoFocus} autocomplete="off"
        onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setHi(0); setOpen(true); }} onKeyDown=${onKey} /></div>
    ${showList && html`<div class="combo-list" role="listbox" style="min-width:420px">
      ${q.trim()
        ? (busy && !items.length ? html`<div class="combo-empty">${t('common.loading')}</div>` : !items.length ? html`<div class="combo-empty">${t('common.no_results')}</div>` : null)
        : shown.length ? html`<div class="combo-head">${t('pos.popular')}</div>` : null}
      ${shown.map((p, i) => html`<div class=${`combo-item ${i === hi ? 'on' : ''}`} onMouseDown=${(e) => { e.preventDefault(); pick(p); }} onMouseEnter=${() => setHi(i)}>
        ${p.photo_id ? html`<img class="thumb" style="width:30px;height:30px;border-radius:5px;object-fit:cover" src=${`/api/files/${p.photo_id}`} alt="" />` : html`<${Icon} name=${p.type === 'service' ? 'wrench' : 'package'} size="sm" />`}
        <div class="grow" style="min-width:0"><div class="ellipsis" dir="auto">${p.name}</div>
          <div class="sub ellipsis">${[p.code, p.brand_name, p.shelf ? `${t('product.shelf')}: ${p.shelf}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${p.track_stock ? html`<span class=${`tiny num ${p.stock <= 0 ? 'neg' : p.stock_state === 'low' ? 'warn-text' : 'muted'}`}>${num(p.stock, 2)} ${dn(p.unit) || ''}</span>` : null}
        <span class="num strong" style="min-width:90px;text-align:end">${priceText(p)}</span>
      </div>`)}
      ${onMore && html`<button type="button" class="combo-more" onMouseDown=${(e) => e.preventDefault()} onClick=${more}>
        <${Icon} name="list-checks" size="sm" />${t('picker.all_list')}</button>`}
    </div>`}
  </div>`;
}

/**
 * Product list for documents: browse by category or search, tick several products (each with its quantity)
 * and add them all at once. close([{ product, qty }]) — the rows are /api/products rows.
 * priceOf(product): the price that will go on the line, in the document's currency (sale price or cost).
 */
export function ProductPickerDialog({ close, priceListId, warehouseId, type, currency, priceOf, priceLabel, showPrices = true, q: q0 = '' }) {
  const [q, setQ] = useState(q0 || '');
  const dq = useDebounced(q, 200);
  const [cat, setCat] = useState('');
  const [onlySel, setOnlySel] = useState(false);
  const [inStock, setInStock] = useState(false);
  const [sel, setSel] = useState(() => new Map()); // product id -> { product, qty }
  const [hi, setHi] = useState(0);
  const searchRef = useRef(null);
  const wrapRef = useRef(null);
  const cats = boot().categories || [];
  const res = useAsync(() => api.get('/api/products', {
    q: dq.trim() || undefined, category_id: cat || undefined, stock: inStock ? 'in' : undefined, type,
    price_list_id: priceListId, warehouse_id: warehouseId, limit: 500, sort: 'name',
  }), [dq, cat, inStock]);
  const found = (res.data && res.data.rows) || [];
  const total = (res.data && res.data.total) || 0;
  const rows = onlySel ? [...sel.values()].map((x) => x.product) : found;
  useEffect(() => { setHi(0); }, [dq, cat, inStock, onlySel]);
  useEffect(() => { if (!sel.size && onlySel) setOnlySel(false); }, [sel.size]);
  useEffect(() => {
    const el = wrapRef.current && wrapRef.current.querySelector(`tr[data-i="${hi}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const toggle = (p) => setSel((m) => { const n = new Map(m); if (n.has(p.id)) n.delete(p.id); else n.set(p.id, { product: p, qty: 1 }); return n; });
  const setQty = (id, v) => setSel((m) => { const n = new Map(m); const x = n.get(id); if (x) n.set(id, { ...x, qty: v }); return n; });
  const allOn = rows.length > 0 && rows.every((p) => sel.has(p.id));
  const toggleAll = () => setSel((m) => {
    const n = new Map(m);
    if (allOn) rows.forEach((p) => n.delete(p.id)); else rows.forEach((p) => { if (!n.has(p.id)) n.set(p.id, { product: p, qty: 1 }); });
    return n;
  });
  const picked = [...sel.values()].filter((x) => Number(x.qty) > 0);
  const sum = showPrices && priceOf ? picked.reduce((s, x) => s + (Number(priceOf(x.product)) || 0) * Number(x.qty), 0) : 0;
  const done = () => { if (picked.length) close(picked); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { done(); return; }
      if (rows[hi]) { toggle(rows[hi]); try { e.target.select(); } catch (x) { /* */ } }
    }
  };
  const stockCell = (p) => (p.track_stock
    ? html`<span class=${`num ${p.stock <= 0 ? 'neg' : p.stock_state === 'low' ? 'warn-text' : ''}`}>${num(p.stock, 2)}</span> <span class="tiny muted">${dn(p.unit) || ''}</span>`
    : html`<span class="muted">—</span>`);

  return html`<${Modal} title=${t('picker.title')} icon="list-checks" close=${close} size="xwide"
    left=${html`<span class="small">${picked.length ? html`${t('picker.selected_n', { n: picked.length })}${showPrices && priceOf ? html` · <b class="num">${money(sum, currency)}</b>` : null}` : html`<span class="muted">${t('picker.hint')}</span>`}</span>
      ${sel.size > 0 && html`<button type="button" class="link-btn small" onClick=${() => setSel(new Map())}>${t('common.clear')}</button>`}`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}>
      <${Btn} kind="primary" icon="plus" disabled=${!picked.length} onClick=${done}>${t('picker.add_n', { n: picked.length })}</${Btn}>`}>
    <div class="col gap-12">
      <div class="row gap-12 wrap">
        <div class="input-wrap grow" style="min-width:240px"><${Icon} name="search" />
          <input ref=${searchRef} class="input" value=${q} autoFocus placeholder=${t('product.search_scan')} autocomplete="off"
            onInput=${(e) => { setQ(e.target.value); setOnlySel(false); }} onKeyDown=${onKey} aria-label=${t('product.search_scan')} /></div>
        <${Check} checked=${inStock} onValue=${setInStock} label=${t('picker.in_stock')} />
      </div>
      <div class="picker-cats">
        <button type="button" class=${`chip ${!cat && !onlySel ? 'on' : ''}`} onClick=${() => { setCat(''); setOnlySel(false); }}>${t('common.all')}</button>
        ${sel.size > 0 && html`<button type="button" class=${`chip ${onlySel ? 'on' : ''}`} onClick=${() => setOnlySel(!onlySel)}><${Icon} name="check" size="sm" />${t('picker.selected_tab', { n: sel.size })}</button>`}
        ${cats.map((c) => html`<button type="button" class=${`chip ${cat === c.id && !onlySel ? 'on' : ''}`} onClick=${() => { setCat(cat === c.id ? '' : c.id); setOnlySel(false); }}>${c.name}</button>`)}
      </div>
      <div class="table-wrap picker-list" ref=${wrapRef}>
        ${!onlySel && res.loading && !res.data ? html`<${Loading} />` : !rows.length ? html`<${Empty} icon="package-search" title=${t('common.no_results')} />` : html`<table class="tbl compact">
          <thead><tr>
            <th class="c" style="width:38px"><input type="checkbox" checked=${allOn} onChange=${toggleAll} title=${t('picker.select_all')} aria-label=${t('picker.select_all')} /></th>
            <th>${t('nav.products')}</th>
            <th class="r">${t('product.stock')}</th>
            ${showPrices && priceOf && html`<th class="r">${priceLabel || t('print.col.price')}</th>`}
            <th class="r" style="width:120px">${t('print.col.qty')}</th>
          </tr></thead>
          <tbody>${rows.map((p, i) => {
            const it = sel.get(p.id);
            return html`<tr key=${p.id} data-i=${i} class=${`clickable ${it ? 'selected' : ''} ${i === hi ? 'kb' : ''}`} onClick=${() => { setHi(i); toggle(p); }}>
              <td class="c"><input type="checkbox" checked=${!!it} onClick=${(e) => e.stopPropagation()} onChange=${() => toggle(p)} aria-label=${p.name} /></td>
              <td><div class="cell-name" dir="auto">${p.name}</div><div class="sub">${[p.code, p.brand_name, p.category_name].filter(Boolean).join(' · ')}</div></td>
              <td class="r nowrap">${stockCell(p)}</td>
              ${showPrices && priceOf && html`<td class="r num nowrap">${money(priceOf(p), currency)}</td>`}
              <td class="r" onClick=${(e) => e.stopPropagation()}>${it ? html`<${NumInput} size="sm" value=${it.qty} onValue=${(v) => setQty(p.id, v)} dec=${3} min=${0} />` : null}</td>
            </tr>`;
          })}</tbody>
        </table>`}
      </div>
      ${!onlySel && total > found.length && html`<p class="small muted" style="margin:0">${t('picker.more', { n: total - found.length })}</p>`}
      <p class="tiny muted" style="margin:0">${t('picker.keys')}</p>
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ vehicle */
/** value: { id?, plate, description } ; onChange(vehicle | {plate}) */
export function VehiclePicker({ value, onChange, partnerId, placeholder, size = '' }) {
  const search = async (q) => {
    if (!q && partnerId) return api.get('/api/vehicles', { partner_id: partnerId, limit: 10 });
    if (!q) return [];
    return api.get('/api/vehicles', { q, limit: 12 });
  };
  return html`<${Combo} value=${value ? value.plate || value.description || '' : ''} placeholder=${placeholder || t('vehicle.plate_search')} size=${size}
    search=${search} minChars=${partnerId ? 0 : 1}
    renderItem=${(v) => html`<${Icon} name="car" size="sm" /><div class="grow"><div class="strong ltr">${v.plate || '—'}</div><div class="sub ellipsis" dir="auto">${[v.description, v.partner_name].filter(Boolean).join(' · ')}</div></div>`}
    onSelect=${(v) => onChange(v)}
    onCreate=${(text) => onChange({ id: null, plate: text.toUpperCase().trim() })} createLabel=${t('vehicle.use_plate')} />`;
}

export async function newVehicle(initial) {
  return openModal(VehicleDialog, { initial });
}

/* ------------------------------------------------------------------ selects */
export function accountOptions({ currency, types, includeInactive } = {}) {
  return (boot().money_accounts || [])
    .filter((a) => (includeInactive || a.active) && (!currency || a.currency === currency) && (!types || types.includes(a.type)))
    .map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }));
}

export function AccountSelect({ value, onValue, currency, types, placeholder, size = '', disabled }) {
  return html`<${Select} value=${value} onValue=${onValue} size=${size} disabled=${disabled} placeholder=${placeholder} options=${accountOptions({ currency, types })} />`;
}

export function defaultAccount(currency, type = 'cash') {
  const list = (boot().money_accounts || []).filter((a) => a.active && a.type === type && a.currency === currency);
  return list.find((a) => a.is_default) || list[0] || null;
}

export function account(id) { return (boot().money_accounts || []).find((a) => a.id === id) || null; }

export function WarehouseSelect({ value, onValue, size = '', placeholder, disabled }) {
  const list = (boot().warehouses || []).filter((w) => w.active || w.id === value);
  return html`<${Select} value=${value} onValue=${onValue} size=${size} disabled=${disabled} placeholder=${placeholder} options=${list.map((w) => ({ value: w.id, label: w.name }))} />`;
}

export function activeWarehouses() { return (boot().warehouses || []).filter((w) => w.active); }

export function defaultWarehouseId() {
  const u = (boot().user || {}).default_warehouse_id;
  const pos = ((boot().settings || {}).pos || {}).default_warehouse_id;
  const ws = activeWarehouses();
  return (u && ws.some((w) => w.id === u) && u) || (pos && ws.some((w) => w.id === pos) && pos) || (ws.find((w) => w.is_default) || ws[0] || {}).id || null;
}

export function CurrencySelect({ value, onValue, size = '', disabled }) {
  const list = (boot().currencies || []).filter((c) => c.active || c.code === value);
  return html`<${Select} value=${value} onValue=${onValue} size=${size} disabled=${disabled} options=${list.map((c) => ({ value: c.code, label: c.code }))} />`;
}

export function activeCurrencies() { return (boot().currencies || []).filter((c) => c.active).map((c) => c.code); }

export function StaffSelect({ value, onValue, size = '', placeholder, roles, disabled }) {
  const list = (boot().staff || []).filter((s) => (s.active || s.id === value) && (!roles || roles.includes(s.role_code)));
  return html`<${Select} value=${value} onValue=${onValue} size=${size} disabled=${disabled} placeholder=${placeholder ?? '—'} options=${list.map((s) => ({ value: s.id, label: s.full_name }))} />`;
}

export function PriceListSelect({ value, onValue, size = '', placeholder, disabled }) {
  const list = (boot().price_lists || []).filter((p) => p.active || p.id === value);
  return html`<${Select} value=${value} onValue=${onValue} size=${size} disabled=${disabled} placeholder=${placeholder} options=${list.map((p) => ({ value: p.id, label: p.name }))} />`;
}

export function defaultPriceListId() {
  const pos = ((boot().settings || {}).pos || {}).default_price_list_id;
  const pls = (boot().price_lists || []).filter((p) => p.active);
  return (pos && pls.some((p) => p.id === pos) && pos) || (pls.find((p) => p.is_default) || pls[0] || {}).id || null;
}

export function CategorySelect({ value, onValue, size = '', placeholder }) {
  const list = boot().categories || [];
  return html`<${Select} value=${value} onValue=${onValue} size=${size} placeholder=${placeholder ?? t('common.all')} options=${list.map((c) => ({ value: c.id, label: c.name }))} />`;
}

export function BrandSelect({ value, onValue, size = '', placeholder }) {
  const list = boot().brands || [];
  return html`<${Select} value=${value} onValue=${onValue} size=${size} placeholder=${placeholder ?? t('common.all')} options=${list.map((c) => ({ value: c.id, label: c.name }))} />`;
}

/** load full partner (with balances) by id */
export async function loadPartner(id) {
  if (!id) return null;
  try { return await api.get(`/api/partners/${id}`); } catch (e) { errToast(e); return null; }
}

export function KindPill({ kind }) {
  return html`<${Pill} kind=${kind === 'supplier' ? 'brass' : kind === 'both' ? 'dark' : 'info'}>${t(`partner.kind.${kind}`)}</${Pill}>`;
}
