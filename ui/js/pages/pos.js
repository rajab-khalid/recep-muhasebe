// Point of sale: barcode / name / vehicle search, cart, mixed-currency payment ($ + IQD + card), change,
// receipt printing, parked sales. Built for the counter: everything works from the keyboard.
import { html, useState, useEffect, useRef, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api, ApiError } from '../core/api.js';
import { can, boot, useStore, prefs, setPrefs } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { money, num, qty as fqty, convert, round, decimals, usdIqd, today, dateTime, date as fdate, pct as fpct, rateText } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Drawer, Field, Input, NumInput, Select, Segmented, Pill, Money, Balances, Empty, Loading, Notice,
  openModal, toast, errToast, confirmDialog, useHotkeys, useDebounced,
} from '../core/ui.js';
import { printDoc, shareDoc } from '../core/docprint.js';
import { PartnerPicker, VehiclePicker, StaffSelect, PriceListSelect, defaultAccount, account, defaultWarehouseId, defaultPriceListId, loadPartner } from './pickers.js';
import { DiscountInput, FindInvoiceDialog } from './docs.js';
import { dn } from '../core/names.js';

const PARK_KEY = 'rm_pos_parked';
function parkedList() { try { return JSON.parse(localStorage.getItem(PARK_KEY) || '[]'); } catch (e) { return []; } }
function saveParked(list) { try { localStorage.setItem(PARK_KEY, JSON.stringify(list)); } catch (e) { /* storage full or blocked */ } }

let seq = 0;
const key = () => `c${++seq}${Date.now() % 100000}`;
const tolOf = (cur) => (cur === 'IQD' ? 1 : 0.01);

function walkin() {
  const id = boot().walkin_id;
  return id ? { id, name: t('partner.walkin'), is_walkin: 1 } : null;
}

export function Pos({ query = {} }) {
  useTitle(t('nav.pos'));
  const settings = boot().settings || {};
  const posCfg = settings.pos || {};
  const me = useStore((s) => s.user);
  const bootData = useStore((s) => s.boot);
  const rateNow = usdIqd();

  const [currency, setCurrency] = useState(prefs('pos_currency', (settings.general || {}).default_currency || 'IQD'));
  const [rate, setRate] = useState(rateNow);
  const [priceListId, setPriceListId] = useState(defaultPriceListId());
  const [warehouseId] = useState(defaultWarehouseId());
  const [customer, setCustomer] = useState(walkin());
  const [vehicle, setVehicle] = useState(null);
  const [km, setKm] = useState(null);
  // category chips: fade the far edge while more chips are hidden there
  const catsRef = useRef(null);
  const [catsMore, setCatsMore] = useState(false);
  const checkCats = () => {
    const el = catsRef.current;
    if (!el) return;
    const left = Math.abs(el.scrollLeft);
    setCatsMore(el.scrollWidth - el.clientWidth - left > 4);
  };
  useEffect(() => { checkCats(); const tm = setTimeout(checkCats, 300); window.addEventListener('resize', checkCats); return () => { clearTimeout(tm); window.removeEventListener('resize', checkCats); }; }, []);
  const [lines, setLines] = useState([]);
  const [docDisc, setDocDisc] = useState({ amount: 0, pct: null });
  const [activeKey, setActiveKey] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [results, setResults] = useState(null);
  const [hi, setHi] = useState(0);
  const [notes, setNotes] = useState('');
  const [parked, setParked] = useState(parkedList());
  const searchRef = useRef(null);
  const dq = useDebounced(q, 160);

  useEffect(() => { setRate(usdIqd()); }, [bootData && bootData.currencies]);
  useEffect(() => { setPrefs('pos_currency', currency); }, [currency]);
  const focusSearch = () => setTimeout(() => searchRef.current && searchRef.current.focus(), 0);
  useEffect(focusSearch, []);

  // resume a parked sale
  useEffect(() => {
    if (!query.resume) return;
    const list = parkedList();
    const p = list.find((x) => x.id === query.resume);
    if (!p) return;
    restore(p);
    saveParked(list.filter((x) => x.id !== p.id));
    setParked(parkedList());
  }, [query.resume]);

  /* ---------------- product results */
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const params = { price_list_id: priceListId, warehouse_id: warehouseId, category_id: cat || undefined, limit: 48 };
        const r = dq.trim() ? await api.get('/api/products', { ...params, q: dq.trim() }) : await api.get('/api/products/popular', params);
        if (alive) { setResults(r.rows); setHi(0); }
      } catch (e) { if (alive) setResults([]); }
    };
    run();
    return () => { alive = false; };
  }, [dq, cat, priceListId]);

  /* ---------------- cart helpers */
  const priceIn = (p, cur = currency, r = rate) => {
    const base = p.prices && priceListId && p.prices[priceListId] != null ? p.prices[priceListId] : (p.price || 0);
    return round(convert(base, p.currency, cur, r), Math.max(decimals(cur), cur === 'IQD' ? 0 : 2));
  };
  const addProduct = (p, qty = 1) => {
    if (!p) return;
    setLines((ls) => {
      const ex = ls.find((l) => l.product_id === p.id && l.kind !== 'labor');
      if (ex) { setActiveKey(ex.key); return ls.map((l) => (l === ex ? { ...l, qty: round((Number(l.qty) || 0) + qty, 3) } : l)); }
      const unitPrice = priceIn(p);
      const nl = {
        key: key(), kind: p.type === 'service' ? 'service' : 'product', product_id: p.id, code: p.code, name: p.name, unit: p.unit, qty,
        unit_price: unitPrice, list_price: unitPrice, discount: 0, discount_pct: null, staff_id: '', stock: p.stock, track_stock: p.track_stock,
        cost_usd: p.cost_usd ?? (p.avg_cost_usd || null), p_currency: p.currency, p_price: p.prices && priceListId ? p.prices[priceListId] ?? p.price : p.price,
      };
      setActiveKey(nl.key);
      return [...ls, nl];
    });
    setQ('');
    focusSearch();
  };
  const scan = async (text) => {
    const code = text.trim();
    if (!code) return;
    // quantity prefix: "3*code"
    let qty = 1;
    let c = code;
    const m = /^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.+)$/.exec(code);
    if (m) { qty = Number(m[1].replace(',', '.')); c = m[2].trim(); }
    if (/^\S+$/.test(c)) {
      try {
        const r = await api.get(`/api/products/by-code/${encodeURIComponent(c)}`, { price_list_id: priceListId, warehouse_id: warehouseId });
        if (r.product) { addProduct(r.product, qty); return; }
      } catch (e) { /* fall through to the result list */ }
    }
    if (results && results[hi] && dq.trim() === q.trim()) { addProduct(results[hi], qty); return; }
    // wait for results of the current text
    try {
      const r = await api.get('/api/products', { q: c, limit: 2, price_list_id: priceListId, warehouse_id: warehouseId });
      if (r.rows.length === 1) addProduct(r.rows[0], qty);
      else if (!r.rows.length) toast(t('pos.not_found', { code: c }), 'err');
    } catch (e) { errToast(e); }
  };
  const setLine = (k, patch) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const removeLine = (k) => setLines((ls) => ls.filter((l) => l.key !== k));
  const clearCart = () => { setLines([]); setDocDisc({ amount: 0, pct: null }); setCustomer(walkin()); setVehicle(null); setKm(null); setNotes(''); setPriceListId(defaultPriceListId()); focusSearch(); };

  const changeCurrency = (cur) => {
    if (cur === currency) return;
    setLines((ls) => ls.map((l) => {
      const cv = (v) => round(convert(v || 0, currency, cur, rate), cur === 'IQD' ? 0 : 2);
      return { ...l, unit_price: cv(l.unit_price), list_price: cv(l.list_price), discount: l.discount_pct ? 0 : cv(l.discount) };
    }));
    setDocDisc((dd) => (dd.pct ? dd : { amount: round(convert(dd.amount || 0, currency, cur, rate), cur === 'IQD' ? 0 : 2), pct: null }));
    setCurrency(cur);
  };
  const repriceTo = async (plId) => {
    setPriceListId(plId);
    const ids = lines.filter((l) => l.product_id).map((l) => l.product_id);
    if (!ids.length) return;
    try {
      const rows = await api.post('/api/products/for-sale', { ids, price_list_id: plId, warehouse_id: warehouseId });
      const map = Object.fromEntries(rows.map((r) => [r.id, r]));
      setLines((ls) => ls.map((l) => {
        const p = map[l.product_id];
        if (!p) return l;
        const base = p.prices[plId] ?? p.price ?? 0;
        const up = round(convert(base, p.currency, currency, rate), currency === 'IQD' ? 0 : 2);
        return { ...l, unit_price: up, list_price: up };
      }));
    } catch (e) { errToast(e); }
  };
  const chooseCustomer = async (p) => {
    let full = p;
    if (p && p.id && !p.balances && !p.is_walkin) full = (await loadPartner(p.id)) || p;
    setCustomer(full || walkin());
    const pl = full && full.price_list_id;
    if (pl && pl !== priceListId) { repriceTo(pl); toast(t('pos.price_list_switched', { name: full.price_list_name || '' })); }
    else if (!pl && full && full.is_walkin && priceListId !== defaultPriceListId()) repriceTo(defaultPriceListId());
    focusSearch();
  };

  /* ---------------- totals */
  const dec = currency === 'IQD' ? 0 : 2;
  const calc = useMemo(() => {
    let sub = 0; let lineDisc = 0; let sum = 0; let listTotal = 0;
    for (const l of lines) {
      const gross = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
      let dsc = l.discount_pct ? gross * l.discount_pct / 100 : Number(l.discount) || 0;
      dsc = Math.min(Math.max(dsc, 0), Math.abs(gross));
      const tot = round(gross - dsc, dec);
      sub += gross; lineDisc += dsc; sum += tot;
      listTotal += (Number(l.qty) || 0) * Math.max(Number(l.list_price) || 0, Number(l.unit_price) || 0);
    }
    let disc = docDisc.pct ? sum * docDisc.pct / 100 : Number(docDisc.amount) || 0;
    disc = round(Math.min(Math.max(disc, 0), Math.max(sum, 0)), dec);
    let total = round(sum - disc, dec);
    let rounding = 0;
    const step = Number(posCfg.iqd_cash_rounding) || 0;
    if (currency === 'IQD' && step > 0 && total > 0) {
      const r = Math.round(total / step) * step;
      if (Math.abs(r - total) < Math.max(1, total * 0.05)) { rounding = r - total; total = r; }
    }
    const discPct = listTotal > 0 ? (listTotal - total) / listTotal * 100 : 0;
    return { sub, lineDisc, sum, disc, total, rounding, discPct, count: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0) };
  }, [lines, docDisc, currency]);
  const maxDisc = me && me.max_discount_pct != null ? me.max_discount_pct : Number(posCfg.default_max_discount_pct) || 0;
  const discOver = !can('sales.discount') && calc.discPct > maxDisc + 0.01;
  const shortLines = lines.filter((l) => l.kind === 'product' && l.track_stock && l.stock != null && Number(l.qty) > l.stock + 1e-9);
  const blockStock = posCfg.allow_negative_stock === false && shortLines.length > 0;
  const lineRate = currency === 'USD' ? 1 : rate;
  const below = (l) => {
    if (!can('products.cost') || !l.cost_usd || l.kind !== 'product') return false;
    const gross = l.qty * l.unit_price;
    const dsc = l.discount_pct ? gross * l.discount_pct / 100 : l.discount || 0;
    const share = calc.sum ? calc.total / calc.sum : 1;
    return l.qty > 0 && ((gross - dsc) * share) / l.qty < l.cost_usd * lineRate - 1e-6;
  };

  /* ---------------- park / restore */
  const snapshot = () => ({ id: key(), at: new Date().toISOString(), currency, priceListId, customer, vehicle, km, lines, docDisc, notes, total: calc.total });
  function restore(p) {
    setCurrency(p.currency); setPriceListId(p.priceListId || defaultPriceListId()); setCustomer(p.customer || walkin()); setVehicle(p.vehicle || null);
    setKm(p.km || null); setLines(p.lines || []); setDocDisc(p.docDisc || { amount: 0, pct: null }); setNotes(p.notes || '');
  }
  const park = () => {
    if (!lines.length) return;
    const list = [snapshot(), ...parkedList()].slice(0, 30);
    saveParked(list);
    setParked(list);
    clearCart();
    toast(t('pos.parked'));
  };
  const resume = (p) => {
    const list = parkedList().filter((x) => x.id !== p.id);
    if (lines.length) list.unshift(snapshot());
    saveParked(list);
    setParked(list);
    restore(p);
  };

  /* ---------------- pay */
  const pay = async () => {
    if (!lines.length) { focusSearch(); return; }
    if (discOver) { toast(t('pos.discount_over', { pct: fpct(calc.discPct), max: fpct(maxDisc) }), 'err'); return; }
    if (blockStock) { toast(t('pos.stock_short', { names: shortLines.map((l) => l.name).join(', ') }), 'err'); return; }
    const res = await openModal(PayDialog, { total: calc.total, currency, rate, customer, buildBody });
    if (res && res.doc) {
      const doc = res.doc;
      clearCart();
      if (posCfg.auto_print_receipt) printDoc(doc, 'auto', { silent: true });
      openModal(DoneDialog, { doc, change: res.change, changeCurrency: res.changeCurrency }).then(() => focusSearch());
    } else focusSearch();
  };
  function buildBody({ payments, change, confirmCredit }) {
    return {
      type: 'sale', channel: 'pos', post: true, date: today(), partner_id: customer ? customer.id : null, currency, usd_iqd: rate, price_list_id: priceListId, warehouse_id: warehouseId,
      vehicle_id: vehicle && vehicle.id ? vehicle.id : null, vehicle_plate: vehicle ? vehicle.plate || null : null, vehicle_desc: vehicle ? vehicle.description || null : null, km: vehicle ? km : null,
      staff_id: me && me.id, notes: notes || null,
      discount: docDisc.pct ? 0 : docDisc.amount || 0, discount_pct: docDisc.pct || null, rounding: calc.rounding || 0,
      lines: lines.map((l) => ({ kind: l.kind, product_id: l.product_id || null, code: l.code, description: l.name, qty: l.qty, unit: l.unit, unit_price: l.unit_price, discount: l.discount_pct ? 0 : l.discount, discount_pct: l.discount_pct || null, staff_id: l.staff_id || null })),
      payments, change, confirm_credit_limit: confirmCredit || undefined,
    };
  }

  const addLabor = async () => {
    const r = await openModal(LaborDialog, { currency });
    if (r) { const nl = { key: key(), kind: 'labor', product_id: null, code: '', name: r.description, unit: '', qty: 1, unit_price: r.price, list_price: r.price, discount: 0, discount_pct: null, staff_id: r.staff_id || '' }; setLines((ls) => [...ls, nl]); setActiveKey(nl.key); }
    focusSearch();
  };

  /* ---------------- keyboard */
  const free = () => !document.querySelector('.overlay, .drawer');
  useHotkeys({
    f2: () => { if (!free()) return false; focusSearch(); return undefined; },
    f4: () => {
      if (!free()) return false;
      const inp = document.querySelector('.pos .cart-head .combo input');
      if (inp) inp.focus(); else { const b = document.querySelector('.pos .cart-head .partner-chip .icon-btn'); if (b) b.click(); }
      return undefined;
    },
    f8: () => { if (!free()) return false; park(); return undefined; },
    f10: () => { if (!free()) return false; pay(); return undefined; },
    'ctrl+enter': () => { if (!free()) return false; pay(); return undefined; },
    delete: (e) => { if (!free() || (e.target.tagName === 'INPUT' && e.target.value)) return false; if (activeKey) removeLine(activeKey); return undefined; },
    '+': (e) => { if (!free() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return false; const l = lines.find((x) => x.key === activeKey); if (l) setLine(l.key, { qty: (Number(l.qty) || 0) + 1 }); return undefined; },
    '-': (e) => { if (!free() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return false; const l = lines.find((x) => x.key === activeKey); if (l && l.qty > 1) setLine(l.key, { qty: l.qty - 1 }); return undefined; },
  }, [lines, activeKey, calc, customer, vehicle, km, notes, docDisc, currency, priceListId, rate]);

  const onSearchKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (q.trim()) scan(q); else if (lines.length) pay(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, (results || []).length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setQ(''); }
  };

  const cats = (boot().categories || []);
  const other = currency === 'USD' ? 'IQD' : 'USD';
  return html`<div class="pos-screen">
    <div class="pos-left">
      <div class="pos-bar">
        <div class="pos-scan"><${Icon} name="scan-barcode" />
          <input ref=${searchRef} class="input" value=${q} placeholder=${t('pos.scan_ph')} autocomplete="off" onInput=${(e) => setQ(e.target.value)} onKeyDown=${onSearchKey} aria-label=${t('pos.scan_ph')} />
        </div>
        <${Btn} icon="wrench" onClick=${addLabor} title=${t('pos.add_labor')}>${t('pos.labor')}</${Btn}>
        <${Btn} icon="circle-pause" onClick=${park} disabled=${!lines.length} kbd="F8">${t('pos.park')}</${Btn}>
        <${Btn} icon="history" onClick=${() => openModal(RecentDrawer, {})}>${t('pos.recent')}</${Btn}>
        ${can('returns.create') && html`<${Btn} icon="undo-2" onClick=${() => openModal(FindInvoiceDialog, { type: 'sale' }).then((d) => d && navigate('/docs/sale_return/new', { from: d.id }))}>${t('pos.return')}</${Btn}>`}
      </div>
      ${cats.length > 0 && html`<div class=${`pos-cats ${catsMore ? 'more' : ''}`} ref=${catsRef} onScroll=${checkCats}>
        <button type="button" class=${`chip ${!cat ? 'on' : ''}`} onClick=${() => setCat('')}>${dq.trim() ? t('pos.all_results') : t('pos.popular')}</button>
        ${cats.map((c) => html`<button type="button" class=${`chip ${cat === c.id ? 'on' : ''}`} onClick=${() => setCat(cat === c.id ? '' : c.id)}>${c.name}</button>`)}
      </div>`}
      ${parked.length > 0 && html`<div class="pos-parked">
        <span class="tiny muted">${t('pos.parked_sales')}:</span>
        ${parked.map((p) => html`<button type="button" class="chip" onClick=${() => resume(p)} title=${dateTime(p.at)}>
          <${Icon} name="circle-play" size="sm" />${p.customer && !p.customer.is_walkin ? p.customer.name : t('pos.parked_n', { n: (p.lines || []).length })} · <b class="num">${money(p.total, p.currency)}</b></button>`)}
        <button type="button" class="link-btn tiny" onClick=${() => { saveParked([]); setParked([]); }}>${t('common.clear')}</button>
      </div>`}
      <div class="pos-results">
        ${results === null ? html`<${Loading} />` : !results.length ? html`<div style="grid-column:1/-1"><${Empty} icon="package-search" title=${t('common.no_results')} text=${dq ? t('pos.not_found_hint') : ''} /></div>`
          : results.map((p, i) => {
            const st = p.track_stock ? (p.stock <= 0 ? 'out' : p.stock_state === 'low' ? 'low' : '') : '';
            return html`<button type="button" class=${`pcard ${i === hi && dq ? 'kb' : ''}`} onClick=${() => addProduct(p)} key=${p.id}>
              <div class="nm" dir="auto">${p.name}</div>
              <div class="meta"><span class="ellipsis">${p.code || p.brand_name || ''}</span>${p.track_stock ? html`<span class=${`st ${st} num`}>${num(p.stock, 2)} ${dn(p.unit) || ''}</span>` : null}</div>
              <div class="pr num">${p.price != null ? money(priceIn(p), currency) : '—'}</div>
            </button>`;
          })}
      </div>
    </div>

    <div class="pos-right">
      <div class="cart-head">
        <div class="row gap-8">
          <div class="grow"><${PartnerPicker} value=${customer} onChange=${chooseCustomer} kind="customer" placeholder=${t('pos.customer_ph')} /></div>
          ${customer && !customer.is_walkin && html`<${IconBtn} icon="x" title=${t('pos.to_walkin')} onClick=${() => chooseCustomer(walkin())} />`}
        </div>
        <div class="row gap-8">
          <div class="grow"><${VehiclePicker} value=${vehicle} size="sm" partnerId=${customer && !customer.is_walkin ? customer.id : null}
            onChange=${async (v) => { setVehicle(v.id ? { id: v.id, plate: v.plate, description: v.description } : { id: null, plate: v.plate, description: '' }); if (v.km) setKm(v.km); if (v.id && v.partner_id && (!customer || customer.is_walkin)) chooseCustomer(await loadPartner(v.partner_id)); }} /></div>
          ${vehicle && html`<div style="width:96px"><${NumInput} size="sm" value=${km} onValue=${setKm} dec=${0} placeholder=${t('vehicle.km')} /></div><${IconBtn} icon="x" title=${t('common.clear')} onClick=${() => { setVehicle(null); setKm(null); }} />`}
        </div>
        <div class="row gap-8">
          <${Segmented} value=${currency} onValue=${changeCurrency} options=${(boot().currencies || []).filter((c) => c.active).map((c) => ({ value: c.code, label: c.code }))} />
          <div class="grow"><${PriceListSelect} size="sm" value=${priceListId} onValue=${repriceTo} /></div>
          <span class="tiny muted nowrap" title=${t('rate.label')}>${rateText(rate)}</span>
        </div>
      </div>
      <div class="cart">
        ${!lines.length ? html`<${Empty} icon="shopping-cart" title=${t('pos.empty_cart')} text=${t('pos.empty_cart_hint')} />`
          : lines.map((l) => {
            const gross = l.qty * l.unit_price;
            const dsc = l.discount_pct ? gross * l.discount_pct / 100 : l.discount || 0;
            const short = l.kind === 'product' && l.track_stock && l.stock != null && Number(l.qty) > l.stock + 1e-9;
            return html`<div class=${`cart-line ${activeKey === l.key ? 'active' : ''}`} key=${l.key} onClick=${() => setActiveKey(l.key)}>
              <div style="min-width:0"><div class="nm" dir="auto">${l.kind === 'labor' && html`<${Icon} name="wrench" size="sm" /> `}${l.name}</div>
                <div class="tiny muted">${[l.code, short ? html`<span class="neg">${t('pos.stock_left', { n: fqty(l.stock) })}</span>` : null, below(l) ? html`<span class="neg">${t('doc.below_cost')}</span>` : null].filter(Boolean).map((x, i) => html`${i > 0 ? ' · ' : ''}${x}`)}</div></div>
              <div class="tot num">${money(gross - dsc, currency)}</div>
              <div class="ctl">
                <div class="qty">
                  <button type="button" onClick=${(e) => { e.stopPropagation(); if (l.qty > 1) setLine(l.key, { qty: round(l.qty - 1, 3) }); else removeLine(l.key); }} aria-label="-"><${Icon} name="minus" size="sm" /></button>
                  <input value=${fqty(l.qty)} inputmode="decimal" onFocus=${(e) => e.target.select()} onChange=${(e) => { const v = Number(String(e.target.value).replace(',', '.')); if (v > 0) setLine(l.key, { qty: v }); }} />
                  <button type="button" onClick=${(e) => { e.stopPropagation(); setLine(l.key, { qty: round(Number(l.qty) + 1, 3) }); }} aria-label="+"><${Icon} name="plus" size="sm" /></button>
                </div>
                <span class="tiny muted">×</span>
                <div style="width:104px"><${NumInput} size="sm" value=${l.unit_price} onValue=${(v) => setLine(l.key, { unit_price: v ?? 0 })} dec=${dec} /></div>
                <div style="width:78px"><${DiscountInput} amount=${l.discount} pct=${l.discount_pct} dec=${dec} onChange=${(a, p) => setLine(l.key, { discount: a, discount_pct: p })} /></div>
                ${l.kind === 'labor' && html`<div style="width:120px"><${StaffSelect} size="sm" value=${l.staff_id} onValue=${(v) => setLine(l.key, { staff_id: v })} placeholder=${t('doc.who_did')} /></div>`}
                <span class="grow"></span>
                <${IconBtn} icon="trash-2" danger title=${t('common.remove')} onClick=${(e) => { e.stopPropagation(); removeLine(l.key); }} />
              </div>
            </div>`;
          })}
      </div>
      <div class="cart-sum">
        ${calc.sub !== calc.total && html`<div class="sum-row"><span>${t('doc.subtotal')}</span><span class="num">${money(calc.sub, currency)}</span></div>`}
        ${calc.lineDisc > 0 && html`<div class="sum-row"><span>${t('doc.line_discounts')}</span><span class="num neg">−${money(calc.lineDisc, currency)}</span></div>`}
        <div class="sum-row" style="align-items:center"><span>${t('doc.discount')}</span><div style="width:120px"><${DiscountInput} amount=${docDisc.amount} pct=${docDisc.pct} dec=${dec} onChange=${(a, p) => setDocDisc({ amount: a, pct: p })} /></div></div>
        ${calc.rounding !== 0 && html`<div class="sum-row"><span>${t('pos.rounding')}</span><span class="num">${money(calc.rounding, currency, { sign: true })}</span></div>`}
        <div class="sum-total"><span class="lbl">${t('doc.grand_total')} <span class="tiny muted">(${t('pos.items_n', { n: fqty(calc.count) })})</span></span><span class="amt num">${money(calc.total, currency)}</span></div>
        <div class="sum-alt num">≈ ${money(convert(calc.total, currency, other, rate), other)}</div>
        ${discOver && html`<${Notice} kind="err">${t('pos.discount_over', { pct: fpct(calc.discPct), max: fpct(maxDisc) })}</${Notice}>`}
        ${blockStock && html`<${Notice} kind="err">${t('pos.stock_short', { names: shortLines.map((l) => l.name).join(', ') })}</${Notice}>`}
        ${customer && !customer.is_walkin && customer.balances && Object.keys(customer.balances).length > 0 && can('partners.balance') && html`<div class="row small gap-8"><span class="muted">${t('pos.customer_balance')}:</span><${Balances} value=${customer.balances} /></div>`}
      </div>
      <div class="pos-actions">
        <${Btn} kind="primary" size="xl" icon="banknote" onClick=${pay} disabled=${!lines.length || discOver || blockStock} kbd="F10">${t('pos.pay')}</${Btn}>
        <${Btn} size="xl" icon="notebook-pen" iconOnly title=${t('doc.notes')} onClick=${async () => { const v = await openModal(NoteDialog, { value: notes }); if (v !== undefined && v !== null) setNotes(v); }} />
        <${Btn} size="xl" icon="trash-2" iconOnly title=${t('pos.clear')} disabled=${!lines.length} onClick=${async () => { if (await confirmDialog({ title: t('pos.clear'), text: t('pos.clear_text'), danger: true, okText: t('pos.clear') })) clearCart(); }} />
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ payment */
function PayDialog({ total, currency, rate, customer, buildBody, close }) {
  const accounts = (boot().money_accounts || []).filter((a) => a.active);
  // tenders: default cash per currency first, then cards/banks
  const tenders = useMemo(() => {
    const cash = ['IQD', 'USD', ...new Set(accounts.map((a) => a.currency))].filter((c, i, arr) => arr.indexOf(c) === i).map((c) => defaultAccount(c, 'cash')).filter(Boolean);
    const others = accounts.filter((a) => a.type !== 'cash');
    return [...cash, ...others];
  }, []);
  const defTender = tenders.find((a) => a.currency === currency && a.type === 'cash') || tenders[0];
  const [amounts, setAmounts] = useState({});
  const [focusId, setFocusId] = useState(() => (defTender || {}).id);
  const [changeAcc, setChangeAcc] = useState(() => (defaultAccount(currency, 'cash') || defaultAccount('IQD', 'cash') || tenders[0] || {}).id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const tendered = tenders.reduce((s, a) => s + convert(amounts[a.id] || 0, a.currency, currency, rate), 0);
  const tol = tolOf(currency);
  const remaining = round(total - tendered, currency === 'IQD' ? 0 : 2);
  const changeDoc = tendered - total > tol ? tendered - total : 0;
  const chAcc = accounts.find((a) => a.id === changeAcc);
  const chCur = chAcc ? chAcc.currency : currency;
  const changeAmt = changeDoc ? round(convert(changeDoc, currency, chCur, rate), chCur === 'IQD' ? 0 : 2) : 0;
  const credit = remaining > tol && tendered > 0;
  const canCredit = customer && !customer.is_walkin && can('sales.credit');
  const nonCashOver = changeDoc > 0 && tenders.filter((a) => a.type !== 'cash' && amounts[a.id] > 0).reduce((s, a) => s + convert(amounts[a.id], a.currency, currency, rate), 0) > total + tol;

  const setAmt = (id, v) => { setAmounts({ ...amounts, [id]: v }); setErr(null); };
  const exact = (a) => {
    const others = tenders.filter((x) => x.id !== a.id).reduce((s, x) => s + convert(amounts[x.id] || 0, x.currency, currency, rate), 0);
    const need = Math.max(0, total - others);
    setAmt(a.id, round(convert(need, currency, a.currency, rate), a.currency === 'IQD' ? 0 : 2));
  };
  const addNote = (a, v) => setAmt(a.id, round((amounts[a.id] || 0) + v, 2));
  const submit = async (confirmCredit = false) => {
    if (busy) return;
    if (tendered === 0 && defTender) {
      // nothing typed: the customer pays the exact amount in the default cash box
      const exactAmt = round(convert(total, currency, defTender.currency, rate), defTender.currency === 'IQD' ? 0 : 2);
      const body = buildBody({ payments: [{ account_id: defTender.id, amount: exactAmt, method: defTender.type === 'pos' ? 'card' : 'cash' }], change: null, confirmCredit });
      setBusy(true);
      try { const doc = await api.post('/api/docs', body); close({ doc, change: 0, changeCurrency: currency }); } catch (e) { setBusy(false); if (e instanceof ApiError && e.code === 'credit_limit') { if (await confirmDialog({ title: t('doc.credit_limit_title'), text: `${e.message}\n\n${t('doc.credit_limit_text')}`, okText: t('doc.save_anyway'), danger: true })) submit(true); return; } setErr(e.message); }
      return;
    }
    if (credit && !canCredit) { setErr(customer && !customer.is_walkin ? t('err.forbidden_credit') : t('pos.need_customer_for_credit')); return; }
    if (nonCashOver) { setErr(t('pos.card_over')); return; }
    const payments = tenders.filter((a) => amounts[a.id] > 0).map((a) => ({ account_id: a.id, amount: amounts[a.id], method: a.type === 'pos' ? 'card' : a.type === 'bank' ? 'transfer' : 'cash' }));
    const body = buildBody({ payments, change: changeAmt > 0 ? { account_id: changeAcc, amount: changeAmt } : null, confirmCredit });
    setBusy(true);
    try {
      const doc = await api.post('/api/docs', body);
      close({ doc, change: changeAmt, changeCurrency: chCur });
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'credit_limit') {
        if (await confirmDialog({ title: t('doc.credit_limit_title'), text: `${e.message}\n\n${t('doc.credit_limit_text')}`, okText: t('doc.save_anyway'), danger: true })) submit(true);
        return;
      }
      setErr(e.message);
    }
  };
  const notes = { IQD: [5000, 10000, 25000, 50000], USD: [10, 20, 50, 100] };
  return html`<${Modal} title=${t('pos.payment')} icon="banknote" close=${close} size="wide" onSubmit=${() => submit()}
    left=${html`<span class="small muted">${rateText(rate)}</span>`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.back')}</${Btn}>
      <${Btn} type="submit" kind="primary" size="lg" icon="check" disabled=${busy || (credit && !canCredit)}>${credit ? t('pos.confirm_credit') : t('pos.confirm')}</${Btn}>`}>
    <div class="col gap-16">
      <div class="pay-due">
        <div><div class="k">${t('pos.to_pay')}</div><div class="v num">${money(total, currency)}</div><div class="k num">≈ ${money(convert(total, currency, currency === 'USD' ? 'IQD' : 'USD', rate), currency === 'USD' ? 'IQD' : 'USD')}</div></div>
        <div style="text-align:end">${changeDoc > 0
          ? html`<div class="k">${t('pos.change')}</div><div class="v brass num">${money(changeAmt, chCur)}</div>`
          : tendered === 0 ? html`<div class="k">${t('pos.enter_exact', { name: defTender ? defTender.name : '' })}</div><div class="v num">↵</div>`
            : html`<div class="k">${t('doc.remaining')}</div><div class=${`v num ${credit ? 'brass' : ''}`}>${money(Math.max(0, remaining), currency)}</div>`}
          <div class="k">${t('pos.tendered')}: <span class="num">${money(tendered, currency)}</span></div></div>
      </div>
      <div class="col gap-8">${tenders.map((a) => html`<div class=${`tender-row ${focusId === a.id ? 'on' : ''}`} key=${a.id}>
        <div class="tender-name"><${Icon} name=${a.type === 'pos' ? 'credit-card' : a.type === 'bank' ? 'landmark' : 'banknote'} /><div><div class="strong">${a.name}</div><div class="tiny muted">${a.currency}</div></div></div>
        <div style="width:190px"><${NumInput} value=${amounts[a.id] ?? null} onValue=${(v) => setAmt(a.id, v)} dec=${a.currency === 'IQD' ? 0 : 2} onFocus=${() => setFocusId(a.id)} autoFocus=${focusId === a.id} /></div>
        <${Btn} size="sm" onClick=${() => exact(a)}>${t('pos.exact')}</${Btn}>
        ${a.type === 'cash' && notes[a.currency] && html`<div class="row gap-4 wrap">${notes[a.currency].map((v) => html`<button type="button" class="chip" onClick=${() => addNote(a, v)}>+${num(v)}</button>`)}</div>`}
        ${amounts[a.id] > 0 && html`<${IconBtn} icon="x" title=${t('common.clear')} onClick=${() => setAmt(a.id, null)} />`}
      </div>`)}</div>
      ${changeDoc > 0 && html`<div class="row gap-8"><span class="small">${t('pos.change_from')}:</span>
        <div style="width:260px"><${Select} size="sm" value=${changeAcc} onValue=${setChangeAcc} options=${accounts.filter((a) => a.type === 'cash').map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }))} /></div></div>`}
      ${credit && html`<${Notice} kind=${canCredit ? 'warn' : 'err'}>${canCredit ? t('pos.credit_note', { amount: money(remaining, currency), name: customer.name }) : t('pos.need_customer_for_credit')}</${Notice}>`}
      ${err && html`<${Notice} kind="err">${err}</${Notice}>`}
    </div>
  </${Modal}>`;
}

function DoneDialog({ doc, change, changeCurrency, close }) {
  useHotkeys({ enter: () => { printDoc(doc, 'auto'); close(); } }, []);
  return html`<${Modal} title=${t('pos.done')} icon="circle-check" close=${close}
    foot=${html`<${Btn} icon="message-circle" onClick=${() => shareDoc(doc)}>WhatsApp</${Btn}>
      <${Btn} icon="file-text" onClick=${() => printDoc(doc, 'a4')}>${t('doc.print_a4')}</${Btn}>
      <${Btn} icon="receipt" onClick=${() => { printDoc(doc, 'receipt'); }}>${t('doc.print_receipt')}</${Btn}>
      <${Btn} kind="primary" icon="plus" onClick=${() => close()} autoFocus>${t('pos.new_sale')}</${Btn}>`}>
    <div style="text-align:center;padding:10px 0">
      <div class="small muted">${doc.no} · ${t('doc.grand_total')}</div>
      <div style="font-family:var(--font-cond);font-size:30px;font-weight:600" class="num">${money(doc.total, doc.currency)}</div>
      ${change > 0 && html`<div class="mt-16"><div class="small muted">${t('pos.change_give')}</div><div style="font-family:var(--font-cond);font-size:44px;font-weight:700;color:var(--brass-strong)" class="num">${money(change, changeCurrency)}</div></div>`}
      ${doc.remaining > tolOf(doc.currency) && html`<div class="mt-12"><${Pill} kind="warn">${t('pos.on_credit', { amount: money(doc.remaining, doc.currency) })}</${Pill}></div>`}
      <p class="tiny muted mt-12">${t('pos.done_hint')}</p>
    </div>
  </${Modal}>`;
}

function LaborDialog({ currency, close }) {
  const [description, setDescription] = useState(t('pos.labor_default'));
  const [price, setPrice] = useState(null);
  const [staffId, setStaffId] = useState('');
  return html`<${Modal} title=${t('pos.add_labor')} icon="wrench" close=${close} onSubmit=${() => price > 0 && description.trim() && close({ description: description.trim(), price, staff_id: staffId })}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!(price > 0) || !description.trim()}>${t('common.add')}</${Btn}>`}>
    <div class="col gap-12">
      <${Field} label=${t('common.description')}><${Input} value=${description} onValue=${setDescription} /></${Field}>
      <div class="form-2">
        <${Field} label=${`${t('print.col.price')} (${currency})`}><${NumInput} value=${price} onValue=${setPrice} dec=${currency === 'IQD' ? 0 : 2} autoFocus /></${Field}>
        <${Field} label=${t('doc.who_did')}><${StaffSelect} value=${staffId} onValue=${setStaffId} /></${Field}>
      </div>
    </div>
  </${Modal}>`;
}

function NoteDialog({ value, close }) {
  const [v, setV] = useState(value || '');
  return html`<${Modal} title=${t('doc.notes')} close=${close} onSubmit=${() => close(v)} foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary">${t('common.ok')}</${Btn}>`}>
    <textarea class="textarea" rows="4" value=${v} onInput=${(e) => setV(e.target.value)} autoFocus dir="auto"></textarea>
  </${Modal}>`;
}

function RecentDrawer({ close }) {
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState(null);
  const me = boot().user || {};
  useEffect(() => {
    api.get('/api/docs', { type: 'sale', from: today(), to: today(), include_cancelled: 1, limit: 60, created_by: all ? undefined : me.id }).then((r) => setRows(r.rows)).catch(errToast);
  }, [all]);
  const sum = (rows || []).filter((r) => r.status === 'posted').reduce((m, r) => { m[r.currency] = (m[r.currency] || 0) + r.total; return m; }, {});
  return html`<${Drawer} title=${t('pos.recent_today')} close=${close} narrow
    tools=${can('sales.view') && html`<${Segmented} value=${all ? 'all' : 'me'} onValue=${(v) => setAll(v === 'all')} options=${[{ value: 'me', label: t('pos.mine') }, { value: 'all', label: t('common.all') }]} />`}>
    ${rows === null ? html`<${Loading} />` : !rows.length ? html`<${Empty} icon="receipt" title=${t('pos.no_sales_today')} />` : html`
      <div class="row wrap gap-12 mb-12 small">${Object.entries(sum).map(([c, v]) => html`<b class="num">${money(v, c)}</b>`)}<span class="muted">${t('doc.count_n', { n: rows.length })}</span></div>
      <div class="mini-list" style="margin:0 -18px">${rows.map((r) => html`<div class=${`mini-row ${r.status === 'cancelled' ? 'muted' : ''}`}>
        <div class="grow"><div class="small strong">${r.no} ${r.status === 'cancelled' ? html`<${Pill}>${t('doc.status.cancelled')}</${Pill}>` : null}</div><div class="tiny muted" dir="auto">${(r.created_at || '').slice(11, 16)} · ${r.partner_name || ''}</div></div>
        <${Money} value=${r.total} cur=${r.currency} strong />
        <${IconBtn} icon="printer" title=${t('doc.print_receipt')} onClick=${() => printDoc(r.id, 'receipt')} />
        <${IconBtn} icon="external-link" title=${t('common.open')} onClick=${() => { close(); navigate(`/doc/${r.id}`); }} />
      </div>`)}</div>`}
  </${Drawer}>`;
}
