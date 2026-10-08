// Printing. In the desktop app pages go through the main process (can print silently to a chosen printer);
// in a browser (phone / other PC) a hidden iframe opens the system print dialog.
import { t } from './i18n.js';
import { toast } from './ui.js';

const PAGE_CSS = {
  A4: '@page { size: A4; margin: 10mm; }',
  A5: '@page { size: A5; margin: 8mm; }',
  receipt: '@page { size: 80mm auto; margin: 0; }',
};

export function wrapHtml(body, { title = 'Print', page = 'A4', css = '', dir = 'ltr', w, h } = {}) {
  const pageCss = page === 'label' ? `@page { size: ${w}mm ${h}mm; margin: 0; }` : (PAGE_CSS[page] || PAGE_CSS.A4);
  return `<!doctype html><html dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<base href="${location.origin}/">
<style>
@font-face { font-family: 'Plex'; font-weight: 400; src: url(${location.origin}/fonts/plex-sans-latin-400.woff2) format('woff2'); }
@font-face { font-family: 'Plex'; font-weight: 600; src: url(${location.origin}/fonts/plex-sans-latin-600.woff2) format('woff2'); }
@font-face { font-family: 'Plex Arabic'; font-weight: 400; src: url(${location.origin}/fonts/plex-arabic-400.woff2) format('woff2'); }
@font-face { font-family: 'Plex Arabic'; font-weight: 600; src: url(${location.origin}/fonts/plex-arabic-600.woff2) format('woff2'); }
${pageCss}
html, body { margin: 0; padding: 0; background: #fff; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
* { box-sizing: border-box; }
${css}
</style></head><body>${body}</body></html>`;
}

function waitForImages(doc) {
  const imgs = [...doc.images];
  return Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 4000); }))));
}

/**
 * opts: { title, page: 'A4'|'A5'|'receipt'|'label', w, h (mm, labels), silent, printer, copies, dir, css }
 */
export async function printHtml(body, opts = {}) {
  const full = wrapHtml(body, opts);
  const desk = window.desktop;
  if (desk && desk.print) {
    try {
      const r = await desk.print({ html: full, silent: !!opts.silent && !!opts.printer, printer: opts.printer || '', copies: opts.copies || 1, page: opts.page || 'A4', w: opts.w, h: opts.h });
      if (r && r.ok === false && r.error) toast(`${t('print.failed')}: ${r.error}`, 'err');
      return r;
    } catch (e) {
      toast(`${t('print.failed')}: ${e.message || e}`, 'err');
      return { ok: false };
    }
  }
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(full);
  doc.close();
  await new Promise((r) => setTimeout(r, 150));
  await waitForImages(doc);
  try { await doc.fonts.ready; } catch (e) { /* ignore */ }
  iframe.contentWindow.focus();
  iframe.contentWindow.print();
  setTimeout(() => iframe.remove(), 60000);
  return { ok: true };
}

/** open the HTML in a new window for preview / saving as PDF from the browser */
export function previewHtml(body, opts = {}) {
  const w = window.open('', '_blank');
  if (!w) { toast(t('print.popup_blocked'), 'err'); return; }
  w.document.write(wrapHtml(body, opts));
  w.document.close();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/** printable report table(s) */
export function printTables(title, subtitle, groups, { dir = 'ltr' } = {}) {
  const css = `
    body { font-family: 'Plex', 'Plex Arabic', 'Segoe UI', Arial, sans-serif; font-size: 11.5px; padding: 0; }
    h1 { font-size: 18px; margin: 0 0 2px; } .sub { color: #555; margin-bottom: 14px; font-size: 12px; }
    h2 { font-size: 13px; margin: 18px 0 6px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: start; font-weight: 600; border-bottom: 1.5px solid #333; padding: 5px 6px; font-size: 11px; }
    td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
    td.r, th.r { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-top: 1.5px solid #333; border-bottom: 0; }
    tr { break-inside: avoid; }`;
  const body = `<h1>${escapeHtml(title)}</h1>${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}` + groups.map((g) => `
    ${g.title ? `<h2>${escapeHtml(g.title)}</h2>` : ''}
    <table><thead><tr>${g.headers.map((h) => `<th class="${h.r ? 'r' : ''}">${escapeHtml(h.label)}</th>`).join('')}</tr></thead>
    <tbody>${g.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${g.headers[i] && g.headers[i].r ? 'r' : ''}" dir="auto">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    ${g.foot ? `<tfoot><tr>${g.foot.map((c, i) => `<td class="${g.headers[i] && g.headers[i].r ? 'r' : ''}">${escapeHtml(c)}</td>`).join('')}</tr></tfoot>` : ''}</table>`).join('');
  return printHtml(body, { title, page: 'A4', css, dir });
}
