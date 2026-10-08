// Small SVG charts: grouped vertical bars with a shared zero baseline, hover tooltip, legend for 2+ series.
// Colors come from the validated series tokens (--series-1 blue, --series-2 brass).
import { html, useState } from './h.js';
import { isRtl } from './i18n.js';

function niceStep(range) {
  const raw = range / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/**
 * labels: ['2026-01', ...]; series: [{ label, values: [..], color }]; fmt(v) -> string; height px
 */
export function BarChart({ labels, series, fmt = (v) => String(v), height = 220, labelFmt = (l) => l, unit }) {
  const [hover, setHover] = useState(null);
  const rtl = isRtl();
  const all = series.flatMap((s) => s.values.map((v) => Number(v) || 0));
  let max = Math.max(0, ...all);
  let min = Math.min(0, ...all);
  if (max === min) max = min + 1;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const W = 760;
  const left = 70;
  const top = unit ? 22 : 12;
  const H = height;
  const bottom = 24;
  const plotH = H - top - bottom;
  const y = (v) => top + (max - v) / (max - min) * plotH;
  const n = labels.length || 1;
  const slot = (W - left) / n;
  const gap = Math.min(10, slot * 0.25);
  const groupW = slot - gap;
  const barW = Math.max(2, Math.min(30, (groupW - (series.length - 1) * 2) / series.length));
  const ticks = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(v);
  const every = Math.ceil(n / 14);
  // right-to-left: time runs from right to left and the value axis sits on the right
  const X = (x, w = 0) => (rtl ? W - x - w : x);
  return html`<div style="position:relative">
    ${series.length > 1 && html`<div class="legend mb-8">${series.map((s) => html`<span><i style=${`background:${s.color}`}></i>${s.label}</span>`)}</div>`}
    <svg viewBox=${`0 0 ${W} ${H}`} style="width:100%;height:auto;display:block" role="img">
      ${unit && html`<text x=${X(left - 8)} y="10" text-anchor=${rtl ? 'start' : 'end'} font-size="10.5" fill="#75808A">${unit}</text>`}
      ${ticks.map((v) => html`<g><line x1=${X(left)} x2=${X(W)} y1=${y(v)} y2=${y(v)} stroke=${v === 0 ? '#C9CFCB' : '#ECEFED'} stroke-width="1" />
        <text x=${X(left - 8)} y=${y(v) + 4} text-anchor=${rtl ? 'start' : 'end'} font-size="11" fill="#75808A">${fmt(v)}</text></g>`)}
      ${labels.map((l, i) => {
        const gx = left + i * slot + gap / 2 + (groupW - (barW * series.length + 2 * (series.length - 1))) / 2;
        return html`<g onMouseEnter=${() => setHover(i)} onMouseLeave=${() => setHover(null)}>
          <rect x=${X(left + i * slot, slot)} y=${top} width=${slot} height=${plotH} fill=${hover === i ? 'rgba(42,100,163,.06)' : 'transparent'} />
          ${series.map((s, k) => {
            const v = Number(s.values[i]) || 0;
            const y0 = y(Math.max(v, 0));
            const h = Math.abs(y(v) - y(0));
            if (h < 0.5) return null;
            const x = X(gx + k * (barW + 2), barW);
            const r = Math.min(4, barW / 2, h);
            const d = v >= 0
              ? `M ${x} ${y0 + h} L ${x} ${y0 + r} Q ${x} ${y0} ${x + r} ${y0} L ${x + barW - r} ${y0} Q ${x + barW} ${y0} ${x + barW} ${y0 + r} L ${x + barW} ${y0 + h} Z`
              : `M ${x} ${y(0)} L ${x + barW} ${y(0)} L ${x + barW} ${y(0) + h - r} Q ${x + barW} ${y(0) + h} ${x + barW - r} ${y(0) + h} L ${x + r} ${y(0) + h} Q ${x} ${y(0) + h} ${x} ${y(0) + h - r} Z`;
            return html`<path d=${d} fill=${s.color} />`;
          })}
          ${i % every === 0 && html`<text x=${X(left + i * slot + slot / 2)} y=${H - 6} text-anchor="middle" font-size="11" fill="#75808A">${labelFmt(l)}</text>`}
        </g>`;
      })}
    </svg>
    ${hover !== null && html`<div class="menu" style=${`top:${series.length > 1 ? 30 : 4}px; ${(hover > n / 2) !== rtl ? `left:${rtl ? 6 : left}px` : `right:${rtl ? left : 6}px`}; min-width:180px; padding:10px 12px; pointer-events:none`}>
      <div class="tiny muted mb-8">${labelFmt(labels[hover])}</div>
      ${series.map((s) => html`<div class="row between gap-12 small"><span><span style=${`display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-inline-end:6px;vertical-align:-1px`}></span>${s.label}</span><b class="num">${fmt(s.values[hover] || 0)}</b></div>`)}
    </div>`}
  </div>`;
}
