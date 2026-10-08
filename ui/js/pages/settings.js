// Settings: company, invoice design (templates + drag & drop designer), POS, currencies, stock & warehouses,
// price lists, catalogue (categories, brands, vehicle makes/models), numbering, labels, backup, network, security.
import { html, useState, useEffect, useRef, useMemo } from '../core/h.js';
import { t, LANGS, getLang, has } from '../core/i18n.js';
import { api } from '../core/api.js';
import { can, boot, useStore } from '../core/store.js';
import { useTitle } from '../core/page.js';
import { navigate } from '../core/router.js';
import { refreshBoot } from '../core/session.js';
import { money, num, today, date as fdate, dateTime, usdIqd, fileSize } from '../core/format.js';
import {
  Icon, Btn, IconBtn, Modal, Field, Input, NumInput, Select, Textarea, Segmented, Check, Table, Panel, Empty, Loading, Notice, Pill, KV,
  useAsync, openModal, toast, errToast, confirmDialog, promptDialog, readImage, pickFile,
} from '../core/ui.js';
import { wrapHtml, printHtml } from '../core/print.js';
import { invoiceBody, buildTokens, renderLayoutBlock, defaultHeaderLayout, TOKEN_LIST, defaultTemplate, sherwanTemplate, receiptBody, RECEIPT_CSS, absUrl } from '../core/invoice.js';
import { RateDialog } from '../app.js';
import { PartnerPicker, PriceListSelect, WarehouseSelect, CurrencySelect } from './pickers.js';
import { clearModelCache } from './products.js';
import { dn } from '../core/names.js';
import { labelHtml, labelCss } from './products.js';

const SECTIONS = [
  ['company', 'store', 'settings.manage'], ['invoice', 'file-text', 'settings.manage'], ['pos', 'shopping-cart', 'settings.manage'],
  ['currencies', 'coins', 'settings.manage'], ['stock', 'boxes', 'settings.manage'], ['pricelists', 'tag', 'settings.manage'],
  ['catalog', 'layout-grid', 'settings.manage'], ['numbering', 'hash', 'settings.manage'], ['labels', 'scan-barcode', 'settings.manage'],
  ['backup', 'database', 'backup.manage'], ['network', 'wifi', 'settings.manage'], ['security', 'shield', 'settings.manage'],
  ['general', 'sliders-horizontal', 'settings.manage'], ['about', 'info', 'settings.manage'],
];

export function Settings({ tab }) {
  useTitle(t('nav.settings'));
  const allowed = SECTIONS.filter(([, , p]) => can(p));
  const cur = allowed.some(([k]) => k === tab) ? tab : (allowed[0] || [])[0];
  return html`<div class="page settings-layout">
    <nav class="settings-nav">${allowed.map(([k, icon]) => html`<button type="button" class=${cur === k ? 'on' : ''} onClick=${() => navigate(`/settings/${k}`)}><${Icon} name=${icon} size="sm" />${t(`settings.${k}`)}</button>`)}</nav>
    <div class="stack" style="min-width:0">
      ${cur === 'company' && html`<${CompanySettings} />`}
      ${cur === 'invoice' && html`<${InvoiceSettings} />`}
      ${cur === 'pos' && html`<${PosSettings} />`}
      ${cur === 'currencies' && html`<${CurrencySettings} />`}
      ${cur === 'stock' && html`<${StockSettings} />`}
      ${cur === 'pricelists' && html`<${PriceListSettings} />`}
      ${cur === 'catalog' && html`<${CatalogSettings} />`}
      ${cur === 'numbering' && html`<${NumberingSettings} />`}
      ${cur === 'labels' && html`<${LabelSettings} />`}
      ${cur === 'backup' && html`<${BackupSettings} />`}
      ${cur === 'network' && html`<${NetworkSettings} />`}
      ${cur === 'security' && html`<${SecuritySettings} />`}
      ${cur === 'general' && html`<${GeneralSettings} />`}
      ${cur === 'about' && html`<${AboutSettings} />`}
    </div>
  </div>`;
}

/** hook: edit one settings group and save it */
function useSettingsGroup(key) {
  const [val, setVal] = useState(() => JSON.parse(JSON.stringify((boot().settings || {})[key] || {})));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (patch) => { setVal((v) => ({ ...v, ...patch })); setDirty(true); };
  const save = async (extra) => {
    setSaving(true);
    try {
      const r = await api.post(`/api/settings/${key}`, { ...val, ...(extra || {}) });
      setVal(r);
      setDirty(false);
      await refreshBoot();
      toast(t('common.saved'));
      return r;
    } catch (e) { errToast(e); return null; } finally { setSaving(false); }
  };
  return { val, set, save, saving, dirty };
}

function SaveBar({ g, label }) {
  return html`<div class="row end mt-16"><${Btn} kind="primary" icon="check" disabled=${g.saving || !g.dirty} onClick=${() => g.save()}>${label || t('common.save')}</${Btn}></div>`;
}

/* ------------------------------------------------------------------ company */
function CompanySettings() {
  const c0 = boot().company || {};
  const [c, setC] = useState({ name: c0.name || '', slogan: c0.slogan || '', address: c0.address || '', phone: c0.phone || '', phone2: c0.phone2 || '', email: c0.email || '', tax_no: c0.tax_no || '', tax_office: c0.tax_office || '' });
  const [logo, setLogo] = useState(c0.logo_url || null);
  const [newLogo, setNewLogo] = useState(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (p) => setC({ ...c, ...p });
  const pick = async () => {
    const f = await pickFile('image/*');
    if (!f) return;
    const url = await readImage(f, 800, 0.9);
    setNewLogo(url); setLogo(url); setRemoveLogo(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/company', { ...c, logo: newLogo || undefined, logo_remove: removeLogo || undefined });
      await refreshBoot();
      setNewLogo(null);
      toast(t('common.saved'));
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  return html`<${Panel} title=${t('settings.company')} icon="store">
    <div class="row top gap-16 wrap">
      <div class="col gap-8" style="align-items:center">
        <div class="photo-box" style="width:150px;height:150px" onClick=${pick}>${logo ? html`<img src=${logo} alt="" style="object-fit:contain" />` : html`<${Icon} name="image" size="lg" cls="muted" />`}</div>
        <div class="row gap-8"><button type="button" class="link-btn small" onClick=${pick}>${t('company.logo')}</button>
          ${logo && html`<button type="button" class="link-btn small neg" onClick=${() => { setLogo(null); setNewLogo(null); setRemoveLogo(true); }}>${t('common.remove')}</button>`}</div>
        <p class="tiny muted" style="max-width:160px;text-align:center">${t('company.logo_hint')}</p>
      </div>
      <div class="grow grid-form">
        <${Field} label=${t('company.name')} cls="span-2"><${Input} value=${c.name} onValue=${(v) => set({ name: v })} dir="auto" /></${Field}>
        <${Field} label=${t('company.slogan')} cls="span-2"><${Input} value=${c.slogan} onValue=${(v) => set({ slogan: v })} dir="auto" /></${Field}>
        <${Field} label=${t('company.address')} cls="span-all"><${Input} value=${c.address} onValue=${(v) => set({ address: v })} dir="auto" /></${Field}>
        <${Field} label=${t('company.phone')}><${Input} value=${c.phone} onValue=${(v) => set({ phone: v })} /></${Field}>
        <${Field} label=${t('partner.phone2')}><${Input} value=${c.phone2} onValue=${(v) => set({ phone2: v })} /></${Field}>
        <${Field} label=${t('partner.email')}><${Input} value=${c.email} onValue=${(v) => set({ email: v })} /></${Field}>
        <${Field} label=${t('partner.tax_no')}><${Input} value=${c.tax_no} onValue=${(v) => set({ tax_no: v })} /></${Field}>
        <${Field} label=${t('company.tax_office')}><${Input} value=${c.tax_office} onValue=${(v) => set({ tax_office: v })} /></${Field}>
      </div>
    </div>
    <div class="row end mt-16"><${Btn} kind="primary" icon="check" disabled=${busy} onClick=${save}>${t('common.save')}</${Btn}></div>
  </${Panel}>`;
}

/* ------------------------------------------------------------------ invoice design */
function sampleDoc() {
  const me = boot().user || {};
  const rate = usdIqd();
  return {
    id: 'sample', type: 'sale', no: `SF${today().slice(0, 4)}-0001`, date: today(), due_date: null, currency: 'IQD', usd_iqd: rate, rate,
    total: 255000, discount: 0, line_discount: 0, paid: 155000, remaining: 100000, payment_status: 'partial', status: 'posted',
    partner_name: t('settings.sample_customer'), partner_phone: '0750 000 0000', partner_address: 'Zakho', staff_name: me.full_name || '',
    vehicle_plate: '12 A 34567', vehicle_desc: 'Toyota Corolla 2019', km: 85000, notes: t('settings.sample_note'),
    lines: [
      { kind: 'product', code: 'PS-2201', description: t('settings.sample_line1'), qty: 1, unit: 'set', unit_price: 75000, discount: 0, line_total: 75000, warranty_until: null },
      { kind: 'product', code: 'LED-H7', description: t('settings.sample_line2'), qty: 2, unit: 'adet', unit_price: 60000, discount: 0, line_total: 120000 },
      { kind: 'labor', code: '', description: t('settings.sample_line3'), qty: 1, unit: '', unit_price: 60000, discount: 0, line_total: 60000 },
    ],
    payments: [{ method: 'cash', currency: 'IQD', amount: 155000, purpose: 'sale', account_name: 'Kasa IQD' }], change: [],
  };
}

/** scaled live preview of an HTML page */
function PreviewFrame({ body, width = 820, height = 1160, page = 'A4', css = '' }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0.7);
  useEffect(() => {
    if (!box.current) return undefined;
    const ro = new ResizeObserver(() => { if (box.current) setScale(Math.min(1, (box.current.clientWidth - 24) / width)); });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const doc = wrapHtml(body, { page, css });
  // the page keeps its own reading direction inside the frame; the frame itself is laid out left-to-right and centred
  return html`<div class="paper-preview" ref=${box} style="direction:ltr; overflow:hidden; padding:12px 0">
    <div style=${`width:${Math.round(width * scale)}px; height:${Math.round(height * scale)}px; margin:0 auto; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,.12); background:#fff`}>
      <iframe title="preview" srcdoc=${doc} style=${`width:${width}px; height:${height}px; border:0; background:#fff; transform:scale(${scale}); transform-origin:0 0; display:block`}></iframe>
    </div>
  </div>`;
}

const FONTS = [
  ["'Segoe UI', Tahoma, Arial, sans-serif", 'Segoe UI'], ["'Plex', 'Plex Arabic', Arial, sans-serif", 'IBM Plex'], ["Tahoma, Arial, sans-serif", 'Tahoma'],
  ["Arial, Helvetica, sans-serif", 'Arial'], ["'Times New Roman', serif", 'Times'],
];

function InvoiceSettings() {
  const g = useSettingsGroup('invoice');
  const inv = g.val;
  const [doc, setDoc] = useState(sampleDoc());
  const [useReal, setUseReal] = useState(false);
  useEffect(() => {
    if (!useReal) { setDoc(sampleDoc()); return; }
    api.get('/api/docs', { type: 'sale', limit: 1, from: '2000-01-01' }).then((r) => (r.rows[0] ? api.get(`/api/docs/${r.rows[0].id}`) : null)).then((d) => d && setDoc(d)).catch(() => {});
  }, [useReal]);
  const company = boot().company || {};
  const body = useMemo(() => invoiceBody(doc, { company, inv }), [doc, JSON.stringify(inv)]);
  const openDesigner = () => openModal(DesignerDialog, { inv, doc }).then((r) => { if (r) g.set({ headerLayout: r.headerLayout, itemsTableConfig: r.itemsTableConfig, template: 'layout' }); });
  const editCustom = () => openModal(CustomTemplateDialog, { inv, doc }).then((r) => { if (r !== undefined && r !== null) g.set({ customTemplate: r, template: 'custom' }); });
  return html`<div class="split wide-side" style="grid-template-columns:minmax(0,1fr) 420px">
    <div class="stack">
      <${Panel} title=${t('settings.preview')} icon="eye" tools=${html`<${Check} checked=${useReal} onValue=${setUseReal} label=${t('settings.preview_real')} />
        <${Btn} size="sm" icon="printer" onClick=${() => printHtml(body, { page: inv.paper === 'A5' ? 'A5' : 'A4', title: 'test' })}>${t('settings.test_print')}</${Btn}>`}>
        <${PreviewFrame} body=${body} />
      </${Panel}>
    </div>
    <div class="stack">
      <${Panel} title=${t('settings.template')} icon="file-text">
        <div class="col gap-8">
          ${[['layout', 'settings.tpl.layout'], ['default', 'settings.tpl.default'], ['sherwan', 'settings.tpl.sherwan'], ['custom', 'settings.tpl.custom']].map(([k, label]) => html`<label class="check" style="align-items:flex-start;padding:6px 0">
            <input type="radio" name="tpl" checked=${(inv.template || 'layout') === k} onChange=${() => g.set({ template: k })} style="margin-top:3px" />
            <span><b>${t(label)}</b><div class="small muted">${t(`${label}_desc`)}</div></span></label>`)}
        </div>
        <div class="row wrap gap-8 mt-12">
          <${Btn} icon="move" onClick=${openDesigner}>${t('settings.open_designer')}</${Btn}>
          <${Btn} icon="square-pen" onClick=${editCustom}>${t('settings.edit_html')}</${Btn}>
        </div>
        ${(inv.template || 'layout') === 'layout' && !(inv.headerLayout && inv.headerLayout.length) && html`<p class="small muted mt-8">${t('settings.layout_default_used')}</p>`}
      </${Panel}>
      <${Panel} title=${t('settings.style')} icon="palette">
        <div class="form-2">
          <${Field} label=${t('settings.accent')}><input type="color" class="input" style="padding:3px" value=${inv.accentColor || '#1C5FA8'} onInput=${(e) => g.set({ accentColor: e.target.value })} /></${Field}>
          <${Field} label=${t('settings.dark_color')}><input type="color" class="input" style="padding:3px" value=${inv.invDarkColor || '#14181D'} onInput=${(e) => g.set({ invDarkColor: e.target.value })} /></${Field}>
          <${Field} label=${t('settings.font')}><${Select} value=${inv.invFontFamily} onValue=${(v) => g.set({ invFontFamily: v })} options=${FONTS.map(([v, l]) => ({ value: v, label: l }))} /></${Field}>
          <${Field} label=${t('settings.paper')}><${Select} value=${inv.paper || 'A4'} onValue=${(v) => g.set({ paper: v })} options=${[{ value: 'A4', label: 'A4' }, { value: 'A5', label: 'A5' }]} /></${Field}>
          <${Field} label=${t('settings.base_font')}><${NumInput} value=${inv.invBaseFontSize} onValue=${(v) => g.set({ invBaseFontSize: v || 12 })} dec=${0} /></${Field}>
          <${Field} label=${t('settings.title_font')}><${NumInput} value=${inv.invTitleFontSize} onValue=${(v) => g.set({ invTitleFontSize: v || 15 })} dec=${0} /></${Field}>
          <${Field} label=${t('settings.logo_size')}><${NumInput} value=${inv.logoSize} onValue=${(v) => g.set({ logoSize: v || 56 })} dec=${0} /></${Field}>
          <${Field} label=${t('settings.logo_layout')}><${Select} value=${inv.logoLayout || 'left'} onValue=${(v) => g.set({ logoLayout: v })} options=${['left', 'right', 'top'].map((x) => ({ value: x, label: t(`settings.logo_${x}`) }))} /></${Field}>
        </div>
        <div class="col gap-8 mt-12">
          <${Field} label=${t('settings.thanks')}><${Input} value=${inv.thanks || ''} onValue=${(v) => g.set({ thanks: v })} placeholder=${t('print.thanks')} dir="auto" /></${Field}>
          <${Check} checked=${inv.show_other_currency !== false} onValue=${(v) => g.set({ show_other_currency: v })} label=${t('settings.show_other_currency')} />
          <${Check} checked=${inv.show_warranty !== false} onValue=${(v) => g.set({ show_warranty: v })} label=${t('settings.show_warranty')} />
        </div>
        <${SaveBar} g=${g} />
      </${Panel}>
      <${Panel} title=${t('settings.receipt_preview')} icon="receipt">
        <${PreviewFrame} body=${receiptBody(doc, { company, inv })} width=${310} height=${720} page="receipt" css=${RECEIPT_CSS} />
      </${Panel}>
    </div>
  </div>`;
}

const CANVAS_W = 800;
const CANVAS_H = 1130;
function itemsColumnsOf(inv) {
  const defaults = ['row', 'code', 'desc', 'qty', 'unit', 'price', 'discount', 'total'].map((k) => ({ key: k, visible: !['unit', 'discount'].includes(k), label: '' }));
  const cfg = Array.isArray(inv.itemsTableConfig) && inv.itemsTableConfig.length ? inv.itemsTableConfig.map((c) => ({ ...c })) : null;
  if (!cfg) return defaults;
  for (const d of defaults) if (!cfg.some((c) => c.key === d.key)) cfg.push(d);
  return cfg;
}

function DesignerDialog({ inv, doc, close }) {
  const [blocks, setBlocks] = useState(() => JSON.parse(JSON.stringify(inv.headerLayout && inv.headerLayout.length ? inv.headerLayout : defaultHeaderLayout())));
  const [cols, setCols] = useState(() => itemsColumnsOf(inv));
  const [sel, setSel] = useState(null);
  const drag = useRef(null);
  const company = boot().company || {};
  const tok = useMemo(() => {
    const tk = buildTokens(doc, { company, inv: { ...inv, itemsTableConfig: cols } });
    tk.__logo_url = absUrl(company.logo_url);
    tk.__company_name = company.name;
    return tk;
  }, [JSON.stringify(cols)]);
  const update = (id, patch) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const snap = (v) => Math.round(v / 10) * 10;
  useEffect(() => {
    const move = (e) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.mode === 'move') update(d.id, { x: snap(Math.max(0, Math.min(CANVAS_W - 20, d.ox + dx))), y: snap(Math.max(0, Math.min(CANVAS_H - 10, d.oy + dy))) });
      else {
        const b = blocks.find((x) => x.id === d.id);
        const patch = { w: snap(Math.max(60, d.ow + dx)) };
        if (b && !['table', 'totals', 'notes'].includes(b.type)) patch.h = snap(Math.max(14, d.oh + dy));
        update(d.id, patch);
      }
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [blocks]);
  const start = (e, b, mode) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(b.id);
    drag.current = { mode, id: b.id, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, ow: b.w, oh: b.h };
  };
  const addText = () => {
    const id = `t${Date.now()}`;
    setBlocks([...blocks, { id, type: 'text', x: 40, y: 120, w: 300, h: 24, fontSize: 12, bold: false, align: 'left', color: '#152128', content: t('settings.new_text') }]);
    setSel(id);
  };
  const b = blocks.find((x) => x.id === sel);
  const auto = b && ['table', 'totals', 'notes'].includes(b.type);
  const colName = (k) => t(`print.col.${k}`);
  return html`<${Modal} title=${t('settings.designer')} icon="move" close=${close} size="full"
    left=${html`<${Btn} size="sm" icon="plus" onClick=${addText}>${t('settings.add_text')}</${Btn}><${Btn} size="sm" onClick=${() => { setBlocks(defaultHeaderLayout()); setSel(null); }}>${t('settings.reset_default')}</${Btn}>`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} kind="primary" icon="check" onClick=${() => close({ headerLayout: blocks, itemsTableConfig: cols })}>${t('settings.apply_design')}</${Btn}>`}>
    <div class="designer-wrap">
      <div class="designer-stage" onPointerDown=${() => setSel(null)}>
        <div class="designer-canvas" style=${`width:${CANVAS_W}px;height:${CANVAS_H}px`}>
          ${blocks.map((bl) => html`<div key=${bl.id} class=${`designer-block ${sel === bl.id ? 'sel' : ''}`} style=${`left:${bl.x}px;top:${bl.y}px;width:${bl.w}px;${['table', 'totals', 'notes'].includes(bl.type) ? '' : `height:${bl.h}px;`}`}
            onPointerDown=${(e) => start(e, bl, 'move')}>
            <div style="pointer-events:none" dangerouslySetInnerHTML=${{ __html: renderLayoutBlock(bl, tok, { absolute: false }) }}></div>
            ${sel === bl.id && html`<div class="rs" onPointerDown=${(e) => start(e, bl, 'resize')}></div>`}
          </div>`)}
        </div>
      </div>
      <aside class="designer-side">
        <p class="small muted">${t('settings.designer_hint')}</p>
        ${!b ? html`<p class="small muted mt-12">${t('settings.designer_select')}</p>` : html`<div class="col gap-8 mt-12">
          <div class="label">${t(`settings.block.${b.type}`)}</div>
          <div class="form-2">
            <${Field} label="X"><${NumInput} size="sm" value=${b.x} onValue=${(v) => update(b.id, { x: v || 0 })} dec=${0} /></${Field}>
            <${Field} label="Y"><${NumInput} size="sm" value=${b.y} onValue=${(v) => update(b.id, { y: v || 0 })} dec=${0} /></${Field}>
            <${Field} label=${t('settings.width')}><${NumInput} size="sm" value=${b.w} onValue=${(v) => update(b.id, { w: v || 60 })} dec=${0} /></${Field}>
            ${!auto && html`<${Field} label=${t('settings.height')}><${NumInput} size="sm" value=${b.h} onValue=${(v) => update(b.id, { h: v || 14 })} dec=${0} /></${Field}>`}
          </div>
          ${b.type === 'text' && html`
            <${Field} label=${t('settings.content')}><${Textarea} value=${b.content} onValue=${(v) => update(b.id, { content: v })} rows=${3} dir="auto" /></${Field}>
            <${Select} size="sm" value="" onValue=${(v) => v && update(b.id, { content: `${b.content || ''}{{${v}}}` })} placeholder=${t('settings.insert_token')} options=${TOKEN_LIST.filter((k) => !['ITEMS_ROWS', 'ITEMS_HEADER', 'ITEMS_HEADER_SHERWAN', 'HEADER'].includes(k)).map((k) => ({ value: k, label: k }))} />
            <div class="form-2">
              <${Field} label=${t('settings.font_size')}><${NumInput} size="sm" value=${b.fontSize} onValue=${(v) => update(b.id, { fontSize: v || 12 })} dec=${0} /></${Field}>
              <${Field} label=${t('settings.color')}><input type="color" class="input sm" style="padding:2px" value=${b.color || '#152128'} onInput=${(e) => update(b.id, { color: e.target.value })} /></${Field}>
            </div>
            <${Segmented} value=${b.align || 'left'} onValue=${(v) => update(b.id, { align: v })} options=${['left', 'center', 'right'].map((a) => ({ value: a, label: t(`settings.align_${a}`) }))} />
            <${Check} checked=${!!b.bold} onValue=${(v) => update(b.id, { bold: v })} label=${t('settings.bold')} />`}
          ${b.type === 'totals' && html`
            <${Field} label=${t('doc.subtotal')}><${Input} size="sm" value=${b.subtotalLabel || ''} onValue=${(v) => update(b.id, { subtotalLabel: v })} placeholder=${t('doc.subtotal')} /></${Field}>
            <${Field} label=${t('doc.discount')}><${Input} size="sm" value=${b.discountLabel || ''} onValue=${(v) => update(b.id, { discountLabel: v })} placeholder=${t('doc.discount')} /></${Field}>
            <${Field} label=${t('doc.grand_total')}><${Input} size="sm" value=${b.grandTotalLabel || ''} onValue=${(v) => update(b.id, { grandTotalLabel: v })} placeholder=${t('doc.grand_total')} /></${Field}>`}
          ${['logo', 'table', 'notes'].includes(b.type) && html`<p class="small muted">${t(`settings.block_hint.${b.type}`)}</p>`}
          ${!['itemsTable', 'totals'].includes(b.id) && html`<${Btn} size="sm" kind="danger" icon="trash-2" onClick=${() => { setBlocks(blocks.filter((x) => x.id !== b.id)); setSel(null); }}>${t('common.delete')}</${Btn}>`}
        </div>`}
        <div class="form-section mt-16">
          <h3>${t('settings.table_columns')}</h3>
          ${cols.map((c, i) => html`<div class="row gap-8 mb-8">
            <input type="checkbox" checked=${c.key === 'desc' || c.visible} disabled=${c.key === 'desc'} onChange=${(e) => setCols(cols.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x)))} />
            <span class="small" style="width:70px">${colName(c.key)}</span>
            <input class="input sm grow" value=${c.label || ''} placeholder=${colName(c.key)} onInput=${(e) => setCols(cols.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <button type="button" class="icon-btn" disabled=${i === 0} onClick=${() => { const n = [...cols]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setCols(n); }}><${Icon} name="chevron-up" size="sm" /></button>
          </div>`)}
        </div>
      </aside>
    </div>
  </${Modal}>`;
}

function CustomTemplateDialog({ inv, doc, close }) {
  const [src, setSrc] = useState(inv.customTemplate || defaultTemplate());
  const ref = useRef(null);
  const company = boot().company || {};
  const body = useMemo(() => invoiceBody(doc, { company, inv: { ...inv, customTemplate: src }, template: 'custom' }), [src]);
  const insert = (k) => {
    const el = ref.current;
    const tok = `{{${k}}}`;
    if (!el) { setSrc(src + tok); return; }
    const s = el.selectionStart;
    setSrc(src.slice(0, s) + tok + src.slice(el.selectionEnd));
  };
  return html`<${Modal} title=${t('settings.edit_html')} icon="square-pen" close=${close} size="full"
    left=${html`<${Btn} size="sm" onClick=${() => setSrc(defaultTemplate())}>${t('settings.load_default')}</${Btn}><${Btn} size="sm" onClick=${() => setSrc(sherwanTemplate())}>${t('settings.load_sherwan')}</${Btn}>`}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} kind="primary" icon="check" onClick=${() => close(src)}>${t('settings.apply_design')}</${Btn}>`}>
    <div class="grid-2" style="height:100%">
      <div class="col gap-8" style="min-height:0">
        <textarea ref=${ref} class="textarea" style="flex:1;min-height:520px;font-family:ui-monospace,Consolas,monospace;font-size:12px" value=${src} onInput=${(e) => setSrc(e.target.value)} dir="ltr" spellcheck="false"></textarea>
        <div class="chip-list">${TOKEN_LIST.map((k) => html`<button type="button" class="chip" onClick=${() => insert(k)}>${k}</button>`)}</div>
      </div>
      <${PreviewFrame} body=${body} />
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ POS */
function PosSettings() {
  const g = useSettingsGroup('pos');
  const v = g.val;
  const [printers, setPrinters] = useState(null);
  const [walkin, setWalkin] = useState(null);
  useEffect(() => {
    if (window.desktop && window.desktop.printers) window.desktop.printers().then(setPrinters).catch(() => setPrinters([]));
    if (v.default_partner_id) api.get(`/api/partners/${v.default_partner_id}`).then(setWalkin).catch(() => {});
  }, []);
  return html`<${Panel} title=${t('settings.pos')} icon="shopping-cart">
    <div class="grid-form">
      <${Field} label=${t('settings.pos_customer')} cls="span-2"><${PartnerPicker} value=${walkin} onChange=${(p) => { setWalkin(p); g.set({ default_partner_id: p ? p.id : null }); }} kind="customer" showBalance=${false} allowCreate=${false} /></${Field}>
      <${Field} label=${t('doc.price_list')}><${PriceListSelect} value=${v.default_price_list_id} onValue=${(x) => g.set({ default_price_list_id: x })} /></${Field}>
      <${Field} label=${t('doc.warehouse')}><${WarehouseSelect} value=${v.default_warehouse_id} onValue=${(x) => g.set({ default_warehouse_id: x })} /></${Field}>
      <${Field} label=${t('settings.max_discount')} hint=${t('settings.max_discount_hint')}><${NumInput} value=${v.default_max_discount_pct} onValue=${(x) => g.set({ default_max_discount_pct: x || 0 })} dec=${2} /></${Field}>
      <${Field} label=${t('settings.iqd_rounding')} hint=${t('settings.iqd_rounding_hint')}><${Select} value=${String(v.iqd_cash_rounding || 0)} onValue=${(x) => g.set({ iqd_cash_rounding: Number(x) })} options=${[0, 250, 500, 1000].map((n) => ({ value: String(n), label: n ? num(n) : t('settings.no_rounding') }))} /></${Field}>
      <${Field} label=${t('settings.print_mode')}><${Select} value=${v.print_mode || 'receipt'} onValue=${(x) => g.set({ print_mode: x })} options=${[{ value: 'receipt', label: t('settings.print_receipt') }, { value: 'a4', label: t('settings.print_a4') }]} /></${Field}>
      <${Field} label=${t('settings.receipt_printer')} hint=${printers === null ? t('settings.printer_browser') : t('settings.printer_hint')}>
        ${printers && printers.length ? html`<${Select} value=${v.receipt_printer || ''} onValue=${(x) => g.set({ receipt_printer: x })} placeholder=${t('settings.ask_printer')} options=${printers.map((p) => ({ value: p.name, label: `${p.displayName || p.name}${p.isDefault ? ' ★' : ''}` }))} />`
          : html`<${Input} value=${v.receipt_printer || ''} onValue=${(x) => g.set({ receipt_printer: x })} placeholder=${t('settings.ask_printer')} />`}
      </${Field}>
      <div class="span-all col gap-8">
        <${Check} checked=${!!v.auto_print_receipt} onValue=${(x) => g.set({ auto_print_receipt: x })} label=${t('settings.auto_print')} />
        <${Check} checked=${v.allow_negative_stock !== false} onValue=${(x) => g.set({ allow_negative_stock: x })} label=${t('settings.allow_negative')} />
        <${Check} checked=${v.block_below_cost !== false} onValue=${(x) => g.set({ block_below_cost: x })} label=${t('settings.block_below_cost')} />
      </div>
    </div>
    <${SaveBar} g=${g} />
  </${Panel}>`;
}

/* ------------------------------------------------------------------ currencies */
function CurrencySettings() {
  const [list, setList] = useState(boot().currencies || []);
  const reload = async () => { await refreshBoot(); setList(boot().currencies || []); };
  const toggle = async (c) => {
    try { await api.post('/api/currencies', { code: c.code, active: !c.active }); await reload(); } catch (e) { errToast(e); }
  };
  const editRate = async (c) => {
    if (c.code === 'IQD') { const r = await openModal(RateDialog); if (r) reload(); return; }
    const v = await promptDialog({ title: `1 USD = ? ${c.code}`, inputLabel: t('rate.label'), inputValue: String(c.rate) });
    if (!v) return;
    try { await api.post(`/api/currencies/${c.code}/rate`, { rate: Number(String(v).replace(',', '.')) }); await reload(); toast(t('common.saved')); } catch (e) { errToast(e); }
  };
  return html`<${Panel} title=${t('settings.currencies')} icon="coins" body=${false}>
    <div class="panel-body"><p class="small muted" style="margin:0">${t('settings.currencies_text')}</p></div>
    <${Table} rows=${list} columns=${[
      { key: 'code', label: t('common.currency'), render: (c) => html`<b>${c.code}</b> <span class="muted small">${has(`cur.${c.code}`) ? t(`cur.${c.code}`) : c.name}</span>${c.code === 'USD' ? html` <${Pill} kind="brass">${t('settings.base_currency')}</${Pill}>` : null}` },
      { key: 'rate', label: t('settings.rate_vs_usd'), align: 'r', render: (c) => (c.code === 'USD' ? '1' : html`<span class="num strong">${num(c.rate, c.code === 'IQD' ? 2 : 4)}</span>`) },
      { key: 'dec', label: t('settings.decimals'), align: 'r', render: (c) => c.decimals },
      { key: 'upd', label: t('common.updated_at'), render: (c) => html`<span class="small muted">${c.updated_at ? dateTime(c.updated_at) : ''}</span>` },
      { key: 'act', label: '', cls: 'w-actions', render: (c) => c.code !== 'USD' && html`<div class="row gap-4">
        <${Btn} size="sm" onClick=${() => editRate(c)}>${t('rate.edit')}</${Btn}>
        ${c.code !== 'IQD' && html`<${Btn} size="sm" kind="ghost" onClick=${() => toggle(c)}>${c.active ? t('settings.deactivate') : t('settings.activate')}</${Btn}>`}</div>` },
    ]} />
  </${Panel}>`;
}

/* ------------------------------------------------------------------ stock & warehouses */
function StockSettings() {
  const g = useSettingsGroup('stock');
  const { data: whs, reload } = useAsync(() => api.get('/api/warehouses'), []);
  const edit = (w) => openModal(WarehouseDialog, { warehouse: w }).then((r) => { if (r) { reload(); refreshBoot(); } });
  const recalc = async () => {
    if (!(await confirmDialog({ title: t('settings.recalc_cost'), text: t('settings.recalc_text') }))) return;
    try { const r = await api.post('/api/products/recalc-cost'); toast(t('settings.recalc_done', { n: r.products })); } catch (e) { errToast(e); }
  };
  return html`<div class="stack">
    <${Panel} title=${t('settings.stock')} icon="boxes">
      <div class="grid-form">
        <${Field} label=${t('settings.low_default')} hint=${t('settings.low_default_hint')}><${NumInput} value=${g.val.low_stock_default} onValue=${(v) => g.set({ low_stock_default: v || 0 })} dec=${0} /></${Field}>
        <${Field} label=${t('settings.dead_days')}><${NumInput} value=${g.val.dead_stock_days} onValue=${(v) => g.set({ dead_stock_days: v || 90 })} dec=${0} /></${Field}>
      </div>
      <${SaveBar} g=${g} />
    </${Panel}>
    <${Panel} title=${t('settings.warehouses')} icon="warehouse" body=${false} tools=${html`<${Btn} size="sm" icon="plus" onClick=${() => edit(null)}>${t('common.add')}</${Btn}>`}>
      ${!whs ? html`<${Loading} />` : html`<${Table} rows=${whs} onRow=${edit} rowCls=${(w) => (w.active ? '' : 'cancelled')} columns=${[
        { key: 'name', label: t('common.name'), render: (w) => html`<span class="cell-name">${dn(w.name)}</span>${w.is_default ? html` <${Pill} kind="brass">${t('common.default')}</${Pill}>` : null}<div class="sub">${w.code || ''} ${w.address || ''}</div>` },
        { key: 'n', label: t('stock.products'), align: 'r', render: (w) => num(w.product_count) },
        { key: 'v', label: t('stock.value'), align: 'r', render: (w) => (w.value_usd != null ? money(w.value_usd, 'USD') : '') },
      ]} />`}
    </${Panel}>
    ${can('settings.manage') && html`<${Panel} title=${t('settings.costing')} icon="calculator"><p class="small muted">${t('settings.costing_text')}</p><${Btn} icon="refresh-cw" onClick=${recalc}>${t('settings.recalc_cost')}</${Btn}></${Panel}>`}
  </div>`;
}

function WarehouseDialog({ warehouse, close }) {
  const w = warehouse || { active: 1 };
  const [f, setF] = useState({ name: w.name || '', code: w.code || '', address: w.address || '', is_default: !!w.is_default, active: w.active !== 0 });
  const save = async () => { try { await api.post('/api/warehouses', { ...f, id: w.id }); toast(t('common.saved')); close(true); } catch (e) { errToast(e); } };
  return html`<${Modal} title=${w.id ? w.name : t('settings.new_warehouse')} close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!f.name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12">
      <div class="form-2"><${Field} label=${t('common.name')}><${Input} value=${f.name} onValue=${(v) => setF({ ...f, name: v })} autoFocus /></${Field}><${Field} label=${t('product.code')}><${Input} value=${f.code} onValue=${(v) => setF({ ...f, code: v })} /></${Field}></div>
      <${Field} label=${t('partner.address')}><${Input} value=${f.address} onValue=${(v) => setF({ ...f, address: v })} /></${Field}>
      <${Check} checked=${f.is_default} onValue=${(v) => setF({ ...f, is_default: v })} label=${t('settings.default_warehouse')} />
      ${w.id && html`<${Check} checked=${f.active} onValue=${(v) => setF({ ...f, active: v })} label=${t('common.active')} />`}
    </div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ price lists */
function PriceListSettings() {
  const [list, setList] = useState(boot().price_lists || []);
  const edit = async (pl) => {
    const r = await openModal(PriceListDialog, { pl });
    if (r) { await refreshBoot(); setList(boot().price_lists || []); }
  };
  return html`<${Panel} title=${t('settings.pricelists')} icon="tag" body=${false} tools=${html`<${Btn} size="sm" icon="plus" onClick=${() => edit(null)}>${t('common.add')}</${Btn}>`}>
    <div class="panel-body"><p class="small muted" style="margin:0">${t('settings.pricelists_text')}</p></div>
    <${Table} rows=${list} onRow=${edit} rowCls=${(p) => (p.active ? '' : 'cancelled')} columns=${[
      { key: 'name', label: t('common.name'), render: (p) => html`<span class="cell-name">${dn(p.name)}</span>${p.is_default ? html` <${Pill} kind="brass">${t('common.default')}</${Pill}>` : null}` },
      { key: 'active', label: t('common.active'), render: (p) => (p.active ? t('common.yes') : t('common.no')) },
    ]} />
  </${Panel}>`;
}
function PriceListDialog({ pl, close }) {
  const p = pl || { active: 1 };
  const [f, setF] = useState({ name: p.name || '', is_default: !!p.is_default, active: p.active !== 0 });
  const save = async () => { try { await api.post('/api/price-lists', { ...f, id: p.id }); toast(t('common.saved')); close(true); } catch (e) { errToast(e); } };
  return html`<${Modal} title=${p.id ? p.name : t('settings.new_pricelist')} close=${close} onSubmit=${save}
    foot=${html`<${Btn} onClick=${() => close()}>${t('common.cancel')}</${Btn}><${Btn} type="submit" kind="primary" disabled=${!f.name.trim()}>${t('common.save')}</${Btn}>`}>
    <div class="col gap-12"><${Field} label=${t('common.name')}><${Input} value=${f.name} onValue=${(v) => setF({ ...f, name: v })} autoFocus /></${Field}>
      <${Check} checked=${f.is_default} onValue=${(v) => setF({ ...f, is_default: v })} label=${t('settings.default_pricelist')} />
      ${p.id && html`<${Check} checked=${f.active} onValue=${(v) => setF({ ...f, active: v })} label=${t('common.active')} />`}</div>
  </${Modal}>`;
}

/* ------------------------------------------------------------------ catalogue */
function CatalogSettings() {
  const cats = useAsync(() => api.get('/api/categories'), []);
  const brands = useAsync(() => api.get('/api/brands'), []);
  const makes = useAsync(() => api.get('/api/vehicle-makes'), []);
  const [make, setMake] = useState(null);
  const models = useAsync(() => (make ? api.get('/api/vehicle-models', { make_id: make.id }) : Promise.resolve([])), [make && make.id]);
  const after = async (fn) => { try { await fn(); await refreshBoot(); clearModelCache(); } catch (e) { errToast(e); } };
  const nameDialog = (title, value) => promptDialog({ title, inputLabel: t('common.name'), inputValue: value || '', requireText: true });
  const editCat = async (c) => { const n = await nameDialog(c ? c.name : t('product.new_category'), c && c.name); if (n) after(async () => { await api.post('/api/categories', { id: c && c.id, name: n }); cats.reload(); }); };
  const delCat = async (c) => { if (await confirmDialog({ title: t('common.delete'), text: t('settings.delete_category', { name: c.name, n: c.product_count }), danger: true, okText: t('common.delete') })) after(async () => { await api.del(`/api/categories/${c.id}`); cats.reload(); }); };
  const editBrand = async (b) => { const n = await nameDialog(b ? b.name : t('product.new_brand'), b && b.name); if (n) after(async () => { await api.post('/api/brands', { id: b && b.id, name: n }); brands.reload(); }); };
  const delBrand = async (b) => { if (await confirmDialog({ title: t('common.delete'), text: t('settings.delete_brand', { name: b.name, n: b.product_count }), danger: true, okText: t('common.delete') })) after(async () => { await api.del(`/api/brands/${b.id}`); brands.reload(); }); };
  const editMake = async (m) => { const n = await nameDialog(m ? m.name : t('settings.new_make'), m && m.name); if (n) after(async () => { await api.post('/api/vehicle-makes', { id: m && m.id, name: n }); makes.reload(); }); };
  const delMake = async (m) => { if (await confirmDialog({ title: t('common.delete'), text: m.name, danger: true, okText: t('common.delete') })) after(async () => { await api.del(`/api/vehicle-makes/${m.id}`); if (make && make.id === m.id) setMake(null); makes.reload(); }); };
  const editModel = async (m) => { const n = await nameDialog(m ? m.name : t('settings.new_model'), m && m.name); if (n) after(async () => { await api.post('/api/vehicle-models', { id: m && m.id, make_id: make.id, name: n }); models.reload(); makes.reload(); }); };
  const delModel = async (m) => { if (await confirmDialog({ title: t('common.delete'), text: m.name, danger: true, okText: t('common.delete') })) after(async () => { await api.del(`/api/vehicle-models/${m.id}`); models.reload(); makes.reload(); }); };
  const list = (rows, onEdit, onDel, sub) => (!(rows || []).length ? html`<${Empty} icon="tag" title=${t('common.empty')} />` : html`<div class="mini-list" style="max-height:480px;overflow:auto">${(rows || []).map((r) => html`<div class="mini-row">
    <div class="grow" dir="auto">${dn(r.name)}${sub ? html` <span class="tiny muted">${sub(r)}</span>` : null}</div>
    <${IconBtn} icon="pencil" title=${t('common.edit')} onClick=${() => onEdit(r)} /><${IconBtn} icon="trash-2" danger title=${t('common.delete')} onClick=${() => onDel(r)} /></div>`)}</div>`);
  return html`<div class="stack">
    <div class="grid-2">
      <${Panel} title=${t('settings.categories')} icon="layout-grid" body=${false} tools=${html`<${Btn} size="sm" icon="plus" onClick=${() => editCat(null)}>${t('common.add')}</${Btn}>`}>
        ${cats.data ? list(cats.data, editCat, delCat, (r) => `(${r.product_count})`) : html`<${Loading} />`}</${Panel}>
      <${Panel} title=${t('settings.brands')} icon="tag" body=${false} tools=${html`<${Btn} size="sm" icon="plus" onClick=${() => editBrand(null)}>${t('common.add')}</${Btn}>`}>
        ${brands.data ? list(brands.data, editBrand, delBrand, (r) => `(${r.product_count})`) : html`<${Loading} />`}</${Panel}>
    </div>
    <div class="grid-2">
      <${Panel} title=${t('settings.makes')} icon="car" body=${false} tools=${html`<${Btn} size="sm" icon="plus" onClick=${() => editMake(null)}>${t('common.add')}</${Btn}>`}>
        ${makes.data ? html`<div class="mini-list" style="max-height:420px;overflow:auto">${makes.data.map((m) => html`<div class=${`mini-row link ${make && make.id === m.id ? 'selected' : ''}`} style=${make && make.id === m.id ? 'background:var(--info-soft)' : ''} onClick=${(e) => { if (!e.target.closest('button')) setMake(m); }}>
          <div class="grow">${m.name} <span class="tiny muted">(${m.model_count})</span></div><${IconBtn} icon="pencil" onClick=${() => editMake(m)} /><${IconBtn} icon="trash-2" danger onClick=${() => delMake(m)} /></div>`)}</div>` : html`<${Loading} />`}
      </${Panel}>
      <${Panel} title=${make ? `${t('settings.models')}: ${make.name}` : t('settings.models')} icon="car" body=${false} tools=${make && html`<${Btn} size="sm" icon="plus" onClick=${() => editModel(null)}>${t('common.add')}</${Btn}>`}>
        ${!make ? html`<div class="panel-body small muted">${t('settings.pick_make')}</div>` : models.data ? list(models.data, editModel, delModel) : html`<${Loading} />`}
      </${Panel}>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ numbering */
const NUM_TYPES = ['sale', 'purchase', 'sale_return', 'purchase_return', 'quote', 'service', 'purchase_order', 'transfer', 'adjust', 'payment_in', 'payment_out', 'expense', 'income', 'money_transfer', 'stock_count'];
function NumberingSettings() {
  const g = useSettingsGroup('numbering');
  const pfx = g.val.prefixes || {};
  const [next, setNext] = useState({});
  useEffect(() => {
    Promise.all(NUM_TYPES.map((tp) => api.get('/api/docs/next-no', { type: tp }).then((r) => [tp, r.no]).catch(() => [tp, '']))).then((list) => setNext(Object.fromEntries(list)));
  }, [g.saving]);
  return html`<${Panel} title=${t('settings.numbering')} icon="hash">
    <p class="small muted">${t('settings.numbering_text')}</p>
    <table class="tbl compact"><thead><tr><th>${t('common.type')}</th><th style="width:140px">${t('settings.prefix')}</th><th>${t('settings.next_no')}</th></tr></thead>
      <tbody>${NUM_TYPES.map((tp) => html`<tr><td>${t(`numbering.${tp}`)}</td><td><${Input} size="sm" value=${pfx[tp] || ''} onValue=${(v) => g.set({ prefixes: { ...pfx, [tp]: v.toUpperCase().replace(/[^A-Z0-9-]/g, '') } })} /></td><td class="small muted num">${next[tp] || ''}</td></tr>`)}</tbody></table>
    <div class="row gap-12 mt-12"><${Field} label=${t('settings.pad')}><div style="width:100px"><${NumInput} value=${g.val.pad || 4} onValue=${(v) => g.set({ pad: Math.min(8, Math.max(3, v || 4)) })} dec=${0} /></div></${Field}></div>
    <${SaveBar} g=${g} />
  </${Panel}>`;
}

/** "Recep Muhasebe · Windows", "Chrome · Android" from a browser's user-agent text */
function deviceName(ua) {
  const u = String(ua || '');
  if (!u) return '—';
  const app = /Electron|recep-muhasebe/i.test(u) ? 'Recep Muhasebe' : /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Mac OS X/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  return [app, os].filter(Boolean).join(' · ') || u.slice(0, 40);
}

/* ------------------------------------------------------------------ labels */
function LabelSettings() {
  const g = useSettingsGroup('labels');
  const v = g.val;
  const w = v.width_mm || 50;
  const h = v.height_mm || 30;
  const sample = labelHtml({ name: t('settings.sample_label_name'), code: 'FR-001', barcode: '2001234567893', price: 45000, currency: 'IQD' },
    { showName: v.show_name !== false, showCode: !!v.show_code, showPrice: v.show_price !== false });
  const preview = `<style>${labelCss(w, h)} .lb { outline: 1px dashed #bbb; }</style>${sample}`;
  return html`<${Panel} title=${t('settings.labels')} icon="scan-barcode">
    <div class="row top gap-24 wrap">
      <div class="grid-form grow">
        <${Field} label=${t('settings.label_width')}><${NumInput} value=${v.width_mm} onValue=${(x) => g.set({ width_mm: x || 50 })} dec=${0} /></${Field}>
        <${Field} label=${t('settings.label_height')}><${NumInput} value=${v.height_mm} onValue=${(x) => g.set({ height_mm: x || 30 })} dec=${0} /></${Field}>
        <${Field} label=${t('doc.price_list')}><${PriceListSelect} value=${v.price_list_id} onValue=${(x) => g.set({ price_list_id: x })} placeholder=${t('common.default')} /></${Field}>
        <div class="span-all col gap-8">
          <${Check} checked=${v.show_name !== false} onValue=${(x) => g.set({ show_name: x })} label=${t('product.label_name')} />
          <${Check} checked=${v.show_price !== false} onValue=${(x) => g.set({ show_price: x })} label=${t('product.label_price')} />
          <${Check} checked=${!!v.show_code} onValue=${(x) => g.set({ show_code: x })} label=${t('product.label_code')} />
        </div>
      </div>
      <div><div class="label mb-8">${t('settings.preview')}</div><div style="background:#E6E9E7;padding:16px;border-radius:10px;display:flex;justify-content:center" dangerouslySetInnerHTML=${{ __html: preview }}></div>
        <${Btn} size="sm" icon="printer" cls="mt-8" onClick=${() => printHtml(sample, { page: 'label', w, h, title: 'label test', css: labelCss(w, h) })}>${t('settings.test_print')}</${Btn}></div>
    </div>
    <${SaveBar} g=${g} />
  </${Panel}>`;
}

/* ------------------------------------------------------------------ backup */
function BackupSettings() {
  const g = useSettingsGroup('backup');
  const { data, loading, reload } = useAsync(() => api.get('/api/backup'), []);
  const [busy, setBusy] = useState(false);
  const now = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/backup/now', {});
      toast(r.copy_error ? `${t('settings.backup_done', { name: r.name })}\n${t('settings.backup_copy_error')}: ${r.copy_error}` : t('settings.backup_done', { name: r.name }), r.copy_error ? 'warn' : 'ok');
      reload();
    } catch (e) { errToast(e); } finally { setBusy(false); }
  };
  const restore = async (name) => {
    if (!(await confirmDialog({ title: t('settings.restore'), text: t('settings.restore_text', { name }), danger: true, okText: t('settings.restore') }))) return;
    try { await api.post('/api/backup/restore', { name }); restarting(); } catch (e) { errToast(e); }
  };
  const restoreFile = async () => {
    const f = await pickFile('.db');
    if (!f) return;
    if (!(await confirmDialog({ title: t('settings.restore'), text: t('settings.restore_text', { name: f.name }), danger: true, okText: t('settings.restore') }))) return;
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
    try { await api.post('/api/backup/restore', { file_base64: b64 }); restarting(); } catch (e) { errToast(e); }
  };
  const chooseFolder = async () => {
    if (window.desktop && window.desktop.chooseFolder) { const p = await window.desktop.chooseFolder(); if (p) g.set({ folder: p }); }
  };
  return html`<div class="stack">
    <${Panel} title=${t('settings.backup')} icon="database">
      <div class="col gap-12">
        <${Notice}>${t('settings.backup_text')}</${Notice}>
        <${Check} checked=${g.val.auto !== false} onValue=${(v) => g.set({ auto: v })} label=${t('settings.backup_auto')} />
        <div class="form-2">
          <${Field} label=${t('settings.backup_keep')}><${NumInput} value=${g.val.keep} onValue=${(v) => g.set({ keep: v || 30 })} dec=${0} /></${Field}>
          <${Field} label=${t('settings.backup_folder')} hint=${t('settings.backup_folder_hint')}><div class="row gap-4"><${Input} value=${g.val.folder || ''} onValue=${(v) => g.set({ folder: v })} placeholder=${t('settings.backup_folder_ph')} />${window.desktop && window.desktop.chooseFolder && html`<${IconBtn} icon="archive" title=${t('settings.choose_folder')} onClick=${chooseFolder} />`}</div></${Field}>
        </div>
        <${SaveBar} g=${g} />
      </div>
    </${Panel}>
    <${Panel} title=${t('settings.backups')} icon="archive" body=${false} tools=${html`<${Btn} size="sm" icon="upload" onClick=${restoreFile}>${t('settings.restore_from_file')}</${Btn}><${Btn} size="sm" kind="primary" icon="save" disabled=${busy} onClick=${now}>${t('settings.backup_now')}</${Btn}>`}>
      ${data && html`<div class="panel-body small muted">${t('settings.backup_dir')}: <span class="ltr">${data.dir}</span>${data.settings.last_at ? html` · ${t('settings.last_backup')}: ${dateTime(data.settings.last_at)}` : null}</div>`}
      ${loading && !data ? html`<${Loading} />` : html`<${Table} rows=${(data && data.list) || []} empty=${html`<${Empty} icon="database" title=${t('settings.no_backups')} />`} columns=${[
        { key: 'name', label: t('common.name'), render: (b) => html`<span class="small ltr">${b.name}</span>` },
        { key: 'date', label: t('common.date'), render: (b) => dateTime(b.mtime) },
        { key: 'size', label: t('settings.size'), align: 'r', render: (b) => fileSize(b.size) },
        { key: 'act', label: '', cls: 'w-actions', render: (b) => html`<div class="row gap-4"><${IconBtn} icon="download" title=${t('common.download')} onClick=${() => api.download(`/api/backup/download/${encodeURIComponent(b.name)}`, b.name)} />
          <${Btn} size="sm" onClick=${() => restore(b.name)}>${t('settings.restore')}</${Btn}></div>` },
      ]} />`}
    </${Panel}>
    <${Panel} title=${t('settings.export')} icon="file-down"><p class="small muted">${t('settings.export_text')}</p>
      <${Btn} icon="download" onClick=${() => api.download('/api/export/json', `recep-muhasebe-${today()}.json`)}>${t('settings.export_json')}</${Btn}></${Panel}>
  </div>`;
}

function restarting() {
  toast(t('settings.restarting'), 'warn', 8000);
  if (window.desktop && window.desktop.relaunch) setTimeout(() => window.desktop.relaunch(), 600);
  else setTimeout(() => location.reload(), 6000);
}

/* ------------------------------------------------------------------ network */
let qrLoader = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLoader) {
    qrLoader = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/qrcode.js';
      s.onload = () => res(window.qrcode);
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return qrLoader;
}
function QrCode({ text, size = 5 }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    loadQr().then((qrcode) => { const qr = qrcode(0, 'M'); qr.addData(text); qr.make(); setSvg(qr.createSvgTag(size, 2)); }).catch(() => setSvg(''));
  }, [text]);
  return html`<div class="qr-box" dangerouslySetInnerHTML=${{ __html: svg }}></div>`;
}

function NetworkSettings() {
  const g = useSettingsGroup('network');
  const { data: info } = useAsync(() => api.get('/api/system/info'), []);
  const lan = (info && info.lan) || [];
  const port = (info && info.port) || g.val.port || 8642;
  const save = async () => {
    const r = await g.save();
    if (r) {
      if (window.desktop && window.desktop.relaunch && (await confirmDialog({ title: t('settings.network'), text: t('settings.network_restart'), okText: t('settings.restart_now') }))) window.desktop.relaunch();
    }
  };
  return html`<div class="stack">
    <${Panel} title=${t('settings.network')} icon="wifi">
      <div class="col gap-12">
        <p class="small dim">${t('settings.network_text')}</p>
        <${Check} checked=${!!g.val.lan_enabled} onValue=${(v) => g.set({ lan_enabled: v })} label=${t('settings.lan_enable')} />
        <div style="width:180px"><${Field} label=${t('settings.port')}><${Input} inputmode="numeric" value=${g.val.port || ''} onValue=${(v) => g.set({ port: Number(String(v).replace(/\D/g, '')) || 8642 })} /></${Field}></div>
        <${Notice} kind="warn">${t('settings.network_security')}</${Notice}>
        <div class="row end"><${Btn} kind="primary" icon="check" disabled=${g.saving || !g.dirty} onClick=${save}>${t('common.save')}</${Btn}></div>
      </div>
    </${Panel}>
    ${g.val.lan_enabled && (info && (boot().server || {}).lan_enabled) && html`<${Panel} title=${t('settings.connect_devices')} icon="smartphone">
      ${!lan.length ? html`<p class="small muted">${t('settings.no_lan')}</p>` : html`<div class="row wrap gap-24">${lan.map((a) => html`<div class="col gap-8" style="align-items:center">
        <${QrCode} text=${`http://${a.address}:${port}/`} />
        <b class="ltr">http://${a.address}:${port}</b><span class="tiny muted">${a.name}</span></div>`)}</div>
        <p class="small muted mt-12">${t('settings.connect_hint')}</p>`}
    </${Panel}>`}
    ${info && html`<${Panel} title=${t('settings.sessions')} icon="monitor" body=${false}><${Table} compact rows=${info.sessions} columns=${[
      { key: 'u', label: t('common.user'), render: (s) => s.full_name },
      { key: 'ip', label: 'IP', render: (s) => html`<span class="ltr small">${s.ip || ''}</span>` },
      { key: 'agent', label: t('settings.device'), render: (s) => html`<span class="small muted" title=${s.agent || ''}>${deviceName(s.agent)}</span>` },
      { key: 'seen', label: t('settings.last_seen'), render: (s) => html`<span class="small">${dateTime(s.last_seen)}</span>` },
    ]} /></${Panel}>`}
  </div>`;
}

/* ------------------------------------------------------------------ security */
function SecuritySettings() {
  const g = useSettingsGroup('security');
  return html`<${Panel} title=${t('settings.security')} icon="shield">
    <div class="col gap-12">
      <${Check} checked=${!!g.val.lock_on_start} onValue=${(v) => g.set({ lock_on_start: v })} label=${t('settings.lock_on_start')} />
      <div class="form-2">
        <${Field} label=${t('settings.idle_lock')} hint=${t('settings.idle_lock_hint')}><${NumInput} value=${g.val.idle_lock_minutes} onValue=${(v) => g.set({ idle_lock_minutes: v || 0 })} dec=${0} /></${Field}>
        <${Field} label=${t('settings.session_days')} hint=${t('settings.session_days_hint')}><${NumInput} value=${g.val.session_days} onValue=${(v) => g.set({ session_days: v || 90 })} dec=${0} /></${Field}>
      </div>
      <${Notice}>${t('settings.security_text')}</${Notice}>
    </div>
    <${SaveBar} g=${g} />
  </${Panel}>`;
}

/* ------------------------------------------------------------------ general */
function GeneralSettings() {
  const g = useSettingsGroup('general');
  const s = useSettingsGroup('service');
  return html`<div class="stack">
    <${Panel} title=${t('settings.general')} icon="sliders-horizontal">
      <div class="grid-form">
        <${Field} label=${t('setup.default_currency')} hint=${t('settings.default_currency_hint')}><${CurrencySelect} value=${g.val.default_currency} onValue=${(v) => g.set({ default_currency: v })} /></${Field}>
        <${Field} label=${t('common.display_currency')}><${CurrencySelect} value=${g.val.display_currency} onValue=${(v) => g.set({ display_currency: v })} /></${Field}>
        <${Field} label=${t('settings.default_lang')}><${Select} value=${g.val.lang} onValue=${(v) => g.set({ lang: v })} options=${LANGS.map((l) => ({ value: l.code, label: l.name }))} /></${Field}>
        <${Field} label=${t('settings.commission_basis')}><${Select} value=${g.val.commission_basis || 'profit'} onValue=${(v) => g.set({ commission_basis: v })} options=${[{ value: 'profit', label: t('report.basis_opt.profit') }, { value: 'revenue', label: t('report.basis_opt.revenue') }]} /></${Field}>
      </div>
      <${SaveBar} g=${g} />
    </${Panel}>
    <${Panel} title=${t('settings.service')} icon="wrench">
      <div class="grid-form">
        <${Field} label=${t('settings.labor_warranty_days')}><${NumInput} value=${s.val.warranty_days_labor} onValue=${(v) => s.set({ warranty_days_labor: v || 0 })} dec=${0} /></${Field}>
        <${Field} label=${t('settings.service_terms')} cls="span-all"><${Textarea} value=${s.val.default_terms || ''} onValue=${(v) => s.set({ default_terms: v })} rows=${3} dir="auto" /></${Field}>
      </div>
      <${SaveBar} g=${s} />
    </${Panel}>
  </div>`;
}

/* ------------------------------------------------------------------ about */
function AboutSettings() {
  const { data: info } = useAsync(() => api.get('/api/system/info'), []);
  const [upd, setUpd] = useState(null);
  const check = async () => {
    if (!(window.desktop && window.desktop.checkUpdates)) return;
    setUpd({ state: 'checking' });
    try { setUpd(await window.desktop.checkUpdates()); } catch (e) { setUpd({ state: 'error', error: e.message }); }
  };
  return html`<div class="stack">
    <${Panel} title=${t('settings.about')} icon="info">
      <div class="row gap-16 wrap">
        <div class="brand-mark" style="width:56px;height:56px;font-size:28px">R</div>
        <div><div style="font-family:var(--font-cond);font-size:22px;font-weight:600">Recep Muhasebe</div><div class="muted">${t('settings.version')} ${(info && info.version) || (boot().version || '')}</div></div>
        <div class="grow"></div>
        ${window.desktop && window.desktop.checkUpdates && html`<${Btn} icon="refresh-cw" onClick=${check}>${t('settings.check_updates')}</${Btn}>`}
      </div>
      ${upd && html`<${Notice} cls="mt-12" kind=${upd.state === 'error' ? 'err' : upd.state === 'available' ? 'warn' : ''}>${t(`settings.update.${upd.state}`, { version: upd.version || '', error: upd.error || '' })}</${Notice}>`}
      ${info && html`<div class="mt-16"><${KV} items=${[
        [t('settings.data_dir'), html`<span class="ltr small">${info.data_dir}</span>`],
        [t('settings.db_size'), fileSize(info.db_size)],
        [t('nav.products'), num(info.counts.products)], [t('settings.partners_count'), num(info.counts.partners)], [t('settings.docs_count'), num(info.counts.docs)], [t('nav.payments'), num(info.counts.payments)],
        ['Node', info.node], [t('settings.platform'), info.platform],
      ]} /></div>
      ${window.desktop && window.desktop.openPath && html`<${Btn} size="sm" icon="archive" cls="mt-12" onClick=${() => window.desktop.openPath(info.data_dir)}>${t('settings.open_data_dir')}</${Btn}>`}`}
    </${Panel}>
  </div>`;
}
