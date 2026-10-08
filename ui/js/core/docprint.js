// Printing and sharing documents: A4 invoice (chosen template), 80mm receipt, workshop job card, WhatsApp text.
import { t, getLang } from './i18n.js';
import { boot } from './store.js';
import { printHtml, previewHtml } from './print.js';
import { invoiceBody, receiptBody, RECEIPT_CSS, jobCardBody, statementBody } from './invoice.js';
import { money, date as fdate, waPhone } from './format.js';
import { api } from './api.js';
import { toast } from './ui.js';

function company() { return boot().company || {}; }
function inv() { return (boot().settings || {}).invoice || {}; }
function pos() { return (boot().settings || {}).pos || {}; }

/** make sure we have the full document (lines, payments) */
async function full(doc) {
  if (doc && Array.isArray(doc.lines) && Array.isArray(doc.payments)) return doc;
  return api.get(`/api/docs/${doc.id || doc}`);
}

export function docBody(doc, mode = 'a4', template) {
  if (mode === 'receipt') return receiptBody(doc, { company: company(), inv: inv() });
  if (mode === 'job') return jobCardBody(doc, { company: company() });
  return invoiceBody(doc, { company: company(), inv: inv(), template });
}

/** mode: 'a4' | 'receipt' | 'job' | 'auto' (POS setting decides) */
export async function printDoc(docOrId, mode = 'a4', { silent = false, copies = 1 } = {}) {
  const doc = await full(docOrId);
  let m = mode;
  if (m === 'auto') m = pos().print_mode === 'a4' ? 'a4' : 'receipt';
  const title = `${doc.no}`;
  if (m === 'receipt') {
    const printer = pos().receipt_printer || '';
    return printHtml(docBody(doc, 'receipt'), { title, page: 'receipt', css: RECEIPT_CSS, silent: silent && !!printer, printer, copies });
  }
  const paper = inv().paper === 'A5' ? 'A5' : 'A4';
  return printHtml(docBody(doc, m), { title, page: paper, copies, dir: 'ltr' });
}

export async function previewDoc(docOrId, mode = 'a4') {
  const doc = await full(docOrId);
  if (mode === 'receipt') return previewHtml(docBody(doc, 'receipt'), { title: doc.no, page: 'receipt', css: RECEIPT_CSS });
  return previewHtml(docBody(doc, mode), { title: doc.no, page: inv().paper === 'A5' ? 'A5' : 'A4' });
}

export function printStatement(st, from, to) {
  return printHtml(statementBody(st, { company: company(), from, to }), { title: `${t('partner.statement')} — ${st.partner.name}`, page: 'A4', dir: getLang() === 'ar' ? 'rtl' : 'ltr' });
}

export function openExternal(url) {
  if (window.desktop && window.desktop.openExternal) window.desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/** WhatsApp link with an optional phone number (opens WhatsApp Web / desktop app) */
export function whatsapp(phone, text) {
  const p = waPhone(phone);
  const url = p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
  openExternal(url);
}

export function docShareText(doc) {
  const c = company();
  const lines = [
    `${c.name || ''}`.trim(),
    `${t(`print.title.${doc.type}`)}: ${doc.no} — ${fdate(doc.date)}`,
    `${t('doc.grand_total')}: ${money(doc.total, doc.currency)}`,
  ];
  if (doc.remaining != null && doc.remaining > (doc.currency === 'IQD' ? 1 : 0.01)) lines.push(`${t('doc.remaining')}: ${money(doc.remaining, doc.currency)}`);
  if (doc.vehicle_plate || doc.v_plate) lines.push(`${t('doc.vehicle')}: ${doc.vehicle_plate || doc.v_plate} ${doc.vehicle_desc || ''}`.trim());
  lines.push(t('wa.thanks'));
  return lines.filter(Boolean).join('\n');
}

export async function shareDoc(docOrId) {
  const doc = await full(docOrId);
  whatsapp(doc.partner_is_walkin || doc.is_walkin ? '' : doc.partner_phone, docShareText(doc));
}

/** balance reminder for a customer */
export function reminderText(partner) {
  const c = company();
  const parts = Object.entries(partner.balances || {}).filter(([, v]) => v > 0).map(([cur, v]) => money(v, cur));
  if (!parts.length) { toast(t('partner.no_debt'), 'warn'); return null; }
  return t('wa.reminder', { name: partner.name, amount: parts.join(' + '), company: c.name || '' });
}
