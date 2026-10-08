// Shared pickers used by many screens: partner, product, vehicle search; account / warehouse / staff selects.
import { html, useState, useEffect, useRef } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { boot, can } from '../core/store.js';
import { money, num, convert } from '../core/format.js';
import { Icon, IconBtn, Combo, Select, Balances, Pill, openModal, errToast } from '../core/ui.js';
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
 */
export function ProductSearch({ onPick, priceListId, warehouseId, currency, usdIqd, placeholder, autoFocus, inputRef, size = '', type, extraParams }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
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
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const pick = (p) => { setQ(''); setItems([]); setOpen(false); onPick(p); setTimeout(() => ref.current && ref.current.focus(), 0); };
  const byCode = async (code) => {
    try {
      const r = await api.get(`/api/products/by-code/${encodeURIComponent(code)}`, { price_list_id: priceListId, warehouse_id: warehouseId });
      return r.product;
    } catch (e) { return null; }
  };
  const onKey = async (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return; }
    if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
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
  return html`<div class="combo grow" ref=${box}>
    <div class="input-wrap"><${Icon} name="scan-barcode" />
      <input ref=${ref} class=${`input ${size}`} value=${q} placeholder=${placeholder || t('product.search_scan')} autoFocus=${autoFocus} autocomplete="off"
        onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown=${onKey} /></div>
    ${open && q.trim() && html`<div class="combo-list" role="listbox" style="min-width:420px">
      ${busy && !items.length ? html`<div class="combo-empty">${t('common.loading')}</div>` : !items.length ? html`<div class="combo-empty">${t('common.no_results')}</div>` : null}
      ${items.map((p, i) => html`<div class=${`combo-item ${i === hi ? 'on' : ''}`} onMouseDown=${(e) => { e.preventDefault(); pick(p); }} onMouseEnter=${() => setHi(i)}>
        ${p.photo_id ? html`<img class="thumb" style="width:30px;height:30px;border-radius:5px;object-fit:cover" src=${`/api/files/${p.photo_id}`} alt="" />` : html`<${Icon} name=${p.type === 'service' ? 'wrench' : 'package'} size="sm" />`}
        <div class="grow" style="min-width:0"><div class="ellipsis" dir="auto">${p.name}</div>
          <div class="sub ellipsis">${[p.code, p.brand_name, p.shelf ? `${t('product.shelf')}: ${p.shelf}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${p.track_stock ? html`<span class=${`tiny num ${p.stock <= 0 ? 'neg' : p.stock_state === 'low' ? 'warn-text' : 'muted'}`}>${num(p.stock, 2)} ${dn(p.unit) || ''}</span>` : null}
        <span class="num strong" style="min-width:90px;text-align:end">${p.price != null ? money(priceIn(p), currency || p.currency) : '—'}</span>
      </div>`)}
    </div>`}
  </div>`;
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
