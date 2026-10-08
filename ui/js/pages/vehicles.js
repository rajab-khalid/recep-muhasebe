// Vehicles: plate registry with owner, make/model/year, and the full history of what was sold / fitted / repaired.
import { html, useState, useEffect } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { refreshBoot } from '../core/session.js';
import { money, num, qty as fqty, date as fdate, today } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Textarea, Table, Panel, Empty, Loading, Notice, Pill, Money, KV,
  SearchBox, MenuButton, useAsync, useDebounced, openModal, toast, errToast, confirmDialog,
} from '../core/ui.js';
import { PartnerPicker } from './pickers.js';
import { StatusPill } from './dashboard.js';

export function VehicleDialog({ vehicle, initial, close }) {
  const v0 = vehicle || initial || {};
  const makes = boot().vehicle_makes || [];
  const [f, setF] = useState({
    plate: v0.plate || '', make_id: v0.make_id || '', model_id: v0.model_id || '', make_text: v0.make_text || '', model_text: v0.model_text || '',
    year: v0.year || null, engine: v0.engine || '', color: v0.color || '', vin: v0.vin || '', km: v0.km || null, notes: v0.notes || '',
  });
  const [owner, setOwner] = useState(v0.partner_id ? { id: v0.partner_id, name: v0.partner_name } : null);
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (f.make_id) api.get('/api/vehicle-models', { make_id: f.make_id }).then(setModels).catch(() => setModels([])); else setModels([]); }, [f.make_id]);
  const set = (p) => setF({ ...f, ...p });
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/vehicles', { ...f, id: vehicle ? vehicle.id : undefined, partner_id: owner ? owner.id : null, plate: f.plate.toUpperCase().trim() });
      if (f.make_text && !f.make_id) refreshBoot();
      toast(t('common.saved'));
      close(r);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${vehicle ? t('vehicle.edit') : t('vehicle.new')} icon="car" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="form-2">
        <${Field} label=${t('vehicle.plate')}><${Input} value=${f.plate} onValue=${(v) => set({ plate: v })} autoFocus cls="lg" style="text-transform:uppercase;font-weight:600" /></${Field}>
        <${Field} label=${t('vehicle.owner')}><${PartnerPicker} value=${owner} onChange=${setOwner} kind="customer" showBalance=${false} /></${Field}>
      </div>
      <div class="form-3">
        <${Field} label=${t('vehicle.make')}>${makes.length ? html`<${Select} value=${f.make_id} onValue=${(v) => set({ make_id: v, model_id: '', make_text: '' })} placeholder=${t('vehicle.other_make')} options=${makes.map((m) => ({ value: m.id, label: m.name }))} />` : null}
          ${!f.make_id && html`<${Input} value=${f.make_text} onValue=${(v) => set({ make_text: v })} placeholder=${t('vehicle.make_type')} cls="mt-8" />`}</${Field}>
        <${Field} label=${t('vehicle.model')}>${models.length ? html`<${Select} value=${f.model_id} onValue=${(v) => set({ model_id: v, model_text: '' })} placeholder=${t('vehicle.other_model')} options=${models.map((m) => ({ value: m.id, label: m.name }))} />` : null}
          ${!f.model_id && html`<${Input} value=${f.model_text} onValue=${(v) => set({ model_text: v })} placeholder=${t('vehicle.model_type')} cls=${models.length ? 'mt-8' : ''} />`}</${Field}>
        <${Field} label=${t('vehicle.year')}><${NumInput} value=${f.year} onValue=${(v) => set({ year: v })} dec=${0} /></${Field}>
        <${Field} label=${t('vehicle.engine')}><${Input} value=${f.engine} onValue=${(v) => set({ engine: v })} placeholder="1.6 / 2.5 Hybrid" /></${Field}>
        <${Field} label=${t('vehicle.color')}><${Input} value=${f.color} onValue=${(v) => set({ color: v })} /></${Field}>
        <${Field} label=${t('vehicle.km')}><${NumInput} value=${f.km} onValue=${(v) => set({ km: v })} dec=${0} /></${Field}>
      </div>
      <${Field} label=${t('vehicle.vin')}><${Input} value=${f.vin} onValue=${(v) => set({ vin: v.toUpperCase() })} /></${Field}>
      <${Field} label=${t('doc.notes')}><${Textarea} value=${f.notes} onValue=${(v) => set({ notes: v })} rows=${2} /></${Field}>
    </div>
  </${Modal}>`;
}

export function Vehicles({ query = {} }) {
  useTitle(t('nav.vehicles'));
  const [q, setQ] = useState(query.q || '');
  const dq = useDebounced(q, 250);
  const { data, loading, reload } = useAsync(() => api.get('/api/vehicles', { q: dq, limit: 500 }), [dq]);
  const add = () => openModal(VehicleDialog, { initial: { plate: /^[\w\s-]+$/.test(q) ? q.toUpperCase() : '' } }).then((v) => v && navigate(`/vehicle/${v.id}`));
  return html`<div class="page">
    <div class="toolbar">
      <${SearchBox} value=${q} onValue=${setQ} cls="search" placeholder=${t('vehicle.search_ph')} autoFocus />
      <div class="toolbar-end">
      ${can('vehicles.manage') && html`<${Btn} kind="primary" icon="plus" onClick=${add}>${t('vehicle.new')}</${Btn}>`}
      </div>
    </div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} onRow=${(v) => navigate(`/vehicle/${v.id}`)}
      empty=${html`<${Empty} icon="car" title=${q ? t('common.no_results') : t('vehicle.none')} text=${t('vehicle.none_hint')} />`}
      columns=${[
        { key: 'plate', label: t('vehicle.plate'), render: (v) => html`<span class="plate">${v.plate || '—'}</span>` },
        { key: 'desc', label: t('vehicle.model'), render: (v) => html`<span dir="auto">${v.description || '—'}</span>${v.color ? html`<div class="sub">${v.color}</div>` : null}` },
        { key: 'owner', label: t('vehicle.owner'), render: (v) => html`<span dir="auto">${v.partner_name || ''}</span>${v.partner_phone ? html`<div class="sub ltr">${v.partner_phone}</div>` : null}` },
        { key: 'km', label: t('vehicle.km'), align: 'r', render: (v) => (v.km ? html`<span class="num">${num(v.km)}</span>` : '') },
        { key: 'last', label: t('vehicle.last_visit'), render: (v) => html`<span class="small muted">${v.last_visit ? fdate(v.last_visit) : ''}</span>` },
      ]} />`}</div>
  </div>`;
}

export function VehiclePage({ id }) {
  const { data: v, loading, error, reload } = useAsync(() => api.get(`/api/vehicles/${id}`), [id]);
  useTitle(v ? (v.plate || v.description) : t('common.loading'), [{ label: t('nav.vehicles'), href: '#/vehicles' }]);
  if (loading && !v) return html`<${Loading} />`;
  if (error) return html`<div class="page"><${Notice} kind="err">${error.message}</${Notice}></div>`;
  const edit = () => openModal(VehicleDialog, { vehicle: v }).then((r) => r && reload());
  const docs = v.history || [];
  const totalSpent = docs.filter((d) => d.type === 'sale' && d.status === 'posted').reduce((m, d) => { m[d.currency] = (m[d.currency] || 0) + d.total; return m; }, {});
  const warranties = docs.flatMap((d) => (d.type === 'sale' && d.status === 'posted' ? d.lines.filter((l) => l.warranty_active).map((l) => ({ ...l, doc: d })) : []));
  return html`<div class="page stack">
    <div class="split wide-side">
      <div class="panel"><div class="panel-body row top gap-16 wrap">
        <div class="plate big">${v.plate || '—'}</div>
        <div class="grow" style="min-width:220px">
          <div style="font-size:17px;font-weight:600" dir="auto">${v.description || t('vehicle.unknown_model')}</div>
          <div class="row wrap gap-16 mt-8 small muted">
            ${v.color && html`<span>${t('vehicle.color')}: ${v.color}</span>`}
            ${v.km ? html`<span>${t('vehicle.km')}: <b class="num" style="color:var(--ink)">${num(v.km)}</b></span>` : null}
            ${v.vin && html`<span class="ltr">VIN: ${v.vin}</span>`}
          </div>
          ${v.partner_id ? html`<div class="mt-8"><${Icon} name="user" size="sm" /> <a href=${`#/partner/${v.partner_id}`} dir="auto">${v.partner_name}</a> ${v.partner_phone ? html`<span class="small muted ltr">${v.partner_phone}</span>` : null}</div>` : html`<div class="small muted mt-8">${t('vehicle.no_owner')}</div>`}
          ${v.notes && html`<div class="notice mt-12" style="white-space:pre-line" dir="auto"><${Icon} name="notebook-pen" size="sm" /><div>${v.notes}</div></div>`}
        </div>
        <div class="row gap-8 wrap" style="align-self:flex-start">
          ${can('service.manage') && html`<${Btn} kind="primary" icon="wrench" onClick=${() => navigate('/docs/service/new', { vehicle: v.id })}>${t('doc.new.service')}</${Btn}>`}
          ${can(['sales.create', 'pos.use']) && html`<${Btn} icon="receipt" onClick=${() => navigate('/docs/sale/new', { vehicle: v.id })}>${t('doc.new.sale')}</${Btn}>`}
          ${can('quotes.manage') && html`<${Btn} icon="clipboard-list" onClick=${() => navigate('/docs/quote/new', { vehicle: v.id })}>${t('doc.new.quote')}</${Btn}>`}
          ${can('vehicles.manage') && html`<${IconBtn} icon="pencil" title=${t('common.edit')} onClick=${edit} />`}
        </div>
      </div></div>
      <div class="panel stat">
        <div class="k">${t('vehicle.visits')}</div><div class="v">${num(docs.filter((d) => d.status !== 'cancelled').length)}</div>
        <div class="s">${Object.entries(totalSpent).map(([c, a]) => money(a, c)).join(' + ') || '—'}</div>
        ${warranties.length > 0 && html`<div class="mt-12"><${Pill} kind="in" dot>${t('vehicle.active_warranties', { n: warranties.length })}</${Pill}></div>`}
      </div>
    </div>

    ${warranties.length > 0 && html`<${Panel} title=${t('vehicle.warranties')} icon="clipboard-check" body=${false}><div class="mini-list">
      ${warranties.map((w) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${w.doc.id}`)}><${Icon} name="circle-check" cls="pos" /><div class="grow" dir="auto">${w.description}</div>
        <span class="small muted">${w.doc.no} · ${t('print.warranty_until')}: <b>${fdate(w.warranty_until)}</b></span></div>`)}
    </div></${Panel}>`}

    <${Panel} title=${t('vehicle.history')} icon="history" body=${false}>
      ${!docs.length ? html`<${Empty} icon="history" title=${t('vehicle.no_history')} /> ` : html`<div class="vh-list">
        ${docs.map((d) => html`<div class=${`vh-item ${d.status === 'cancelled' ? 'cancelled' : ''}`}>
          <div class="vh-date"><div class="strong">${fdate(d.date)}</div>${d.km ? html`<div class="tiny muted num">${num(d.km)} km</div>` : null}</div>
          <div class="grow" style="min-width:0">
            <div class="row gap-8 wrap"><a class="strong" href=${`#/doc/${d.id}`}>${d.no}</a><${Pill}>${t(`doc.type.${d.type}`)}</${Pill}>
              ${['service', 'quote'].includes(d.type) ? html`<${StatusPill} type=${d.type} status=${d.status} />` : d.status === 'cancelled' ? html`<${Pill} kind="out">${t('doc.status.cancelled')}</${Pill}>` : null}
              <span class="small muted">${[d.technician_name, d.staff_name].filter(Boolean).join(' · ')}</span></div>
            ${d.complaint && html`<div class="small mt-8" dir="auto"><span class="muted">${t('doc.complaint')}:</span> ${d.complaint}</div>`}
            ${d.work_done && html`<div class="small" dir="auto"><span class="muted">${t('doc.work_done')}:</span> ${d.work_done}</div>`}
            <ul class="vh-lines">${d.lines.filter((l) => l.kind !== 'text').map((l) => html`<li><span dir="auto">${l.description}</span> <span class="muted num">× ${fqty(l.qty)}</span>
              ${l.warranty_until ? html` <span class=${`tiny ${l.warranty_active ? 'pos' : 'muted'}`}>(${t('print.warranty_until')} ${fdate(l.warranty_until)})</span>` : null}</li>`)}</ul>
          </div>
          <div class="num strong">${money(d.total, d.currency)}</div>
        </div>`)}
      </div>`}
    </${Panel}>
  </div>`;
}
