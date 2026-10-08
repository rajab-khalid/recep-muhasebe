// Audit log: who did what and when; changed values side by side.
import { html, useState } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { boot } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { dateTime, money, rateText } from '../core/format.js';
import { Btn, Drawer, Select, Table, Loading, Empty, Notice, Pill, DateRange, periodRange, SearchBox, useAsync, useDebounced, openModal } from '../core/ui.js';

const ENTITIES = ['doc', 'payment', 'partner', 'product', 'money_account', 'transfer', 'finance_entry', 'stock_count', 'user', 'role', 'settings', 'currency', 'system', 'partner_move', 'money_move', 'vehicle', 'recurring', 'warehouse', 'price_list', 'category', 'brand', 'legacy'];
// Entries copied from the old program are stored as "v2:created", "v2:updated" ...
const LEGACY = { created: 'create', updated: 'update', deleted: 'delete', payment: 'payment', restored: 'restore' };
const actionKey = (a) => (a && a.startsWith('v2:') ? LEGACY[a.slice(3)] || 'update' : a);
const actionLabel = (a) => t(`audit.action.${actionKey(a)}`);

/** who did it: a person, or the program itself (setup, data import, automatic backup, old program) */
export function actorName(name) {
  if (!name) return '';
  if (name === 'v2') return t('audit.entity.legacy');
  if (['setup', 'import', 'backup', 'system'].includes(name)) return t(`audit.actor.${name}`);
  return name;
}

/** the entry's message in the reader's language; older entries fall back to their stored text */
export function auditText(r) {
  let m = null;
  try { m = r.msg ? JSON.parse(r.msg) : null; } catch (e) { m = null; }
  if (!m || !m.k) return r.summary || '';
  const v = m.v || {};
  const amt = (a, c) => (a === null || a === undefined || a === '' ? '' : money(a, c));
  const parts = (...xs) => xs.filter((x) => x !== null && x !== undefined && x !== '').join(' · ');
  switch (m.k) {
    case 'doc': return parts(v.type ? t(`doc.type.${v.type}`) : '', v.no, ['transfer', 'adjust'].includes(v.type) ? '' : amt(v.total, v.currency), v.reason);
    case 'status': return `${v.no}: ${t(`doc.status.${v.from}`)} → ${t(`doc.status.${v.to}`)}`;
    case 'payment': return parts(v.no, t(v.direction === 'out' ? 'pay.dir.out' : 'pay.dir.in'), amt(v.amount, v.currency), v.partner);
    case 'no_reason': return parts(v.no, v.reason);
    case 'no_amount': return parts(v.no, amt(v.amount, v.currency));
    case 'amount': return parts(v.account, amt(v.amount, v.currency), v.desc);
    case 'transfer': return parts(v.no, `${amt(v.from_amount, v.from_currency)} → ${amt(v.to_amount, v.to_currency)}`);
    case 'cash_count': return parts(v.account, `${t('cash.system_balance')}: ${amt(v.system, v.currency)}`, `${t('cash.counted')}: ${amt(v.counted, v.currency)}`, `${t('cash.difference')}: ${money(v.diff, v.currency, { sign: true })}`);
    case 'products_n': return t('product.count_n', { n: v.n });
    case 'count_post': return parts(v.no, `${t('stock.differences')}: ${v.n}`);
    case 'import': return t('audit.msg.import', v);
    case 'setup': return t('audit.msg.setup');
    case 'rate': return v.code === 'IQD' ? rateText(v.rate) : `1 USD = ${v.rate} ${v.code}`;
    case 'restore': return v.name || t('audit.msg.uploaded_file');
    case 'login_failed': return v.wait ? (v.wait < 90 ? t('audit.msg.paused_sec', { n: v.wait }) : t('audit.msg.paused_min', { n: Math.round(v.wait / 60) })) : t('audit.msg.login_failed');
    case 'user_unlocked': return t('audit.msg.user_unlocked', v);
    case 'secret_reset': return t('audit.msg.secret_reset', v);
    default: return r.summary || '';
  }
}
const LINKS = { doc: (id) => `/doc/${id}`, partner: (id) => `/partner/${id}`, product: (id) => `/products/${id}`, money_account: (id) => `/cash/${id}`, vehicle: (id) => `/vehicle/${id}`, stock_count: (id) => `/stock/count/${id}` };

export function Audit({ query = {} }) {
  useTitle(t('nav.audit'));
  const r0 = periodRange('week');
  const [f, setF] = useState({ from: r0.from, to: r0.to, user_id: '', entity: query.entity || '', action: '', q: '' });
  const dq = useDebounced(f.q, 300);
  const { data, loading, error } = useAsync(() => api.get('/api/reports/audit', { ...f, q: dq, entity_id: query.entity_id, limit: 2000 }), [f.from, f.to, f.user_id, f.entity, f.action, dq]);
  const rows = data || [];
  const actionKind = (a0) => { const a = actionKey(a0); return (['cancel', 'delete', 'delete_draft', 'login_failed', 'deactivate', 'restore'].includes(a) ? 'out' : ['create', 'post', 'login'].includes(a) ? 'in' : ['update', 'price_change', 'balance_adjust', 'settings', 'rate'].includes(a) ? 'warn' : ''); };
  return html`<div class="page">
    <div class="toolbar">
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      <div style="width:170px"><${Select} value=${f.user_id} onValue=${(v) => setF({ ...f, user_id: v })} placeholder=${t('audit.all_users')} options=${(boot().staff || []).map((s) => ({ value: s.id, label: s.full_name }))} /></div>
      <div style="width:170px"><${Select} value=${f.entity} onValue=${(v) => setF({ ...f, entity: v })} placeholder=${t('audit.all_records')} options=${ENTITIES.map((e) => ({ value: e, label: t(`audit.entity.${e}`) }))} /></div>
    </div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table} rows=${rows} compact
      onRow=${(r) => openModal(AuditDrawer, { id: r.id })}
      empty=${html`<${Empty} icon="history" title=${t('audit.none')} />`}
      columns=${[
        { key: 'ts', label: t('audit.time'), render: (r) => html`<span class="nowrap small">${dateTime(r.ts)}</span>` },
        { key: 'user', label: t('common.user'), render: (r) => actorName(r.user_name) || html`<span class="muted">—</span>` },
        { key: 'action', label: t('audit.action'), render: (r) => html`<${Pill} kind=${actionKind(r.action)}>${actionLabel(r.action)}</${Pill}>` },
        { key: 'entity', label: t('audit.record'), render: (r) => (r.entity ? t(`audit.entity.${r.entity}`) : '') },
        { key: 'summary', label: t('audit.summary'), render: (r) => html`<span class="small" dir="auto">${auditText(r)}</span>` },
        { key: 'ip', label: 'IP', render: (r) => html`<span class="tiny muted ltr">${r.ip || ''}</span>` },
      ]} />`}</div>
    ${rows.length >= 2000 && html`<p class="small muted mt-8">${t('audit.limited')}</p>`}
  </div>`;
}

function AuditDrawer({ id, close }) {
  const { data: a, loading } = useAsync(() => api.get(`/api/audit/${id}`), [id]);
  const link = a && a.entity_id && LINKS[a.entity] ? LINKS[a.entity](a.entity_id) : null;
  return html`<${Drawer} title=${t('audit.detail')} close=${close} narrow>
    ${loading || !a ? html`<${Loading} />` : html`<div class="col gap-12">
      <div><div class="small muted">${dateTime(a.ts)} · ${actorName(a.user_name) || '—'} · <span class="ltr">${a.ip || ''}</span></div>
        <div class="strong mt-8">${actionLabel(a.action)} — ${a.entity ? t(`audit.entity.${a.entity}`) : ''}</div>
        <div class="mt-8" dir="auto">${auditText(a)}</div></div>
      ${link && html`<${Btn} size="sm" icon="external-link" onClick=${() => { close(); navigate(link); }}>${t('common.open')}</${Btn}>`}
      ${a.data && html`<${DataView} data=${a.data} />`}
    </div>`}
  </${Drawer}>`;
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function DataView({ data }) {
  // {before: {...}, after: {...}} or {field: [old, new]} or anything else
  if (data && typeof data === 'object' && data.before && data.after && typeof data.before === 'object') {
    const keys = [...new Set([...Object.keys(data.before), ...Object.keys(data.after)])].filter((k) => fmt(data.before[k]) !== fmt(data.after[k]));
    return html`<table class="tbl compact"><thead><tr><th>${t('audit.field')}</th><th>${t('audit.old')}</th><th>${t('audit.new')}</th></tr></thead>
      <tbody>${keys.map((k) => html`<tr><td class="small">${k}</td><td class="small neg" dir="auto">${fmt(data.before[k])}</td><td class="small pos" dir="auto">${fmt(data.after[k])}</td></tr>`)}</tbody></table>`;
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && Object.values(data).every((v) => Array.isArray(v) && v.length === 2)) {
    return html`<table class="tbl compact"><thead><tr><th>${t('audit.field')}</th><th>${t('audit.old')}</th><th>${t('audit.new')}</th></tr></thead>
      <tbody>${Object.entries(data).map(([k, [o, n]]) => html`<tr><td class="small">${k}</td><td class="small neg" dir="auto">${fmt(o)}</td><td class="small pos" dir="auto">${fmt(n)}</td></tr>`)}</tbody></table>`;
  }
  return html`<pre class="small" style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px;max-height:60vh;overflow:auto" dir="ltr">${JSON.stringify(data, null, 2)}</pre>`;
}
