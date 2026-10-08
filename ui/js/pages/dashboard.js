// Dashboard: an instrument cluster (today vs. an average day, this month vs. last month, cash readouts),
// then the 14-day sales chart, stock alerts, open work orders, overdue invoices, best sellers.
import { html, useState, useEffect, useRef } from '../core/h.js';
import { t, isRtl } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, useStore, setting } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { money, num, convert, date as fdate, daysBetween, today, pct, compact } from '../core/format.js';
import { Icon, Btn, Panel, Empty, Loading, Pill, Money, Notice, useAsync, openModal } from '../core/ui.js';
import { PaymentDialog } from './payments.js';
import { FinanceEntryDialog } from './finance.js';
import { dn } from '../core/names.js';

export function Dashboard() {
  useTitle(t('nav.dashboard'));
  const dc = useStore((s) => s.displayCurrency);
  const { data, loading, error, reload } = useAsync(() => api.get('/api/dashboard'), []);
  useEffect(() => { const tm = setInterval(reload, 60000); return () => clearInterval(tm); }, [reload]);
  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${Notice} kind="err">${error.message}</${Notice}>`;
  const d = data;
  const rate = d.usd_iqd;
  const disp = (usd, opts) => money(dc === 'USD' ? usd : usd * rate, dc, opts);
  const cash = d.cash.filter((a) => a.type === 'cash');
  const banks = d.cash.filter((a) => a.type !== 'cash');
  const sumCur = (list, cur) => list.filter((a) => a.currency === cur).reduce((s, a) => s + a.balance, 0);
  const recvUsd = d.receivable ? Object.entries(d.receivable).reduce((s, [c, v]) => s + convert(v, c, 'USD', rate), 0) : null;
  const payUsd = d.payable ? Object.entries(d.payable).reduce((s, [c, v]) => s + convert(v, c, 'USD', rate), 0) : null;
  const collect = (cur) => (d.today.collections.find((c) => c.currency === cur) || {}).amount || 0;

  return html`<div class="page stack">
    <div class="row wrap gap-8">
      <div class="grow small muted">${t('dash.greeting', { date: fdate(d.date) })}</div>
      ${can('payments.collect') && html`<${Btn} icon="hand-coins" onClick=${() => openModal(PaymentDialog, { direction: 'in' }).then((r) => r && reload())}>${t('pay.collect')}</${Btn}>`}
      ${can('purchases.create') && html`<${Btn} icon="truck" onClick=${() => navigate('/docs/purchase/new')}>${t('doc.new.purchase')}</${Btn}>`}
      ${can('finance.manage') && html`<${Btn} icon="receipt-text" onClick=${() => openModal(FinanceEntryDialog, { kind: 'expense' }).then((r) => r && reload())}>${t('fin.new_expense')}</${Btn}>`}
      ${can(['pos.use', 'sales.create']) && html`<${Btn} kind="primary" icon="shopping-cart" onClick=${() => navigate('/pos')}>${t('pos.new_sale')}</${Btn}>`}
    </div>

    <section class="cluster" aria-label=${t('dash.cluster')}>
      <${Gauge} label=${t('dash.today_sales')} value=${d.today.sales_usd} target=${d.avg_daily_usd} targetLabel=${t('dash.avg_day')}
        main=${disp(d.today.sales_usd)} sub=${t('dash.sales_count', { n: d.today.sales_count })} disp=${disp} />
      <div class="readouts">
        <${Readout} k=${t('dash.gross_profit_today')} icon="trending-up" v=${d.today.profit_usd !== null ? disp(d.today.profit_usd) : '—'} cls=${d.today.profit_usd > 0 ? 'pos' : d.today.profit_usd < 0 ? 'neg' : ''}
          s=${d.today.profit_usd !== null && d.today.sales_usd > 0 ? t('dash.margin', { pct: pct(d.today.profit_usd / d.today.sales_usd * 100) }) : t('dash.no_sales_yet')} />
        <${Readout} k=${t('dash.collected_today')} icon="hand-coins" v=${money(collect('IQD'), 'IQD')} s=${money(collect('USD'), 'USD')} />
        <${Readout} k=${t('dash.month_sales')} icon="calendar" v=${disp(d.month.sales_usd)} s=${t('dash.month_docs', { n: d.month.count })} />
        <${Readout} k=${t('dash.cash_iqd')} icon="wallet" v=${money(sumCur(cash, 'IQD'), 'IQD')} cls=${sumCur(cash, 'IQD') < 0 ? 'neg' : ''} s=${banks.length ? t('dash.bank_total', { amount: money(sumCur(banks, 'IQD'), 'IQD') }) : ' '} onClick=${can('cash.view') ? () => navigate('/cash') : null} />
        <${Readout} k=${t('dash.cash_usd')} icon="wallet" v=${money(sumCur(cash, 'USD'), 'USD')} cls=${sumCur(cash, 'USD') < 0 ? 'neg' : ''} s=${banks.length ? t('dash.bank_total', { amount: money(sumCur(banks, 'USD'), 'USD') }) : ' '} onClick=${can('cash.view') ? () => navigate('/cash') : null} />
        <${Readout} k=${t('dash.receivable')} icon="users" v=${recvUsd !== null ? disp(recvUsd) : '—'} s=${payUsd !== null ? t('dash.payable_short', { amount: disp(payUsd) }) : ''} onClick=${can('partners.view') ? () => navigate('/partners/customer', { balance: 'debtors' }) : null} />
      </div>
      <${Gauge} second label=${t('dash.this_month')} value=${d.month.sales_usd} target=${d.month.last_month_same_usd} targetLabel=${t('dash.last_month_same')}
        main=${disp(d.month.sales_usd)} sub=${d.month.last_month_same_usd > 0 ? t('dash.vs_last_month', { pct: pct((d.month.sales_usd / d.month.last_month_same_usd - 1) * 100, 0) }) : t('dash.no_last_month')} disp=${disp} />
    </section>

    ${d.recurring_pending > 0 && can('finance.manage') && html`<${Notice} kind="warn">${t('dash.recurring_pending', { n: d.recurring_pending })} <button class="link-btn" onClick=${() => navigate('/finance', { tab: 'recurring' })}>${t('common.open')}</button></${Notice}>`}
    ${d.cash.some((a) => a.balance < 0 && a.type === 'cash') && can('cash.manage') && html`<${Notice} kind="warn">${t('dash.negative_cash')} <button class="link-btn" onClick=${() => navigate('/cash')}>${t('cash.count')}</button></${Notice}>`}

    <div class="split wide-side">
      <${Panel} title=${t('dash.chart_title')} tools=${d.chart.some((c) => c.profit_usd !== null) && html`<div class="legend"><span><i style="background:var(--series-1)"></i>${t('dash.cost')}</span><span><i style="background:var(--series-2)"></i>${t('dash.gross_profit')}</span></div>`}>
        ${d.chart.some((r) => r.sales_usd > 0) ? html`<${SalesChart} rows=${d.chart} disp=${disp} unit=${dc} toDisp=${(usd) => (dc === 'USD' ? usd : usd * rate)} />`
          : html`<${Empty} icon="chart-column" title=${t('dash.no_sales_14')} text=${t('dash.no_sales_14_hint')} />`}
      </${Panel}>
      <${Panel} title=${t('dash.stock_alerts')} icon="package-minus" body=${false}
        tools=${html`${d.stock.critical > 0 && html`<${Pill} kind="out">${t('dash.critical_n', { n: d.stock.critical })}</${Pill}>`}${d.stock.low > 0 && html`<${Pill} kind="warn">${t('dash.low_n', { n: d.stock.low })}</${Pill}>`}`}
        foot=${can('reports.stock') || can('orders.manage') ? html`<${Btn} size="sm" icon="clipboard-list" onClick=${() => navigate('/stock/suggestions')}>${t('dash.purchase_suggestions')}</${Btn}>` : null}>
        ${!d.stock.list.length ? html`<${Empty} icon="circle-check" title=${t('dash.stock_ok')} />` : html`<div class="mini-list">
          ${d.stock.list.map((p) => html`<div class="mini-row link" onClick=${() => navigate(`/products/${p.id}`)}>
            <${Icon} name=${p.state === 'critical' ? 'triangle-alert' : 'package'} cls=${p.state === 'critical' ? 'neg' : 'warn-text'} />
            <div class="grow ellipsis" dir="auto">${p.name}</div>
            <span class="num"><b class=${p.stock <= 0 ? 'neg' : 'warn-text'}>${num(p.stock, 2)}</b> <span class="tiny muted">/ ${num(p.min, 2)}</span></span>
          </div>`)}</div>`}
      </${Panel}>
    </div>

    <div class="grid-3">
      <${Panel} title=${t('dash.open_service')} icon="wrench" body=${false}
        tools=${can('service.manage') && html`<${Btn} size="sm" icon="plus" onClick=${() => navigate('/docs/service/new')}>${t('common.new')}</${Btn}>`}>
        ${!d.service.length ? html`<${Empty} icon="wrench" title=${t('dash.no_open_service')} />` : html`<div class="mini-list">
          ${d.service.map((s) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${s.id}`)}>
            <div class="grow"><div class="strong ltr">${s.plate || s.no}</div><div class="tiny muted ellipsis" dir="auto">${[s.vehicle_desc, s.partner_name].filter(Boolean).join(' — ')}</div></div>
            <${StatusPill} type="service" status=${s.status} />
          </div>`)}</div>`}
      </${Panel}>
      <${Panel} title=${t('dash.overdue')} icon="clock" body=${false}>
        ${d.overdue === null || !d.overdue.length ? html`<${Empty} icon="circle-check" title=${t('dash.no_overdue')} />` : html`<div class="mini-list">
          ${d.overdue.map((o) => html`<div class="mini-row link" onClick=${() => navigate(`/doc/${o.id}`)}>
            <div class="grow"><div class="ellipsis" dir="auto">${dn(o.partner_name)}</div><div class="tiny muted">${o.no} · ${t('dash.days_late', { n: daysBetween(o.due_date, today()) })}</div></div>
            <${Money} value=${o.open} cur=${o.currency} cls="neg strong" />
          </div>`)}</div>`}
      </${Panel}>
      <${Panel} title=${t('dash.top_products')} icon="star" body=${false}>
        ${!d.top_products.length ? html`<${Empty} icon="chart-column" title=${t('dash.no_sales_month')} />` : html`<div class="mini-list">
          ${d.top_products.map((p, i) => {
            const max = d.top_products[0].revenue || 1;
            return html`<div class="mini-row">
              <div class="grow"><div class="ellipsis" dir="auto">${p.name || t('doc.kind.labor')}</div><div class="meter mt-8"><i style=${`width:${Math.max(3, p.revenue / max * 100)}%;background:var(--series-1)`}></i></div></div>
              <div style="text-align:end"><div class="num strong">${disp(p.revenue)}</div><div class="tiny muted num">${num(p.qty, 2)} ${t('common.pcs')}</div></div>
            </div>`;
          })}</div>`}
      </${Panel}>
    </div>

    <${Panel} title=${t('dash.recent_docs')} icon="file-text" body=${false}>
      ${!d.recent.length ? html`<${Empty} icon="file-text" title=${t('dash.no_docs')} text=${t('dash.no_docs_hint')} />` : html`<div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('doc.no')}</th><th>${t('common.type')}</th><th>${t('doc.partner')}</th><th>${t('common.date')}</th><th class="r">${t('doc.total')}</th><th>${t('doc.payment_status')}</th></tr></thead>
        <tbody>${d.recent.map((r) => html`<tr class=${`clickable ${r.status === 'cancelled' ? 'cancelled' : ''}`} onClick=${() => navigate(`/doc/${r.id}`)}>
          <td class="strong">${r.no}</td><td>${t(`doc.type.${r.type}`)}</td><td dir="auto">${dn(r.partner_name) || '—'}</td><td>${fdate(r.date)}</td>
          <td class="r"><${Money} value=${r.total} cur=${r.currency} /></td><td>${r.status === 'cancelled' ? html`<${Pill}>${t('doc.status.cancelled')}</${Pill}>` : html`<${PayPill} status=${r.payment_status} />`}</td>
        </tr>`)}</tbody></table></div>`}
    </${Panel}>
  </div>`;
}

function Readout({ k, v, s, icon, cls = '', onClick }) {
  return html`<div class="readout-cell" style=${onClick ? 'cursor:pointer' : ''} onClick=${onClick || undefined}>
    <div class="k">${icon && html`<${Icon} name=${icon} size="sm" />`}${k}</div>
    <div class=${`v figure ${cls}`}>${v}</div>${s && html`<div class="s">${s}</div>`}
  </div>`;
}

/**
 * Speedometer-style gauge: the arc spans 0 .. 2x the reference value (an average day / last month so far).
 * The brass tick marks the reference; the needle shows the current value.
 */
function Gauge({ label, value, target, targetLabel, main, sub, second, disp }) {
  const ref = target;
  const refLabel = targetLabel;
  const max = Math.max(ref > 0 ? ref * 2 : 0, value * 1.15, 1);
  const frac = Math.max(0, Math.min(1, value / max));
  const refFrac = ref > 0 ? Math.min(1, ref / max) : null;
  const R = 80;
  const cx = 100;
  const cy = 100;
  const pt = (f, r = R) => {
    const a = Math.PI * (1 - f);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (f0, f1, r = R) => {
    const [x0, y0] = pt(f0, r);
    const [x1, y1] = pt(f1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ticks = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    const [x0, y0] = pt(f, R - 14);
    const [x1, y1] = pt(f, R - (i % 5 === 0 ? 22 : 18));
    ticks.push(html`<line x1=${x0} y1=${y0} x2=${x1} y2=${y1} stroke=${i % 5 === 0 ? '#8B96A1' : '#4A545E'} stroke-width=${i % 5 === 0 ? 1.6 : 1} />`);
  }
  const [nx, ny] = pt(frac, R - 26);
  return html`<div class=${`gauge ${second ? 'second' : ''}`} role="img" aria-label=${`${label}: ${main}`}>
    <svg viewBox="0 0 200 118">
      <defs><linearGradient id=${`gg${second ? 2 : 1}`} x1="0" x2="1"><stop offset="0" stop-color="#7C5E1E" /><stop offset="1" stop-color="#E2C27A" /></linearGradient></defs>
      <path d=${arc(0, 1)} stroke="#313942" stroke-width="10" fill="none" stroke-linecap="round" />
      ${frac > 0.001 && html`<path d=${arc(0, frac)} stroke=${`url(#gg${second ? 2 : 1})`} stroke-width="10" fill="none" stroke-linecap="round" />`}
      ${ticks}
      ${refFrac !== null && (() => { const [a, b] = pt(refFrac, R + 9); const [c, e] = pt(refFrac, R - 6); return html`<line x1=${a} y1=${b} x2=${c} y2=${e} stroke="#E2C27A" stroke-width="2.5" stroke-linecap="round"><title>${refLabel}</title></line>`; })()}
      <line x1=${cx} y1=${cy} x2=${nx} y2=${ny} stroke="#F2F4F6" stroke-width="2.5" stroke-linecap="round" />
      <circle cx=${cx} cy=${cy} r="6" fill="#C59A3D" stroke="#1C2127" stroke-width="2" />
    </svg>
    <div class="cap">${label}</div>
    <div class="gauge-read"><div class="big figure">${main}</div><div class="small">${sub}</div>
      ${ref > 0 && html`<div class="tiny">${refLabel}: ${disp(ref)}</div>`}</div>
  </div>`;
}

/** 14-day bars: cost + gross profit stacked (or plain sales when profit is hidden) */
function SalesChart({ rows, disp, unit, toDisp }) {
  const [hover, setHover] = useState(null);
  const rtl = isRtl();
  const hasProfit = rows.some((r) => r.profit_usd !== null);
  const max = Math.max(1, ...rows.map((r) => r.sales_usd));
  const T = 22; // room for the unit and the top value label
  const H = 170;
  const td = today();
  const nice = niceMax(max);
  const W = 640;
  const left = 54;
  const bw = Math.min(24, (W - left) / rows.length - 8);
  const step = (W - left) / rows.length;
  const y = (v) => T + H - (v / nice) * H;
  const X = (x, w = 0) => (rtl ? W - x - w : x);
  return html`<div style="position:relative">
    <svg viewBox=${`0 0 ${W} ${T + H + 26}`} style="width:100%;height:auto;display:block" role="img" aria-label=${t('dash.chart_title')}>
      <text x=${X(left - 8)} y="10" text-anchor=${rtl ? 'start' : 'end'} font-size="10.5" fill="#75808A">${unit}</text>
      ${[0, 0.5, 1].map((f) => html`<g><line x1=${X(left)} x2=${X(W)} y1=${y(nice * f)} y2=${y(nice * f)} stroke="#E7EAE8" stroke-width="1" />
        <text x=${X(left - 8)} y=${y(nice * f) + 4} text-anchor=${rtl ? 'start' : 'end'} font-size="11" fill="#75808A">${compact(toDisp(nice * f))}</text></g>`)}
      ${rows.map((r, i) => {
        const x = X(left + i * step + (step - bw) / 2, bw);
        const total = Math.max(0, r.sales_usd);
        const profit = hasProfit ? Math.max(0, Math.min(r.profit_usd || 0, total)) : 0;
        const cost = total - profit;
        const hCost = (cost / nice) * H;
        const hProf = (profit / nice) * H;
        const isToday = r.date === td;
        return html`<g onMouseEnter=${() => setHover(i)} onMouseLeave=${() => setHover(null)} onFocus=${() => setHover(i)} tabindex="0" style="cursor:default; outline:none">
          <rect x=${X(left + i * step, step)} y=${T} width=${step} height=${H} fill=${hover === i ? 'rgba(42,100,163,.06)' : 'transparent'} />
          ${total > 0 && html`<path d=${barPath(x, T + H - hCost, bw, hCost, hProf > 0 ? 0 : 4)} fill="var(--series-1)" />`}
          ${hProf > 0 && html`<path d=${barPath(x, T + H - hCost - hProf, bw, hProf - (hCost > 0 ? 2 : 0), 4)} fill="var(--series-2)" />`}
          <text x=${x + bw / 2} y=${T + H + 17} text-anchor="middle" font-size="11" fill=${isToday ? '#161B20' : '#75808A'} font-weight=${isToday ? 600 : 400}>${r.date.slice(8, 10)}</text>
        </g>`;
      })}
    </svg>
    ${hover !== null && html`<div class="menu" style=${`top:6px; ${(hover > rows.length / 2) !== rtl ? `left:${rtl ? 6 : 60}px` : `right:${rtl ? 60 : 6}px`}; min-width:180px; padding:10px 12px; pointer-events:none`}>
      <div class="tiny muted">${fdate(rows[hover].date)}</div>
      <div class="strong num" style="font-size:16px">${disp(rows[hover].sales_usd)}</div>
      ${hasProfit && html`<div class="small"><span style="display:inline-block;width:10px;height:2px;background:var(--series-2);vertical-align:middle;margin-inline-end:6px"></span>${t('dash.gross_profit')}: <b class="num">${disp(rows[hover].profit_usd || 0)}</b></div>`}
      <div class="small muted">${t('dash.sales_count', { n: rows[hover].count })}</div>
    </div>`}
  </div>`;
}

function barPath(x, top, w, h, r) {
  // rounded top corners (data end), square bottom (baseline)
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  const yb = top + h;
  return `M ${x} ${yb} L ${x} ${top + rr} Q ${x} ${top} ${x + rr} ${top} L ${x + w - rr} ${top} Q ${x + w} ${top} ${x + w} ${top + rr} L ${x + w} ${yb} Z`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return n * p;
}

export function PayPill({ status }) {
  if (!status) return null;
  const kind = status === 'paid' ? 'in' : status === 'partial' ? 'warn' : 'out';
  return html`<${Pill} kind=${kind} dot>${t(`doc.pay.${status}`)}</${Pill}>`;
}

export function StatusPill({ type, status }) {
  const map = {
    draft: '', posted: 'in', cancelled: '', open: 'info', accepted: 'in', rejected: 'out', converted: 'dark', in_progress: 'warn', waiting_parts: 'warn',
    done: 'in', delivered: 'dark', invoiced: 'dark', sent: 'info', received: 'in',
  };
  return html`<${Pill} kind=${map[status] || ''} dot>${t(`doc.status.${status}`)}</${Pill}>`;
}
