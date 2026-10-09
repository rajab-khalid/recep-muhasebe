// Application shell: sidebar, top bar, routing, global search, rate editor, notifications, lock screen.
import { html, useState, useEffect, useRef } from './core/h.js';
import { t, onLang, setLang, LANGS, getLang } from './core/i18n.js';
import { store, useStore, can, setPrefs, boot } from './core/store.js';
import { useRoute, navigate, back, canGoBack } from './core/router.js';
import { api, ApiError } from './core/api.js';
import { money, num, dateTime, initials, date as fdate, rateText } from './core/format.js';
import {
  Icon, IconBtn, Btn, Modal, ModalHost, ToastHost, openModal, toast, errToast, Field, NumInput, Input, Spinner, Empty, MenuButton, useHotkeys, Pill, confirmDialog,
} from './core/ui.js';
import { loadBoot, logout, refreshBoot } from './core/session.js';
import { Login } from './pages/login.js';
import { Setup } from './pages/setup.js';
import { Dashboard } from './pages/dashboard.js';
import { Pos } from './pages/pos.js';
import { DocList, DocView, DocEditor } from './pages/docs.js';
import { Products, ProductPage } from './pages/products.js';
import { Stock, CountPage } from './pages/stock.js';
import { Partners, PartnerPage } from './pages/partners.js';
import { Vehicles, VehiclePage } from './pages/vehicles.js';
import { Cash, CashAccountPage } from './pages/cash.js';
import { Payments } from './pages/payments.js';
import { Finance } from './pages/finance.js';
import { Reports, ReportPage } from './pages/reports.js';
import { Users } from './pages/users.js';
import { Settings } from './pages/settings.js';
import { Audit } from './pages/audit.js';
import { dn } from './core/names.js';

export const NAV = [
  { group: 'nav.g.main', items: [{ path: '/', icon: 'gauge', label: 'nav.dashboard', perm: 'dashboard.view' }] },
  {
    group: 'nav.g.sales', items: [
      { path: '/pos', icon: 'shopping-cart', label: 'nav.pos', perm: ['pos.use', 'sales.create'] },
      { path: '/docs/sale', icon: 'receipt', label: 'nav.sales', perm: 'sales.view' },
      { path: '/docs/quote', icon: 'clipboard-list', label: 'nav.quotes', perm: 'quotes.view' },
      { path: '/docs/service', icon: 'wrench', label: 'nav.service', perm: 'service.view' },
      { path: '/docs/sale_return', icon: 'undo-2', label: 'nav.returns', perm: 'returns.view' },
    ],
  },
  {
    group: 'nav.g.purchase', items: [
      { path: '/docs/purchase', icon: 'truck', label: 'nav.purchases', perm: 'purchases.view' },
      { path: '/docs/purchase_order', icon: 'file-text', label: 'nav.orders', perm: 'orders.view' },
      { path: '/docs/purchase_return', icon: 'rotate-ccw', label: 'nav.purchase_returns', perm: 'returns.view' },
    ],
  },
  {
    group: 'nav.g.stock', items: [
      { path: '/products', icon: 'package', label: 'nav.products', perm: 'products.view' },
      { path: '/stock', icon: 'boxes', label: 'nav.stock', perm: 'stock.view' },
    ],
  },
  {
    group: 'nav.g.accounts', items: [
      { path: '/partners/customer', icon: 'users', label: 'nav.customers', perm: 'partners.view' },
      { path: '/partners/supplier', icon: 'building-2', label: 'nav.suppliers', perm: 'partners.view' },
      { path: '/vehicles', icon: 'car', label: 'nav.vehicles', perm: 'vehicles.view' },
    ],
  },
  {
    group: 'nav.g.money', items: [
      { path: '/cash', icon: 'wallet', label: 'nav.cash', perm: ['cash.view', 'bank.view'] },
      { path: '/payments', icon: 'hand-coins', label: 'nav.payments', perm: ['payments.collect', 'payments.pay'] },
      { path: '/finance', icon: 'receipt-text', label: 'nav.finance', perm: 'finance.view' },
    ],
  },
  { group: 'nav.g.analysis', items: [{ path: '/reports', icon: 'chart-column', label: 'nav.reports', perm: ['reports.sales', 'reports.stock', 'reports.finance', 'reports.profit'] }] },
  {
    group: 'nav.g.admin', items: [
      { path: '/users', icon: 'user-cog', label: 'nav.users', perm: 'users.manage' },
      { path: '/settings', icon: 'settings', label: 'nav.settings', perm: ['settings.manage', 'backup.manage'] },
      { path: '/audit', icon: 'history', label: 'nav.audit', perm: 'audit.view' },
    ],
  },
];


export function App() {
  const [, force] = useState(0);
  useEffect(() => onLang(() => force((n) => n + 1)), []);
  const setup = useStore((s) => s.setup);
  const user = useStore((s) => s.user);
  const bootData = useStore((s) => s.boot);
  const locked = useStore((s) => s.locked);
  let screen;
  if (setup && !setup.done) screen = html`<${Setup} />`;
  else if (!user || !bootData) screen = html`<${Login} />`;
  else screen = html`<${Shell} />`;
  return html`<div key=${getLang()}>${screen}${locked && user && html`<${LockScreen} />`}<${ModalHost} /><${ToastHost} /></div>`;
}

function allowed(item) { return !item.perm || can(item.perm); }

function Shell() {
  const route = useRoute();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { setMobileOpen(false); }, [route.raw]);
  useIdleLock();
  useHotkeys({
    'ctrl+k': () => openModal(GlobalSearch),
    f2: () => { if (can(['pos.use', 'sales.create'])) navigate('/pos'); else return false; },
  }, []);
  const isPos = route.parts[0] === 'pos';
  return html`<div class=${`shell ${collapsed || isPos ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
    <${Sidebar} route=${route} />
    <div class="main">
      <${Topbar} onMenu=${() => setMobileOpen(!mobileOpen)} />
      <main class=${`content ${isPos ? 'flush' : ''}`} id="content">
        <${Routes} route=${route} />
      </main>
    </div>
  </div>`;
}

function Routes({ route }) {
  const [a, b, c] = route.parts;
  const q = route.query;
  if (!a) return can('dashboard.view') ? html`<${Dashboard} />` : html`<${FirstAllowed} />`;
  switch (a) {
    case 'pos': return html`<${Pos} key=${q.resume || 'pos'} query=${q} />`;
    case 'docs': return c === 'new' ? html`<${DocEditor} key=${route.raw} type=${b} query=${q} />` : html`<${DocList} key=${b} type=${b} query=${q} />`;
    case 'doc': return c === 'edit' ? html`<${DocEditor} key=${route.raw} id=${b} query=${q} />` : html`<${DocView} key=${b} id=${b} />`;
    case 'products': return b ? html`<${ProductPage} key=${b} id=${b} query=${q} />` : html`<${Products} query=${q} />`;
    case 'stock': return b === 'count' && c ? html`<${CountPage} key=${c} id=${c} />` : html`<${Stock} tab=${b} query=${q} />`;
    case 'partners': return html`<${Partners} key=${b} kind=${b || 'customer'} query=${q} />`;
    case 'partner': return html`<${PartnerPage} key=${b} id=${b} tab=${c} query=${q} />`;
    case 'vehicles': return html`<${Vehicles} query=${q} />`;
    case 'vehicle': return html`<${VehiclePage} key=${b} id=${b} />`;
    case 'cash': return b ? html`<${CashAccountPage} key=${b} id=${b} query=${q} />` : html`<${Cash} query=${q} />`;
    case 'payments': return html`<${Payments} query=${q} />`;
    case 'finance': return html`<${Finance} query=${q} />`;
    case 'reports': return b ? html`<${ReportPage} key=${b} name=${b} query=${q} />` : html`<${Reports} />`;
    case 'users': return html`<${Users} />`;
    case 'settings': return html`<${Settings} tab=${b} />`;
    case 'audit': return html`<${Audit} query=${q} />`;
    default: return html`<${Empty} title=${t('common.not_found')} />`;
  }
}

function FirstAllowed() {
  useEffect(() => {
    for (const g of NAV) for (const it of g.items) if (it.path !== '/' && allowed(it)) { navigate(it.path); return; }
  }, []);
  return null;
}

function Sidebar({ route }) {
  const b = useStore((s) => s.boot);
  const u = useStore((s) => s.user);
  const notif = useStore((s) => s.notifications);
  const company = (b && b.company) || {};
  const current = route.path;
  const isActive = (p) => (p === '/' ? current === '/' : current === p || current.startsWith(p + '/') || (p === '/docs/sale' && false));
  const svcCount = notif.filter((n) => n.kind === 'service_done' && !n.read).length;
  // keep the current page's menu item in view on short screens
  useEffect(() => {
    const el = document.querySelector('.nav-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return html`<aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">${company.logo_url ? html`<img src=${company.logo_url} alt="" />` : 'R'}</div>
      <div class="brand-text"><div class="brand-name">Recep Muhasebe</div><div class="brand-sub" dir="auto">${company.name || ''}</div></div>
    </div>
    <nav class="nav" aria-label=${t('nav.menu')}>
      ${NAV.map((g) => {
        const items = g.items.filter(allowed);
        if (!items.length) return null;
        return html`<div><div class="nav-label">${t(g.group)}</div>
          ${items.map((it) => html`<a class=${`nav-item ${isActive(it.path) ? 'active' : ''}`} href=${'#' + it.path} title=${t(it.label)}>
            <${Icon} name=${it.icon} /><span>${t(it.label)}</span>
            ${it.path === '/docs/service' && svcCount ? html`<span class="nav-badge">${svcCount}</span>` : null}
          </a>`)}</div>`;
      })}
    </nav>
    <div class="side-foot">
      <div class="avatar">${initials(u && u.full_name)}</div>
      <div class="who"><b>${u && u.full_name}</b><span>${u && dn(u.role_name)}</span></div>
      <button class="chrome-btn" title=${t('nav.collapse')} onClick=${() => { const v = !store.state.sidebarCollapsed; store.set({ sidebarCollapsed: v }); setPrefs('sidebar_collapsed', v); }}>
        <${Icon} name=${store.state.sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size="sm" /></button>
    </div>
  </aside>`;
}

/** one screen back; with no earlier screen, the page above this one (e.g. the list a document belongs to) */
function goBack() {
  const crumbs = store.state.crumbs || [];
  const parent = [...crumbs].reverse().find((c) => c.href);
  back(parent ? parent.href.replace(/^#/, '') : '/');
}

/** Back button of the desktop program: Alt+← and the mouse's back button (a browser does this itself) */
function useBackKeys() {
  useEffect(() => {
    if (!window.desktop) return undefined;
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'BrowserBack')) { e.preventDefault(); goBack(); }
    };
    const onMouse = (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse); };
  }, []);
}

function Topbar({ onMenu }) {
  const route = useRoute();
  const title = useStore((s) => s.pageTitle);
  const crumbs = useStore((s) => s.crumbs);
  useBackKeys();
  const showBack = route.path !== '/' || canGoBack();
  const b = useStore((s) => s.boot);
  const u = useStore((s) => s.user);
  const dc = useStore((s) => s.displayCurrency);
  const notifs = useStore((s) => s.notifications);
  const iqd = ((b && b.currencies) || []).find((c) => c.code === 'IQD');
  useNotifications();
  const unread = notifs.filter((n) => !n.read).length;
  const langItems = LANGS.map((l) => ({ label: `${l.code === getLang() ? '✓ ' : ''}${l.name}`, onClick: () => setLang(l.code) }));
  return html`<header class="topbar">
    <${IconBtn} icon="menu" title=${t('nav.menu')} onClick=${onMenu} cls="mobile-menu" />
    ${showBack && html`<button type="button" class="back-btn" onClick=${goBack} title=${window.desktop ? `${t('common.back')} (Alt+←)` : t('common.back')} aria-label=${t('common.back')}>
      <${Icon} name="arrow-left" size="sm" /><span>${t('common.back')}</span></button>`}
    <div class="title">
      ${crumbs && html`<div class="crumbs">${crumbs.map((c, i) => html`${i > 0 && html`<${Icon} name="chevron-right" size="sm" />`}${c.href ? html`<a href=${c.href}>${c.label}</a>` : html`<span>${c.label}</span>`}`)}</div>`}
      <h1 dir="auto">${title || ''}</h1>
    </div>
    <div class="tools">
      <button class="rate-chip" title=${t('rate.edit')} onClick=${() => openModal(RateDialog)}>
        <${Icon} name="coins" size="sm" /><span class="lbl">${t('rate.short')}</span><b class="num">${rateText(iqd ? iqd.rate : 0)}</b>
      </button>
      <div class="segmented hide-sm" title=${t('common.display_currency')}>
        ${['IQD', 'USD'].map((c) => html`<button class=${dc === c ? 'on' : ''} onClick=${() => { store.set({ displayCurrency: c }); setPrefs('display_currency', c); }}>${c}</button>`)}
      </div>
      <${IconBtn} icon="search" title=${`${t('search.global')} (Ctrl+K)`} onClick=${() => openModal(GlobalSearch)} />
      ${can(['pos.use', 'sales.create']) && html`<${Btn} kind="primary" icon="shopping-cart" onClick=${() => navigate('/pos')} cls="hide-sm" title="F2">${t('nav.pos')}</${Btn}>`}
      <div style="position:relative">
        <${IconBtn} icon="bell" title=${t('notif.title')} onClick=${() => openModal(NotificationsDialog)} />
        ${unread > 0 && html`<span class="dot"></span>`}
      </div>
      <${MenuButton} iconOnly icon="globe" title=${t('common.language')} items=${langItems} />
      <${MenuButton} iconOnly icon="user" title=${u && u.full_name} items=${[
        { label: u && u.full_name, icon: 'user', disabled: true },
        { label: t('user.change_secret'), icon: 'lock', onClick: () => openModal(ChangeSecretDialog) },
        { label: t('user.lock'), icon: 'lock', onClick: () => store.set({ locked: true }) },
        '-',
        { label: t('user.logout'), icon: 'log-out', danger: true, onClick: () => logout() },
      ]} />
    </div>
  </header>`;
}

/* ------------------------------------------------------------------ notifications */
function useNotifications() {
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/notifications').then((n) => { if (alive) store.set({ notifications: n }); }).catch(() => {});
    load();
    const tm = setInterval(load, 60000);
    return () => { alive = false; clearInterval(tm); };
  }, []);
}

const NOTIF_META = {
  stock_out: { icon: 'package-minus', go: (n) => `/products/${n.ref}` },
  stock_low: { icon: 'package', go: (n) => `/products/${n.ref}` },
  overdue: { icon: 'clock', go: (n) => `/doc/${n.ref}` },
  recurring: { icon: 'receipt-text', go: () => '/finance?tab=recurring' },
  service_done: { icon: 'wrench', go: (n) => `/doc/${n.ref}` },
  backup_old: { icon: 'database', go: () => '/settings/backup' },
};

function NotificationsDialog({ close }) {
  const list = useStore((s) => s.notifications);
  const markAll = async () => {
    const keys = list.filter((n) => !n.read).map((n) => n.key);
    await api.post('/api/notifications/read', { keys });
    store.set({ notifications: list.map((n) => ({ ...n, read: true })) });
  };
  const text = (n) => {
    switch (n.kind) {
      case 'stock_out': return t('notif.stock_out', { name: n.name });
      case 'stock_low': return t('notif.stock_low', { name: n.name, qty: num(n.value, 2) });
      case 'overdue': return t('notif.overdue', { name: n.name, days: n.value });
      case 'recurring': return t('notif.recurring', { name: n.name || '' });
      case 'service_done': return t('notif.service_done', { no: n.name });
      case 'backup_old': return t('notif.backup_old');
      default: return n.kind;
    }
  };
  return html`<${Modal} title=${t('notif.title')} close=${close} icon="bell"
    foot=${html`<${Btn} onClick=${markAll} disabled=${!list.some((n) => !n.read)}>${t('notif.mark_all')}</${Btn}><${Btn} kind="primary" onClick=${() => close()}>${t('common.close')}</${Btn}>`}>
    ${!list.length ? html`<${Empty} icon="circle-check" title=${t('notif.none')} />` : html`<div class="mini-list" style="margin:-18px">
      ${list.map((n) => {
        const m = NOTIF_META[n.kind] || { icon: 'info', go: () => '/' };
        return html`<div class="mini-row link" style=${n.read ? 'opacity:.6' : ''} onClick=${() => { close(); navigate(m.go(n)); }}>
          <span class=${n.level === 'danger' ? 'neg' : n.level === 'warn' ? 'warn-text' : 'muted'}><${Icon} name=${m.icon} /></span>
          <div class="grow" dir="auto">${text(n)}</div>${!n.read && html`<${Pill} kind="info">${t('notif.new')}</${Pill}>`}
        </div>`;
      })}</div>`}
  </${Modal}>`;
}

/* ------------------------------------------------------------------ exchange rate */
export function RateDialog({ close }) {
  const b = boot();
  const iqd = (b.currencies || []).find((c) => c.code === 'IQD') || { rate: 0 };
  const [rate, setRate] = useState(iqd.rate);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(null);
  const [history, setHistory] = useState(null);
  const canEdit = can(['settings.manage', 'cash.manage']);
  useEffect(() => { if (can(['reports.finance'])) api.get('/api/reports/rateHistory').then((h) => setHistory(h.slice(0, 8))).catch(() => {}); }, []);
  const save = async (confirmBig) => {
    if (!(rate > 0)) return;
    setBusy(true);
    try {
      await api.post('/api/currencies/IQD/rate', { rate, source: 'manual', confirm_big_change: confirmBig === true || undefined });
      await refreshBoot();
      toast(t('rate.saved', { rate: num(rate, 2) }));
      close(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_big_change') {
        setBusy(false);
        const ok = await confirmDialog({ title: t('rate.big_change_title'), text: t('rate.big_change_text', { old: num(e.details.old, 2), rate: num(e.details.rate, 2) }), okText: t('rate.big_change_ok'), danger: true });
        if (ok) save(true);
        return;
      }
      errToast(e);
    } finally { setBusy(false); }
  };
  const fetchOnline = async () => {
    try { const r = await api.get('/api/rates/online'); setOnline(r); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('rate.title')} close=${close} icon="coins" onSubmit=${canEdit ? save : undefined}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}>${canEdit && html`<${Btn} type="submit" kind="primary" disabled=${busy || !(rate > 0)}>${t('common.save')}</${Btn}>`}`}>
    <${Field} label=${t('rate.label')} hint=${t('rate.hint')}>
      <div class="input-wrap"><${NumInput} value=${rate} onValue=${setRate} dec=${2} cls="has-suffix lg" autoFocus=${canEdit} disabled=${!canEdit} /><span class="suffix">IQD</span></div>
    </${Field}>
    <div class="row mt-12 wrap">
      ${[1300, 1310, 1450, 1480, 1500, 1520].map((v) => html`<${Btn} size="sm" disabled=${!canEdit} onClick=${() => setRate(v)}>${num(v)}</${Btn}>`)}
    </div>
    <div class="row mt-16">
      <${Btn} size="sm" icon="globe" onClick=${fetchOnline}>${t('rate.online')}</${Btn}>
      ${online && html`<span class="small">${t('rate.online_value', { rate: num(online.IQD, 2) })} <button class="link-btn" onClick=${() => setRate(Math.round(online.IQD))}>${t('rate.use_it')}</button></span>`}
    </div>
    <p class="small muted mt-8">${t('rate.online_note')}</p>
    ${history && history.length > 0 && html`<div class="mt-16"><div class="label mb-8">${t('rate.history')}</div>
      <table class="tbl compact"><tbody>${history.map((h) => html`<tr><td class="small">${dateTime(h.ts)}</td><td class="small muted">${t(`rate.src.${String(h.source).replace('v2-', '')}`)}${h.user_name ? ` · ${h.user_name}` : String(h.source).startsWith('v2-') ? ` · ${t('audit.entity.legacy')}` : ''}</td><td class="r num">${num(h.rate, 2)}</td></tr>`)}</tbody></table></div>`}
  </${Modal}>`;
}

/* ------------------------------------------------------------------ global search */
function GlobalSearch({ close }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return undefined; }
    const tm = setTimeout(async () => {
      const tasks = [];
      tasks.push(can(['products.view', 'pos.use']) ? api.get('/api/products', { q, limit: 6 }).then((r) => r.rows) : Promise.resolve([]));
      tasks.push(can('partners.view') ? api.get('/api/partners', { q, limit: 6 }) : Promise.resolve([]));
      const docTypes = ['sale', 'purchase', 'quote', 'service', 'sale_return', 'purchase_return', 'purchase_order'].filter((tp) => can({ sale: 'sales.view', purchase: 'purchases.view', quote: 'quotes.view', service: 'service.view', sale_return: 'returns.view', purchase_return: 'returns.view', purchase_order: 'orders.view' }[tp]));
      tasks.push(docTypes.length ? api.get('/api/docs', { type: docTypes.join(','), q, limit: 8, include_cancelled: 1 }).then((r) => r.rows) : Promise.resolve([]));
      tasks.push(can('vehicles.view') ? api.get('/api/vehicles', { q, limit: 5 }) : Promise.resolve([]));
      const [p, pa, d, v] = await Promise.all(tasks.map((x) => x.catch(() => [])));
      setRes({ p: p.slice(0, 6), pa: pa.slice(0, 6), d, v });
      setHi(0);
    }, 200);
    return () => clearTimeout(tm);
  }, [q]);
  const flat = res ? [
    ...res.p.map((x) => ({ go: `/products/${x.id}`, icon: 'package', label: x.name, sub: [x.code, x.barcode].filter(Boolean).join(' ') })),
    ...res.pa.map((x) => ({ go: `/partner/${x.id}`, icon: x.kind === 'supplier' ? 'building-2' : 'users', label: x.name, sub: x.phone })),
    ...res.d.map((x) => ({ go: `/doc/${x.id}`, icon: 'file-text', label: `${x.no} — ${x.partner_name || ''}`, sub: `${t(`doc.type.${x.type}`)} · ${fdate(x.date)}${x.vehicle_plate ? ' · ' + x.vehicle_plate : ''}` })),
    ...res.v.map((x) => ({ go: `/vehicle/${x.id}`, icon: 'car', label: x.plate || x.description, sub: [x.description, x.partner_name].filter(Boolean).join(' · ') })),
  ] : [];
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && flat[hi]) { close(); navigate(flat[hi].go); }
  };
  return html`<${Modal} title=${t('search.global')} close=${close} size="wide" icon="search">
    <div class="input-wrap"><${Icon} name="search" /><input class="input lg" autoFocus value=${q} placeholder=${t('search.placeholder')} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} /></div>
    <div class="mt-12">
      ${!res ? html`<p class="small muted">${t('search.hint')}</p>` : !flat.length ? html`<${Empty} title=${t('common.no_results')} />`
        : html`<div class="mini-list">${flat.map((r, i) => html`<div class=${`mini-row link ${i === hi ? 'selected' : ''}`} style=${i === hi ? 'background:var(--info-soft)' : ''}
            onClick=${() => { close(); navigate(r.go); }}><${Icon} name=${r.icon} /><div class="grow"><div dir="auto">${r.label}</div><div class="tiny muted" dir="auto">${r.sub}</div></div></div>`)}</div>`}
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ account */
function ChangeSecretDialog({ close }) {
  const [cur, setCur] = useState('');
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState('');
  const save = async () => {
    try {
      await api.post('/api/auth/change-secret', { current: cur, pin: pin || undefined, password: pw || undefined });
      toast(t('user.secret_changed'));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('user.change_secret')} close=${close} onSubmit=${save} foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!pin && !pw}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Field} label=${t('user.current_secret')}><${Input} type="password" value=${cur} onValue=${setCur} autoFocus /></${Field}>
      <${Field} label=${t('user.new_pin')} hint=${t('user.pin_hint')}><${Input} type="password" inputmode="numeric" maxlength="8" value=${pin} onValue=${setPin} /></${Field}>
      <${Field} label=${t('user.new_password')}><${Input} type="password" value=${pw} onValue=${setPw} /></${Field}>
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ lock screen */
function useIdleLock() {
  const sec = (boot().settings || {}).security || {};
  useEffect(() => {
    if (sec.lock_on_start && !sessionStorage.getItem('rm_unlocked')) store.set({ locked: true });
    const mins = Number(sec.idle_lock_minutes) || 0;
    if (!mins) return undefined;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ['mousemove', 'keydown', 'mousedown', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const tm = setInterval(() => { if (Date.now() - last > mins * 60000 && !store.state.locked) store.set({ locked: true }); }, 15000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(tm); };
  }, [sec.idle_lock_minutes, sec.lock_on_start]);
}

function LockScreen() {
  const u = useStore((s) => s.user);
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const unlock = async () => {
    try {
      await api.post('/api/auth/verify', { secret: val });
      sessionStorage.setItem('rm_unlocked', '1');
      store.set({ locked: false });
    } catch (e) { setErr(e.message); setVal(''); }
  };
  return html`<div class="lock-screen"><form class="lock-card" onSubmit=${(e) => { e.preventDefault(); unlock(); }}>
    <div class="avatar" style="width:56px;height:56px;margin:0 auto 10px;font-size:20px;background:var(--graphite)">${initials(u && u.full_name)}</div>
    <h3>${u && u.full_name}</h3><p class="small muted">${t('lock.text')}</p>
    <input class="input lg" type="password" autoFocus value=${val} onInput=${(e) => { setVal(e.target.value); setErr(''); }} style="text-align:center;letter-spacing:6px" aria-label=${t('lock.secret')} />
    ${err && html`<div class="small neg mt-8">${err}</div>`}
    <${Btn} type="submit" kind="primary" cls="mt-12" style="width:100%">${t('lock.unlock')}</${Btn}>
    <button type="button" class="link-btn mt-12 small" onClick=${() => logout()}>${t('lock.switch_user')}</button>
  </form></div>`;
}

export { loadBoot };
