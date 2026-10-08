// First-run wizard: language, move old data (Recep Muhasebe 1.x/2.x), company, owner account, exchange rate.
import { html, useState, useEffect } from '../core/h.js';
import { t, LANGS, getLang, setLang } from '../core/i18n.js';
import { api } from '../core/api.js';
import { num, dateTime } from '../core/format.js';
import { Btn, Icon, Input, NumInput, Field, Select, Notice, Spinner, pickFile, readImage, Textarea, toast } from '../core/ui.js';
import { store } from '../core/store.js';
import { loadBoot } from '../core/session.js';

export function Setup() {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState(null);     // { kind: 'desktop'|'file', id?, name, json }
  const [preview, setPreview] = useState(null);
  const [report, setReport] = useState(null);
  const [rate, setRate] = useState(1310);
  const [currency, setCurrency] = useState('IQD');
  const [company, setCompany] = useState({ name: '', phone: '', address: '' });
  const [logo, setLogo] = useState(null);
  const [admin, setAdmin] = useState({ full_name: '', username: 'admin', pin: '', pin2: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const imported = !!report;

  const steps = imported ? ['lang', 'data', 'report', 'company', 'admin'] : ['lang', 'data', 'company', 'admin', 'currency'];
  const cur = steps[step];
  const next = () => { setErr(''); setStep((s) => Math.min(s + 1, steps.length - 1)); };
  const prev = () => { setErr(''); setStep((s) => Math.max(s - 1, 0)); };

  const doPreview = async (src) => {
    setBusy(true); setErr('');
    try {
      const pv = await api.post('/api/setup/import-preview', { data: src.json });
      setSource(src); setPreview(pv); setRate(pv.suggested_rate || 1310);
      setCompany((c) => ({ ...c, name: pv.company || c.name }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true); setErr('');
    try {
      const rep = await api.post('/api/setup/import', { data: source.json, usd_iqd: rate, lang: getLang() });
      setReport(rep);
      setStep(2);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const finish = async () => {
    if (admin.pin && admin.pin !== admin.pin2) { setErr(t('setup.pin_mismatch')); return; }
    if (admin.pin && !/^\d{4,8}$/.test(admin.pin)) { setErr(t('err.bad_pin')); return; }
    setBusy(true); setErr('');
    try {
      const body = {
        lang: getLang(), usd_iqd: imported ? undefined : rate, default_currency: currency,
        company: { ...company, logo: logo || undefined },
        admin: { full_name: admin.full_name || 'Admin', username: admin.username || 'admin', pin: admin.pin || undefined, password: admin.password || undefined },
      };
      const r = await api.post('/api/setup/complete', body);
      store.set({ setup: { ...store.state.setup, done: true } });
      await loadBoot(r.user);
      location.hash = '#/';
      toast(t('setup.done'));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return html`<div class="auth-screen">
    <aside class="auth-side">
      <div class="row"><img src="img/icon.svg" width="44" height="44" alt="" /><div class="brand-name" style="font-size:20px">Recep Muhasebe</div></div>
      <div><div class="big">${t('setup.headline')}</div><p class="tag">${t('setup.tagline')}</p></div>
      <div class="small" style="color:var(--chrome-dim)">${t('setup.step', { n: step + 1, total: steps.length })}</div>
    </aside>
    <main class="auth-main"><div class="auth-card" style="max-width:620px">
      <div class="steps">${steps.map((s, i) => html`<i class=${i <= step ? 'on' : ''}></i>`)}</div>

      ${cur === 'lang' && html`<div>
        <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.lang_title')}</h2>
        <p class="muted mb-16">${t('setup.lang_text')}</p>
        <div class="col gap-8">${LANGS.map((l) => html`<button type="button" class=${`user-tile ${getLang() === l.code ? 'on' : ''}`} style="flex-direction:row;justify-content:flex-start;padding:12px 16px" onClick=${() => setLang(l.code)}>
          <${Icon} name=${getLang() === l.code ? 'circle-check' : 'globe'} /><span class="strong">${l.name}</span></button>`)}</div>
        <div class="row end mt-24"><${Btn} kind="primary" size="lg" onClick=${next}>${t('common.continue')}</${Btn}></div>
      </div>`}

      ${cur === 'data' && html`<${DataStep} busy=${busy} preview=${preview} source=${source} rate=${rate} setRate=${setRate}
        onPreview=${doPreview} onImport=${doImport} onFresh=${() => { setSource(null); setPreview(null); next(); }} onBack=${prev}
        onClear=${() => { setSource(null); setPreview(null); }} />`}

      ${cur === 'report' && html`<${ImportReport} report=${report} onNext=${next} />`}

      ${cur === 'company' && html`<div>
        <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-16">${t('setup.company_title')}</h2>
        <div class="col gap-12">
          <${Field} label=${t('company.name')} required><${Input} value=${company.name} onValue=${(v) => setCompany({ ...company, name: v })} dir="auto" autoFocus /></${Field}>
          <${Field} label=${t('company.phone')}><${Input} value=${company.phone} onValue=${(v) => setCompany({ ...company, phone: v })} /></${Field}>
          <${Field} label=${t('company.address')}><${Textarea} value=${company.address} onValue=${(v) => setCompany({ ...company, address: v })} dir="auto" rows="2" /></${Field}>
          ${!(preview && preview.has_logo && imported) && html`<${Field} label=${t('company.logo')}>
            <div class="row"><div class="photo-box" style="width:72px;height:72px" onClick=${async () => { const f = await pickFile('image/*'); if (f) setLogo(await readImage(f, 800)); }}>
              ${logo ? html`<img src=${logo} alt="" />` : html`<${Icon} name="image" />`}</div><span class="small muted">${t('company.logo_hint')}</span></div>
          </${Field}>`}
        </div>
        <div class="row between mt-24"><${Btn} onClick=${prev}>${t('common.back')}</${Btn}><${Btn} kind="primary" size="lg" disabled=${!company.name.trim()} onClick=${next}>${t('common.continue')}</${Btn}></div>
      </div>`}

      ${cur === 'admin' && html`<div>
        <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.admin_title')}</h2>
        <p class="muted mb-16">${t('setup.admin_text')}</p>
        <div class="form-2">
          <${Field} label=${t('user.full_name')} required cls="span-all"><${Input} value=${admin.full_name} onValue=${(v) => setAdmin({ ...admin, full_name: v })} autoFocus /></${Field}>
          <${Field} label=${t('login.username')}><${Input} value=${admin.username} onValue=${(v) => setAdmin({ ...admin, username: v })} /></${Field}>
          <${Field} label=${t('login.password')} hint=${t('setup.password_hint')}><${Input} type="password" value=${admin.password} onValue=${(v) => setAdmin({ ...admin, password: v })} /></${Field}>
          <${Field} label=${t('user.pin')} hint=${t('user.pin_hint')}><${Input} type="password" inputmode="numeric" maxlength="8" value=${admin.pin} onValue=${(v) => setAdmin({ ...admin, pin: v.replace(/\D/g, '') })} /></${Field}>
          <${Field} label=${t('setup.pin_again')}><${Input} type="password" inputmode="numeric" maxlength="8" value=${admin.pin2} onValue=${(v) => setAdmin({ ...admin, pin2: v.replace(/\D/g, '') })} /></${Field}>
        </div>
        ${!admin.pin && !admin.password && html`<${Notice} kind="warn">${t('setup.no_secret_warning')}</${Notice}>`}
        <div class="row between mt-24"><${Btn} onClick=${prev}>${t('common.back')}</${Btn}>
          ${steps[step + 1] ? html`<${Btn} kind="primary" size="lg" disabled=${!admin.full_name.trim()} onClick=${next}>${t('common.continue')}</${Btn}>`
            : html`<${Btn} kind="primary" size="lg" disabled=${busy || !admin.full_name.trim()} onClick=${finish}>${t('setup.finish')}</${Btn}>`}</div>
      </div>`}

      ${cur === 'currency' && html`<div>
        <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.currency_title')}</h2>
        <p class="muted mb-16">${t('setup.currency_text')}</p>
        <div class="form-2">
          <${Field} label=${t('rate.label')}><div class="input-wrap"><${NumInput} value=${rate} onValue=${setRate} dec=${2} cls="has-suffix" /><span class="suffix">IQD</span></div></${Field}>
          <${Field} label=${t('setup.default_currency')}><${Select} value=${currency} onValue=${setCurrency} options=${[{ value: 'IQD', label: 'IQD' }, { value: 'USD', label: 'USD' }]} /></${Field}>
        </div>
        <div class="row between mt-24"><${Btn} onClick=${prev}>${t('common.back')}</${Btn}><${Btn} kind="primary" size="lg" disabled=${busy || !(rate > 0)} onClick=${finish}>${t('setup.finish')}</${Btn}></div>
      </div>`}

      ${err && html`<div class="notice err mt-16">${err}</div>`}
      ${busy && html`<div class="row mt-16"><${Spinner} /><span class="muted">${t('common.working')}</span></div>`}
    </div></main>
  </div>`;
}

function DataStep({ busy, preview, source, rate, setRate, onPreview, onImport, onFresh, onBack, onClear }) {
  const [found, setFound] = useState(null);
  const desktop = window.desktop;
  useEffect(() => {
    if (desktop && desktop.findOldData) desktop.findOldData().then(setFound).catch(() => setFound([]));
    else setFound([]);
  }, []);
  const fromDesktop = async (f) => {
    try {
      const json = await desktop.readOldData(f.id);
      onPreview({ kind: 'desktop', id: f.id, name: f.name, json });
    } catch (e) { toast(e.message || String(e), 'err'); }
  };
  const fromFile = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    const text = await file.text();
    onPreview({ kind: 'file', name: file.name, json: text });
  };

  if (preview) {
    const c = preview.counts;
    return html`<div>
      <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.preview_title')}</h2>
      <p class="muted mb-16">${t('setup.preview_text', { name: source.name, date: dateTime(preview.saved_at) })}</p>
      <div class="panel"><div class="panel-body"><div class="grid-3">
        ${[['setup.c.products', c.products], ['setup.c.accounts', c.accounts], ['setup.c.sales', c.sales], ['setup.c.purchases', c.purchases], ['setup.c.cash', c.cash], ['setup.c.expenses', c.expenses]]
          .map(([k, v]) => html`<div class="stat" style="padding:4px 0"><div class="k">${t(k)}</div><div class="v">${num(v)}</div></div>`)}
      </div></div></div>
      <div class="mt-16"><${Field} label=${t('setup.rate_for_import')} hint=${t('setup.rate_for_import_hint', { rate: num(preview.suggested_rate) })}>
        <div class="input-wrap" style="max-width:240px"><${NumInput} value=${rate} onValue=${setRate} dec=${2} cls="has-suffix" /><span class="suffix">IQD</span></div>
      </${Field}></div>
      <${Notice} kind="ok" cls="mt-16">${t('setup.import_safe')}</${Notice}>
      <div class="row between mt-24"><${Btn} onClick=${onClear}>${t('common.back')}</${Btn}><${Btn} kind="primary" size="lg" icon="download" disabled=${busy || !(rate > 0)} onClick=${onImport}>${t('setup.import_now')}</${Btn}></div>
    </div>`;
  }
  return html`<div>
    <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.data_title')}</h2>
    <p class="muted mb-16">${t('setup.data_text')}</p>
    ${found === null ? html`<${Spinner} />` : html`<div class="col gap-8">
      ${found.map((f) => html`<button type="button" class="user-tile" style="flex-direction:row;justify-content:flex-start;text-align:start;padding:14px 16px" disabled=${busy} onClick=${() => fromDesktop(f)}>
        <${Icon} name="database" size="lg" /><div class="grow"><div class="strong">${t('setup.found_data', { name: f.name })}</div>
        <div class="small muted">${t('setup.last_saved', { date: dateTime(f.saved_at) })}${f.counts ? ` · ${t('setup.found_counts', { products: f.counts.products, invoices: f.counts.invoices })}` : ''}</div></div>
        <${Icon} name="chevron-right" /></button>`)}
      ${desktop && found.length === 0 && html`<${Notice}>${t('setup.nothing_found')}</${Notice}>`}
      <button type="button" class="user-tile" style="flex-direction:row;justify-content:flex-start;text-align:start;padding:14px 16px" disabled=${busy} onClick=${fromFile}>
        <${Icon} name="upload" size="lg" /><div class="grow"><div class="strong">${t('setup.from_file')}</div><div class="small muted">${t('setup.from_file_hint')}</div></div><${Icon} name="chevron-right" /></button>
      <button type="button" class="user-tile" style="flex-direction:row;justify-content:flex-start;text-align:start;padding:14px 16px" disabled=${busy} onClick=${onFresh}>
        <${Icon} name="plus" size="lg" /><div class="grow"><div class="strong">${t('setup.fresh')}</div><div class="small muted">${t('setup.fresh_hint')}</div></div><${Icon} name="chevron-right" /></button>
    </div>`}
    <div class="row mt-24"><${Btn} onClick=${onBack}>${t('common.back')}</${Btn}></div>
  </div>`;
}

export function ImportReport({ report, onNext }) {
  const r = report;
  const cash = r.checks.cash || [];
  return html`<div>
    <h2 style="font-family:var(--font-cond);font-size:26px" class="mb-8">${t('setup.report_title')}</h2>
    <p class="muted mb-16">${t('setup.report_text', { products: r.counts.products, sales: r.counts.sales, purchases: r.counts.purchases, partners: r.counts.partners })}</p>
    <div class="col gap-8">
      <${Notice} kind=${r.checks.stock_mismatch ? 'warn' : 'ok'}>${r.checks.stock_mismatch ? t('setup.stock_mismatch', { n: r.checks.stock_mismatch }) : t('setup.stock_ok', { qty: num(r.checks.stock_total) })}</${Notice}>
      ${r.fixed.map((f) => html`<${Notice} kind="ok" icon="wrench">${fixText(f)}</${Notice}>`)}
      ${r.warnings.map((w) => html`<${Notice} kind="warn">${warnText(w)}</${Notice}>`)}
    </div>
    ${cash.length > 0 && html`<div class="panel mt-16"><div class="panel-head"><h3>${t('setup.cash_check')}</h3></div>
      <table class="tbl compact"><thead><tr><th>${t('common.currency')}</th><th class="r">${t('setup.old_program')}</th><th class="r">${t('setup.new_program')}</th></tr></thead>
      <tbody>${cash.map((c) => html`<tr><td>${c.currency}</td><td class="r num">${num(c.old, c.currency === 'IQD' ? 0 : 2)}</td><td class=${`r num ${c.new < 0 ? 'neg' : ''}`}>${num(c.new, c.currency === 'IQD' ? 0 : 2)}</td></tr>`)}</tbody></table>
      ${cash.some((c) => Math.abs(c.old - c.new) > (c.currency === 'IQD' ? 1 : 0.01)) && html`<div class="panel-body small muted">${t('setup.cash_diff_hint')}</div>`}</div>`}
    <div class="row end mt-24"><${Btn} kind="primary" size="lg" onClick=${onNext}>${t('common.continue')}</${Btn}></div>
  </div>`;
}

/** report lines in the chosen language; amounts shown with the program's number format */
const iso = (x) => `\u2068${x || ''}\u2069`;
function fmtAmount(a, cur) { return a === undefined || a === null ? '' : `${num(a, cur === 'IQD' ? 0 : 2)}`; }
function fixText(f) {
  if (f.code === 'payment_currency') return t('setup.fix.payment_currency', { doc: f.doc || '', amount: fmtAmount(f.amount, f.to), from: f.from || '', to: f.to || '' });
  if (f.code === 'try_currency') return t('setup.fix.try_currency', { n: f.n || 0, list: f.list || '' });
  return f.text;
}
function warnText(w) {
  switch (w.code) {
    case 'overpaid': return t('setup.warn.overpaid', { doc: w.doc || '', amount: `${fmtAmount(w.amount, w.currency)} ${w.currency || ''}`.trim() });
    case 'negative_cash': return t('setup.warn.negative_cash', { currency: w.currency, amount: num(w.amount, w.currency === 'IQD' ? 0 : 2) });
    case 'dup_codes': return t('setup.warn.dup_codes', { n: w.n || 0, list: w.list || '' });
    case 'deleted_product': return t('setup.warn.deleted_product', { name: iso(w.name), doc: w.doc || '' });
    case 'dup_barcode': return t('setup.warn.dup_barcode', { barcode: w.barcode || '', first: iso(w.first), second: iso(w.second) });
    case 'missing_account': return t('setup.warn.missing_account', { doc: w.doc || '' });
    case 'dup_number': return t('setup.warn.dup_number', { doc: w.doc || '', new_no: w.new_no || '' });
    case 'no_cash': return t('setup.warn.no_cash', { currency: w.currency || '' });
    case 'stock_correction': return t('setup.warn.stock_correction', { n: w.n || 0 });
    case 'logo': return t('setup.warn.logo', { error: w.error || '' });
    default: return w.text;
  }
}
