// Users and roles: who can sign in, with which permissions; discount limits and commission rates per person.
import { html, useState } from '../core/h.js';
import { t, LANGS } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { refreshBoot } from '../core/session.js';
import { dateTime, pct as fpct } from '../core/format.js';
import { Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Check, Table, Panel, Empty, Loading, Notice, Pill, Tabs, useAsync, openModal, toast, errToast, confirmDialog } from '../core/ui.js';
import { WarehouseSelect } from './pickers.js';
import { dn } from '../core/names.js';

export function Users() {
  useTitle(t('nav.users'));
  const [tab, setTab] = useState('users');
  const users = useAsync(() => api.get('/api/users'), []);
  const roles = useAsync(() => api.get('/api/roles'), []);
  const me = useStore((s) => s.user);
  const editUser = (u) => openModal(UserDialog, { user: u, roles: roles.data || [] }).then((r) => { if (r) { users.reload(); roles.reload(); refreshBoot(); } });
  const editRole = (r) => openModal(RoleDialog, { role: r }).then((x) => { if (x) roles.reload(); });
  return html`<div class="page">
    <div class="toolbar">
      <${Tabs} value=${tab} onValue=${setTab} tabs=${[{ id: 'users', label: t('user.users'), icon: 'users' }, { id: 'roles', label: t('user.roles'), icon: 'shield' }]} />
      <div class="toolbar-end">
      ${tab === 'users' ? html`<${Btn} kind="primary" icon="user-plus" onClick=${() => editUser(null)}>${t('user.new')}</${Btn}>` : html`<${Btn} kind="primary" icon="plus" onClick=${() => editRole(null)}>${t('user.new_role')}</${Btn}>`}
      </div>
    </div>
    ${tab === 'users' && html`<div class="panel">${users.loading && !users.data ? html`<${Loading} />` : html`<${Table} rows=${users.data || []} onRow=${editUser} rowCls=${(u) => (u.active ? '' : 'cancelled')}
      columns=${[
        { key: 'name', label: t('user.full_name'), render: (u) => html`<div class="row gap-8"><div class="avatar" style="background:var(--graphite)">${(u.full_name || '?').slice(0, 2).toUpperCase()}</div><div><div class="cell-name">${u.full_name}${me && me.id === u.id ? html` <${Pill} kind="info">${t('user.you')}</${Pill}>` : null}</div><div class="sub">${u.username || ''}</div></div></div>` },
        { key: 'role', label: t('user.role'), render: (u) => dn(u.role_name) || '—' },
        { key: 'login', label: t('user.login'), render: (u) => (!u.can_login ? html`<${Pill}>${t('user.no_login')}</${Pill}>` : html`<div class="row gap-4">${u.has_password && html`<${Pill}>${t('user.has_password')}</${Pill}>`}${u.has_pin && html`<${Pill}>PIN</${Pill}>`}${!u.has_password && !u.has_pin && html`<${Pill} kind="warn">${t('user.no_secret')}</${Pill}>`}</div>`) },
        { key: 'disc', label: t('user.max_discount'), align: 'r', render: (u) => (u.permissions.includes('*') || u.permissions.includes('sales.discount') ? html`<span class="muted small">${t('user.unlimited')}</span>` : u.max_discount_pct != null ? fpct(u.max_discount_pct) : html`<span class="muted small">${t('common.default')}</span>`) },
        { key: 'comm', label: t('user.commission'), align: 'r', render: (u) => (u.commission_sales_pct || u.commission_labor_pct ? html`<span class="small">${fpct(u.commission_sales_pct || 0)} / ${fpct(u.commission_labor_pct || 0)}</span>` : '') },
        { key: 'last', label: t('user.last_login'), render: (u) => html`<span class="small muted">${u.last_login_at ? dateTime(u.last_login_at) : '—'}</span>` },
        { key: 'state', label: '', render: (u) => (!u.active ? html`<${Pill} kind="out">${t('common.inactive')}</${Pill}>` : u.locked_until ? html`<${Pill} kind="warn">${t('user.locked')}</${Pill}>` : '') },
      ]} />`}</div>`}
    ${tab === 'roles' && html`<div class="panel">${roles.loading && !roles.data ? html`<${Loading} />` : html`<${Table} rows=${roles.data || []} onRow=${editRole}
      columns=${[
        { key: 'name', label: t('user.role'), render: (r) => html`<span class="cell-name">${dn(r.name)}</span>${r.builtin ? html` <${Pill}>${t('user.builtin')}</${Pill}>` : null}` },
        { key: 'perms', label: t('user.permissions'), render: (r) => html`<span class="small muted">${r.permissions.includes('*') ? t('user.all_permissions') : t('user.perm_count', { n: r.permissions.length })}</span>` },
        { key: 'users', label: t('user.users'), align: 'r', render: (r) => r.user_count },
      ]} />`}</div>`}
  </div>`;
}

function UserDialog({ user, roles, close }) {
  const u = user || { active: true, can_login: true };
  const [f, setF] = useState({
    full_name: u.full_name || '', username: u.username || '', role_id: u.role_id || (roles.find((r) => r.code === 'sales') || roles[0] || {}).id || '', phone: u.phone || '',
    can_login: u.can_login !== false, active: u.active !== false, max_discount_pct: u.max_discount_pct ?? null, commission_sales_pct: u.commission_sales_pct || 0,
    commission_labor_pct: u.commission_labor_pct || 0, default_warehouse_id: u.default_warehouse_id || '', lang: u.lang || '', notes: u.notes || '', password: '', pin: '', clear_pin: false,
  });
  const set = (p) => setF({ ...f, ...p });
  const save = async () => {
    if (f.pin && !/^\d{4,8}$/.test(f.pin)) { toast(t('err.bad_pin'), 'err'); return; }
    try {
      await api.post('/api/users', { ...f, id: u.id, password: f.password || undefined, pin: f.pin || undefined, max_discount_pct: f.max_discount_pct === null ? '' : f.max_discount_pct, default_warehouse_id: f.default_warehouse_id || null, lang: f.lang || null });
      toast(t('common.saved'));
      close(true);
    } catch (e) { errToast(e); }
  };
  const unlock = async () => {
    try { await api.post(`/api/users/${u.id}/unlock`); toast(t('user.unlocked')); close(true); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${u.id ? t('user.edit') : t('user.new')} icon="user" close=${close} size="wide" onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!f.full_name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      ${u.locked_until && html`<${Notice} kind="warn"><div class="row between gap-12 wrap"><span>${t('user.locked_until', { time: dateTime(u.locked_until) })}</span><${Btn} size="sm" icon="unlock" onClick=${unlock}>${t('user.unlock')}</${Btn}></div></${Notice}>`}
      <div class="form-2">
        <${Field} label=${t('user.full_name')} required><${Input} value=${f.full_name} onValue=${(v) => set({ full_name: v })} autoFocus /></${Field}>
        <${Field} label=${t('user.role')}><${Select} value=${f.role_id} onValue=${(v) => set({ role_id: v })} options=${roles.map((r) => ({ value: r.id, label: dn(r.name) }))} /></${Field}>
        <${Field} label=${t('login.username')} hint=${t('user.username_hint')}><${Input} value=${f.username} onValue=${(v) => set({ username: v.toLowerCase().replace(/\s/g, '') })} autocomplete="off" /></${Field}>
        <${Field} label=${t('common.phone')}><${Input} value=${f.phone} onValue=${(v) => set({ phone: v })} /></${Field}>
        <${Field} label=${u.has_password ? t('user.new_password') : t('login.password')} hint=${u.has_password ? t('user.keep_empty') : null}><${Input} type="password" value=${f.password} onValue=${(v) => set({ password: v })} autocomplete="new-password" /></${Field}>
        <${Field} label=${u.has_pin ? t('user.new_pin') : 'PIN'} hint=${t('user.pin_hint')}><${Input} type="password" inputmode="numeric" maxlength="8" value=${f.pin} onValue=${(v) => set({ pin: v.replace(/\D/g, '') })} autocomplete="new-password" /></${Field}>
      </div>
      ${u.has_pin && html`<${Check} checked=${f.clear_pin} onValue=${(v) => set({ clear_pin: v })} label=${t('user.clear_pin')} />`}
      <div class="form-3">
        <${Field} label=${t('user.max_discount')} hint=${t('user.max_discount_hint')}><${NumInput} value=${f.max_discount_pct} onValue=${(v) => set({ max_discount_pct: v })} dec=${2} placeholder=${t('common.default')} /></${Field}>
        <${Field} label=${t('user.commission_sales')} hint=${t('user.commission_sales_hint')}><${NumInput} value=${f.commission_sales_pct} onValue=${(v) => set({ commission_sales_pct: v || 0 })} dec=${2} /></${Field}>
        <${Field} label=${t('user.commission_labor')} hint=${t('user.commission_labor_hint')}><${NumInput} value=${f.commission_labor_pct} onValue=${(v) => set({ commission_labor_pct: v || 0 })} dec=${2} /></${Field}>
        ${(boot().warehouses || []).length > 1 && html`<${Field} label=${t('user.default_warehouse')}><${WarehouseSelect} value=${f.default_warehouse_id} onValue=${(v) => set({ default_warehouse_id: v })} placeholder=${t('common.default')} /></${Field}>`}
        <${Field} label=${t('common.language')}><${Select} value=${f.lang} onValue=${(v) => set({ lang: v })} placeholder=${t('common.default')} options=${LANGS.map((l) => ({ value: l.code, label: l.name }))} /></${Field}>
      </div>
      <${Field} label=${t('doc.notes')}><${Input} value=${f.notes} onValue=${(v) => set({ notes: v })} /></${Field}>
      <div class="row gap-16"><${Check} checked=${f.can_login} onValue=${(v) => set({ can_login: v })} label=${t('user.can_login')} /><${Check} checked=${f.active} onValue=${(v) => set({ active: v })} label=${t('common.active')} /></div>
      <p class="small muted">${t('user.staff_note')}</p>
    </div>
  </${Modal}>`;
}

function RoleDialog({ role, close }) {
  const r = role || { permissions: [] };
  const catalog = boot().permissions_catalog || {};
  const isAdmin = r.code === 'admin';
  const [name, setName] = useState(dn(r.name) || '');
  const [perms, setPerms] = useState(new Set(r.permissions));
  const toggle = (p) => { const n = new Set(perms); if (n.has(p)) n.delete(p); else n.add(p); setPerms(n); };
  const toggleGroup = (list) => { const n = new Set(perms); const all = list.every((p) => n.has(p)); list.forEach((p) => (all ? n.delete(p) : n.add(p))); setPerms(n); };
  const save = async () => {
    try { await api.post('/api/roles', { id: r.id, name, permissions: [...perms] }); toast(t('common.saved')); close(true); } catch (e) { errToast(e); }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('user.delete_role'), text: r.name, danger: true, okText: t('common.delete') }))) return;
    try { await api.del(`/api/roles/${r.id}`); close(true); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${r.id ? dn(r.name) : t('user.new_role')} icon="shield" close=${close} size="xwide" onSubmit=${save}
    left=${r.id && !r.builtin && html`<${Btn} kind="ghost" icon="trash-2" onClick=${del}>${t('common.delete')}</${Btn}>`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Field} label=${t('user.role_name')}><${Input} value=${name} onValue=${setName} autoFocus /></${Field}>
      ${isAdmin ? html`<${Notice}>${t('user.admin_all')}</${Notice}>` : html`<div class="perm-grid">${Object.entries(catalog).map(([g, list]) => html`<div class="perm-group">
        <h4 class="row between"><span>${t(`perm.group.${g}`)}</span><button type="button" class="link-btn tiny" onClick=${() => toggleGroup(list)}>${list.every((p) => perms.has(p)) ? t('user.none') : t('user.all')}</button></h4>
        ${list.map((p) => html`<${Check} checked=${perms.has(p)} onValue=${() => toggle(p)} label=${t(`perm.${p}`)} />`)}
      </div>`)}</div>`}
    </div>
  </${Modal}>`;
}
