// Printable documents: the invoice template engine (carried over from Recep Muhasebe 2 so existing designs keep
// working), the 80mm receipt, the workshop job card and the account statement.
import { t, getLang } from './i18n.js';
import { money, num, qty as fqty, date as fdate, convert, rateText } from './format.js';
import { escapeHtml } from './print.js';
import { barcodeSvg } from './barcode.js';
import { dn } from './names.js';

const esc = escapeHtml;
const BADINI_TITLES = {
  sale: 'فاتورە', purchase: 'فاتورا کڕینێ', sale_return: 'فاتورا زڤڕاندنێ', purchase_return: 'زڤڕاندنا کڕینێ',
  quote: 'پێشنیارا بهای', service: 'فۆرما کاری', purchase_order: 'داخوازا کڕینێ',
};
const BADINI_PAY = { cash: 'نەقد', card: 'کارت', transfer: 'گواستن', other: 'دیکە', credit: 'قەرز', mixed: 'تێکەل' };
const BADINI_COLS = { row: 'ریز بەند', code: 'کۆدی کەلوپەلی', desc: 'وەسفا کەلوپەلی', qty: 'ژمارە', unit: 'یەکە', price: 'بها', discount: 'داشکاندن', total: 'کۆمی گشتی' };

export function absUrl(u) { return u && u.startsWith('/') ? location.origin + u : u; }

/* ------------------------------------------------------------------ templates */
export function defaultTemplate() {
  return `<div id="invoice-doc" dir="{{DOC_DIR}}" style="font-family:{{FONT_FAMILY}}; color:#152128; padding:36px 40px; max-width:800px; margin:0 auto; background:#fff;">
  {{HEADER}}
  <div style="display:flex; justify-content:space-between; margin-bottom:22px; gap:20px;">
    <div>
      <div style="font-size:11px; color:#5B6B78; font-weight:700; margin-bottom:4px;">{{BILL_TO_LABEL}}</div>
      <div style="font-weight:700; font-size:14px; color:#0F2A3D;">{{BILL_TO_NAME}}</div>
      <div style="font-size:11.5px; color:#5B6B78; margin-top:2px;">{{BILL_TO_ADDRESS}}</div>
      <div style="font-size:11.5px; color:#5B6B78;">{{BILL_TO_CONTACT}}</div>
      {{VEHICLE_BLOCK}}
    </div>
    <div style="text-align:end; font-size:12px;">
      <div style="margin-bottom:4px;"><span style="color:#5B6B78;">{{DATE_LABEL}}: </span><b>{{INV_DATE}}</b></div>
      <div><span style="color:#5B6B78;">{{DUE_LABEL}}: </span><b>{{INV_DUE}}</b></div>
      <div style="margin-top:4px;"><span style="color:#5B6B78;">{{PAYMENT_LABEL}}: </span><b>{{PAYMENT_METHOD}}</b></div>
    </div>
  </div>
  <table style="width:100%; border-collapse:collapse; margin-bottom:6px;">
    <thead><tr style="background:{{ACCENT}}12;">{{ITEMS_HEADER}}</tr></thead>
    <tbody>{{ITEMS_ROWS}}</tbody>
  </table>
  <div style="display:flex; justify-content:flex-end; margin-top:10px;">
    <div style="width:280px;">
      <div style="display:flex; justify-content:space-between; padding:5px 0; font-size:12.5px; color:#5B6B78;"><span>{{SUBTOTAL_LABEL}}</span><span>{{SUBTOTAL}}</span></div>
      <div style="display:flex; justify-content:space-between; padding:5px 0; font-size:12.5px; color:#5B6B78;"><span>{{DISCOUNT_LABEL}}</span><span>{{DISCOUNT_AMOUNT}}</span></div>
      <div style="display:flex; justify-content:space-between; padding:10px 0; margin-top:4px; border-top:2px solid {{ACCENT}}; font-size:{{TITLE_FONT_SIZE}}; font-weight:800; color:{{ACCENT}};"><span>{{GRAND_TOTAL_LABEL}}</span><span>{{GRAND_TOTAL}}</span></div>
      <div style="text-align:end; font-size:11px; color:#5B6B78; margin-top:2px;">{{GRAND_TOTAL_OTHER}}</div>
      {{BALANCE_BLOCK}}
    </div>
  </div>
  {{NOTES_BLOCK}}
  <div style="margin-top:40px; padding-top:16px; border-top:1px solid #E3E8EC; text-align:center; font-size:11.5px; color:#5B6B78;">{{THANKS_NOTE}}</div>
</div>`;
}

export function sherwanTemplate() {
  return `<div id="invoice-doc" dir="rtl" style="font-family:{{FONT_FAMILY}}; color:#152128; padding:34px 36px; max-width:800px; margin:0 auto; background:#fff;">
  <div style="text-align:center; margin-bottom:18px;">{{LOGO_IMG}}</div>
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:22px; border-bottom:3px solid {{DARK_COLOR}}; padding-bottom:18px;">
    <div style="text-align:right;">
      <div style="font-size:{{BASE_FONT_SIZE}}; color:{{ACCENT}}; font-weight:700; margin-top:6px;">بۆ فرۆتنا کەلوپەلێن جوانکاریا ترومبێلا</div>
      <div style="font-size:{{BASE_FONT_SIZE}}; color:#5B6B78; margin-top:6px;">{{COMPANY_ADDRESS}}</div>
      <div style="font-size:{{BASE_FONT_SIZE}}; color:#5B6B78;">{{COMPANY_PHONE}}</div>
    </div>
    <div style="min-width:230px;">
      <div style="background:{{DARK_COLOR}}; color:#fff; text-align:center; font-weight:800; font-size:{{TITLE_FONT_SIZE}}; padding:8px; border-radius:6px 6px 0 0;">{{BADINI_TITLE}}</div>
      <table style="width:100%; border-collapse:collapse; border:1px solid {{DARK_COLOR}}; border-top:none;">
        <tr><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; border-bottom:1px solid #E3E8EC; background:#F3F5F7; white-space:nowrap;">ژمارا فاتورێ:</td><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}}; border-bottom:1px solid #E3E8EC;">{{INVOICE_NO}}</td></tr>
        <tr><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; border-bottom:1px solid #E3E8EC; background:#F3F5F7; white-space:nowrap;">مێژوو:</td><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}}; border-bottom:1px solid #E3E8EC;">{{INV_DATE}}</td></tr>
        <tr><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; background:#F3F5F7; white-space:nowrap;">شێوازێ پارە دانی:</td><td style="padding:7px 10px; font-size:{{BASE_FONT_SIZE}};">{{BADINI_PAYMENT_METHOD}}</td></tr>
      </table>
    </div>
  </div>
  <div style="margin-bottom:20px;">
    <div style="background:{{ACCENT}}; color:#fff; font-weight:800; font-size:{{TITLE_FONT_SIZE}}; padding:8px 12px; border-radius:6px 6px 0 0;">زانیاریێن کڕیاری</div>
    <table style="width:100%; border-collapse:collapse; border:1px solid #E3E8EC;">
      <tr>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; width:22%; border-bottom:1px solid #E3E8EC; border-left:1px solid #E3E8EC; white-space:nowrap;">ناڤێ کڕیاری:</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; width:28%; border-bottom:1px solid #E3E8EC; border-left:1px solid #E3E8EC;">{{BILL_TO_NAME}}</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; width:22%; border-bottom:1px solid #E3E8EC; border-left:1px solid #E3E8EC; white-space:nowrap;">ژمارا مۆبایلی:</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; width:28%; border-bottom:1px solid #E3E8EC;">{{CUSTOMER_PHONE}}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; border-left:1px solid #E3E8EC; white-space:nowrap;">جۆرێ ترومبێلێ:</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; border-left:1px solid #E3E8EC;">{{VEHICLE_TYPE}}</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; border-left:1px solid #E3E8EC; white-space:nowrap;">ژمارا ترومبێلێ:</td>
        <td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}};">{{VEHICLE_PLATE}}</td>
      </tr>
    </table>
  </div>
  <table style="width:100%; border-collapse:collapse; margin-bottom:4px; border:1px solid {{DARK_COLOR}};">
    <thead><tr style="background:{{DARK_COLOR}}; color:#fff;">{{ITEMS_HEADER_SHERWAN}}</tr></thead>
    <tbody>{{ITEMS_ROWS}}</tbody>
  </table>
  <div style="display:flex; justify-content:space-between; gap:16px; margin-top:14px; align-items:flex-start;">
    <div style="flex:1;">
      <div style="background:{{DARK_COLOR}}; color:#fff; font-weight:800; font-size:{{BASE_FONT_SIZE}}; padding:7px 12px; border-radius:6px 6px 0 0;">تێبینی و مەرج</div>
      <div style="border:1px solid #E3E8EC; border-top:none; padding:10px 12px; font-size:{{BASE_FONT_SIZE}}; color:#5B6B78; line-height:1.9; min-height:70px;">
        {{NOTES_TEXT}}
        • کەلوپەلێن فرۆتی ناهێنە زڤڕاندن پشتی دەربازبوونا ٣ ڕۆژان.<br>
        • سوپاس بۆ باوەریا وە ب {{COMPANY_NAME}}!
      </div>
    </div>
    <div style="width:250px;">
      <table style="width:100%; border-collapse:collapse; border:1px solid {{DARK_COLOR}};">
        <tr><td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; background:{{DARK_COLOR}}; color:#fff; white-space:nowrap;">کۆمێ تێکڕایی:</td><td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; text-align:left; border-bottom:1px solid #E3E8EC;">{{SUBTOTAL}}</td></tr>
        <tr><td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; font-weight:700; background:{{DARK_COLOR}}; color:#fff; white-space:nowrap;">داشکاندن:</td><td style="padding:8px 12px; font-size:{{BASE_FONT_SIZE}}; text-align:left; border-bottom:1px solid #E3E8EC;">{{DISCOUNT_AMOUNT}}</td></tr>
        <tr><td style="padding:9px 12px; font-size:{{TITLE_FONT_SIZE}}; font-weight:800; background:{{ACCENT}}; color:#fff; white-space:nowrap;">کۆمێ گشتی:</td><td style="padding:9px 12px; font-size:{{TITLE_FONT_SIZE}}; font-weight:800; text-align:left; color:{{DARK_COLOR}};">{{GRAND_TOTAL}}</td></tr>
        <tr><td colspan="2" style="padding:4px 12px; font-size:10.5px; text-align:left; color:#5B6B78; border:1px solid #E3E8EC; border-top:none;">{{GRAND_TOTAL_OTHER}}</td></tr>
        {{BADINI_BALANCE_ROWS}}
      </table>
    </div>
  </div>
  <div style="margin-top:34px; text-align:center; font-size:{{BASE_FONT_SIZE}}; color:#5B6B78; border-top:1px solid #E3E8EC; padding-top:14px;">
    {{COMPANY_NAME}} — {{COMPANY_ADDRESS}} — {{COMPANY_PHONE}}
  </div>
</div>`;
}

export function defaultHeaderLayout() {
  return [
    { id: 'logo', type: 'logo', x: 30, y: 20, w: 90, h: 90 },
    { id: 'cname', type: 'text', x: 135, y: 22, w: 340, h: 28, fontSize: 19, bold: true, align: 'left', color: '#0F2A3D', content: '{{COMPANY_NAME}}' },
    { id: 'caddr', type: 'text', x: 135, y: 52, w: 340, h: 36, fontSize: 11, bold: false, align: 'left', color: '#5B6B78', content: '{{COMPANY_ADDRESS}}' },
    { id: 'cphone', type: 'text', x: 135, y: 88, w: 340, h: 18, fontSize: 11, bold: false, align: 'left', color: '#5B6B78', content: '{{COMPANY_PHONE}}' },
    { id: 'title', type: 'text', x: 510, y: 18, w: 260, h: 34, fontSize: 23, bold: true, align: 'right', color: '#1B8F6B', content: '{{INVOICE_TITLE}}' },
    { id: 'invno', type: 'text', x: 510, y: 56, w: 260, h: 18, fontSize: 13, bold: false, align: 'right', color: '#152128', content: '#{{INVOICE_NO}}' },
    { id: 'invdate', type: 'text', x: 510, y: 76, w: 260, h: 18, fontSize: 11, bold: false, align: 'right', color: '#5B6B78', content: '{{DATE_LABEL}}: {{INV_DATE}}' },
    { id: 'billto', type: 'text', x: 30, y: 150, w: 420, h: 90, fontSize: 12, bold: false, align: 'left', color: '#152128', content: '{{BILL_TO_LABEL}}: {{BILL_TO_NAME}}\n{{BILL_TO_ADDRESS}}\n{{BILL_TO_CONTACT}}' },
    { id: 'itemsTable', type: 'table', x: 30, y: 270, w: 740, h: 220 },
    { id: 'totals', type: 'totals', x: 490, y: 510, w: 280, h: 110, subtotalLabel: '', discountLabel: '', grandTotalLabel: '' },
    { id: 'notes', type: 'notes', x: 30, y: 510, w: 420, h: 110 },
  ];
}

export const TOKEN_LIST = ['HEADER', 'LOGO_IMG', 'BILL_TO_LABEL', 'BILL_TO_NAME', 'BILL_TO_ADDRESS', 'BILL_TO_CONTACT', 'CUSTOMER_PHONE_LABEL', 'CUSTOMER_PHONE',
  'DATE_LABEL', 'DUE_LABEL', 'INV_DATE', 'INV_DUE', 'ROW_LABEL', 'CODE_LABEL', 'ITEM_DESC_LABEL', 'QTY_LABEL', 'PRICE_LABEL', 'LINE_TOTAL_LABEL',
  'ITEMS_HEADER', 'ITEMS_HEADER_SHERWAN', 'ITEMS_ROWS', 'SUBTOTAL_LABEL', 'SUBTOTAL', 'DISCOUNT_LABEL', 'DISCOUNT_AMOUNT', 'GRAND_TOTAL_LABEL', 'GRAND_TOTAL',
  'GRAND_TOTAL_OTHER', 'PAID_LABEL', 'PAID_AMOUNT', 'REMAINING_LABEL', 'REMAINING_AMOUNT', 'BALANCE_BLOCK', 'PAYMENT_LABEL', 'PAYMENT_METHOD', 'BADINI_PAYMENT_METHOD',
  'DOC_DIR', 'VEHICLE_LABEL', 'VEHICLE_TYPE', 'VEHICLE_PLATE', 'VEHICLE_BLOCK', 'KM', 'NOTES_BLOCK', 'NOTES_TEXT', 'THANKS_NOTE', 'ACCENT', 'DARK_COLOR',
  'COMPANY_NAME', 'COMPANY_ADDRESS', 'COMPANY_PHONE', 'INVOICE_NO', 'INVOICE_TITLE', 'BADINI_TITLE', 'STAFF_NAME', 'BARCODE'];

/* ------------------------------------------------------------------ item table */
function itemColumns(inv) {
  const defaults = [
    { key: 'row', visible: true, label: '' }, { key: 'code', visible: true, label: '' }, { key: 'desc', visible: true, label: '' },
    { key: 'qty', visible: true, label: '' }, { key: 'unit', visible: false, label: '' }, { key: 'price', visible: true, label: '' },
    { key: 'discount', visible: false, label: '' }, { key: 'total', visible: true, label: '' },
  ];
  const cfg = Array.isArray(inv.itemsTableConfig) && inv.itemsTableConfig.length ? inv.itemsTableConfig : null;
  if (!cfg) return defaults;
  const out = [...cfg];
  for (const d of defaults) if (!out.some((c) => c.key === d.key)) out.splice(defaults.indexOf(d), 0, d);
  return out;
}
function colLabel(c, badini) {
  if (c.label && c.label.trim()) return c.label;
  if (badini) return BADINI_COLS[c.key] || '';
  return ({ row: t('print.col.row'), code: t('print.col.code'), desc: t('print.col.desc'), qty: t('print.col.qty'), unit: t('print.col.unit'), price: t('print.col.price'), discount: t('print.col.discount'), total: t('print.col.total') })[c.key] || '';
}
function visibleCols(inv) { return itemColumns(inv).filter((c) => c.key === 'desc' || c.visible); }

function itemsHeader(inv, badini, style, accent, dark, base) {
  const cols = visibleCols(inv);
  return cols.map((c, i) => {
    const label = esc(colLabel(c, badini));
    if (style === 'sherwan') {
      const isLast = i === cols.length - 1;
      const align = c.key === 'desc' ? 'right' : 'center';
      return `<th style="padding:9px 8px; font-size:${base}; text-align:${align}; ${isLast ? '' : `border-left:1px solid ${dark};`}">${label}</th>`;
    }
    const align = c.key === 'row' ? 'center' : (c.key === 'desc' || c.key === 'code' ? 'start' : 'end');
    return `<th style="text-align:${align}; padding:9px 10px; font-size:10.5px; color:${accent}; border-bottom:2px solid ${accent};${c.key === 'row' ? ' width:34px;' : ''}">${label}</th>`;
  }).join('');
}

function itemsRows(doc, inv, badini) {
  const cols = visibleCols(inv);
  const lines = doc.lines.filter((l) => l.kind !== 'text' || l.description);
  let n = 0;
  return lines.map((l) => {
    if (l.kind === 'text') return `<tr><td colspan="${cols.length}" style="padding:8px 10px; font-size:12px; color:#5B6B78; border-bottom:1px solid #E3E8EC;">${esc(l.description)}</td></tr>`;
    n++;
    const warranty = l.warranty_until && inv.show_warranty !== false ? `<div style="font-size:10.5px; color:#5B6B78; margin-top:2px;">${badini ? 'گەرەنتی هەتا' : esc(t('print.warranty_until'))}: ${fdate(l.warranty_until)}</div>` : '';
    const tdc = 'padding:9px 10px; font-size:12.5px; border-bottom:1px solid #E3E8EC;';
    return '<tr>' + cols.map((c) => {
      switch (c.key) {
        case 'row': return `<td style="${tdc} text-align:center; color:#5B6B78;">${n}</td>`;
        case 'code': return `<td style="${tdc} color:#5B6B78; font-size:11.5px;" dir="ltr">${esc(l.code || l.product_code || '')}</td>`;
        case 'desc': return `<td style="${tdc}" dir="auto">${esc(l.description || l.product_name || '')}${l.note ? `<div style="font-size:11px;color:#5B6B78">${esc(l.note)}</div>` : ''}${warranty}</td>`;
        case 'qty': return `<td style="${tdc} text-align:${badini ? 'center' : 'end'}; white-space:nowrap;">${fqty(l.qty)}</td>`;
        case 'unit': return `<td style="${tdc} text-align:center;">${esc(dn(l.unit) || '')}</td>`;
        case 'price': return `<td style="${tdc} text-align:${badini ? 'center' : 'end'}; white-space:nowrap;" dir="ltr">${money(l.unit_price, doc.currency)}</td>`;
        case 'discount': return `<td style="${tdc} text-align:${badini ? 'center' : 'end'}; white-space:nowrap;" dir="ltr">${l.discount ? money(l.discount, doc.currency) : ''}</td>`;
        case 'total': return `<td style="${tdc} text-align:${badini ? 'center' : 'end'}; white-space:nowrap; font-weight:600;" dir="ltr">${money(l.line_total, doc.currency)}</td>`;
        default: return '';
      }
    }).join('') + '</tr>';
  }).join('');
}

/* ------------------------------------------------------------------ tokens */
function payMethodOf(doc) {
  const pays = (doc.payments || []).filter((p) => p.purpose !== 'change');
  if (doc.payment_status && doc.payment_status !== 'paid' && !pays.length) return 'credit';
  const methods = [...new Set(pays.map((p) => p.method))];
  if (methods.length > 1) return 'mixed';
  if (methods.length === 1) return methods[0];
  return doc.payment_method || 'cash';
}

export function buildTokens(doc, { company, inv }) {
  const accent = inv.accentColor || '#1C5FA8';
  const dark = inv.invDarkColor || '#14181D';
  const base = `${inv.invBaseFontSize || 12}px`;
  const titleSize = `${inv.invTitleFontSize || 15}px`;
  const logoUrl = absUrl(company.logo_url);
  const sub = doc.lines.reduce((s, l) => s + (l.kind === 'text' ? 0 : l.qty * l.unit_price), 0);
  const disc = (doc.discount || 0) + (doc.line_discount || 0);
  const otherCur = doc.currency === 'USD' ? 'IQD' : 'USD';
  const other = convert(doc.total, doc.currency, otherCur, doc.usd_iqd);
  const pm = payMethodOf(doc);
  const remaining = doc.remaining != null ? doc.remaining : null;
  const showBalance = remaining !== null && remaining > (doc.currency === 'IQD' ? 1 : 0.01) && ['sale', 'purchase'].includes(doc.type);
  const vehicleType = doc.vehicle_desc || '';
  const plate = doc.vehicle_plate || doc.v_plate || '';
  const title = t(`print.title.${doc.type}`);
  const logoImg = logoUrl
    ? `<img src="${esc(logoUrl)}" style="max-height:${inv.logoSize || 70}px; max-width:${Math.round((inv.logoSize || 70) * 4.2)}px; object-fit:contain;">`
    : `<div style="font-weight:800; font-size:${Math.max(18, Math.round((inv.logoSize || 56) * 0.5))}px; color:${accent};">${esc(company.name || '')}</div>`;
  const tok = {
    LOGO_IMG: logoImg, ACCENT: accent, DARK_COLOR: dark,
    FONT_FAMILY: inv.invFontFamily || "'Segoe UI', Tahoma, Arial, sans-serif", BASE_FONT_SIZE: base, TITLE_FONT_SIZE: titleSize,
    BILL_TO_LABEL: esc(t(['purchase', 'purchase_return', 'purchase_order'].includes(doc.type) ? 'print.supplier' : 'print.bill_to')),
    BILL_TO_NAME: esc(dn(doc.partner_name) || '—'), BILL_TO_ADDRESS: esc(doc.partner_address || ''),
    BILL_TO_CONTACT: esc([doc.partner_phone, doc.partner_tax_no ? `${t('partner.tax_no')}: ${doc.partner_tax_no}` : ''].filter(Boolean).join(' · ')),
    CUSTOMER_PHONE_LABEL: esc(t('common.phone')), CUSTOMER_PHONE: esc(doc.partner_phone || '—'),
    DATE_LABEL: esc(t('common.date')), DUE_LABEL: esc(t('doc.due_date')), INV_DATE: fdate(doc.date), INV_DUE: doc.due_date ? fdate(doc.due_date) : '—',
    ROW_LABEL: esc(t('print.col.row')), CODE_LABEL: esc(t('print.col.code')), ITEM_DESC_LABEL: esc(t('print.col.desc')), QTY_LABEL: esc(t('print.col.qty')),
    PRICE_LABEL: esc(t('print.col.price')), LINE_TOTAL_LABEL: esc(t('print.col.total')),
    ITEMS_HEADER: itemsHeader(inv, false, 'default', accent, dark, base),
    ITEMS_HEADER_SHERWAN: itemsHeader(inv, true, 'sherwan', accent, dark, base),
    SUBTOTAL_LABEL: esc(t('doc.subtotal')), SUBTOTAL: money(sub, doc.currency),
    DISCOUNT_LABEL: esc(t('doc.discount')), DISCOUNT_AMOUNT: disc ? money(disc, doc.currency) : '—',
    GRAND_TOTAL_LABEL: esc(t('doc.grand_total')), GRAND_TOTAL: money(doc.total, doc.currency),
    GRAND_TOTAL_OTHER: inv.show_other_currency === false ? '' : `≈ ${money(other, otherCur)} (${rateText(doc.usd_iqd)})`,
    PAID_LABEL: esc(t('doc.paid')), PAID_AMOUNT: money(doc.paid || 0, doc.currency),
    REMAINING_LABEL: esc(t('doc.remaining')), REMAINING_AMOUNT: remaining !== null ? money(remaining, doc.currency) : '',
    BALANCE_BLOCK: showBalance ? `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px; color:#5B6B78; margin-top:6px;"><span>${esc(t('doc.paid'))}</span><span>${money(doc.paid || 0, doc.currency)}</span></div>
      <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12.5px; font-weight:700; color:#BF3A2B;"><span>${esc(t('doc.remaining'))}</span><span>${money(remaining, doc.currency)}</span></div>` : '',
    BADINI_BALANCE_ROWS: showBalance ? `<tr><td style="padding:6px 12px; font-size:${base}; font-weight:700; white-space:nowrap;">هاتیە دان:</td><td style="padding:6px 12px; font-size:${base}; text-align:left;">${money(doc.paid || 0, doc.currency)}</td></tr>
      <tr><td style="padding:6px 12px; font-size:${base}; font-weight:700; white-space:nowrap; color:#BF3A2B;">ماوە:</td><td style="padding:6px 12px; font-size:${base}; text-align:left; color:#BF3A2B; font-weight:700;">${money(remaining, doc.currency)}</td></tr>` : '',
    PAYMENT_LABEL: esc(t('doc.payment')), PAYMENT_METHOD: esc(t(`pay.method.${pm}`)), BADINI_PAYMENT_METHOD: esc(BADINI_PAY[pm] || BADINI_PAY.cash),
    DOC_DIR: getLang() === 'ar' ? 'rtl' : 'ltr',
    VEHICLE_LABEL: esc(t('doc.vehicle')), VEHICLE_TYPE: esc(vehicleType || '—'), VEHICLE_PLATE: esc(plate || '—'), KM: doc.km ? num(doc.km) : '',
    VEHICLE_BLOCK: plate || vehicleType ? `<div style="font-size:11.5px; color:#152128; margin-top:6px;"><b>${esc(t('doc.vehicle'))}:</b> <span dir="ltr">${esc(plate)}</span> ${esc(vehicleType)}${doc.km ? ` · ${num(doc.km)} km` : ''}</div>` : '',
    NOTES_BLOCK: doc.notes ? `<div style="margin-top:22px; padding:12px 14px; background:#F3F5F7; border-radius:8px; font-size:12px; color:#5B6B78; white-space:pre-line;"><b style="color:#152128;">${esc(t('doc.notes'))}:</b> ${esc(doc.notes)}</div>` : '',
    NOTES_TEXT: doc.notes ? `${esc(doc.notes)}<br>` : '',
    THANKS_NOTE: esc(inv.thanks || t('print.thanks')),
    COMPANY_NAME: esc(company.name || ''), COMPANY_ADDRESS: esc(company.address || ''), COMPANY_PHONE: esc([company.phone, company.phone2].filter(Boolean).join(' | ')),
    INVOICE_NO: esc(doc.no), INVOICE_TITLE: esc(title.toUpperCase && getLang() !== 'tr' ? title.toUpperCase() : title), BADINI_TITLE: BADINI_TITLES[doc.type] || 'فاتورە',
    STAFF_NAME: esc(doc.staff_name || ''), BARCODE: barcodeSvg(doc.no, { height: 32, showText: false }),
    ITEMS_ROWS: itemsRows(doc, inv, false),
  };
  tok.HEADER = headerHtml(doc, company, inv, accent, tok);
  return tok;
}

function headerHtml(doc, company, inv, accent, tok) {
  const size = inv.logoSize || 56;
  const logoUrl = absUrl(company.logo_url);
  const logoEl = logoUrl
    ? `<img src="${esc(logoUrl)}" style="width:${size}px;height:${size}px;object-fit:contain;border-radius:6px;">`
    : `<div style="width:${size}px;height:${size}px;border-radius:10px;background:${accent};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${Math.max(16, Math.round(size * 0.38))}px;flex:none;">${esc((company.name || 'R')[0])}</div>`;
  const companyBlock = `<div style="font-weight:800; font-size:19px; color:#0F2A3D;">${esc(company.name || '')}</div>
    <div style="font-size:11.5px; color:#5B6B78; margin-top:2px; max-width:320px;">${esc(company.address || '')}</div>
    <div style="font-size:11.5px; color:#5B6B78;">${esc([company.phone, company.phone2].filter(Boolean).join(' | '))}${company.tax_no ? ` · ${esc(t('partner.tax_no'))}: ${esc(company.tax_no)}` : ''}</div>`;
  const titleBlock = `<div style="font-weight:800; font-size:24px; color:${accent};">${tok.INVOICE_TITLE}</div><div style="font-size:13px; color:#152128; margin-top:6px;">#${esc(doc.no)}</div>`;
  if (inv.logoLayout === 'top') {
    return `<div style="border-bottom:3px solid ${accent}; padding-bottom:22px; margin-bottom:24px; text-align:center;"><div style="display:flex; justify-content:center; margin-bottom:10px;">${logoEl}</div>${companyBlock}<div style="margin-top:12px;">${titleBlock}</div></div>`;
  }
  if (inv.logoLayout === 'right') {
    return `<div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${accent}; padding-bottom:22px; margin-bottom:24px;"><div>${companyBlock}</div><div style="text-align:end;"><div style="display:flex; justify-content:flex-end; margin-bottom:10px;">${logoEl}</div>${titleBlock}</div></div>`;
  }
  return `<div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${accent}; padding-bottom:22px; margin-bottom:24px;"><div style="display:flex; gap:14px; align-items:center;">${logoEl}<div>${companyBlock}</div></div><div style="text-align:end;">${titleBlock}</div></div>`;
}

function fill(template, tok) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (tok[k] !== undefined ? tok[k] : ''));
}

/* ------------------------------------------------------------------ free layout (designer) */
const CANVAS_W = 800;
export function renderLayoutBlock(block, tok, { absolute = true, offsetY = 0 } = {}) {
  const pos = absolute ? `position:absolute; left:${block.x}px; top:${block.y - offsetY}px; width:${block.w}px;` : `width:${block.w}px;`;
  if (block.type === 'logo') {
    const img = tok.__logo_url
      ? `<img src="${esc(tok.__logo_url)}" style="width:100%; height:100%; object-fit:contain;">`
      : `<div style="width:100%; height:100%; border-radius:8px; background:${esc(tok.ACCENT)}; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:${Math.max(16, Math.round(block.h * 0.4))}px;">${esc((tok.__company_name || 'R')[0])}</div>`;
    return `<div style="${pos} height:${block.h}px;">${img}</div>`;
  }
  if (block.type === 'table') {
    return `<div style="${pos}"><table style="width:100%; border-collapse:collapse;"><thead><tr style="background:${tok.ACCENT}12;">${tok.ITEMS_HEADER}</tr></thead><tbody>${tok.ITEMS_ROWS}</tbody></table></div>`;
  }
  if (block.type === 'totals') {
    const sl = (block.subtotalLabel && block.subtotalLabel.trim()) ? esc(block.subtotalLabel) : tok.SUBTOTAL_LABEL;
    const dl = (block.discountLabel && block.discountLabel.trim()) ? esc(block.discountLabel) : tok.DISCOUNT_LABEL;
    const gl = (block.grandTotalLabel && block.grandTotalLabel.trim()) ? esc(block.grandTotalLabel) : tok.GRAND_TOTAL_LABEL;
    return `<div style="${pos}">
      <div style="display:flex; justify-content:space-between; padding:5px 0; font-size:12.5px; color:#5B6B78;"><span>${sl}</span><span>${tok.SUBTOTAL}</span></div>
      <div style="display:flex; justify-content:space-between; padding:5px 0; font-size:12.5px; color:#5B6B78;"><span>${dl}</span><span>${tok.DISCOUNT_AMOUNT}</span></div>
      <div style="display:flex; justify-content:space-between; padding:10px 0; margin-top:4px; border-top:2px solid ${tok.ACCENT}; font-size:15px; font-weight:800; color:${tok.ACCENT};"><span>${gl}</span><span>${tok.GRAND_TOTAL}</span></div>
      <div style="text-align:right; font-size:11px; color:#5B6B78; margin-top:2px;">${tok.GRAND_TOTAL_OTHER}</div>${tok.BALANCE_BLOCK}</div>`;
  }
  if (block.type === 'notes') {
    return `<div style="${pos} font-size:12px; color:#5B6B78;">${tok.NOTES_BLOCK}${tok.VEHICLE_BLOCK}<div style="margin-top:16px; text-align:center; font-size:11.5px; padding-top:12px; border-top:1px solid #E3E8EC;">${tok.THANKS_NOTE}</div></div>`;
  }
  const text = fill(String(block.content || ''), tok);
  return `<div style="${pos} height:${block.h}px; font-size:${block.fontSize}px; font-weight:${block.bold ? 800 : 400}; text-align:${block.align}; color:${block.color}; white-space:pre-line; overflow:hidden; font-family:${tok.FONT_FAMILY};" dir="auto">${text}</div>`;
}

/**
 * The header blocks keep their absolute positions; the item table flows (grows with the number of lines)
 * and blocks placed below the table move down with it, so long invoices never overlap the totals.
 */
function layoutHtml(blocks, tok) {
  const table = blocks.find((b) => b.type === 'table') || { x: 30, y: 270, w: 740, h: 220 };
  const tableEnd = table.y + table.h;
  const above = blocks.filter((b) => b !== table && b.y < table.y);
  const below = blocks.filter((b) => b !== table && b.y >= table.y);
  const headH = Math.max(table.y, ...above.map((b) => b.y + b.h));
  const belowStart = below.length ? Math.min(...below.map((b) => b.y)) : tableEnd;
  const gap = Math.max(10, belowStart - tableEnd);
  const belowH = below.length ? Math.max(...below.map((b) => b.y + b.h)) - belowStart : 0;
  return `<div id="invoice-doc" dir="ltr" style="font-family:${tok.FONT_FAMILY}; color:#152128; width:${CANVAS_W}px; margin:0 auto; background:#fff; padding:20px 0;">
    <div style="position:relative; height:${headH}px;">${above.map((b) => renderLayoutBlock(b, tok)).join('')}</div>
    <div style="margin-left:${table.x}px; width:${table.w}px; min-height:${Math.max(40, table.y + table.h - headH)}px;">${renderLayoutBlock(table, tok, { absolute: false })}</div>
    <div style="position:relative; height:${belowH + 10}px; margin-top:${gap}px;">${below.map((b) => renderLayoutBlock(b, tok, { offsetY: belowStart })).join('')}</div>
  </div>`;
}

/** full A4 HTML body for a document */
export function invoiceBody(doc, { company, inv, template }) {
  const tok = buildTokens(doc, { company, inv });
  tok.__logo_url = absUrl(company.logo_url);
  tok.__company_name = company.name;
  const tpl = template || inv.template || 'layout';
  let body;
  if (tpl === 'layout' && Array.isArray(inv.headerLayout) && inv.headerLayout.length) body = layoutHtml(inv.headerLayout, tok);
  else if (tpl === 'custom' && inv.customTemplate) body = fill(inv.customTemplate, tok);
  else if (tpl === 'sherwan') body = fill(sherwanTemplate(), tok);
  else body = fill(defaultTemplate(), tok);
  return body;
}

/* ------------------------------------------------------------------ 80mm receipt */
export function receiptBody(doc, { company, inv }) {
  const pays = (doc.payments || []).filter((p) => p.purpose !== 'change');
  const change = (doc.change || []).reduce((s, c) => s + c.amount, 0);
  const otherCur = doc.currency === 'USD' ? 'IQD' : 'USD';
  const rows = doc.lines.filter((l) => l.kind !== 'text').map((l) => `
    <tr><td colspan="3" dir="auto" style="padding-top:4px">${esc(l.description)}</td></tr>
    <tr><td class="dim">${fqty(l.qty)} × ${money(l.unit_price, doc.currency)}</td><td></td><td class="r">${money(l.line_total, doc.currency)}</td></tr>
    ${l.discount ? `<tr><td class="dim" colspan="2">${esc(t('doc.discount'))}</td><td class="r">−${money(l.discount, doc.currency)}</td></tr>` : ''}`).join('');
  const logo = absUrl(company.logo_url);
  return `<div class="rc">
    ${logo ? `<div class="c"><img src="${esc(logo)}" style="max-width:46mm; max-height:22mm; object-fit:contain"></div>` : ''}
    <div class="c b big" dir="auto">${esc(company.name || '')}</div>
    <div class="c sm" dir="auto">${esc(company.address || '')}</div>
    <div class="c sm">${esc([company.phone, company.phone2].filter(Boolean).join(' | '))}</div>
    <div class="line"></div>
    <div class="row"><span>${esc(t(`print.title.${doc.type}`))}</span><b>${esc(doc.no)}</b></div>
    <div class="row sm"><span>${fdate(doc.date)}</span><span>${esc(doc.staff_name || '')}</span></div>
    ${doc.partner_name && !doc.is_walkin ? `<div class="sm" dir="auto">${esc(doc.partner_name)}${doc.partner_phone ? ` · ${esc(doc.partner_phone)}` : ''}</div>` : ''}
    ${doc.vehicle_plate || doc.vehicle_desc ? `<div class="sm">${esc(t('doc.vehicle'))}: <span dir="ltr">${esc(doc.vehicle_plate || '')}</span> ${esc(doc.vehicle_desc || '')}</div>` : ''}
    <div class="line"></div>
    <table>${rows}</table>
    <div class="line"></div>
    ${(doc.discount || 0) > 0 ? `<div class="row"><span>${esc(t('doc.discount'))}</span><span>−${money(doc.discount, doc.currency)}</span></div>` : ''}
    <div class="row b big"><span>${esc(t('doc.grand_total'))}</span><span>${money(doc.total, doc.currency)}</span></div>
    <div class="row sm"><span></span><span>≈ ${money(convert(doc.total, doc.currency, otherCur, doc.usd_iqd), otherCur)}</span></div>
    ${pays.length ? '<div class="line"></div>' + pays.map((p) => `<div class="row sm"><span>${esc(t(`pay.method.${p.method}`))} (${esc(p.currency)})</span><span>${money(p.amount, p.currency)}</span></div>`).join('') : ''}
    ${change > 0 ? `<div class="row sm"><span>${esc(t('pos.change'))}</span><span>${money(change, (doc.change[0] || {}).currency || doc.currency)}</span></div>` : ''}
    ${doc.remaining > (doc.currency === 'IQD' ? 1 : 0.01) ? `<div class="row b"><span>${esc(t('doc.remaining'))}</span><span>${money(doc.remaining, doc.currency)}</span></div>` : ''}
    <div class="line"></div>
    <div class="c sm" dir="auto">${esc(inv.thanks || t('print.thanks'))}</div>
    <div class="c" style="margin-top:4px">${barcodeSvg(doc.no, { height: 28, showText: false }).replace('<svg ', '<svg style="width:46mm;height:9mm" ')}</div>
  </div>`;
}
export const RECEIPT_CSS = `
  body { width: 80mm; }
  .rc { padding: 3mm 4mm; font-family: 'Plex', 'Plex Arabic', 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11px; color: #000; }
  .c { text-align: center; } .b { font-weight: 700; } .big { font-size: 13px; } .sm { font-size: 10px; } .dim { color: #333; }
  .line { border-top: 1px dashed #000; margin: 5px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; } td.r { text-align: right; white-space: nowrap; }`;

/* ------------------------------------------------------------------ workshop job card */
export function jobCardBody(doc, { company }) {
  const logo = absUrl(company.logo_url);
  const lines = doc.lines.filter((l) => l.kind !== 'text');
  return `<div style="font-family:'Plex','Plex Arabic','Segoe UI',Arial,sans-serif; font-size:12px; color:#111; padding:6px 4px;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #111; padding-bottom:10px;">
      <div style="display:flex; gap:12px; align-items:center;">${logo ? `<img src="${esc(logo)}" style="height:54px">` : ''}<div><div style="font-size:17px; font-weight:700" dir="auto">${esc(company.name || '')}</div><div dir="auto">${esc(company.phone || '')}</div></div></div>
      <div style="text-align:end"><div style="font-size:20px; font-weight:700">${esc(t('print.title.service'))}</div><div style="font-size:14px">${esc(doc.no)}</div><div>${fdate(doc.date)}</div></div>
    </div>
    <table style="width:100%; border-collapse:collapse; margin-top:12px;">
      <tr><td style="width:18%; color:#555">${esc(t('doc.customer'))}</td><td style="width:32%; font-weight:600" dir="auto">${esc(dn(doc.partner_name) || '')}</td><td style="width:18%; color:#555">${esc(t('common.phone'))}</td><td dir="ltr">${esc(doc.partner_phone || '')}</td></tr>
      <tr><td style="color:#555">${esc(t('vehicle.plate'))}</td><td style="font-weight:600; font-size:15px" dir="ltr">${esc(doc.vehicle_plate || doc.v_plate || '')}</td><td style="color:#555">${esc(t('doc.vehicle'))}</td><td dir="auto">${esc(doc.vehicle_desc || '')}</td></tr>
      <tr><td style="color:#555">${esc(t('vehicle.km'))}</td><td>${doc.km ? num(doc.km) : ''}</td><td style="color:#555">${esc(t('doc.technician'))}</td><td>${esc(doc.technician_name || '')}</td></tr>
    </table>
    <div style="margin-top:12px; border:1px solid #999; border-radius:6px; padding:8px 10px; min-height:60px;"><div style="color:#555; font-size:11px">${esc(t('doc.complaint'))}</div><div style="white-space:pre-line" dir="auto">${esc(doc.complaint || '')}</div></div>
    <div style="margin-top:8px; border:1px solid #999; border-radius:6px; padding:8px 10px; min-height:60px;"><div style="color:#555; font-size:11px">${esc(t('doc.work_done'))}</div><div style="white-space:pre-line" dir="auto">${esc(doc.work_done || '')}</div></div>
    <table style="width:100%; border-collapse:collapse; margin-top:12px;">
      <thead><tr><th style="text-align:start; border-bottom:1.5px solid #111; padding:5px">${esc(t('print.col.desc'))}</th><th style="border-bottom:1.5px solid #111; padding:5px; text-align:end">${esc(t('print.col.qty'))}</th><th style="border-bottom:1.5px solid #111; padding:5px; text-align:end">${esc(t('print.col.price'))}</th><th style="border-bottom:1.5px solid #111; padding:5px; text-align:end">${esc(t('print.col.total'))}</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td style="padding:5px; border-bottom:1px solid #ddd" dir="auto">${esc(l.description)}${l.kind === 'labor' ? ` <span style="color:#555">(${esc(t('doc.kind.labor'))})</span>` : ''}</td><td style="padding:5px; border-bottom:1px solid #ddd; text-align:end">${fqty(l.qty)}</td><td style="padding:5px; border-bottom:1px solid #ddd; text-align:end" dir="ltr">${money(l.unit_price, doc.currency)}</td><td style="padding:5px; border-bottom:1px solid #ddd; text-align:end" dir="ltr">${money(l.line_total, doc.currency)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3" style="padding:7px 5px; text-align:end; font-weight:700">${esc(t('doc.grand_total'))}</td><td style="padding:7px 5px; text-align:end; font-weight:700" dir="ltr">${money(doc.total, doc.currency)}</td></tr></tfoot>
    </table>
    <div style="display:flex; gap:20px; margin-top:40px;">
      <div style="flex:1; border-top:1px solid #111; padding-top:4px; text-align:center">${esc(t('print.customer_signature'))}</div>
      <div style="flex:1; border-top:1px solid #111; padding-top:4px; text-align:center">${esc(t('print.technician_signature'))}</div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ account statement */
/**
 * How one statement line reads: payments show as payments (with the invoice they settled as a reference),
 * documents by their type; a stored description that only repeats the number is left out.
 */
export function stmtCells(r) {
  const isPay = !!r.payment_id || ['payment_in', 'payment_out', 'change'].includes(r.kind);
  const type = isPay || !r.doc_type ? t(`move.kind.${r.kind}`) : t(`doc.type.${r.doc_type}`);
  const no = isPay ? (r.payment_no || r.doc_no || '') : (r.doc_no || r.payment_no || '');
  const ref = isPay && r.payment_no && r.doc_no ? r.doc_no : '';
  const d = String(r.description || '').trim();
  const desc = d && d !== no && !(r.doc_no && d.includes(r.doc_no)) && !(r.payment_no && d.includes(r.payment_no)) ? d : '';
  return { type, no, ref, desc };
}

export function statementBody(st, { company, from, to }) {
  const logo = absUrl(company.logo_url);
  return `<div style="font-family:'Plex','Plex Arabic','Segoe UI',Arial,sans-serif; font-size:11.5px; color:#111;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #111; padding-bottom:10px; margin-bottom:12px;">
      <div style="display:flex; gap:12px; align-items:center;">${logo ? `<img src="${esc(logo)}" style="height:48px">` : ''}<div><div style="font-size:16px; font-weight:700" dir="auto">${esc(company.name || '')}</div><div>${esc(company.phone || '')}</div></div></div>
      <div style="text-align:end"><div style="font-size:18px; font-weight:700">${esc(t('partner.statement'))}</div><div dir="auto" style="font-size:14px">${esc(st.partner.name)}</div><div>${from ? fdate(from) : ''} — ${to ? fdate(to) : fdate(new Date().toISOString().slice(0, 10))}</div></div>
    </div>
    ${st.sections.map((s) => `
      <h3 style="font-size:13px; margin:14px 0 6px">${esc(s.currency)}</h3>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr>${[t('common.date'), t('common.type'), t('doc.no'), t('common.description'), t('partner.debit'), t('partner.credit'), t('partner.balance')].map((h, i) => `<th style="text-align:${i >= 4 ? 'end' : 'start'}; border-bottom:1.5px solid #111; padding:4px 5px; font-size:11px">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td colspan="6" style="padding:4px 5px; color:#555">${esc(t('partner.opening_balance'))}</td><td style="text-align:end; padding:4px 5px"><span dir="ltr">${money(s.opening, s.currency)}</span></td></tr>
          ${s.rows.map((r) => { const c = stmtCells(r); return `<tr><td style="padding:4px 5px; border-bottom:1px solid #ddd; white-space:nowrap">${fdate(r.date)}</td><td style="padding:4px 5px; border-bottom:1px solid #ddd; white-space:nowrap">${esc(c.type)}</td><td style="padding:4px 5px; border-bottom:1px solid #ddd; white-space:nowrap">${esc(c.no)}</td>
            <td style="padding:4px 5px; border-bottom:1px solid #ddd">${c.ref ? `<span dir="ltr">→ ${esc(c.ref)}</span> ` : ''}<span dir="auto">${esc(c.desc)}</span></td>
            <td style="text-align:end; padding:4px 5px; border-bottom:1px solid #ddd"><span dir="ltr">${r.amount > 0 ? money(r.amount, s.currency) : ''}</span></td>
            <td style="text-align:end; padding:4px 5px; border-bottom:1px solid #ddd"><span dir="ltr">${r.amount < 0 ? money(-r.amount, s.currency) : ''}</span></td>
            <td style="text-align:end; padding:4px 5px; border-bottom:1px solid #ddd; font-weight:600"><span dir="ltr">${money(r.balance, s.currency)}</span></td></tr>`; }).join('')}
        </tbody>
        <tfoot><tr><td colspan="4" style="padding:6px 5px; font-weight:700">${esc(t('common.total'))}</td><td style="text-align:end; padding:6px 5px; font-weight:700"><span dir="ltr">${money(s.debit, s.currency)}</span></td><td style="text-align:end; padding:6px 5px; font-weight:700"><span dir="ltr">${money(s.credit, s.currency)}</span></td><td style="text-align:end; padding:6px 5px; font-weight:700"><span dir="ltr">${money(s.closing, s.currency)}</span></td></tr></tfoot>
      </table>
      <div style="text-align:end; margin-top:6px; font-size:12.5px; font-weight:700">${esc(s.closing > 0 ? t('partner.they_owe') : s.closing < 0 ? t('partner.we_owe') : t('partner.settled'))}: <span dir="ltr">${money(Math.abs(s.closing), s.currency)}</span></div>`).join('')}
  </div>`;
}
