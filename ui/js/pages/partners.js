// Customers & suppliers (cari hesaplar): balances per currency, statement (ekstre), open invoices,
// payments, vehicles, balance corrections and currency conversion of a balance.
import { html, useState, useEffect, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { money, num, convert, today, addMonths, date as fdate, dateTime, round, decimals, usdIqd, display, rateText } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Textarea, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Balances, KV, Tabs,
  DateRange, periodRange, SearchBox, MenuButton, useAsync, useDebounced, openModal, toast, errToast, confirmDialog, promptDialog, DateInput } from '../core/ui.js';
import { downloadXlsx } from '../core/xlsx.js';
import { printTables } from '../core/print.js';
import { printStatement, whatsapp, reminderText } from '../core/docprint.js';
import { stmtCells } from '../core/invoice.js';
import { PaymentDialog, PaymentDrawer } from './payments.js';
import { DocTable } from './docs.js';
import { VehicleDialog } from './vehicles.js';
import { PriceListSelect, CurrencySelect, KindPill } from './pickers.js';
import { dn } from '../core/names.js';

/* ================================================================== dialog */
export function PartnerDialog({ partner, initial, close }) {
  const p0 = partner || { kind: 'customer', active: 1, ...(initial || {}) };
  const [f, setF] = useState({
    name: p0.name || '', kind: p0.kind || 'customer', company: p0.company || '', phone: p0.phone || '', phone2: p0.phone2 || '', email: p0.email || '',
    city: p0.city || '', address: p0.address || '', tax_no: p0.tax_no || '', price_list_id: p0.price_list_id || '', credit_limit: p0.credit_limit ?? null,
    credit_currency: p0.credit_currency || (boot().settings.general || {}).default_currency || 'IQD', payment_days: p0.payment_days ?? null, notes: p0.notes || '',
    active: p0.active === undefined ? true : !!p0.active,
  });
  const [opening, setOpening] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setF({ ...f, ...patch });
  const save = async () => {
    if (!f.name.trim()) { toast(t('partner.name_required'), 'err'); return; }
    setBusy(true);
    try {
      const body = { ...f, id: p0.id, price_list_id: f.price_list_id || null };
      if (!p0.id) body.opening = opening.filter((o) => o.amount).map((o) => ({ currency: o.currency, amount: o.dir === 'we' ? -Math.abs(o.amount) : Math.abs(o.amount), date: o.date || today() }));
      const r = await api.post('/api/partners', body);
      toast(t('common.saved'));
      close(r);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${p0.id ? t('partner.edit') : t('partner.new')} icon="users" close=${close} size="wide" onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy || !f.name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      ${!p0.is_walkin && html`<${Segmented} value=${f.kind} onValue=${(v) => set({ kind: v })} options=${['customer', 'supplier', 'both'].map((k) => ({ value: k, label: t(`partner.kind.${k}`) }))} />`}
      <div class="form-2">
        <${Field} label=${t('common.name')} required><${Input} value=${f.name} onValue=${(v) => set({ name: v })} autoFocus dir="auto" /></${Field}>
        <${Field} label=${t('partner.company')}><${Input} value=${f.company} onValue=${(v) => set({ company: v })} dir="auto" /></${Field}>
        <${Field} label=${t('common.phone')} hint=${t('partner.phone_hint')}><${Input} value=${f.phone} onValue=${(v) => set({ phone: v })} type="tel" /></${Field}>
        <${Field} label=${t('partner.phone2')}><${Input} value=${f.phone2} onValue=${(v) => set({ phone2: v })} type="tel" /></${Field}>
        <${Field} label=${t('partner.city')}><${Input} value=${f.city} onValue=${(v) => set({ city: v })} /></${Field}>
        <${Field} label=${t('partner.email')}><${Input} value=${f.email} onValue=${(v) => set({ email: v })} type="email" /></${Field}>
      </div>
      <${Field} label=${t('partner.address')}><${Input} value=${f.address} onValue=${(v) => set({ address: v })} dir="auto" /></${Field}>
      <div class="form-3">
        <${Field} label=${t('partner.tax_no')}><${Input} value=${f.tax_no} onValue=${(v) => set({ tax_no: v })} /></${Field}>
        ${f.kind !== 'supplier' && html`<${Field} label=${t('doc.price_list')} hint=${t('partner.price_list_hint')}><${PriceListSelect} value=${f.price_list_id} onValue=${(v) => set({ price_list_id: v })} placeholder=${t('common.default')} /></${Field}>`}
        <${Field} label=${t('partner.payment_days')} hint=${t('partner.payment_days_hint')}><${NumInput} value=${f.payment_days} onValue=${(v) => set({ payment_days: v })} dec=${0} /></${Field}>
      </div>
      ${f.kind !== 'supplier' && html`<div class="form-3">
        <${Field} label=${t('partner.credit_limit')} hint=${t('partner.credit_limit_hint')}><${NumInput} value=${f.credit_limit} onValue=${(v) => set({ credit_limit: v })} dec=${decimals(f.credit_currency)} /></${Field}>
        <${Field} label=${t('common.currency')}><${CurrencySelect} value=${f.credit_currency} onValue=${(v) => set({ credit_currency: v })} /></${Field}>
      </div>`}
      <${Field} label=${t('doc.notes')}><${Textarea} value=${f.notes} onValue=${(v) => set({ notes: v })} rows=${2} /></${Field}>
      ${p0.id && !p0.is_walkin && html`<${Check} checked=${f.active} onValue=${(v) => set({ active: v })} label=${t('common.active')} />`}
      ${!p0.id && can('partners.adjust') && html`<div class="form-section">
        <div class="row between mb-8"><h3 style="font-size:14px;margin:0">${t('partner.opening_balance')}</h3>
          <${Btn} size="sm" icon="plus" onClick=${() => setOpening([...opening, { currency: f.credit_currency || 'IQD', amount: null, dir: f.kind === 'supplier' ? 'we' : 'they', date: today() }])}>${t('common.add')}</${Btn}></div>
        ${!opening.length ? html`<p class="small muted" style="margin:0">${t('partner.opening_hint')}</p>` : opening.map((o, i) => html`<div class="row gap-8 mb-8">
          <div style="width:170px"><${Select} size="sm" value=${o.dir} onValue=${(v) => setOpening(opening.map((x, j) => (j === i ? { ...x, dir: v } : x)))} options=${[{ value: 'they', label: t('partner.they_owe') }, { value: 'we', label: t('partner.we_owe') }]} /></div>
          <div style="width:90px"><${CurrencySelect} size="sm" value=${o.currency} onValue=${(v) => setOpening(opening.map((x, j) => (j === i ? { ...x, currency: v } : x)))} /></div>
          <div style="width:150px"><${NumInput} size="sm" value=${o.amount} onValue=${(v) => setOpening(opening.map((x, j) => (j === i ? { ...x, amount: v } : x)))} dec=${decimals(o.currency)} /></div>
          <div style="width:150px"><${DateInput} size="sm" value=${o.date} onValue=${(v) => setOpening(opening.map((x, j) => (j === i ? { ...x, date: v } : x)))} /></div>
          <${IconBtn} icon="x" onClick=${() => setOpening(opening.filter((x, j) => j !== i))} />
        </div>`)}
      </div>`}
    </div>
  </${Modal}>`;
}

function AdjustDialog({ partner, close }) {
  const [cur, setCur] = useState(Object.keys(partner.balances || {})[0] || (boot().settings.general || {}).default_currency || 'IQD');
  const [dir, setDir] = useState('they');
  const [amount, setAmount] = useState(null);
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState('adjust');
  const [desc, setDesc] = useState('');
  const save = async () => {
    try {
      await api.post(`/api/partners/${partner.id}/adjust`, { currency: cur, amount: dir === 'we' ? -Math.abs(amount) : Math.abs(amount), date, kind, description: desc });
      toast(t('common.saved'));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('partner.adjust')} icon="scale" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!(amount > 0) || !desc.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Notice} kind="warn">${t('partner.adjust_text')}</${Notice}>
      <${Segmented} value=${kind} onValue=${setKind} options=${[{ value: 'adjust', label: t('partner.adjust_kind.adjust') }, { value: 'opening', label: t('partner.adjust_kind.opening') }]} />
      <div class="form-3">
        <${Field} label=${t('partner.direction')}><${Select} value=${dir} onValue=${setDir} options=${[{ value: 'they', label: t('partner.add_debt') }, { value: 'we', label: t('partner.add_credit') }]} /></${Field}>
        <${Field} label=${t('common.currency')}><${CurrencySelect} value=${cur} onValue=${setCur} /></${Field}>
        <${Field} label=${t('pay.amount')}><${NumInput} value=${amount} onValue=${setAmount} dec=${decimals(cur)} autoFocus /></${Field}>
      </div>
      <div class="form-2">
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
        <${Field} label=${t('common.description')} required><${Input} value=${desc} onValue=${setDesc} /></${Field}>
      </div>
    </div>
  </${Modal}>`;
}

function ConvertDialog({ partner, close }) {
  const bals = partner.balances || {};
  const curs = (boot().currencies || []).filter((c) => c.active).map((c) => c.code);
  const [from, setFrom] = useState(Object.keys(bals)[0] || 'IQD');
  const [to, setTo] = useState((from === 'USD' ? 'IQD' : 'USD'));
  const [amount, setAmount] = useState(bals[from] ? Math.abs(bals[from]) : null);
  const defRate = () => round(convert(1, from, to), 8);
  const [rate, setRate] = useState(defRate());
  useEffect(() => { setRate(defRate()); setAmount(bals[from] ? Math.abs(bals[from]) : null); }, [from, to]);
  const [date, setDate] = useState(today());
  const result = amount && rate ? round(amount * rate, decimals(to)) : 0;
  const usdIqdView = from === 'IQD' && to === 'USD' ? (rate ? 1 / rate : 0) : from === 'USD' && to === 'IQD' ? rate : null;
  const save = async () => {
    try {
      const r = await api.post(`/api/partners/${partner.id}/convert`, { from_currency: from, to_currency: to, from_amount: amount, rate, date });
      toast(t('partner.converted', { amount: money(r.to_amount, to) }));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('partner.convert')} icon="coins" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!(amount > 0) || from === to}>${t('partner.convert_btn')}</${Btn}>`}>
    <div class="col gap-12">
      <p class="small dim">${t('partner.convert_text')}</p>
      <div class="row small gap-8"><span class="muted">${t('partner.balance')}:</span><${Balances} value=${bals} /></div>
      <div class="form-2">
        <${Field} label=${t('partner.convert_from')}><${Select} value=${from} onValue=${setFrom} options=${curs.map((c) => ({ value: c, label: c }))} /></${Field}>
        <${Field} label=${t('partner.convert_to')}><${Select} value=${to} onValue=${setTo} options=${curs.filter((c) => c !== from).map((c) => ({ value: c, label: c }))} /></${Field}>
        <${Field} label=${`${t('pay.amount')} (${from})`}><${NumInput} value=${amount} onValue=${setAmount} dec=${decimals(from)} /></${Field}>
        <${Field} label=${t('partner.convert_rate', { from, to })} hint=${usdIqdView ? rateText(usdIqdView) : null}><${NumInput} value=${rate} onValue=${setRate} dec=${8} /></${Field}>
      </div>
      <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
      <div class="notice"><${Icon} name="arrow-left-right" size="sm" /><div>${money(amount || 0, from)} → <b>${money(result, to)}</b></div></div>
    </div>
  </${Modal}>`;
}

/* ================================================================== list */
export function Partners({ kind = 'customer', query = {} }) {
  useTitle(t(kind === 'supplier' ? 'nav.suppliers' : 'nav.customers'));
  const [q, setQ] = useState('');
  const [balance, setBalance] = useState(query.balance || '');
  const [active, setActive] = useState('');
  const dq = useDebounced(q, 250);
  const showBal = can('partners.balance');
  const { data, loading, error, reload } = useAsync(() => api.get('/api/partners', { kind, q: dq, balance, active, limit: 5000 }), [kind, dq, balance, active]);
  const rows = data || [];
  const totals = useMemo(() => {
    const recv = {}; const pay = {};
    for (const r of rows) for (const [c, v] of Object.entries(r.balances || {})) { if (v > 0) recv[c] = (recv[c] || 0) + v; else pay[c] = (pay[c] || 0) - v; }
    return { recv, pay };
  }, [rows]);
  const add = () => openModal(PartnerDialog, { initial: { kind } }).then((p) => p && navigate(`/partner/${p.id}`));
  const exportX = () => downloadXlsx(`${t(kind === 'supplier' ? 'nav.suppliers' : 'nav.customers')}-${today()}`, [{
    name: t(kind === 'supplier' ? 'nav.suppliers' : 'nav.customers'),
    headers: [t('partner.no'), t('common.name'), t('partner.company'), t('common.phone'), t('partner.city'), 'IQD', 'USD', t('partner.last_move')],
    rows: rows.map((r) => [r.no, r.name, r.company || '', r.phone || '', r.city || '', (r.balances || {}).IQD || 0, (r.balances || {}).USD || 0, r.last_move || '']),
  }]);
  const printList = () => printTables(t(kind === 'supplier' ? 'nav.suppliers' : 'nav.customers'), `${t('partner.balance')} · ${fdate(today())}`, [{
    headers: [{ label: t('common.name') }, { label: t('common.phone') }, { label: 'IQD', r: true }, { label: 'USD', r: true }],
    rows: rows.filter((r) => Object.keys(r.balances || {}).length).map((r) => [r.name, r.phone || '', (r.balances || {}).IQD ? money(r.balances.IQD, 'IQD') : '', (r.balances || {}).USD ? money(r.balances.USD, 'USD') : '']),
    foot: ['', '', money((totals.recv.IQD || 0) - (totals.pay.IQD || 0), 'IQD'), money((totals.recv.USD || 0) - (totals.pay.USD || 0), 'USD')],
  }]);
  return html`<div class="page">
    <div class="toolbar">
      <${SearchBox} value=${q} onValue=${setQ} cls="search" placeholder=${t('partner.search_ph')} autoFocus />
      ${showBal && html`<div style="width:190px"><${Select} value=${balance} onValue=${setBalance} options=${[
        { value: '', label: t('partner.filter.all') }, { value: 'debtors', label: t('partner.filter.debtors') }, { value: 'creditors', label: t('partner.filter.creditors') },
        { value: 'nonzero', label: t('partner.filter.nonzero') }, { value: 'overdue', label: t('partner.filter.overdue') }]} /></div>`}
      <div style="width:130px"><${Select} value=${active} onValue=${setActive} options=${[{ value: '', label: t('common.active') }, { value: '0', label: t('common.inactive') }, { value: 'all', label: t('common.all') }]} /></div>
      <div class="toolbar-end">
      ${showBal && html`<${IconBtn} icon="printer" title=${t('common.print_list')} onClick=${printList} />`}
      <${IconBtn} icon="file-spreadsheet" title=${t('common.export_excel')} onClick=${exportX} />
      ${can('partners.manage') && html`<${Btn} kind="primary" icon="user-plus" onClick=${add}>${t(kind === 'supplier' ? 'partner.new_supplier' : 'partner.new_customer')}</${Btn}>`}
      </div>
    </div>
    ${showBal && (Object.keys(totals.recv).length > 0 || Object.keys(totals.pay).length > 0) && html`<div class="grid-2 mb-16">
      <div class="panel stat"><div class="k">${t('partner.total_receivable')}</div><div class="v"><${Balances} value=${totals.recv} colored=${false} emptyText="0" /></div></div>
      <div class="panel stat"><div class="k">${t('partner.total_payable')}</div><div class="v"><${Balances} value=${totals.pay} colored=${false} emptyText="0" /></div></div>
    </div>`}
    <div class="panel">${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table}
      rows=${rows} onRow=${(r) => navigate(`/partner/${r.id}`)} rowCls=${(r) => (r.active ? '' : 'cancelled')}
      empty=${html`<${Empty} icon="users" title=${q ? t('common.no_results') : t('partner.none')} action=${can('partners.manage') && !q && html`<${Btn} kind="primary" icon="user-plus" onClick=${add}>${t('partner.new')}</${Btn}>`} />`}
      columns=${[
        { key: 'name', label: t('common.name'), render: (r) => html`<div class="cell-name" dir="auto">${dn(r.name)}${r.is_walkin ? html` <${Pill}>${t('partner.walkin_short')}</${Pill}>` : null}${r.kind === 'both' ? html` <${KindPill} kind="both" />` : null}</div>${r.company ? html`<div class="sub" dir="auto">${r.company}</div>` : null}` },
        { key: 'phone', label: t('common.phone'), render: (r) => html`<span class="ltr small">${r.phone || ''}</span>` },
        { key: 'city', label: t('partner.city'), render: (r) => html`<span class="small">${r.city || ''}</span>` },
        showBal && { key: 'bal', label: t('partner.balance'), align: 'r', render: (r) => html`<${Balances} value=${r.balances} emptyText="—" />${r.overdue ? html`<div class="sub neg">${t('partner.overdue_n', { n: r.overdue_docs || '' })}</div>` : null}` },
        { key: 'last', label: t('partner.last_move'), render: (r) => html`<span class="small muted">${r.last_move ? fdate(r.last_move) : ''}</span>` },
      ]} />`}</div>
  </div>`;
}

/* ================================================================== partner page */
export function PartnerPage({ id, tab = 'statement', query = {} }) {
  const { data: p, loading, error, reload } = useAsync(() => api.get(`/api/partners/${id}`), [id]);
  useTitle(p ? dn(p.name) : t('common.loading'), p ? [{ label: t(p.kind === 'supplier' ? 'nav.suppliers' : 'nav.customers'), href: `#/partners/${p.kind === 'supplier' ? 'supplier' : 'customer'}` }] : null);
  if (loading && !p) return html`<${Loading} />`;
  if (error) return html`<div class="page"><${Notice} kind="err">${error.message}</${Notice}></div>`;
  const showBal = can('partners.balance');
  const isSupplier = p.kind === 'supplier';
  let cur = ['statement', 'docs', 'payments', 'vehicles', 'open'].includes(tab) ? tab : 'statement';
  if (!showBal && ['statement', 'open'].includes(cur)) cur = 'docs';
  const go = (tb) => navigate(`/partner/${id}/${tb}`);
  const edit = () => openModal(PartnerDialog, { partner: p }).then((r) => r && reload());
  const remove = async () => {
    if (!(await confirmDialog({ title: t('partner.delete'), text: t('partner.delete_text', { name: p.name }), danger: true, okText: t('common.delete') }))) return;
    try { const r = await api.del(`/api/partners/${p.id}`); toast(r.deactivated ? t('partner.deactivated') : t('common.deleted')); navigate(`/partners/${isSupplier ? 'supplier' : 'customer'}`, null, { replace: true }); } catch (e) { errToast(e); }
  };
  const remind = () => { const txt = reminderText(p); if (txt) whatsapp(p.phone, txt); };
  const hasDebt = Object.values(p.balances || {}).some((v) => v > 0);
  const hasCredit = Object.values(p.balances || {}).some((v) => v < 0);
  return html`<div class="page stack">
    <div class="split wide-side">
      <div class="panel"><div class="panel-body row top gap-16 wrap">
        <div class="avatar" style="width:52px;height:52px;font-size:18px;background:var(--graphite)">${(p.name || '?').trim().slice(0, 2).toUpperCase()}</div>
        <div class="grow" style="min-width:240px">
          <div class="row gap-8 wrap"><${KindPill} kind=${p.kind} />${p.is_walkin ? html`<${Pill}>${t('partner.walkin_short')}</${Pill}>` : null}${!p.active ? html`<${Pill} kind="out">${t('common.inactive')}</${Pill}>` : null}<span class="tiny muted">#${p.no}</span></div>
          ${p.company && html`<div class="dim mt-8" dir="auto">${p.company}</div>`}
          <div class="row wrap gap-16 mt-8 small">
            ${p.phone && html`<span class="row gap-4"><${Icon} name="phone" size="sm" /><a class="ltr" href=${`tel:${p.phone}`}>${p.phone}</a></span>`}
            ${p.phone2 && html`<span class="ltr">${p.phone2}</span>`}
            ${(p.city || p.address) && html`<span class="row gap-4"><${Icon} name="map-pin" size="sm" /><span dir="auto">${[p.address, p.city].filter(Boolean).join(', ')}</span></span>`}
          </div>
          <div class="row wrap gap-16 mt-8 small muted">
            ${p.price_list_name && html`<span>${t('doc.price_list')}: ${p.price_list_name}</span>`}
            ${p.payment_days ? html`<span>${t('partner.payment_days')}: ${p.payment_days}</span>` : null}
            ${p.credit_limit ? html`<span>${t('partner.credit_limit')}: ${money(p.credit_limit, p.credit_currency || 'IQD')}</span>` : null}
            ${p.tax_no && html`<span>${t('partner.tax_no')}: ${p.tax_no}</span>`}
          </div>
          ${p.notes && html`<div class="notice mt-12" style="white-space:pre-line" dir="auto"><${Icon} name="notebook-pen" size="sm" /><div>${p.notes}</div></div>`}
        </div>
        <div class="row gap-8 wrap" style="align-self:flex-start">
          ${!isSupplier && can('payments.collect') && hasDebt && html`<${Btn} kind="primary" icon="hand-coins" onClick=${() => openModal(PaymentDialog, { direction: 'in', partner: p }).then((r) => r && reload())}>${t('pay.collect')}</${Btn}>`}
          ${can('payments.pay') && (isSupplier || hasCredit) && html`<${Btn} kind=${isSupplier ? 'primary' : ''} icon="send" onClick=${() => openModal(PaymentDialog, { direction: 'out', partner: p }).then((r) => r && reload())}>${t('pay.pay')}</${Btn}>`}
          <${MenuButton} label=${t('common.new')} icon="plus" items=${[
            !isSupplier && can(['sales.create', 'pos.use']) && { label: t('doc.new.sale'), icon: 'receipt', onClick: () => navigate('/docs/sale/new', { partner: p.id }) },
            !isSupplier && can('quotes.manage') && { label: t('doc.new.quote'), icon: 'clipboard-list', onClick: () => navigate('/docs/quote/new', { partner: p.id }) },
            !isSupplier && can('service.manage') && { label: t('doc.new.service'), icon: 'wrench', onClick: () => navigate('/docs/service/new', { partner: p.id }) },
            p.kind !== 'customer' && can('purchases.create') && { label: t('doc.new.purchase'), icon: 'truck', onClick: () => navigate('/docs/purchase/new', { partner: p.id }) },
            p.kind !== 'customer' && can('orders.manage') && { label: t('doc.new.purchase_order'), icon: 'file-text', onClick: () => navigate('/docs/purchase_order/new', { partner: p.id }) },
            can('payments.collect') && { label: t('pay.collect'), icon: 'hand-coins', onClick: () => openModal(PaymentDialog, { direction: 'in', partner: p }).then((r) => r && reload()) },
            can('payments.pay') && { label: t('pay.pay'), icon: 'send', onClick: () => openModal(PaymentDialog, { direction: 'out', partner: p }).then((r) => r && reload()) },
          ]} />
          <${MenuButton} iconOnly icon="ellipsis" title=${t('common.more')} items=${[
            can('partners.manage') && { label: t('common.edit'), icon: 'pencil', onClick: edit },
            p.phone && { label: t('partner.whatsapp_reminder'), icon: 'message-circle', onClick: remind },
            p.phone && { label: 'WhatsApp', icon: 'message-circle', onClick: () => whatsapp(p.phone, '') },
            showBal && can('partners.adjust') && '-',
            showBal && can('partners.adjust') && { label: t('partner.adjust'), icon: 'scale', onClick: () => openModal(AdjustDialog, { partner: p }).then((r) => r && reload()) },
            showBal && can('partners.adjust') && { label: t('partner.convert'), icon: 'coins', onClick: () => openModal(ConvertDialog, { partner: p }).then((r) => r && reload()) },
            can('partners.manage') && !p.is_walkin && '-',
            can('partners.manage') && !p.is_walkin && { label: t('partner.delete'), icon: 'trash-2', danger: true, onClick: remove },
          ]} />
        </div>
      </div></div>
      ${showBal && html`<div class="panel stat">
        <div class="k">${t('partner.balance')}</div>
        ${!Object.keys(p.balances).length ? html`<div class="v pos">${t('partner.settled')}</div>` : Object.entries(p.balances).map(([c, v]) => html`<div class="row between mt-8">
          <span class="small muted nowrap">${v > 0 ? t('partner.they_owe') : t('partner.we_owe')}</span><span class=${`v ${v > 0 ? 'pos' : 'neg'}`} style="font-size:26px"><${Money} value=${Math.abs(v)} cur=${c} /></span></div>`)}
        ${Object.keys(p.balances).length > 1 && html`<div class="s mt-8">≈ ${display(p.balance_usd)} ${t('partner.total_equiv')}</div>`}
        <div class="s mt-8">${p.stats.sale_count ? t('partner.sales_stat', { n: p.stats.sale_count, amount: display(p.stats.sale_usd || 0) }) : ''}${p.stats.purchase_count ? ` ${t('partner.purchase_stat', { n: p.stats.purchase_count, amount: display(p.stats.purchase_usd || 0) })}` : ''}</div>
        ${p.stats.last_payment && html`<div class="s">${t('partner.last_payment')}: ${fdate(p.stats.last_payment)}</div>`}
      </div>`}
    </div>

    <${Tabs} value=${cur} onValue=${go} tabs=${[
      showBal && { id: 'statement', label: t('partner.statement'), icon: 'file-text' },
      showBal && { id: 'open', label: t('partner.open_docs'), icon: 'clock', count: (p.open_docs || []).length || null },
      { id: 'docs', label: t('partner.docs'), icon: 'receipt' },
      can(['payments.collect', 'payments.pay', 'cash.view']) && { id: 'payments', label: t('nav.payments'), icon: 'hand-coins' },
      !isSupplier && { id: 'vehicles', label: t('nav.vehicles'), icon: 'car', count: p.vehicles.length || null },
    ]} />
    ${cur === 'statement' && showBal && html`<${Statement} partner=${p} onChange=${reload} />`}
    ${cur === 'open' && showBal && html`<${OpenDocs} partner=${p} onChange=${reload} />`}
    ${cur === 'docs' && html`<${PartnerDocs} partner=${p} />`}
    ${cur === 'payments' && html`<${PartnerPayments} partner=${p} onChange=${reload} />`}
    ${cur === 'vehicles' && html`<${PartnerVehicles} partner=${p} onChange=${reload} />`}
  </div>`;
}

function Statement({ partner, onChange }) {
  const [range, setRange] = useState({ from: addMonths(today(), -6), to: today() });
  const [cur, setCur] = useState('');
  const { data, loading, reload } = useAsync(() => api.get(`/api/partners/${partner.id}/statement`, { from: range.from, to: range.to, currency: cur || undefined }), [range.from, range.to, cur]);
  const cancelMove = async (m) => {
    const reason = await promptDialog({ title: t('partner.cancel_move'), text: m.description || '', inputLabel: t('common.reason'), okText: t('common.cancel_doc'), danger: true, requireText: true });
    if (!reason) return;
    try { await api.post(`/api/partner-moves/${m.id}/cancel`, { reason }); toast(t('common.cancelled')); reload(); onChange && onChange(); } catch (e) { errToast(e); }
  };
  const open = (r) => {
    if (r.doc_id) navigate(`/doc/${r.doc_id}`);
    else if (r.payment_id) openModal(PaymentDrawer, { id: r.payment_id }).then((x) => x && reload());
  };
  const curs = Object.keys(partner.balances || {});
  return html`<div>
    <div class="toolbar">
      <${DateRange} from=${range.from} to=${range.to} onChange=${setRange} />
      ${curs.length > 1 && html`<${Segmented} value=${cur} onValue=${setCur} options=${[{ value: '', label: t('common.all') }, ...curs.map((c) => ({ value: c, label: c }))]} />`}
      <div class="toolbar-end">
      <${Btn} icon="printer" disabled=${!data} onClick=${() => printStatement(data, range.from, range.to)}>${t('partner.print_statement')}</${Btn}>
      </div>
    </div>
    ${loading && !data ? html`<${Loading} />` : !data.sections.length ? html`<div class="panel"><${Empty} icon="file-text" title=${t('partner.no_moves')} /></div>` : data.sections.map((s) => html`<div class="panel mb-16">
      <div class="panel-head"><h2>${s.currency}</h2><div class="tools small"><span class="muted">${t('partner.opening_balance')}:</span> <${Money} value=${s.opening} cur=${s.currency} colored />
        <span class="muted">· ${t('partner.closing')}:</span> <${Money} value=${s.closing} cur=${s.currency} colored strong /></div></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('common.date')}</th><th>${t('common.type')}</th><th>${t('doc.no')}</th><th>${t('common.description')}</th><th class="r">${t('partner.debit')}</th><th class="r">${t('partner.credit')}</th><th class="r">${t('partner.balance')}</th><th class="w-actions"></th></tr></thead>
        <tbody>${s.rows.map((r) => { const c = stmtCells(r); return html`<tr class=${r.doc_id || r.payment_id ? 'clickable' : ''} onClick=${(e) => { if (!e.target.closest('button')) open(r); }}>
          <td class="nowrap">${fdate(r.date)}</td>
          <td class="nowrap">${c.type}${r.method ? html`<div class="sub">${t(`pay.method.${r.method}`)}${r.account_name ? ` · ${r.account_name}` : ''}</div>` : null}</td>
          <td class="nowrap">${c.no}</td>
          <td class="small">${c.ref ? html`<span class="muted ltr">→ ${c.ref}</span> ` : null}<span dir="auto">${c.desc}</span>${r.paid_currency && r.paid_currency !== s.currency ? html`<div class="sub num">${money(r.paid_amount, r.paid_currency)}</div>` : null}${r.due_date && r.amount > 0 ? html`<div class="sub">${t('doc.due_date')}: ${fdate(r.due_date)}</div>` : null}</td>
          <td class="r">${r.amount > 0 ? html`<${Money} value=${r.amount} cur=${s.currency} />` : ''}</td>
          <td class="r">${r.amount < 0 ? html`<${Money} value=${-r.amount} cur=${s.currency} />` : ''}</td>
          <td class="r"><${Money} value=${r.balance} cur=${s.currency} colored strong /></td>
          <td class="w-actions">${['opening', 'adjust', 'convert'].includes(r.kind) && can('partners.adjust') ? html`<${IconBtn} icon="ban" danger title=${t('common.cancel_doc')} onClick=${() => cancelMove(r)} />` : null}</td>
        </tr>`; })}</tbody>
        <tfoot><tr><td colspan="4">${t('common.total')}</td><td class="r num">${money(s.debit, s.currency)}</td><td class="r num">${money(s.credit, s.currency)}</td><td class="r"><${Money} value=${s.closing} cur=${s.currency} colored /></td><td></td></tr></tfoot>
      </table></div></div>`)}
    <p class="small muted">${t('partner.statement_hint')}</p>
  </div>`;
}

function OpenDocs({ partner, onChange }) {
  const { data, loading, reload } = useAsync(() => api.get(`/api/partners/${partner.id}/open-docs`), [partner.id]);
  const pay = (d) => openModal(PaymentDialog, { doc: { ...d, partner_id: partner.id, partner_name: partner.name } }).then((r) => { if (r) { reload(); onChange && onChange(); } });
  return html`<div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} onRow=${(r) => navigate(`/doc/${r.id}`)}
    empty=${html`<${Empty} icon="circle-check" title=${t('partner.no_open_docs')} />`}
    columns=${[
      { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
      { key: 'type', label: t('common.type'), render: (r) => t(`doc.type.${r.type}`) },
      { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
      { key: 'due', label: t('doc.due_date'), render: (r) => (r.due_date ? html`<span class=${r.overdue_days ? 'neg' : ''}>${fdate(r.due_date)}${r.overdue_days ? html`<div class="sub neg">${t('doc.overdue_days', { n: r.overdue_days })}</div>` : null}</span>` : '—') },
      { key: 'total', label: t('doc.total'), align: 'r', render: (r) => html`<${Money} value=${r.total} cur=${r.currency} />` },
      { key: 'rem', label: t('doc.remaining'), align: 'r', render: (r) => html`<${Money} value=${r.remaining} cur=${r.currency} cls="neg" strong />` },
      { key: 'act', label: '', cls: 'w-actions', render: (r) => can(['sale', 'purchase_return'].includes(r.type) ? 'payments.collect' : 'payments.pay') && html`<${Btn} size="sm" icon="hand-coins" onClick=${() => pay(r)}>${t(['sale', 'purchase_return'].includes(r.type) ? 'pay.collect' : 'pay.pay')}</${Btn}>` },
    ]} />`}</div>`;
}

function PartnerDocs({ partner }) {
  const types = ['sale', 'sale_return', 'quote', 'service', 'purchase', 'purchase_return', 'purchase_order'].filter((tp) => can({ sale: 'sales.view', purchase: 'purchases.view', quote: 'quotes.view', service: 'service.view', sale_return: 'returns.view', purchase_return: 'returns.view', purchase_order: 'orders.view' }[tp]));
  const [type, setType] = useState('');
  const { data, loading } = useAsync(() => (types.length ? api.get('/api/docs', { type: type || types.join(','), partner_id: partner.id, include_cancelled: 1, limit: 500, from: '2000-01-01' }) : Promise.resolve({ rows: [] })), [type]);
  return html`<div>
    <div class="toolbar"><div style="width:200px"><${Select} value=${type} onValue=${setType} options=${[{ value: '', label: t('common.all') }, ...types.map((tp) => ({ value: tp, label: t(`doc.type.${tp}`) }))]} /></div></div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${DocTable} rows=${data.rows} showType showPartner=${false} />`}</div>
  </div>`;
}

function PartnerPayments({ partner, onChange }) {
  const { data, loading, reload } = useAsync(() => api.get('/api/payments', { partner_id: partner.id, limit: 1000 }), [partner.id]);
  return html`<div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} onRow=${(r) => openModal(PaymentDrawer, { id: r.id }).then((x) => { if (x) { reload(); onChange && onChange(); } })}
    empty=${html`<${Empty} icon="hand-coins" title=${t('pay.none')} />`}
    columns=${[
      { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
      { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
      { key: 'dir', label: t('common.type'), render: (r) => html`<${Pill} kind=${r.direction === 'in' ? 'in' : 'out'}>${r.purpose === 'change' ? t('pos.change') : t(r.direction === 'in' ? 'pay.dir.in' : 'pay.dir.out')}</${Pill}>` },
      { key: 'acc', label: t('pay.account'), render: (r) => html`<span class="small">${r.account_name}</span>` },
      { key: 'docs', label: t('pay.for_invoices'), render: (r) => html`<span class="small">${r.doc_nos || ''}</span>` },
      { key: 'amount', label: t('pay.amount'), align: 'r', render: (r) => html`<${Money} value=${r.amount} cur=${r.currency} strong />${r.applied_currency !== r.currency ? html`<div class="sub num">→ ${money(r.applied_amount, r.applied_currency)}</div>` : null}` },
    ]} />`}</div>`;
}

function PartnerVehicles({ partner, onChange }) {
  const add = () => openModal(VehicleDialog, { initial: { partner_id: partner.id, partner_name: partner.name } }).then((v) => v && onChange && onChange());
  return html`<div>
    <div class="toolbar"><div class="spacer"></div>${can('vehicles.manage') && html`<${Btn} kind="primary" icon="plus" onClick=${add}>${t('vehicle.new')}</${Btn}>`}</div>
    <div class="panel"><${Table} rows=${partner.vehicles} onRow=${(v) => navigate(`/vehicle/${v.id}`)}
      empty=${html`<${Empty} icon="car" title=${t('vehicle.none')} />`}
      columns=${[
        { key: 'plate', label: t('vehicle.plate'), render: (v) => html`<span class="strong ltr">${v.plate || '—'}</span>` },
        { key: 'desc', label: t('vehicle.model'), render: (v) => html`<span dir="auto">${v.description}</span>` },
        { key: 'vin', label: t('vehicle.vin'), render: (v) => html`<span class="small ltr">${v.vin || ''}</span>` },
        { key: 'km', label: t('vehicle.km'), align: 'r', render: (v) => (v.km ? num(v.km) : '') },
      ]} /></div>
  </div>`;
}
