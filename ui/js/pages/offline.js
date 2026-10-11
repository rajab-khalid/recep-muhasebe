// Working without the shop computer: the bar that says so, the phone's "Offline work" settings, the list of
// work the computer could not apply, and (on the shop computer) the phones that keep a copy.
import { html, useState, useEffect } from '../core/h.js';
import { t, has } from '../core/i18n.js';
import { api } from '../core/api.js';
import { useStore, store } from '../core/store.js';
import { dateTime, fileSize } from '../core/format.js';
import { Icon, Btn, Panel, Notice, KV, Pill, Empty, Loading, openModal, toast, errToast, confirmDialog } from '../core/ui.js';
import { offline, offlineFor, offlineConfig, offlineSupported, isOwner } from '../core/offline.js';
import { refreshBoot } from '../core/session.js';
import { auditText } from './audit.js';

const errText = (e) => (e && e.code && has(`err.${e.code}`) ? t(`err.${e.code}`, e.details || {}) : (e && e.message) || t('err.generic'));

/** what the work was, in the reader's language ("Sales invoice SF2026-T1-0003 · 120,000 IQD") */
export function problemText(p) {
  const l = p.label || {};
  const what = l.msg ? auditText({ msg: JSON.stringify(l.msg), summary: l.summary }) : (l.summary || '');
  const action = l.action && has(`audit.action.${l.action}`) ? t(`audit.action.${l.action}`) : '';
  const entity = l.entity && has(`audit.entity.${l.entity}`) ? t(`audit.entity.${l.entity}`) : '';
  return [[entity, action].filter(Boolean).join(' — '), what].filter(Boolean).join(': ') || `${p.method} ${p.path}`;
}

/* ------------------------------------------------------------------ the bar above every screen */
export function OfflineBar() {
  const o = useStore((s) => s.offline) || {};
  const user = useStore((s) => s.user);
  const copy = o.copy || {};
  const pending = copy.pending || 0;
  const problems = (o.problems || []).length;
  if (o.mode === 'offline') {
    return html`<div class="offline-bar off" role="status">
      <${Icon} name="wifi-off" size="sm" />
      <span class="ob-text"><b>${t('offline.bar')}</b>${copy.snapshotAt ? html` <span class="ob-sub">${t('offline.bar_copy', { time: dateTime(copy.snapshotAt) })}</span>` : null}${pending ? html` <span class="ob-sub">· ${t('offline.pending_n', { n: pending })}</span>` : null}</span>
      ${o.needLogin ? html`<button type="button" class="ob-btn" onClick=${() => offline.signInOnline()}>${t('offline.sign_in')}</button>`
        : html`<button type="button" class="ob-btn" disabled=${!!o.syncing} onClick=${tryNow}>${o.syncing ? t('offline.syncing') : t('offline.try_now')}</button>`}
    </div>`;
  }
  if (problems && offlineFor(user)) {
    return html`<div class="offline-bar warn" role="status"><${Icon} name="triangle-alert" size="sm" />
      <span class="ob-text">${t('offline.problems_n', { n: problems })}</span><a class="ob-btn" href="#/settings/offline">${t('offline.see')}</a></div>`;
  }
  return null;
}
async function tryNow() {
  const ok = await offline.reconnect({ manual: true });
  if (!ok && !(store.state.offline || {}).needLogin) toast(t('offline.still_offline'), 'warn');
}

/* ------------------------------------------------------------------ work the computer could not apply */
export function ProblemList({ problems, onRetry, onDismiss, showDevice }) {
  const [busy, setBusy] = useState(null);
  if (!problems || !problems.length) return html`<${Empty} icon="circle-check" title=${t('offline.no_problems')} />`;
  const run = async (id, fn) => { setBusy(id); try { await fn(); } catch (e) { errToast(e); } finally { setBusy(null); } };
  return html`<div class="problem-list">${problems.map((p) => html`<div class="problem" key=${p.id}>
    <div class="pr-main">
      <div class="pr-what" dir="auto">${problemText(p)}</div>
      <div class="pr-why ${p.status === 'conflict' ? 'warn-text' : 'neg'}">${p.status === 'conflict' ? t('offline.conflict_text') : errText(p.error)}</div>
      <div class="tiny muted">${dateTime(p.ts)}${showDevice && p.device_code ? html` · <${Pill}>${p.device_code}</${Pill}>` : null}</div>
    </div>
    <div class="pr-acts">
      <${Btn} size="sm" icon="refresh-cw" disabled=${busy === p.id} onClick=${() => run(p.id, () => onRetry(p, false))}>${t('offline.retry')}</${Btn}>
      ${p.status === 'conflict' && html`<${Btn} size="sm" kind="primary" disabled=${busy === p.id} onClick=${() => run(p.id, async () => {
        if (await confirmDialog({ title: t('offline.apply_anyway'), text: t('offline.apply_anyway_text'), okText: t('offline.apply_anyway') })) await onRetry(p, true);
      })}>${t('offline.apply_anyway')}</${Btn}>`}
      <${Btn} size="sm" kind="ghost" disabled=${busy === p.id} onClick=${() => run(p.id, async () => {
        if (await confirmDialog({ title: t('offline.dismiss'), text: t('offline.dismiss_text'), okText: t('offline.dismiss'), danger: true })) await onDismiss(p);
      })}>${t('offline.dismiss')}</${Btn}>
    </div>
  </div>`)}</div>`;
}

function retryResult(r) {
  if (r && (r.status === 'applied' || r.status === 'duplicate')) toast(t('offline.retry_ok'));
  else toast(errText(r && r.error), 'err');
}

/* ------------------------------------------------------------------ the phone's settings */
export function offlineSettingsVisible(user) {
  return offlineSupported() && isOwner(user);
}

export function OfflineSettings() {
  const user = useStore((s) => s.user) || {};
  const o = useStore((s) => s.offline) || {};
  const [busy, setBusy] = useState(false);
  const [st, setSt] = useState(null);
  const on = offlineFor(user);
  const isOff = o.mode === 'offline';
  const copy = o.copy || st || {};
  useEffect(() => {
    if (!on) return;
    offline.status().then(setSt).catch(() => {});
    if (!isOff) offline.loadProblems().catch(() => {});
  }, [on]);
  const noPin = !user.has_pin && !user.has_password;
  const enable = async () => {
    setBusy(true);
    try {
      const code = await offline.enable();
      setSt(await offline.status());
      toast(t('offline.on_ok', { code }));
    } catch (e) { errToast({ message: errText(e) }); } finally { setBusy(false); }
  };
  const disable = async () => {
    const pending = copy.pending || 0;
    const ok = await confirmDialog({
      title: t('offline.turn_off'), text: pending ? t('offline.turn_off_pending', { n: pending }) : t('offline.turn_off_text'), okText: t('offline.turn_off'), danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await offline.disable({ force: true }); setSt(null); toast(t('offline.off_ok')); } catch (e) { errToast({ message: errText(e) }); } finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      if (isOff) { if (!(await offline.reconnect({ manual: true }))) toast(t('offline.still_offline'), 'warn'); } else { await offline.refresh({ force: true }); toast(t('offline.refreshed')); }
      setSt(await offline.status());
    } catch (e) { errToast({ message: errText(e) }); } finally { setBusy(false); }
  };
  const cfg = offlineConfig() || {};
  return html`<div class="stack">
    <${Panel} title=${t('settings.offline')} icon="wifi-off">
      <p class="dim" style="max-width:72ch;margin-top:0">${t('offline.intro')}</p>
      ${!on ? html`
        ${o.error && o.error.code === 'device_revoked' ? html`<${Notice} kind="warn" cls="mb-8">${t('err.device_revoked')}</${Notice}>` : null}
        ${copy.pending > 0 ? html`<${Notice} kind="warn" cls="mb-8">${t('offline.unsent_left', { n: copy.pending })}</${Notice}>` : null}
        ${noPin ? html`<${Notice} kind="warn">${t('offline.no_pin')}</${Notice}>` : null}
        <div class="row gap-8 wrap mt-12"><${Btn} kind="primary" icon="wifi-off" disabled=${busy || noPin || isOff} onClick=${enable}>${busy ? t('offline.turning_on') : t('offline.turn_on')}</${Btn}></div>
        <p class="small muted mt-12" style="max-width:72ch">${t('offline.privacy')}</p>`
      : html`
        <${KV} items=${[
          [t('offline.state'), html`<${Pill} kind=${isOff ? 'warn' : 'in'} dot>${isOff ? t('offline.state_offline') : t('offline.state_on')}</${Pill}>`],
          [t('offline.series'), html`<b class="ltr">${copy.series || cfg.code || '—'}</b><div class="tiny muted">${t('offline.series_hint', { code: copy.series || cfg.code || 'T1' })}</div>`],
          [t('offline.last_copy'), copy.snapshotAt ? dateTime(copy.snapshotAt) : t('offline.never')],
          [t('offline.pending'), String(copy.pending || 0)],
          [t('offline.size'), copy.size ? fileSize(copy.size) : '—'],
          o.error && o.error.code !== 'network' ? [t('offline.last_error'), html`<span class="neg small">${errText(o.error)}</span>`] : null,
        ]} />
        <div class="row gap-8 wrap mt-16">
          <${Btn} kind="primary" icon="refresh-cw" disabled=${busy || o.syncing} onClick=${refresh}>${o.syncing ? t('offline.syncing') : isOff ? t('offline.try_now') : t('offline.refresh_now')}</${Btn}>
          ${!isOff && html`<${Btn} kind="ghost" icon="trash-2" disabled=${busy} onClick=${disable}>${t('offline.turn_off')}</${Btn}>`}
        </div>`}
    </${Panel}>
    ${on && html`<${Panel} title=${t('offline.problems')} icon="triangle-alert">
      <p class="small dim" style="margin-top:0;max-width:72ch">${t('offline.problems_text')}</p>
      ${isOff && (o.problems || []).length ? html`<${Notice} kind="warn" cls="mb-8">${t('offline.problems_offline')}</${Notice}>` : null}
      <${ProblemList} problems=${o.problems || []}
        onRetry=${async (p, force) => { retryResult(await offline.retryProblem(p.id, force)); await refreshBoot(); }}
        onDismiss=${async (p) => { await offline.dismissProblem(p.id); toast(t('offline.dismissed')); }} />
    </${Panel}>`}
    <${Panel} title=${t('offline.tips')} icon="info">
      <ul class="small dim tips-list">
        <li>${t('offline.tip_open')}</li>
        <li>${t('offline.tip_home')}</li>
        <li>${t('offline.tip_numbers')}</li>
        <li>${t('offline.tip_admin')}</li>
      </ul>
    </${Panel}>
  </div>`;
}

/* ------------------------------------------------------------------ on the shop computer: phones with a copy */
export function OfflineDevices() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = async () => {
    try {
      const [devices, problems] = await Promise.all([api.get('/api/phone/devices'), api.get('/api/phone/problems')]);
      setData({ devices, problems });
    } catch (e) { setErr(e); }
  };
  useEffect(() => { load(); }, []);
  if (err) return html`<${Panel} title=${t('offline.devices')} icon="wifi-off"><${Notice} kind="err">${err.message}</${Notice}></${Panel}>`;
  if (!data) return html`<${Panel} title=${t('offline.devices')} icon="wifi-off"><${Loading} /></${Panel}>`;
  const remove = async (d) => {
    if (!(await confirmDialog({ title: t('offline.device_remove'), text: t('offline.device_remove_text', { code: d.code }), okText: t('offline.device_remove'), danger: true }))) return;
    try { await api.post(`/api/phone/devices/${d.id}/revoke`); toast(t('offline.device_removed')); load(); } catch (e) { errToast(e); }
  };
  const active = data.devices.filter((d) => !d.revoked);
  return html`<div class="stack">
    <${Panel} title=${t('offline.devices')} icon="wifi-off">
      <p class="small dim" style="margin-top:0;max-width:72ch">${t('offline.devices_text')}</p>
      ${!active.length ? html`<p class="small muted">${t('offline.no_devices')}</p>` : html`<div class="mini-list">${active.map((d) => html`<div class="mini-row" key=${d.id}>
        <${Icon} name="smartphone" />
        <div class="grow"><div><b class="ltr">${d.code}</b> · ${d.name || '—'} <span class="muted small">${d.user_name || ''}</span></div>
          <div class="tiny muted">${t('offline.last_sync')}: ${d.last_sync_at ? dateTime(d.last_sync_at) : t('offline.never')} · ${t('offline.last_copy')}: ${d.last_snapshot_at ? dateTime(d.last_snapshot_at) : t('offline.never')}</div></div>
        ${d.problems ? html`<${Pill} kind="warn">${t('offline.problems_n', { n: d.problems })}</${Pill}>` : null}
        <${Btn} size="sm" kind="ghost" icon="trash-2" onClick=${() => remove(d)}>${t('offline.device_remove')}</${Btn}>
      </div>`)}</div>`}
    </${Panel}>
    ${data.problems.length > 0 && html`<${Panel} title=${t('offline.problems')} icon="triangle-alert">
      <p class="small dim" style="margin-top:0;max-width:72ch">${t('offline.problems_text_pc')}</p>
      <${ProblemList} problems=${data.problems} showDevice
        onRetry=${async (p, force) => { retryResult(await api.post(`/api/phone/problems/${p.id}/retry`, { force })); await load(); }}
        onDismiss=${async (p) => { await api.post(`/api/phone/problems/${p.id}/dismiss`); toast(t('offline.dismissed')); await load(); }} />
    </${Panel}>`}
  </div>`;
}
