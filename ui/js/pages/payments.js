// Payments: collect from customers / pay suppliers, in any currency, against open invoices (FIFO or by hand).
import { html, useState, useEffect, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate, setQuery } from '../core/router.js';
import { money, num, convert, today, date as fdate, dateTime, usdIqd, round, decimals, rateText } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Drawer, Field, Input, NumInput, Select, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, Balances, KV,
  DateRange, periodRange, SearchBox, useAsync, useDebounced, openModal, toast, errToast, promptDialog, confirmDialog, DateInput } from '../core/ui.js';
import { printHtml, escapeHtml } from '../core/print.js';
import { absUrl } from '../core/invoice.js';
import { PartnerPicker, AccountSelect, account, defaultAccount, loadPartner, accountOptions } from './pickers.js';
import { refreshBoot } from '../core/session.js';
import { dn } from '../core/names.js';

const METHODS = ['cash', 'card', 'transfer', 'other'];

function methodFor(acc) { return !acc ? 'cash' : acc.type === 'bank' ? 'transfer' : acc.type === 'pos' ? 'card' : 'cash'; }

/**
 * PaymentDialog props: direction 'in'|'out', partner (object, optional), doc (optional: pay this invoice), close
 * Resolves with the created payment.
 */
export function PaymentDialog({ direction = 'in', partner: initialPartner, doc, close }) {
  const [dir, setDir] = useState(doc ? (['sale', 'purchase_return'].includes(doc.type) ? 'in' : 'out') : direction);
  const [partner, setPartner] = useState(initialPartner || (doc && doc.partner_id ? { id: doc.partner_id, name: doc.partner_name } : null));
  const [openDocs, setOpenDocs] = useState([]);
  const rateNow = usdIqd();
  const startCur = doc ? doc.currency : (boot().settings.general || {}).default_currency || 'IQD';
  const [accountId, setAccountId] = useState(() => (defaultAccount(startCur) || defaultAccount('IQD') || defaultAccount('USD') || {}).id || '');
  const acc = account(accountId);
  const accCur = acc ? acc.currency : startCur;
  const [appliedCur, setAppliedCur] = useState(doc ? doc.currency : accCur);
  const [rate, setRate] = useState(doc && doc.usd_iqd && doc.currency !== accCur ? rateNow : rateNow);
  const [amount, setAmount] = useState(doc && doc.remaining > 0 ? round(convert(doc.remaining, doc.currency, accCur, rateNow), decimals(accCur)) : null);
  const [appliedManual, setAppliedManual] = useState(null);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState(methodFor(acc));
  const [desc, setDesc] = useState('');
  const [mode, setMode] = useState(doc ? 'doc' : 'auto');
  const [alloc, setAlloc] = useState({});
  const [printIt, setPrintIt] = useState(false);
  const [busy, setBusy] = useState(false);

  // full partner (balances) + open invoices
  useEffect(() => {
    if (!partner || !partner.id) { setOpenDocs([]); return; }
    let alive = true;
    (async () => {
      const full = partner.balances ? partner : await loadPartner(partner.id);
      if (!alive) return;
      if (full && !partner.balances) setPartner(full);
      if (can(['partners.balance', 'payments.collect', 'payments.pay'])) {
        try { const od = await api.get(`/api/partners/${partner.id}/open-docs`, { direction: dir }); if (alive) setOpenDocs(od); } catch (e) { /* no permission */ }
      }
      // no doc: suggest the balance currency and amount
      if (!doc && full && full.balances) {
        const entries = Object.entries(full.balances).filter(([, v]) => (dir === 'in' ? v > 0 : v < 0));
        if (entries.length) {
          const [cur, v] = entries.sort((a, b) => Math.abs(convert(b[1], b[0], 'USD')) - Math.abs(convert(a[1], a[0], 'USD')))[0];
          setAppliedCur(cur);
          const a2 = defaultAccount(cur);
          if (a2) { setAccountId(a2.id); setMethod(methodFor(a2)); }
          setAmount(Math.abs(v));
        }
      }
    })();
    return () => { alive = false; };
  }, [partner && partner.id, dir]);

  useEffect(() => { setMethod(methodFor(acc)); }, [accountId]);

  const fxDiffers = appliedCur !== accCur;
  const appliedAuto = amount ? round(convert(amount, accCur, appliedCur, rate), decimals(appliedCur)) : 0;
  const applied = fxDiffers ? (appliedManual ?? appliedAuto) : (amount || 0);
  const eligible = openDocs.filter((d) => d.currency === appliedCur);
  const allocTotal = Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0);
  const bal = partner && partner.balances ? partner.balances[appliedCur] || 0 : null;
  const after = bal === null ? null : round(bal + (dir === 'in' ? -applied : applied), decimals(appliedCur));
  const curOptions = [...new Set([accCur, ...(boot().currencies || []).filter((c) => c.active).map((c) => c.code), ...(partner && partner.balances ? Object.keys(partner.balances) : [])])];

  const autoFill = () => {
    let left = applied;
    const next = {};
    for (const d of eligible) {
      if (left <= 0) break;
      const a = Math.min(left, d.remaining);
      next[d.id] = round(a, decimals(appliedCur));
      left -= a;
    }
    setAlloc(next);
  };

  const submit = async () => {
    if (!partner || !partner.id) { toast(t('pay.choose_partner'), 'err'); return; }
    if (!(amount > 0)) { toast(t('pay.enter_amount'), 'err'); return; }
    if (mode === 'manual' && allocTotal > applied + (appliedCur === 'IQD' ? 1 : 0.01)) { toast(t('pay.over_allocated'), 'err'); return; }
    const body = {
      direction: dir, partner_id: partner.id, account_id: accountId, amount, applied_currency: appliedCur,
      applied_amount: fxDiffers ? applied : undefined, usd_iqd: rate, date, method, description: desc || undefined,
    };
    if (mode === 'doc' && doc) body.allocations = [{ doc_id: doc.id, amount: Math.min(applied, doc.remaining) }];
    else if (mode === 'manual') body.allocations = Object.entries(alloc).filter(([, v]) => v > 0).map(([doc_id, v]) => ({ doc_id, amount: v }));
    else if (mode === 'auto') body.auto_allocate = true;
    setBusy(true);
    try {
      const p = await api.post('/api/payments', body);
      toast(t(dir === 'in' ? 'pay.collected' : 'pay.paid_out', { no: p.no, amount: money(p.amount, p.currency) }));
      if (printIt) printPayment(p);
      close(p);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };

  return html`<${Modal} title=${t(dir === 'in' ? 'pay.collect' : 'pay.pay')} icon=${dir === 'in' ? 'hand-coins' : 'send'} close=${close} size="wide" onSubmit=${submit}
    left=${html`<${Check} checked=${printIt} onValue=${setPrintIt} label=${t('pay.print_receipt')} />`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" icon="check" disabled=${busy || !partner || !(amount > 0)}>${t(dir === 'in' ? 'pay.collect_btn' : 'pay.pay_btn')}</${Btn}>`}>
    <div class="col gap-12">
      ${!doc && html`<${Segmented} value=${dir} onValue=${(v) => { setDir(v); setAlloc({}); }} options=${[
        { value: 'in', label: t('pay.dir.in') }, { value: 'out', label: t('pay.dir.out') }]} />`}
      ${doc && html`<${Notice} icon="file-text">${t('pay.for_doc', { no: doc.no, remaining: money(doc.remaining, doc.currency) })}</${Notice}>`}
      <div class="form-2">
        <${Field} label=${t('doc.partner')} required>
          <${PartnerPicker} value=${partner} onChange=${(p) => { setPartner(p); setAlloc({}); }} kind=${dir === 'in' ? 'customer' : 'supplier'} disabled=${!!doc} autoFocus=${!partner} />
        </${Field}>
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
      </div>
      <div class="form-3">
        <${Field} label=${t('pay.account')} required><${AccountSelect} value=${accountId} onValue=${(v) => { setAccountId(v); setAppliedManual(null); }} /></${Field}>
        <${Field} label=${`${t('pay.amount')} (${accCur})`} required>
          <div class="input-wrap"><${NumInput} value=${amount} onValue=${(v) => { setAmount(v); setAppliedManual(null); }} dec=${decimals(accCur)} cls="has-suffix" autoFocus=${!!partner} /><span class="suffix">${accCur}</span></div>
        </${Field}>
        <${Field} label=${t('pay.method')}><${Select} value=${method} onValue=${setMethod} options=${METHODS.map((m) => ({ value: m, label: t(`pay.method.${m}`) }))} /></${Field}>
      </div>
      <div class="form-3">
        <${Field} label=${t('pay.applied_currency')} hint=${t('pay.applied_currency_hint')}>
          <${Select} value=${appliedCur} onValue=${(v) => { setAppliedCur(v); setAppliedManual(null); setAlloc({}); }} disabled=${!!doc} options=${curOptions.map((c) => ({ value: c, label: c }))} />
        </${Field}>
        ${fxDiffers && html`<${Field} label=${t('rate.label')}><${NumInput} value=${rate} onValue=${(v) => { setRate(v); setAppliedManual(null); }} dec=${2} /></${Field}>`}
        ${fxDiffers && html`<${Field} label=${`${t('pay.applied_amount')} (${appliedCur})`}><${NumInput} value=${applied} onValue=${setAppliedManual} dec=${decimals(appliedCur)} /></${Field}>`}
      </div>
      ${partner && bal !== null && html`<div class="row wrap gap-16 small">
        <span class="muted">${t('pay.balance_before')}:</span> <${Money} value=${bal} cur=${appliedCur} colored strong />
        <${Icon} name="chevron-right" size="sm" />
        <span class="muted">${t('pay.balance_after')}:</span> <${Money} value=${after} cur=${appliedCur} colored strong />
        ${partner.balances && Object.keys(partner.balances).length > 1 && html`<span class="muted">(${t('pay.other_balances')}: <${Balances} value=${Object.fromEntries(Object.entries(partner.balances).filter(([c]) => c !== appliedCur))} />)</span>`}
      </div>`}
      <${Field} label=${t('common.description')}><${Input} value=${desc} onValue=${setDesc} placeholder=${t('pay.desc_ph')} /></${Field}>

      ${partner && html`<div class="form-section">
        <div class="row between mb-8"><h3 style="font-size:14px">${t('pay.allocation')}</h3>
          <${Segmented} value=${mode} onValue=${(v) => { setMode(v); if (v === 'manual') autoFill(); }} options=${[
            doc && { value: 'doc', label: t('pay.alloc.doc') }, { value: 'auto', label: t('pay.alloc.auto') }, { value: 'manual', label: t('pay.alloc.manual') }, { value: 'none', label: t('pay.alloc.none') }].filter(Boolean)} /></div>
        ${mode === 'auto' && html`<p class="small muted">${t('pay.alloc.auto_hint')}</p>`}
        ${mode === 'none' && html`<p class="small muted">${t('pay.alloc.none_hint')}</p>`}
        ${mode === 'manual' && (!eligible.length ? html`<p class="small muted">${t('pay.no_open_docs', { cur: appliedCur })}</p>` : html`<table class="tbl compact">
          <thead><tr><th>${t('doc.no')}</th><th>${t('common.date')}</th><th>${t('doc.due_date')}</th><th class="r">${t('doc.total')}</th><th class="r">${t('doc.remaining')}</th><th class="r" style="width:150px">${t('pay.alloc_amount')}</th></tr></thead>
          <tbody>${eligible.map((d) => html`<tr>
            <td class="strong">${d.no}</td><td>${fdate(d.date)}</td><td class=${d.overdue_days ? 'neg' : ''}>${d.due_date ? fdate(d.due_date) : '—'}</td>
            <td class="r"><${Money} value=${d.total} cur=${d.currency} /></td><td class="r"><${Money} value=${d.remaining} cur=${d.currency} /></td>
            <td class="r"><${NumInput} size="sm" value=${alloc[d.id] ?? null} dec=${decimals(appliedCur)} onValue=${(v) => setAlloc({ ...alloc, [d.id]: v === null ? 0 : Math.min(v, d.remaining) })} /></td>
          </tr>`)}</tbody>
          <tfoot><tr><td colspan="5">${t('pay.allocated_total')}</td><td class=${`r ${allocTotal > applied + 0.01 ? 'neg' : ''}`}>${money(allocTotal, appliedCur)} / ${money(applied, appliedCur)}</td></tr></tfoot>
        </table>`)}
      </div>`}
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ payment receipt (makbuz) */
export function paymentBody(p) {
  const c = boot().company || {};
  const logo = absUrl(c.logo_url);
  const e = escapeHtml;
  return `<div style="font-family:'Plex','Plex Arabic','Segoe UI',Arial,sans-serif; font-size:12.5px; color:#111; padding:4mm;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #111; padding-bottom:8px;">
      <div style="display:flex; gap:10px; align-items:center;">${logo ? `<img src="${e(logo)}" style="height:44px">` : ''}<div><div style="font-weight:700; font-size:15px" dir="auto">${e(c.name || '')}</div><div style="font-size:11px; color:#444" dir="auto">${e([c.phone, c.phone2].filter(Boolean).join(' | '))}</div></div></div>
      <div style="text-align:end"><div style="font-weight:700; font-size:16px">${e(t(p.direction === 'in' ? 'pay.receipt_in' : 'pay.receipt_out'))}</div><div>${e(p.no)}</div><div>${fdate(p.date)}</div></div>
    </div>
    <table style="width:100%; border-collapse:collapse; margin-top:12px; font-size:13px">
      <tr><td style="color:#555; padding:4px 0; width:38%">${e(t(p.direction === 'in' ? 'pay.received_from' : 'pay.paid_to'))}</td><td style="font-weight:600" dir="auto">${e(dn(p.partner_name) || '')}</td></tr>
      <tr><td style="color:#555; padding:4px 0">${e(t('pay.amount'))}</td><td style="font-weight:700; font-size:17px" dir="ltr">${money(p.amount, p.currency)}</td></tr>
      ${p.applied_currency !== p.currency ? `<tr><td style="color:#555; padding:4px 0">${e(t('pay.applied_amount'))}</td><td dir="ltr">${money(p.applied_amount, p.applied_currency)} (${rateText(p.usd_iqd)})</td></tr>` : ''}
      <tr><td style="color:#555; padding:4px 0">${e(t('pay.method'))}</td><td>${e(t(`pay.method.${p.method}`))} — ${e(p.account_name || '')}</td></tr>
      ${p.allocations && p.allocations.length ? `<tr><td style="color:#555; padding:4px 0">${e(t('pay.for_invoices'))}</td><td>${p.allocations.map((a) => `${e(a.no)} (${money(a.amount, a.currency)})`).join(', ')}</td></tr>` : ''}
      ${p.description ? `<tr><td style="color:#555; padding:4px 0">${e(t('common.description'))}</td><td dir="auto">${e(p.description)}</td></tr>` : ''}
      ${p.partner_balances ? `<tr><td style="color:#555; padding:4px 0">${e(t('pay.balance_now'))}</td><td dir="ltr">${Object.entries(p.partner_balances).map(([cur, v]) => money(v, cur)).join(' + ') || '0'}</td></tr>` : ''}
    </table>
    <div style="display:flex; gap:20px; margin-top:34px;">
      <div style="flex:1; border-top:1px solid #111; padding-top:4px; text-align:center">${e(t('pay.signature_receiver'))}</div>
      <div style="flex:1; border-top:1px solid #111; padding-top:4px; text-align:center">${e(t('pay.signature_payer'))}</div>
    </div>
  </div>`;
}

export function printPayment(p) {
  return printHtml(paymentBody(p), { title: p.no, page: 'A5' });
}

/* ------------------------------------------------------------------ payment detail */
export function PaymentDrawer({ id, close }) {
  const { data: p, loading, error, reload } = useAsync(() => api.get(`/api/payments/${id}`), [id]);
  const cancel = async () => {
    const reason = await promptDialog({ title: t('pay.cancel_title'), text: t('pay.cancel_text'), inputLabel: t('common.reason'), okText: t('pay.cancel_btn'), danger: true, requireText: true });
    if (!reason) return;
    try { await api.post(`/api/payments/${id}/cancel`, { reason }); toast(t('pay.cancelled')); reload(); } catch (e) { errToast(e); }
  };
  const allocate = async () => { const r = await openModal(AllocateDialog, { payment: p }); if (r) reload(); };
  return html`<${Drawer} title=${p ? `${p.no} — ${t(p.direction === 'in' ? 'pay.dir.in' : 'pay.dir.out')}` : t('common.loading')} close=${() => close(true)} narrow
    tools=${p && html`<${IconBtn} icon="printer" title=${t('common.print')} onClick=${() => printPayment(p)} />`}
    foot=${p && p.status === 'posted' && html`${can('payments.cancel') && html`<${Btn} kind="ghost" icon="ban" onClick=${cancel}>${t('pay.cancel_btn')}</${Btn}>`}
      ${p.unallocated > 0 && can(['payments.collect', 'payments.pay']) && html`<${Btn} icon="git-merge" onClick=${allocate}>${t('pay.allocate')}</${Btn}>`}`}>
    ${loading && !p ? html`<${Loading} />` : error ? html`<${Notice} kind="err">${error.message}</${Notice}>` : html`<div class="col gap-16">
      ${p.status === 'cancelled' && html`<${Notice} kind="err">${t('pay.is_cancelled')}${p.cancel_reason ? `: ${p.cancel_reason}` : ''}</${Notice}>`}
      <div class="row between"><div><div class="tiny muted">${t('pay.amount')}</div><div style="font-family:var(--font-cond);font-size:28px;font-weight:600"><${Money} value=${p.amount} cur=${p.currency} /></div></div>
        <${Pill} kind=${p.direction === 'in' ? 'in' : 'out'}>${t(p.direction === 'in' ? 'pay.dir.in' : 'pay.dir.out')}</${Pill}></div>
      <${KV} items=${[
        [t('doc.partner'), html`<a href=${`#/partner/${p.partner_id}`} dir="auto">${dn(p.partner_name)}</a>`],
        [t('common.date'), fdate(p.date)],
        [t('pay.account'), p.account_name],
        [t('pay.method'), t(`pay.method.${p.method}`)],
        p.applied_currency !== p.currency && [t('pay.applied_amount'), html`<${Money} value=${p.applied_amount} cur=${p.applied_currency} />`],
        p.applied_currency !== p.currency && [t('rate.short'), rateText(p.usd_iqd)],
        [t('common.description'), p.description],
        [t('common.user'), p.user_name],
        [t('common.created_at'), dateTime(p.created_at)],
        p.purpose === 'change' && [t('common.type'), t('pos.change')],
      ]} />
      <div><div class="label mb-8">${t('pay.for_invoices')}</div>
        ${!p.allocations.length ? html`<p class="small muted">${t('pay.no_allocations')}</p>` : html`<table class="tbl compact"><tbody>
          ${p.allocations.map((a) => html`<tr class="clickable" onClick=${() => { close(); navigate(`/doc/${a.doc_id}`); }}><td class="strong">${a.no}</td><td>${t(`doc.type.${a.type}`)}</td><td>${fdate(a.date)}</td><td class="r"><${Money} value=${a.amount} cur=${a.currency} /></td></tr>`)}
        </tbody></table>`}
        ${p.unallocated > 0 && html`<p class="small mt-8">${t('pay.unallocated')}: <b><${Money} value=${p.unallocated} cur=${p.applied_currency} /></b></p>`}
      </div>
    </div>`}
  </${Drawer}>`;
}

function AllocateDialog({ payment: p, close }) {
  const [docs, setDocs] = useState(null);
  const [alloc, setAlloc] = useState({});
  useEffect(() => {
    api.get(`/api/partners/${p.partner_id}/open-docs`, { direction: p.direction, currency: p.applied_currency }).then((r) => {
      setDocs(r);
      const cur = {};
      for (const a of p.allocations) cur[a.doc_id] = a.amount;
      let left = p.unallocated;
      for (const d of r) { if (left <= 0) break; if (cur[d.id]) continue; const a = Math.min(left, d.remaining); cur[d.id] = a; left -= a; }
      setAlloc(cur);
    }).catch(errToast);
  }, []);
  const existing = p.allocations.filter((a) => !(docs || []).some((d) => d.id === a.doc_id));
  const prevAlloc = (docId) => (p.allocations.find((a) => a.doc_id === docId) || {}).amount || 0;
  const total = Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0);
  const save = async () => {
    const list = Object.entries(alloc).filter(([, v]) => v > 0).map(([doc_id, amount]) => ({ doc_id, amount }));
    try { await api.post(`/api/payments/${p.id}/allocate`, { allocations: list }); toast(t('common.saved')); close(true); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('pay.allocate')} close=${close} size="wide" onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${total > p.applied_amount + 0.01}>${t('common.save')}</${Btn}>`}>
    ${!docs ? html`<${Loading} />` : html`<table class="tbl compact">
      <thead><tr><th>${t('doc.no')}</th><th>${t('common.date')}</th><th class="r">${t('doc.remaining')}</th><th class="r" style="width:160px">${t('pay.alloc_amount')}</th></tr></thead>
      <tbody>
        ${existing.map((a) => html`<tr><td class="strong">${a.no}</td><td>${fdate(a.date)}</td><td class="r">—</td>
          <td class="r"><${NumInput} size="sm" value=${alloc[a.doc_id] ?? 0} onValue=${(v) => setAlloc({ ...alloc, [a.doc_id]: v || 0 })} dec=${decimals(p.applied_currency)} /></td></tr>`)}
        ${docs.map((d) => html`<tr><td class="strong">${d.no}</td><td>${fdate(d.date)}</td><td class="r"><${Money} value=${d.remaining} cur=${d.currency} /></td>
          <td class="r"><${NumInput} size="sm" value=${alloc[d.id] ?? null} onValue=${(v) => setAlloc({ ...alloc, [d.id]: v === null ? 0 : Math.min(v, d.remaining + prevAlloc(d.id)) })} dec=${decimals(p.applied_currency)} /></td></tr>`)}
      </tbody>
      <tfoot><tr><td colspan="3">${t('pay.allocated_total')}</td><td class="r">${money(total, p.applied_currency)} / ${money(p.applied_amount, p.applied_currency)}</td></tr></tfoot>
    </table>`}
  </${Modal}>`;
}

/* ------------------------------------------------------------------ list */
export function Payments({ query = {} }) {
  useTitle(t('nav.payments'));
  const def = periodRange('month');
  const [f, setF] = useState({ direction: query.direction || '', from: query.from || def.from, to: query.to || def.to, account_id: query.account_id || '', q: '', status: '' });
  const dq = useDebounced(f.q, 300);
  const { data, loading, error, reload } = useAsync(() => api.get('/api/payments', {
    direction: f.direction, from: f.from, to: f.to, account_id: f.account_id, q: dq, status: f.status || undefined, purpose: 'exclude_change', limit: 2000,
  }), [f.direction, f.from, f.to, f.account_id, dq, f.status]);
  const rows = data || [];
  const totals = useMemo(() => {
    const m = {};
    for (const p of rows) {
      if (p.status !== 'posted') continue;
      m[p.currency] = m[p.currency] || { in: 0, out: 0 };
      m[p.currency][p.direction] += p.amount;
    }
    return m;
  }, [rows]);
  const open = (p) => openModal(PaymentDrawer, { id: p.id }).then((r) => r && reload());
  const newPay = (dir) => openModal(PaymentDialog, { direction: dir }).then((r) => r && reload());
  return html`<div class="page">
    <div class="toolbar">
      <${Segmented} value=${f.direction} onValue=${(v) => setF({ ...f, direction: v })} options=${[{ value: '', label: t('common.all') }, { value: 'in', label: t('pay.dir.in') }, { value: 'out', label: t('pay.dir.out') }]} />
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      <div style="width:200px"><${Select} value=${f.account_id} onValue=${(v) => setF({ ...f, account_id: v })} placeholder=${t('pay.all_accounts')} options=${accountOptions({ includeInactive: true })} /></div>
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
      <${Check} checked=${f.status === 'cancelled'} onValue=${(v) => setF({ ...f, status: v ? 'cancelled' : '' })} label=${t('common.show_cancelled')} />
      <div class="toolbar-end">
      ${can('payments.collect') && html`<${Btn} icon="hand-coins" kind="primary" onClick=${() => newPay('in')}>${t('pay.collect')}</${Btn}>`}
      ${can('payments.pay') && html`<${Btn} icon="send" onClick=${() => newPay('out')}>${t('pay.pay')}</${Btn}>`}
      </div>
    </div>
    ${Object.keys(totals).length > 0 && html`<div class="grid-4 mb-16">${Object.entries(totals).map(([cur, v]) => html`<div class="panel stat">
      <div class="k">${cur}</div>
      <div class="row between mt-8"><span class="small muted">${t('pay.dir.in')}</span><${Money} value=${v.in} cur=${cur} cls="pos strong" /></div>
      <div class="row between"><span class="small muted">${t('pay.dir.out')}</span><${Money} value=${v.out} cur=${cur} cls="neg strong" /></div>
      <div class="row between" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span class="small muted">${t('common.net')}</span><${Money} value=${v.in - v.out} cur=${cur} colored strong /></div>
    </div>`)}</div>`}
    <div class="panel">
      ${loading && !data ? html`<${Loading} />` : error ? html`<div class="panel-body"><${Notice} kind="err">${error.message}</${Notice}></div>` : html`<${Table}
        rows=${rows} onRow=${open} rowCls=${(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
        empty=${html`<${Empty} icon="hand-coins" title=${t('pay.none')} />`}
        columns=${[
          { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
          { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
          { key: 'partner', label: t('doc.partner'), render: (r) => html`<span dir="auto">${dn(r.partner_name)}</span>` },
          { key: 'dir', label: t('common.type'), render: (r) => html`<${Pill} kind=${r.direction === 'in' ? 'in' : 'out'}>${t(r.direction === 'in' ? 'pay.dir.in' : 'pay.dir.out')}</${Pill}>` },
          { key: 'acc', label: t('pay.account'), render: (r) => html`<span class="small">${r.account_name}</span><div class="sub">${t(`pay.method.${r.method}`)}</div>` },
          { key: 'docs', label: t('pay.for_invoices'), render: (r) => html`<span class="small">${r.doc_nos || html`<span class="muted">${t('pay.on_account')}</span>`}</span>` },
          { key: 'amount', label: t('pay.amount'), align: 'r', render: (r) => html`<${Money} value=${r.direction === 'in' ? r.amount : -r.amount} cur=${r.currency} colored strong />
            ${r.applied_currency !== r.currency && html`<div class="sub num">→ ${money(r.applied_amount, r.applied_currency)}</div>`}` },
          { key: 'user', label: t('common.user'), render: (r) => html`<span class="small muted">${r.user_name || ''}</span>` },
        ]} />`}
    </div>
  </div>`;
}
