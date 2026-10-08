// Shared UI components (Preact + htm).
import { html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from './h.js';
import { ICONS } from './icon-data.js';
import { t, getLang } from './i18n.js';
import { money, num, parseNum, date, today, addDays, monthStart, addMonths, round } from './format.js';

/* ------------------------------------------------------------------ icons & basics */
// icons that point somewhere: mirrored in right-to-left languages
const DIR_ICONS = new Set(['chevron-left', 'chevron-right', 'undo-2', 'log-out', 'arrow-up-right', 'arrow-down-left', 'send', 'external-link']);
export function Icon({ name, size, cls = '', title }) {
  const inner = ICONS[name] || ICONS['circle-help'];
  return html`<svg class=${`icon ${size || ''} ${DIR_ICONS.has(name) ? 'dir' : ''} ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden=${title ? undefined : 'true'} dangerouslySetInnerHTML=${{ __html: (title ? `<title>${title}</title>` : '') + inner }}></svg>`;
}

export function Btn({ kind = '', size = '', icon, children, onClick, disabled, title, type = 'button', kbd, cls = '', iconOnly, autoFocus, ...rest }) {
  const classes = ['btn', kind, size, iconOnly ? 'icon-only' : '', cls].filter(Boolean).join(' ');
  return html`<button type=${type} class=${classes} onClick=${onClick} disabled=${disabled} title=${title} aria-label=${iconOnly ? title : undefined} autoFocus=${autoFocus} ...${rest}>
    ${icon && html`<${Icon} name=${icon} size=${size === 'sm' ? 'sm' : ''} />`}${children}${kbd && html`<span class="kbd">${kbd}</span>`}
  </button>`;
}

export function IconBtn({ icon, title, onClick, danger, disabled, cls = '' }) {
  return html`<button type="button" class=${`icon-btn ${danger ? 'danger' : ''} ${cls}`} title=${title} aria-label=${title} onClick=${onClick} disabled=${disabled}><${Icon} name=${icon} /></button>`;
}

export function Spinner() { return html`<div class="spinner" role="status" aria-label=${t('common.loading')}></div>`; }
export function Loading() { return html`<div class="loading-block"><${Spinner} /></div>`; }

export function Empty({ icon = 'package-search', title, text, action }) {
  return html`<div class="empty"><${Icon} name=${icon} /><h4>${title || t('common.empty')}</h4>${text && html`<div class="small">${text}</div>`}${action}</div>`;
}

export function Pill({ kind = '', dot, children, title }) {
  return html`<span class=${`pill ${kind}`} title=${title}>${dot && html`<i class="dotc"></i>`}${children}</span>`;
}

/** money display; colored=true paints + green and - red */
export function Money({ value, cur, sign, colored, cls = '', strong }) {
  if (value === null || value === undefined || value === '') return html`<span class="muted">—</span>`;
  const c = colored ? (Number(value) > 0 ? 'pos' : Number(value) < 0 ? 'neg' : '') : '';
  return html`<span class=${`money ${c} ${strong ? 'strong' : ''} ${cls}`}>${money(value, cur, { sign })}</span>`;
}

/** list of per-currency balances: {IQD: 5000, USD: -20} */
export function Balances({ value, colored = true, emptyText }) {
  const entries = Object.entries(value || {}).filter(([, v]) => Math.abs(v) > 0);
  if (!entries.length) return html`<div class="bal-list"><span class="money muted">${emptyText || '0'}</span></div>`;
  return html`<div class="bal-list">${entries.map(([c, v]) => html`<${Money} value=${v} cur=${c} colored=${colored} cls="bal" />`)}</div>`;
}

export function KV({ items }) {
  return html`<dl class="kv">${items.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v === null || v === undefined || v === '' ? html`<span class="muted">—</span>` : v}</dd>`)}</dl>`;
}

/* ------------------------------------------------------------------ form controls */
export function Field({ label, hint, error, children, cls = '', required }) {
  return html`<div class=${`field ${cls}`}>
    ${label && html`<label>${label}${required && html` <span class="neg">*</span>`}</label>`}
    ${children}
    ${error ? html`<div class="err">${error}</div>` : hint && html`<div class="hint">${hint}</div>`}
  </div>`;
}

export function Input({ value, onValue, cls = '', size = '', type = 'text', ...rest }) {
  return html`<input class=${`input ${size} ${cls}`} type=${type} value=${value ?? ''} onInput=${(e) => onValue && onValue(e.target.value)} ...${rest} />`;
}

/**
 * Number input that accepts "1.520.000", "12,5" etc. Shows grouped numbers when not focused.
 * onValue receives a number (or null when empty).
 */
/**
 * Number box: shows the formatted number, and the plain number while typing. Entering the box selects the
 * whole number, so typing replaces it (a click into "4.040" never turns "10000" into "404010000").
 */
export function NumInput({ value, onValue, dec = 2, cls = '', size = '', placeholder, autoFocus, disabled, onKeyDown, onBlur, onFocus, inputRef, title, min }) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef(null);
  const justFocused = useRef(false);
  useEffect(() => { if (inputRef) inputRef.current = ref.current; });
  const shown = focused ? text : (value === null || value === undefined || value === '' ? '' : num(value, dec));
  return html`<input ref=${ref} class=${`input num-input ${size} ${cls}`} inputmode="decimal" value=${shown} placeholder=${placeholder}
    autoFocus=${autoFocus} disabled=${disabled} title=${title}
    onFocus=${(e) => {
      const el = e.target;
      const raw = value === null || value === undefined || value === '' ? '' : String(round(value, Math.max(dec, 6))).replace('.', getLang() === 'tr' ? ',' : '.');
      setFocused(true);
      setText(raw);
      // put the plain number in now and select it, so the coming screen update changes nothing and keeps the selection
      el.value = raw;
      try { el.select(); } catch (x) { /* */ }
      justFocused.current = true;
      setTimeout(() => { if (document.activeElement === el && el.value === raw) { try { el.select(); } catch (x) { /* */ } } }, 0);
      onFocus && onFocus(e);
    }}
    onMouseUp=${(e) => { if (justFocused.current) { justFocused.current = false; e.preventDefault(); } }}
    onBlur=${(e) => { justFocused.current = false; setFocused(false); onBlur && onBlur(e); }}
    onKeyDown=${(e) => { justFocused.current = false; if (onKeyDown) onKeyDown(e); }}
    onInput=${(e) => {
      setText(e.target.value);
      let n = parseNum(e.target.value);
      if (n !== null && min !== undefined && n < min) n = min;
      onValue && onValue(n);
    }} />`;
}

export function Select({ value, onValue, options, placeholder, cls = '', size = '', disabled, ...rest }) {
  return html`<select class=${`select ${size} ${cls}`} value=${value ?? ''} disabled=${disabled} onChange=${(e) => onValue && onValue(e.target.value)} ...${rest}>
    ${placeholder !== undefined && html`<option value="">${placeholder}</option>`}
    ${options.map((o) => html`<option value=${o.value} selected=${String(o.value) === String(value ?? '')} disabled=${o.disabled}>${o.label}</option>`)}
  </select>`;
}

export function Textarea({ value, onValue, rows = 3, cls = '', ...rest }) {
  return html`<textarea class=${`textarea ${cls}`} rows=${rows} value=${value ?? ''} onInput=${(e) => onValue && onValue(e.target.value)} ...${rest}></textarea>`;
}

export function Check({ checked, onValue, label, disabled }) {
  return html`<label class="check"><input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onValue && onValue(e.target.checked)} /><span>${label}</span></label>`;
}

export function Segmented({ value, options, onValue }) {
  return html`<div class="segmented" role="tablist">${options.map((o) => html`<button type="button" role="tab" aria-selected=${o.value === value} class=${o.value === value ? 'on' : ''} onClick=${() => onValue(o.value)}>${o.label}</button>`)}</div>`;
}

export function Tabs({ tabs, value, onValue }) {
  return html`<div class="tabs" role="tablist">${tabs.filter(Boolean).map((tb) => html`<button type="button" role="tab" aria-selected=${tb.id === value} class=${tb.id === value ? 'on' : ''} onClick=${() => onValue(tb.id)}>
    ${tb.icon && html`<${Icon} name=${tb.icon} size="sm" />`}${tb.label}${tb.count !== undefined && tb.count !== null && html`<span class="count">${tb.count}</span>`}</button>`)}</div>`;
}

export function SearchBox({ value, onValue, placeholder, autoFocus, cls = '', inputRef, onKeyDown }) {
  return html`<div class=${`input-wrap ${cls}`}><${Icon} name="search" /><input ref=${inputRef} class="input" type="search" value=${value ?? ''} placeholder=${placeholder || t('common.search')}
    autoFocus=${autoFocus} onInput=${(e) => onValue(e.target.value)} onKeyDown=${onKeyDown} /></div>`;
}

/**
 * Autocomplete: search(q) -> Promise<items>; renderItem(item) -> vnode; onSelect(item).
 * onCreate(text) optional: shows "+ add" when no exact match.
 */
export function Combo({ value, placeholder, search, renderItem, onSelect, onCreate, createLabel, autoFocus, size = '', inputRef, clearOnSelect, minChars = 0, disabled, onKeyDownExtra }) {
  const [q, setQ] = useState(value || '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const box = useRef(null);
  useEffect(() => { setQ(value || ''); }, [value]);
  useEffect(() => {
    if (!open) return undefined;
    if ((q || '').length < minChars) { setItems([]); return undefined; }
    const my = ++seq.current;
    setBusy(true);
    const tm = setTimeout(async () => {
      try {
        const r = await search(q || '');
        if (my === seq.current) { setItems(r || []); setHi(0); }
      } finally { if (my === seq.current) setBusy(false); }
    }, 160);
    return () => clearTimeout(tm);
  }, [q, open]);
  useEffect(() => {
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const choose = (it) => {
    setOpen(false);
    if (clearOnSelect) setQ('');
    onSelect && onSelect(it);
  };
  const onKey = (e) => {
    if (onKeyDownExtra && onKeyDownExtra(e, q) === true) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, items.length - (onCreate ? 0 : 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      if (open && items[hi]) { e.preventDefault(); choose(items[hi]); }
      else if (open && onCreate && q && hi >= items.length) { e.preventDefault(); setOpen(false); onCreate(q); }
    } else if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } }
  };
  return html`<div class="combo" ref=${box}>
    <input ref=${inputRef} class=${`input ${size}`} value=${q} placeholder=${placeholder} autoFocus=${autoFocus} disabled=${disabled} autocomplete="off"
      onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown=${onKey} />
    ${open && html`<div class="combo-list" role="listbox">
      ${busy && !items.length ? html`<div class="combo-empty">${t('common.loading')}</div>`
        : !items.length && !(onCreate && q) ? html`<div class="combo-empty">${(q || '').length < minChars ? t('common.type_to_search') : t('common.no_results')}</div>` : null}
      ${items.map((it, i) => html`<div class=${`combo-item ${i === hi ? 'on' : ''}`} role="option" aria-selected=${i === hi} onMouseDown=${(e) => { e.preventDefault(); choose(it); }} onMouseEnter=${() => setHi(i)}>${renderItem(it)}</div>`)}
      ${onCreate && q && html`<div class=${`combo-item ${hi >= items.length ? 'on' : ''}`} onMouseDown=${(e) => { e.preventDefault(); setOpen(false); onCreate(q); }}>
        <${Icon} name="plus" size="sm" /> ${createLabel || t('common.add_new')}: <b>${q}</b></div>`}
    </div>`}
  </div>`;
}

/* ------------------------------------------------------------------ table */
/**
 * columns: [{ key, label, render(row), cls, align: 'r'|'c', sort: fieldName, width }]
 */
export function Table({ columns, rows, onRow, empty, foot, rowCls, compact, sort, onSort, stickyTop }) {
  if (!rows || !rows.length) return empty || html`<${Empty} />`;
  return html`<div class="table-wrap"><table class=${`tbl ${compact ? 'compact' : ''}`}>
    <thead><tr>${columns.filter(Boolean).map((c) => html`<th class=${`${c.align || ''} ${c.sort ? 'sortable' : ''} ${c.cls || ''}`} style=${c.width ? `width:${c.width}` : ''}
      onClick=${c.sort && onSort ? () => onSort(sort && sort.key === c.sort && sort.dir === 'asc' ? { key: c.sort, dir: 'desc' } : { key: c.sort, dir: 'asc' }) : undefined}>
      ${c.label}${sort && c.sort && sort.key === c.sort ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`)}</tr></thead>
    <tbody>${rows.map((r, i) => html`<tr key=${r.id || i} class=${`${onRow ? 'clickable' : ''} ${rowCls ? rowCls(r) : ''}`} onClick=${onRow ? (e) => { if (e.target.closest('button, a, input, select, label')) return; onRow(r, e); } : undefined}>
      ${columns.filter(Boolean).map((c) => html`<td class=${`${c.align || ''} ${c.cls || ''}`}>${c.render ? c.render(r, i) : r[c.key]}</td>`)}</tr>`)}</tbody>
    ${foot && html`<tfoot><tr>${foot}</tr></tfoot>`}
  </table></div>`;
}

export function sortRows(rows, sort) {
  if (!sort || !sort.key) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y)) * dir;
  });
}

/* ------------------------------------------------------------------ panels */
export function Panel({ title, tools, children, cls = '', body = true, foot, icon }) {
  return html`<section class=${`panel ${cls}`}>
    ${(title || tools) && html`<div class="panel-head">${icon && html`<${Icon} name=${icon} />`}${title && html`<h2>${title}</h2>`}${tools && html`<div class="tools">${tools}</div>`}</div>`}
    ${body ? html`<div class="panel-body">${children}</div>` : children}
    ${foot && html`<div class="panel-foot">${foot}</div>`}
  </section>`;
}

export function Notice({ kind = '', icon, children, cls = '' }) {
  const ic = icon || (kind === 'err' ? 'circle-x' : kind === 'warn' ? 'triangle-alert' : kind === 'ok' ? 'circle-check' : 'info');
  return html`<div class=${`notice ${kind} ${cls}`}><${Icon} name=${ic} size="sm" /><div>${children}</div></div>`;
}

/* ------------------------------------------------------------------ modal / drawer manager */
let modalSetter = null;
let modalSeq = 0;
export function ModalHost() {
  const [stack, setStack] = useState([]);
  useEffect(() => { modalSetter = setStack; return () => { modalSetter = null; }; }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !stack.length) return;
      const top = stack[stack.length - 1];
      if (top.props && top.props.noEsc) return;
      e.preventDefault();
      top.close(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack]);
  return html`${stack.map((m) => html`<${m.Comp} key=${m.id} ...${m.props} close=${m.close} />`)}`;
}

/** openModal(Component, props) -> Promise resolved with the value passed to close() */
export function openModal(Comp, props = {}) {
  return new Promise((resolve) => {
    const id = ++modalSeq;
    const close = (val) => {
      if (modalSetter) modalSetter((s) => s.filter((m) => m.id !== id));
      resolve(val);
    };
    if (modalSetter) modalSetter((s) => [...s, { id, Comp, props, close }]);
  });
}

/** Standard modal frame */
export function Modal({ title, close, children, foot, size = '', icon, onSubmit, left }) {
  const body = html`<div class="modal-body">${children}</div>`;
  const inner = html`
    <div class="modal-head">${icon && html`<${Icon} name=${icon} />`}<h3>${title}</h3><${IconBtn} icon="x" title=${t('common.close')} onClick=${() => close()} /></div>
    ${body}
    ${foot && html`<div class="modal-foot">${left && html`<div class="left">${left}</div>`}${foot}</div>`}`;
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) e.currentTarget.dataset.down = '1'; }}
      onMouseUp=${(e) => { if (e.target === e.currentTarget && e.currentTarget.dataset.down === '1') close(); e.currentTarget.dataset.down = ''; }}>
    ${onSubmit
      ? html`<form class=${`modal ${size}`} role="dialog" aria-modal="true" onSubmit=${(e) => { e.preventDefault(); onSubmit(); }}>${inner}</form>`
      : html`<div class=${`modal ${size}`} role="dialog" aria-modal="true">${inner}</div>`}
  </div>`;
}

export function Drawer({ title, close, children, foot, narrow, tools }) {
  return html`<div><div class="drawer-overlay" onClick=${() => close()}></div>
    <aside class=${`drawer ${narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${title}</h3>${tools && html`<div class="row" style="margin-inline-start:auto">${tools}</div>`}<${IconBtn} icon="x" title=${t('common.close')} onClick=${() => close()} cls=${tools ? '' : ''} /></div>
      <div class="modal-body">${children}</div>
      ${foot && html`<div class="modal-foot">${foot}</div>`}
    </aside></div>`;
}

function ConfirmDialog({ close, title, text, okText, danger, input, inputLabel, inputValue, requireText }) {
  const [val, setVal] = useState(inputValue || '');
  return html`<${Modal} title=${title} close=${() => close(null)} onSubmit=${() => close(input ? val : true)}
    foot=${html`<${Btn} onClick=${() => close(null)}>${t('common.cancel')}</${Btn}>
      <${Btn} type="submit" kind=${danger ? 'danger' : 'primary'} disabled=${requireText && !val.trim()} autoFocus=${!input}>${okText || t('common.ok')}</${Btn}>`}>
    ${text && html`<p class="dim" style="white-space:pre-line">${text}</p>`}
    ${input && html`<${Field} label=${inputLabel}><${Input} value=${val} onValue=${setVal} autoFocus=${true} /></${Field}>`}
  </${Modal}>`;
}
export function confirmDialog(opts) { return openModal(ConfirmDialog, opts).then((v) => !!v); }
export function promptDialog(opts) { return openModal(ConfirmDialog, { ...opts, input: true }); }

/* ------------------------------------------------------------------ toasts */
let toastSetter = null;
let toastSeq = 0;
export function ToastHost() {
  const [list, setList] = useState([]);
  useEffect(() => { toastSetter = setList; return () => { toastSetter = null; }; }, []);
  return html`<div class="toasts" aria-live="polite">${list.map((x) => html`<div key=${x.id} class=${`toast ${x.kind}`}>
    <${Icon} name=${x.kind === 'err' ? 'circle-x' : x.kind === 'warn' ? 'triangle-alert' : 'circle-check'} size="sm" /><div style="white-space:pre-line">${x.msg}</div></div>`)}</div>`;
}
export function toast(msg, kind = 'ok', ms) {
  if (!toastSetter) return;
  const id = ++toastSeq;
  toastSetter((l) => [...l.slice(-4), { id, msg, kind }]);
  setTimeout(() => toastSetter && toastSetter((l) => l.filter((x) => x.id !== id)), ms || (kind === 'err' ? 6000 : 3000));
}
export function errToast(e) { toast((e && e.message) || t('err.generic'), 'err'); }

/* ------------------------------------------------------------------ dropdown menu */
export function MenuButton({ label, icon, items, kind = '', size = '', align = 'end', iconOnly, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const list = items.filter(Boolean).filter((it, i, arr) => it !== '-' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== '-'));
  while (list.length && list[list.length - 1] === '-') list.pop();
  return html`<div style="position:relative; display:inline-block" ref=${ref}>
    ${iconOnly ? html`<${IconBtn} icon=${icon || 'ellipsis'} title=${title} onClick=${() => setOpen(!open)} />`
      : html`<${Btn} kind=${kind} size=${size} icon=${icon} onClick=${() => setOpen(!open)}>${label}<${Icon} name="chevron-down" size="sm" /></${Btn}>`}
    ${open && html`<div class="menu" style=${`top:calc(100% + 4px); ${align === 'end' ? 'inset-inline-end:0' : 'inset-inline-start:0'}`}>
      ${list.map((it) => (it === '-' ? html`<div class="menu-sep"></div>` : html`<button type="button" class=${`menu-item ${it.danger ? 'danger' : ''}`} disabled=${it.disabled}
        onClick=${() => { setOpen(false); it.onClick && it.onClick(); }}>${it.icon && html`<${Icon} name=${it.icon} size="sm" />`}${it.label}</button>`))}
    </div>`}
  </div>`;
}

/* ------------------------------------------------------------------ date range with presets */
export function periodRange(id) {
  const td = today();
  switch (id) {
    case 'today': return { from: td, to: td };
    case 'yesterday': { const y = addDays(td, -1); return { from: y, to: y }; }
    case 'week': return { from: addDays(td, -6), to: td };
    case 'month': return { from: monthStart(td), to: td };
    case 'last_month': { const s = addMonths(monthStart(td), -1); return { from: s, to: addDays(monthStart(td), -1) }; }
    case '3m': return { from: addMonths(td, -3), to: td };
    case 'year': return { from: `${td.slice(0, 4)}-01-01`, to: td };
    case 'all': return { from: '2000-01-01', to: td };
    default: return { from: monthStart(td), to: td };
  }
}
export const PERIODS = ['today', 'yesterday', 'week', 'month', 'last_month', '3m', 'year', 'all'];

export function DateRange({ from, to, onChange }) {
  const preset = PERIODS.find((p) => { const r = periodRange(p); return r.from === from && r.to === to; }) || 'custom';
  return html`<div class="row gap-4">
    <select class="select" style="width:auto" value=${preset} onChange=${(e) => { if (e.target.value !== 'custom') onChange(periodRange(e.target.value)); }}>
      ${PERIODS.map((p) => html`<option value=${p} selected=${p === preset}>${t(`period.${p}`)}</option>`)}
      <option value="custom" selected=${preset === 'custom'}>${t('period.custom')}</option>
    </select>
    <${DateInput} style="width:140px" value=${from} onValue=${(v) => onChange({ from: v, to: v > to ? v : to })} ariaLabel=${t('common.from')} />
    <${DateInput} style="width:140px" value=${to} onValue=${(v) => onChange({ from: v < from ? v : from, to: v })} ariaLabel=${t('common.to')} />
  </div>`;
}

/* ------------------------------------------------------------------ dates */
const DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Reads what people type into a date box: "11.08.2026", "11/8/26", "11082026", "1108" (this year), "11" (this month),
 * an ISO date, and Arabic/Persian digits. Returns an ISO date or null when it is not a real date.
 */
export function parseDateText(text, base) {
  let s = String(text || '').trim().replace(/[٠-٩۰-۹]/g, (c) => DIGITS[c]);
  if (!s) return '';
  const ref = (base || today()).split('-').map(Number);
  let y; let m; let d;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; } else {
    const parts = s.split(/[^0-9]+/).filter(Boolean);
    if (parts.length === 1) {
      const p = parts[0];
      if (p.length === 8) { d = +p.slice(0, 2); m = +p.slice(2, 4); y = +p.slice(4); }
      else if (p.length === 6) { d = +p.slice(0, 2); m = +p.slice(2, 4); y = 2000 + +p.slice(4); }
      else if (p.length === 4) { d = +p.slice(0, 2); m = +p.slice(2, 4); y = ref[0]; }
      else if (p.length <= 2) { d = +p; m = ref[1]; y = ref[0]; }
      else return null;
    } else if (parts.length === 2) { d = +parts[0]; m = +parts[1]; y = ref[0]; }
    else if (parts.length === 3) { d = +parts[0]; m = +parts[1]; y = +parts[2]; if (parts[2].length <= 2) y += 2000; }
    else return null;
  }
  if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= 2200)) return null;
  if (d > new Date(y, m, 0).getDate()) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** first day of the week: Saturday in Iraq (Arabic, Kurdish), Monday otherwise */
const weekStart = () => (['ar', 'ku'].includes(getLang()) ? 6 : 1);

/**
 * Date box that always shows the app's own format (11.08.2026 / 11/08/2026), whatever the computer's
 * regional settings are. Typing works; ↑/↓ move a day; Alt+↓ or the button opens a small calendar.
 * value / onValue use ISO dates (yyyy-mm-dd); '' means empty (only when clearable).
 */
export function DateInput({ value, onValue, size = '', cls = '', style, placeholder, clearable, disabled, autoFocus, ariaLabel, inputRef }) {
  const [text, setText] = useState(null); // what is being typed; null = show the value
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(false);
  const ref = useRef(null);
  const justFocused = useRef(false);
  useEffect(() => { if (inputRef) inputRef.current = ref.current; });
  const shown = text !== null ? text : date(value);
  const commit = () => {
    if (text === null) return true;
    const str = text.trim();
    if (!str) { if (clearable) { if (value) onValue(''); setText(null); setBad(false); return true; } setText(null); setBad(false); return true; }
    const iso = parseDateText(str, value);
    if (iso) { if (iso !== value) onValue(iso); setText(null); setBad(false); return true; }
    setBad(true);
    return false;
  };
  const step = (n) => {
    const iso = addDays(value || today(), n);
    onValue(iso);
    if (text !== null) setText(date(iso));
  };
  const pick = (iso) => { setOpen(false); setText(null); setBad(false); if (iso !== value && (iso || clearable)) onValue(iso); };
  return html`<div class=${`date-input ${cls}`} style=${style}>
    <input ref=${ref} class=${`input ${size} ${bad ? 'invalid' : ''}`} value=${shown} disabled=${disabled} autoFocus=${autoFocus} aria-label=${ariaLabel}
      placeholder=${placeholder || (getLang() === 'tr' ? 'gg.aa.yyyy' : 'dd/mm/yyyy')} autocomplete="off" spellcheck="false"
      onFocus=${(e) => {
        const el = e.target;
        const v = date(value);
        setText(v);
        try { el.select(); } catch (x) { /* */ }
        justFocused.current = true;
        // select again after the screen update, but never pull the cursor back once the user has moved on
        setTimeout(() => { if (document.activeElement === el && el.value === v) { try { el.select(); } catch (x) { /* */ } } }, 0);
      }}
      onMouseUp=${(e) => { if (justFocused.current) { justFocused.current = false; e.preventDefault(); } }}
      onInput=${(e) => { setText(e.target.value); setBad(false); }}
      onBlur=${() => { justFocused.current = false; if (!commit()) setTimeout(() => { setText(null); setBad(false); }, 1500); }}
      onKeyDown=${(e) => {
        justFocused.current = false;
        if (e.key === 'Enter') {
          // a typed date is applied first; the next Enter submits the form
          if (text !== null && text.trim() !== date(value)) { e.preventDefault(); commit(); }
        } else if ((e.key === 'ArrowDown' && e.altKey) || e.key === 'F4') { e.preventDefault(); setOpen(true); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
        else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      }} />
    <button type="button" class="date-btn" tabindex="-1" disabled=${disabled} title=${t('common.calendar')} aria-label=${t('common.calendar')}
      onMouseDown=${(e) => e.preventDefault()} onClick=${() => setOpen(!open)}><${Icon} name="calendar" size="sm" /></button>
    ${open && html`<${CalendarPop} anchor=${ref.current} value=${value} clearable=${clearable} onPick=${pick} onClose=${() => setOpen(false)} />`}
  </div>`;
}

function CalendarPop({ anchor, value, clearable, onPick, onClose }) {
  const [ym, setYm] = useState((value || today()).slice(0, 7));
  const [pos, setPos] = useState(null);
  const box = useRef(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 272;
    const h = box.current ? box.current.offsetHeight : 320;
    const rtl = document.documentElement.dir === 'rtl';
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    const left = Math.max(8, Math.min(rtl ? r.right - w : r.left, window.innerWidth - w - 8));
    setPos({ top, left });
  }, []);
  useEffect(() => {
    const down = (e) => { if (box.current && !box.current.contains(e.target) && !(anchor.parentNode && anchor.parentNode.contains(e.target))) onClose(); };
    const scroll = (e) => { if (box.current && e.target instanceof Node && box.current.contains(e.target)) return; onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('keydown', key, true);
    };
  }, []);
  const [y, m] = ym.split('-').map(Number);
  const start = weekStart();
  const offset = (new Date(y, m - 1, 1).getDay() - start + 7) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${pad2(d)}`);
  const move = (n) => { const dt = new Date(y, m - 1 + n, 1); setYm(`${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`); };
  const td = today();
  const dows = [0, 1, 2, 3, 4, 5, 6].map((i) => t(`cal.dow.${((start + i - 1) % 7) + 1}`));
  return html`<div ref=${box} class="cal-pop" role="dialog" aria-label=${t('common.calendar')} style=${pos ? `top:${pos.top}px;left:${pos.left}px` : 'visibility:hidden;top:0;left:0'}
    onMouseDown=${(e) => e.preventDefault()}>
    <div class="cal-head">
      <button type="button" class="icon-btn" onClick=${() => move(-1)} title=${t('cal.prev')} aria-label=${t('cal.prev')}><${Icon} name="chevron-left" /></button>
      <div class="cal-title">${t(`month.${m}`)} ${y}</div>
      <button type="button" class="icon-btn" onClick=${() => move(1)} title=${t('cal.next')} aria-label=${t('cal.next')}><${Icon} name="chevron-right" /></button>
    </div>
    <div class="cal-grid">
      ${dows.map((l) => html`<div class="cal-dow">${l}</div>`)}
      ${cells.map((iso) => (iso ? html`<button type="button" class=${`cal-day ${iso === value ? 'on' : ''} ${iso === td ? 'today' : ''}`} onClick=${() => onPick(iso)}>${Number(iso.slice(8))}</button>` : html`<span></span>`))}
    </div>
    <div class="cal-foot">
      <button type="button" class="link-btn small" onClick=${() => onPick(td)}>${t('period.today')}</button>
      ${clearable && value && html`<button type="button" class="link-btn small" onClick=${() => onPick('')}>${t('common.clear')}</button>`}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ hooks */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return Promise.resolve().then(fn).then(
      (data) => { if (my === seq.current) setState({ data, loading: false, error: null }); return data; },
      (error) => { if (my === seq.current) setState({ data: null, loading: false, error }); },
    );
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const tm = setTimeout(() => setV(value), ms); return () => clearTimeout(tm); }, [value, ms]);
  return v;
}

export function useHotkeys(map, deps = []) {
  useEffect(() => {
    const onKey = (e) => {
      const key = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const fn = map[key] || map[e.key];
      if (fn) {
        const r = fn(e);
        if (r !== false) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, deps);
}

/** read a File as data URL (optionally downscale images so big phone photos stay small) */
export function readImage(file, maxSide = 1600, quality = 0.88) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale >= 1 && file.size < 900 * 1024) { resolve(fr.result); return; }
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', quality));
      };
      img.onerror = () => resolve(fr.result);
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (accept) inp.accept = accept;
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

export { html, render, useState, useEffect, useRef, useMemo, useCallback };
