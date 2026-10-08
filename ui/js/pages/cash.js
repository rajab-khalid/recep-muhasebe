// Cash & bank: one account per currency, statements, transfers and currency exchange (döviz bozdurma),
// cash counts (system vs. physical) and manual corrections.
import { html, useState, useEffect, useMemo } from '../core/h.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate, setQuery } from '../core/router.js';
import { refreshBoot } from '../core/session.js';
import { money, num, convert, today, date as fdate, dateTime, round, decimals, usdIqd } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, Money, KV, Tabs,
  DateRange, periodRange, SearchBox, MenuButton, useAsync, useDebounced, openModal, toast, errToast, confirmDialog, promptDialog, DateInput } from '../core/ui.js';
import { printTables } from '../core/print.js';
import { downloadXlsx } from '../core/xlsx.js';
import { CurrencySelect, accountOptions } from './pickers.js';
import { PaymentDrawer } from './payments.js';

const TYPE_ICON = { cash: 'banknote', bank: 'landmark', pos: 'credit-card' };
const DENOMS = { IQD: [50000, 25000, 10000, 5000, 1000, 500, 250], USD: [100, 50, 20, 10, 5, 1], EUR: [500, 200, 100, 50, 20, 10, 5] };
const canManage = (type) => can(type === 'bank' ? 'bank.manage' : 'cash.manage');

/* ------------------------------------------------------------------ dialogs */
export function AccountDialog({ account: a0, close }) {
  const a = a0 || { type: 'cash', currency: 'IQD', active: 1 };
  const [f, setF] = useState({ type: a.type, name: a.name || '', currency: a.currency, bank_name: a.bank_name || '', branch: a.branch || '', account_no: a.account_no || '', iban: a.iban || '',
    opening_balance: a.opening_balance || 0, opening_date: a.opening_date || '', notes: a.notes || '', is_default: !!a.is_default, active: a.active === undefined ? true : !!a.active });
  const set = (p) => setF({ ...f, ...p });
  const save = async () => {
    try { await api.post('/api/money/accounts', { ...f, id: a.id }); await refreshBoot(); toast(t('common.saved')); close(true); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${a.id ? t('cash.edit_account') : t('cash.new_account')} icon="wallet" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!f.name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Segmented} value=${f.type} onValue=${(v) => set({ type: v })} options=${['cash', 'bank', 'pos'].map((x) => ({ value: x, label: t(`cash.type.${x}`) }))} />
      <div class="form-2">
        <${Field} label=${t('common.name')} required><${Input} value=${f.name} onValue=${(v) => set({ name: v })} autoFocus placeholder=${t(`cash.name_ph.${f.type}`)} /></${Field}>
        <${Field} label=${t('common.currency')} hint=${a.id ? t('cash.currency_locked') : null}><${CurrencySelect} value=${f.currency} onValue=${(v) => set({ currency: v })} /></${Field}>
      </div>
      ${f.type !== 'cash' && html`<div class="form-2">
        <${Field} label=${t('cash.bank_name')}><${Input} value=${f.bank_name} onValue=${(v) => set({ bank_name: v })} /></${Field}>
        <${Field} label=${t('cash.branch')}><${Input} value=${f.branch} onValue=${(v) => set({ branch: v })} /></${Field}>
        <${Field} label=${t('cash.account_no')}><${Input} value=${f.account_no} onValue=${(v) => set({ account_no: v })} /></${Field}>
        <${Field} label="IBAN"><${Input} value=${f.iban} onValue=${(v) => set({ iban: v })} /></${Field}>
      </div>`}
      <div class="form-2">
        <${Field} label=${t('cash.opening_balance')} hint=${t('cash.opening_hint')}><${NumInput} value=${f.opening_balance} onValue=${(v) => set({ opening_balance: v || 0 })} dec=${decimals(f.currency)} /></${Field}>
        <${Field} label=${t('cash.opening_date')}><${DateInput} value=${f.opening_date} onValue=${(v) => set({ opening_date: v })} /></${Field}>
      </div>
      <${Field} label=${t('doc.notes')}><${Input} value=${f.notes} onValue=${(v) => set({ notes: v })} /></${Field}>
      <${Check} checked=${f.is_default} onValue=${(v) => set({ is_default: v })} label=${t('cash.is_default', { type: t(`cash.type.${f.type}`), cur: f.currency })} />
      ${a.id && html`<${Check} checked=${f.active} onValue=${(v) => set({ active: v })} label=${t('common.active')} />`}
    </div>
  </${Modal}>`;
}

export function TransferDialog({ from: fromId, close }) {
  const accs = (boot().money_accounts || []).filter((a) => a.active);
  const [fromAcc, setFromAcc] = useState(fromId || (accs[0] || {}).id || '');
  const [toAcc, setToAcc] = useState((accs.find((a) => a.id !== (fromId || (accs[0] || {}).id)) || {}).id || '');
  const fa = accs.find((a) => a.id === fromAcc);
  const ta = accs.find((a) => a.id === toAcc);
  const exchange = fa && ta && fa.currency !== ta.currency;
  const [amount, setAmount] = useState(null);
  const [rate, setRate] = useState(usdIqd());
  const [toAmount, setToAmount] = useState(null);
  const [toManual, setToManual] = useState(false);
  const [fee, setFee] = useState(null);
  const [date, setDate] = useState(today());
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const autoTo = exchange && amount ? round(convert(amount, fa.currency, ta.currency, rate), decimals(ta.currency)) : amount;
  const toShown = exchange ? (toManual ? toAmount : autoTo) : amount;
  const effRate = exchange && amount && toShown && ['USD', 'IQD'].includes(fa.currency) && ['USD', 'IQD'].includes(ta.currency)
    ? (fa.currency === 'USD' ? toShown / amount : amount / toShown) : null;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/money/transfer', { from_account_id: fromAcc, to_account_id: toAcc, from_amount: amount, to_amount: exchange ? toShown : undefined, usd_iqd: rate, fee: fee || 0, date, description: desc });
      toast(t(exchange ? 'cash.exchanged' : 'cash.transferred', { no: r.no }));
      close(true);
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${t(exchange ? 'cash.exchange' : 'cash.transfer')} icon="arrow-left-right" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${busy || !(amount > 0) || !toAcc || fromAcc === toAcc}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="form-2">
        <${Field} label=${t('cash.from_account')}><${Select} value=${fromAcc} onValue=${setFromAcc} options=${accountOptions()} /></${Field}>
        <${Field} label=${t('cash.to_account')}><${Select} value=${toAcc} onValue=${setToAcc} options=${accountOptions().filter((o) => o.value !== fromAcc)} placeholder="—" /></${Field}>
        <${Field} label=${`${t('cash.amount_out')} (${fa ? fa.currency : ''})`}><${NumInput} value=${amount} onValue=${setAmount} dec=${fa ? decimals(fa.currency) : 2} autoFocus /></${Field}>
        ${exchange ? html`<${Field} label=${`${t('cash.amount_in')} (${ta.currency})`} hint=${t('cash.amount_in_hint')}><${NumInput} value=${toShown} onValue=${(v) => { setToManual(true); setToAmount(v); }} dec=${decimals(ta.currency)} /></${Field}>` : html`<div></div>`}
        ${exchange && html`<${Field} label=${t('rate.label')}><${NumInput} value=${rate} onValue=${(v) => { setRate(v); setToManual(false); }} dec=${2} /></${Field}>`}
        <${Field} label=${t('cash.fee')} hint=${t('cash.fee_hint')}><${NumInput} value=${fee} onValue=${setFee} dec=${fa ? decimals(fa.currency) : 2} /></${Field}>
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
        <${Field} label=${t('common.description')}><${Input} value=${desc} onValue=${setDesc} /></${Field}>
      </div>
      ${exchange && effRate && html`<${Notice}>${t('cash.effective_rate', { rate: num(effRate, 2) })}</${Notice}>`}
    </div>
  </${Modal}>`;
}

export function CountDialog({ account: initial, close }) {
  const accs = (boot().money_accounts || []).filter((a) => a.active && a.type === 'cash');
  const [accId, setAccId] = useState(initial ? initial.id : (accs[0] || {}).id);
  const [list, setList] = useState(null);
  const acc = (list || []).find((a) => a.id === accId) || accs.find((a) => a.id === accId);
  const [date, setDate] = useState(today());
  const [counts, setCounts] = useState({});
  const [direct, setDirect] = useState(null);
  const [mode, setMode] = useState('notes');
  const [post, setPost] = useState(true);
  const [kind, setKind] = useState('count_diff');
  const [note, setNote] = useState('');
  useEffect(() => { api.get('/api/money/accounts').then(setList).catch(() => setList([])); }, []);
  const denoms = acc ? DENOMS[acc.currency] || [] : [];
  const fromNotes = denoms.reduce((s, d) => s + d * (counts[d] || 0), 0) + (counts.other || 0);
  const counted = mode === 'notes' && denoms.length ? fromNotes : direct || 0;
  const system = acc && acc.balance !== undefined ? acc.balance : null;
  const diff = system !== null ? round(counted - system, acc ? decimals(acc.currency) : 2) : null;
  const save = async () => {
    try {
      const r = await api.post('/api/money/count', { account_id: accId, date, counted, details: mode === 'notes' ? counts : null, post_diff: post && diff !== 0, diff_kind: kind, note });
      toast(r.diff ? t('cash.count_saved_diff', { diff: money(r.diff, acc.currency, { sign: true }) }) : t('cash.count_saved_ok'));
      close(true);
    } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('cash.count')} icon="calculator" close=${close} size="wide" onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary">${t('cash.save_count')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="form-3">
        <${Field} label=${t('cash.account')}><${Select} value=${accId} onValue=${(v) => { setAccId(v); setCounts({}); }} options=${accs.map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }))} /></${Field}>
        <${Field} label=${t('common.date')} hint=${date !== today() ? t('cash.count_past') : null}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
        ${denoms.length > 0 && html`<${Field} label=${t('cash.count_mode')}><${Segmented} value=${mode} onValue=${setMode} options=${[{ value: 'notes', label: t('cash.by_notes') }, { value: 'total', label: t('cash.by_total') }]} /></${Field}>`}
      </div>
      ${mode === 'notes' && denoms.length > 0 ? html`<div class="denoms">
        ${denoms.map((d) => html`<div class="denom"><span class="num strong">${num(d)}</span><span class="muted">×</span>
          <div style="width:90px"><${NumInput} size="sm" value=${counts[d] ?? null} onValue=${(v) => setCounts({ ...counts, [d]: v || 0 })} dec=${0} /></div>
          <span class="num small muted" style="min-width:110px;text-align:end">${money(d * (counts[d] || 0), acc.currency)}</span></div>`)}
        <div class="denom"><span class="small">${t('cash.coins_other')}</span><span></span><div style="width:90px"><${NumInput} size="sm" value=${counts.other ?? null} onValue=${(v) => setCounts({ ...counts, other: v || 0 })} dec=${2} /></div><span></span></div>
      </div>` : html`<${Field} label=${t('cash.counted_total')}><${NumInput} value=${direct} onValue=${setDirect} dec=${acc ? decimals(acc.currency) : 2} cls="lg" autoFocus /></${Field}>`}
      ${acc && html`<div class="pay-due">
        <div><div class="k">${t('cash.system_balance')}${date !== today() ? ' *' : ''}</div><div class="v num">${system !== null ? money(system, acc.currency) : '…'}</div></div>
        <div style="text-align:end"><div class="k">${t('cash.counted')}</div><div class="v num">${money(counted, acc.currency)}</div>
          <div class=${`k ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}`} style="font-size:14px">${t('cash.difference')}: <b class="num">${diff !== null ? money(diff, acc.currency, { sign: true }) : ''}</b></div></div>
      </div>`}
      ${diff !== null && diff !== 0 && html`<div class="col gap-8">
        <${Check} checked=${post} onValue=${setPost} label=${t('cash.post_diff')} />
        ${post && html`<${Segmented} value=${kind} onValue=${setKind} options=${[{ value: 'count_diff', label: t('cash.diff_real') }, { value: 'opening', label: t('cash.diff_opening') }]} />
          <p class="small muted" style="margin:0">${t(kind === 'opening' ? 'cash.diff_opening_hint' : 'cash.diff_real_hint')}</p>`}
      </div>`}
      <${Field} label=${t('common.note')}><${Input} value=${note} onValue=${setNote} /></${Field}>
    </div>
  </${Modal}>`;
}

function ManualDialog({ account, close }) {
  const [dir, setDir] = useState('in');
  const [amount, setAmount] = useState(null);
  const [kind, setKind] = useState('adjust');
  const [date, setDate] = useState(today());
  const [desc, setDesc] = useState('');
  const save = async () => {
    try { await api.post('/api/money/manual', { account_id: account.id, amount: dir === 'out' ? -Math.abs(amount) : Math.abs(amount), kind, date, description: desc }); toast(t('common.saved')); close(true); } catch (e) { errToast(e); }
  };
  return html`<${Modal} title=${t('cash.manual')} icon="pencil" close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!(amount > 0) || !desc.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <${Notice} kind="warn">${t('cash.manual_text')}</${Notice}>
      <div class="row gap-12 wrap"><${Segmented} value=${dir} onValue=${setDir} options=${[{ value: 'in', label: t('cash.money_in') }, { value: 'out', label: t('cash.money_out') }]} />
        <${Segmented} value=${kind} onValue=${setKind} options=${[{ value: 'adjust', label: t('cash.kind_adjust') }, { value: 'opening', label: t('cash.kind_opening') }]} /></div>
      <div class="form-2">
        <${Field} label=${`${t('pay.amount')} (${account.currency})`}><${NumInput} value=${amount} onValue=${setAmount} dec=${decimals(account.currency)} autoFocus /></${Field}>
        <${Field} label=${t('common.date')}><${DateInput} value=${date} onValue=${setDate} /></${Field}>
      </div>
      <${Field} label=${t('common.description')} required><${Input} value=${desc} onValue=${setDesc} /></${Field}>
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ overview */
export function Cash({ query = {} }) {
  useTitle(t('nav.cash'));
  const tab = query.tab || 'accounts';
  const [showClosed, setShowClosed] = useState(false);
  const { data, loading, reload } = useAsync(() => api.get('/api/money/accounts', { include_inactive: showClosed ? 1 : '' }), [showClosed]);
  const accs = data || [];
  const byCur = useMemo(() => {
    const m = {};
    for (const a of accs) {
      if (!a.active) continue;
      m[a.currency] = m[a.currency] || { cash: 0, bank: 0, pos: 0 };
      m[a.currency][a.type] += a.balance;
    }
    return m;
  }, [accs]);
  const after = (p) => p.then((r) => { if (r) { reload(); refreshBoot(); } });
  return html`<div class="page">
    <div class="toolbar">
      <${Tabs} value=${tab} onValue=${(v) => setQuery({ tab: v === 'accounts' ? undefined : v })} tabs=${[
        { id: 'accounts', label: t('cash.accounts'), icon: 'wallet' },
        { id: 'transfers', label: t('cash.transfers'), icon: 'arrow-left-right' },
        can('cash.view') && { id: 'counts', label: t('cash.counts'), icon: 'calculator' },
      ]} />
      <div class="toolbar-end">
      ${can(['cash.manage', 'bank.manage']) && html`<${Btn} icon="arrow-left-right" onClick=${() => after(openModal(TransferDialog, {}))}>${t('cash.transfer_exchange')}</${Btn}>`}
      ${can('cash.manage') && html`<${Btn} icon="calculator" onClick=${() => after(openModal(CountDialog, {}))}>${t('cash.count')}</${Btn}>`}
      ${can(['cash.manage', 'bank.manage']) && html`<${Btn} kind="primary" icon="plus" onClick=${() => after(openModal(AccountDialog, {}))}>${t('cash.new_account')}</${Btn}>`}
      </div>
    </div>
    ${tab === 'accounts' && html`<div class="stack">
      <div class="grid-4">${Object.entries(byCur).map(([c, v]) => html`<div class="panel stat">
        <div class="k">${c}</div><div class=${`v ${v.cash + v.bank + v.pos < 0 ? 'neg' : ''}`}><${Money} value=${v.cash + v.bank + v.pos} cur=${c} /></div>
        <div class="s">${t('cash.type.cash')}: ${money(v.cash, c)}${v.bank ? ` · ${t('cash.type.bank')}: ${money(v.bank, c)}` : ''}${v.pos ? ` · ${t('cash.type.pos')}: ${money(v.pos, c)}` : ''}</div>
      </div>`)}</div>
      ${accs.some((a) => a.active && a.type === 'cash' && a.balance < 0) && html`<${Notice} kind="warn">${t('cash.negative_warning')}</${Notice}>`}
      <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${accs} onRow=${(a) => navigate(`/cash/${a.id}`)} rowCls=${(a) => (a.active ? '' : 'cancelled')}
        columns=${[
          { key: 'name', label: t('common.name'), render: (a) => html`<div class="row gap-8"><${Icon} name=${TYPE_ICON[a.type] || 'wallet'} cls="muted" /><div><div class="cell-name">${a.name}${a.is_default ? html` <${Pill} kind="brass">${t('common.default')}</${Pill}>` : null}</div>${a.bank_name ? html`<div class="sub">${a.bank_name}${a.account_no ? ` · ${a.account_no}` : ''}</div>` : null}</div></div>` },
          { key: 'type', label: t('common.type'), render: (a) => t(`cash.type.${a.type}`) },
          { key: 'cur', label: t('common.currency'), render: (a) => a.currency },
          { key: 'bal', label: t('partner.balance'), align: 'r', render: (a) => html`<${Money} value=${a.balance} cur=${a.currency} strong cls=${a.balance < 0 ? 'neg' : ''} />` },
          { key: 'last', label: t('cash.last_move'), render: (a) => html`<span class="small muted">${a.last_move ? fdate(a.last_move) : ''}</span>` },
          { key: 'count', label: t('cash.last_count'), render: (a) => (a.last_count ? html`<span class="small">${fdate(a.last_count.date)}</span> ${a.last_count.diff ? html`<span class=${`small num ${a.last_count.diff < 0 ? 'neg' : 'pos'}`}>${money(a.last_count.diff, a.currency, { sign: true })}</span>` : html`<${Icon} name="check" size="sm" cls="pos" />`}` : html`<span class="small muted">—</span>`) },
          { key: 'act', label: '', cls: 'w-actions', render: (a) => a.active && canManage(a.type) && html`<${MenuButton} iconOnly icon="ellipsis" title=${t('common.more')} items=${[
            a.type === 'cash' && can('cash.manage') && { label: t('cash.count'), icon: 'calculator', onClick: () => after(openModal(CountDialog, { account: a })) },
            { label: t('cash.transfer_exchange'), icon: 'arrow-left-right', onClick: () => after(openModal(TransferDialog, { from: a.id })) },
            { label: t('cash.manual'), icon: 'pencil', onClick: () => after(openModal(ManualDialog, { account: a })) },
            { label: t('common.edit'), icon: 'settings', onClick: () => after(openModal(AccountDialog, { account: a })) },
          ]} />` },
        ]} />`}</div>
      <${Check} checked=${showClosed} onValue=${setShowClosed} label=${t('cash.show_closed')} />
    </div>`}
    ${tab === 'transfers' && html`<${Transfers} />`}
    ${tab === 'counts' && html`<${Counts} />`}
  </div>`;
}

function Transfers() {
  const r0 = periodRange('3m');
  const [f, setF] = useState(r0);
  const { data, loading, reload } = useAsync(() => api.get('/api/money/transfers', f), [f.from, f.to]);
  const cancel = async (x) => {
    const reason = await promptDialog({ title: t('cash.cancel_transfer', { no: x.no }), inputLabel: t('common.reason'), okText: t('common.cancel_doc'), danger: true, requireText: true });
    if (!reason) return;
    try { await api.post(`/api/money/transfers/${x.id}/cancel`, { reason }); toast(t('common.cancelled')); reload(); refreshBoot(); } catch (e) { errToast(e); }
  };
  return html`<div>
    <div class="toolbar"><${DateRange} from=${f.from} to=${f.to} onChange=${setF} /></div>
    <div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []} rowCls=${(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
      empty=${html`<${Empty} icon="arrow-left-right" title=${t('cash.no_transfers')} />`}
      columns=${[
        { key: 'no', label: t('doc.no'), render: (r) => html`<span class="strong">${r.no}</span>` },
        { key: 'date', label: t('common.date'), render: (r) => fdate(r.date) },
        { key: 'kind', label: t('common.type'), render: (r) => html`<${Pill} kind=${r.kind === 'exchange' ? 'brass' : ''}>${t(`cash.kind.${r.kind}`)}</${Pill}>` },
        { key: 'from', label: t('cash.from_account'), render: (r) => html`${r.from_name}<div class="sub num">−${money(r.from_amount, r.from_currency)}</div>` },
        { key: 'to', label: t('cash.to_account'), render: (r) => html`${r.to_name}<div class="sub num">+${money(r.to_amount, r.to_currency)}</div>` },
        { key: 'rate', label: t('rate.short'), align: 'r', render: (r) => (r.kind === 'exchange' ? html`<span class="num small">${num(r.usd_iqd, 2)}</span>` : '') },
        { key: 'fee', label: t('cash.fee'), align: 'r', render: (r) => (r.fee ? html`<span class="num small neg">${money(r.fee, r.from_currency)}</span>` : '') },
        { key: 'desc', label: t('common.description'), render: (r) => html`<span class="small" dir="auto">${r.description || ''}</span><div class="sub">${r.user_name || ''}</div>` },
        { key: 'act', label: '', cls: 'w-actions', render: (r) => r.status === 'posted' && can(['cash.manage', 'bank.manage']) && html`<${IconBtn} icon="ban" danger title=${t('common.cancel_doc')} onClick=${() => cancel(r)} />` },
      ]} />`}</div>
  </div>`;
}

function Counts() {
  const { data, loading } = useAsync(() => api.get('/api/money/counts'), []);
  return html`<div class="panel">${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${data || []}
    empty=${html`<${Empty} icon="calculator" title=${t('cash.no_counts')} />`}
    columns=${[
      { key: 'date', label: t('common.date'), render: (r) => html`${fdate(r.date)}<div class="sub">${dateTime(r.created_at)}</div>` },
      { key: 'acc', label: t('cash.account'), render: (r) => r.account_name },
      { key: 'sys', label: t('cash.system_balance'), align: 'r', render: (r) => html`<${Money} value=${r.system_balance} cur=${r.currency} />` },
      { key: 'cnt', label: t('cash.counted'), align: 'r', render: (r) => html`<${Money} value=${r.counted} cur=${r.currency} strong />` },
      { key: 'diff', label: t('cash.difference'), align: 'r', render: (r) => html`<${Money} value=${r.diff} cur=${r.currency} colored sign />` },
      { key: 'posted', label: t('cash.posted'), render: (r) => (r.diff ? (r.posted ? html`<${Pill} kind="in">${t('common.yes')}</${Pill}>` : html`<${Pill}>${t('common.no')}</${Pill}>`) : '') },
      { key: 'user', label: t('common.user'), render: (r) => html`<span class="small">${r.user_name || ''}</span>${r.note ? html`<div class="sub" dir="auto">${r.note}</div>` : null}` },
    ]} />`}</div>`;
}

/* ------------------------------------------------------------------ account statement */
const MONEY_KINDS = ['collection', 'payment', 'change', 'expense', 'income', 'transfer', 'exchange', 'fee', 'purchase_extra', 'adjust', 'opening', 'count_diff'];
export function CashAccountPage({ id, query = {} }) {
  const r0 = periodRange('month');
  const [f, setF] = useState({ from: query.from || r0.from, to: query.to || r0.to, kind: '', q: '' });
  const dq = useDebounced(f.q, 250);
  const { data, loading, error, reload } = useAsync(() => api.get(`/api/money/accounts/${id}/statement`, { from: f.from, to: f.to, kind: f.kind, q: dq }), [id, f.from, f.to, f.kind, dq]);
  const a = data && data.account;
  useTitle(a ? a.name : t('common.loading'), [{ label: t('nav.cash'), href: '#/cash' }]);
  if (error) return html`<div class="page"><${Notice} kind="err">${error.message}</${Notice}></div>`;
  if (loading && !data) return html`<${Loading} />`;
  const cur = a.currency;
  const after = (p) => p.then((r) => { if (r) { reload(); refreshBoot(); } });
  const cancelMove = async (m) => {
    const reason = await promptDialog({ title: t('cash.cancel_move'), text: m.description || '', inputLabel: t('common.reason'), okText: t('common.cancel_doc'), danger: true, requireText: true });
    if (!reason) return;
    try { await api.post(`/api/money/moves/${m.id}/cancel`, { reason }); toast(t('common.cancelled')); reload(); refreshBoot(); } catch (e) { errToast(e); }
  };
  const open = (r) => {
    if (r.payment_id) openModal(PaymentDrawer, { id: r.payment_id }).then((x) => x && reload());
    else if (r.doc_id) navigate(`/doc/${r.doc_id}`);
    else if (r.entry_id) navigate('/finance');
  };
  const rows = data.rows;
  const printIt = () => printTables(`${a.name} (${cur})`, `${fdate(f.from)} — ${fdate(f.to)}`, [{
    headers: [{ label: t('common.date') }, { label: t('common.type') }, { label: t('common.description') }, { label: t('cash.in'), r: true }, { label: t('cash.out'), r: true }, { label: t('partner.balance'), r: true }],
    rows: [[fdate(f.from), t('partner.opening_balance'), '', '', '', money(data.opening, cur)], ...rows.map((r) => [fdate(r.date), t(`move.money.${r.kind}`), [r.doc_no || r.payment_no || r.entry_no || r.transfer_no, r.description].filter(Boolean).join(' — '), r.amount > 0 ? money(r.amount, cur) : '', r.amount < 0 ? money(-r.amount, cur) : '', money(r.balance, cur)])],
    foot: ['', '', t('common.total'), money(data.total_in, cur), money(data.total_out, cur), money(data.closing, cur)],
  }]);
  const exportX = () => downloadXlsx(`${a.name}-${f.from}-${f.to}`, [{ name: a.name, headers: [t('common.date'), t('common.type'), t('doc.no'), t('common.description'), t('doc.partner'), t('cash.in'), t('cash.out'), t('partner.balance'), t('common.user')],
    rows: rows.map((r) => [r.date, t(`move.money.${r.kind}`), r.doc_no || r.payment_no || r.entry_no || r.transfer_no || '', r.description || '', r.partner_name || '', r.amount > 0 ? r.amount : '', r.amount < 0 ? -r.amount : '', r.balance, r.user_name || '']) }]);
  return html`<div class="page stack">
    <div class="row wrap gap-8">
      <div class="grow row gap-8"><${Icon} name=${TYPE_ICON[a.type]} /><span class="small muted">${t(`cash.type.${a.type}`)} · ${cur}${a.bank_name ? ` · ${a.bank_name}` : ''}${a.iban ? ` · ${a.iban}` : ''}</span></div>
      ${a.type === 'cash' && can('cash.manage') && html`<${Btn} icon="calculator" onClick=${() => after(openModal(CountDialog, { account: { ...a } }))}>${t('cash.count')}</${Btn}>`}
      ${canManage(a.type) && html`<${Btn} icon="arrow-left-right" onClick=${() => after(openModal(TransferDialog, { from: a.id }))}>${t('cash.transfer_exchange')}</${Btn}>
        <${Btn} icon="pencil" onClick=${() => after(openModal(ManualDialog, { account: a }))}>${t('cash.manual')}</${Btn}>`}
      <${IconBtn} icon="printer" title=${t('common.print')} onClick=${printIt} />
      <${IconBtn} icon="file-spreadsheet" title=${t('common.export_excel')} onClick=${exportX} />
    </div>
    <div class="grid-4">
      <div class="panel stat"><div class="k">${t('partner.opening_balance')}</div><div class="v"><${Money} value=${data.opening} cur=${cur} /></div><div class="s">${fdate(f.from)}</div></div>
      <div class="panel stat"><div class="k">${t('cash.in')}</div><div class="v pos"><${Money} value=${data.total_in} cur=${cur} /></div></div>
      <div class="panel stat"><div class="k">${t('cash.out')}</div><div class="v neg"><${Money} value=${data.total_out} cur=${cur} /></div></div>
      <div class="panel stat"><div class="k">${t('cash.closing')}</div><div class="v"><${Money} value=${data.closing} cur=${cur} /></div><div class="s">${t('cash.now')}: ${money(a.balance, cur)}</div></div>
    </div>
    <div class="toolbar" style="margin:0">
      <${DateRange} from=${f.from} to=${f.to} onChange=${(r) => setF({ ...f, ...r })} />
      <div style="width:170px"><${Select} value=${f.kind} onValue=${(v) => setF({ ...f, kind: v })} options=${[{ value: '', label: t('stock.all_kinds') }, ...MONEY_KINDS.map((k) => ({ value: k, label: t(`move.money.${k}`) }))]} /></div>
      <${SearchBox} value=${f.q} onValue=${(v) => setF({ ...f, q: v })} cls="search" />
    </div>
    <div class="panel">${!rows.length ? html`<${Empty} icon="wallet" title=${t('cash.no_moves')} />` : html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>${t('common.date')}</th><th>${t('common.type')}</th><th>${t('common.description')}</th><th class="r">${t('cash.in')}</th><th class="r">${t('cash.out')}</th><th class="r">${t('partner.balance')}</th><th class="w-actions"></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class=${r.payment_id || r.doc_id || r.entry_id ? 'clickable' : ''} onClick=${(e) => { if (!e.target.closest('button')) open(r); }}>
        <td class="nowrap">${fdate(r.date)}<div class="sub">${(r.created_at || '').slice(11, 16)}</div></td>
        <td>${t(`move.money.${r.kind}`)}<div class="sub">${r.doc_no || r.payment_no || r.entry_no || r.transfer_no || ''}</div></td>
        <td class="small" dir="auto">${r.description || ''}${r.category_name ? html`<div class="sub">${r.category_name}</div>` : null}<div class="sub">${r.user_name || ''}</div></td>
        <td class="r">${r.amount > 0 ? html`<${Money} value=${r.amount} cur=${cur} cls="pos" />` : ''}</td>
        <td class="r">${r.amount < 0 ? html`<${Money} value=${-r.amount} cur=${cur} cls="neg" />` : ''}</td>
        <td class="r"><${Money} value=${r.balance} cur=${cur} strong /></td>
        <td class="w-actions">${['adjust', 'opening', 'count_diff'].includes(r.kind) && canManage(a.type) ? html`<${IconBtn} icon="ban" danger title=${t('common.cancel_doc')} onClick=${() => cancelMove(r)} />` : null}</td>
      </tr>`)}</tbody></table></div>`}</div>
  </div>`;
}
