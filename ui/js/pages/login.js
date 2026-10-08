// Sign-in: pick a user tile, then PIN pad or password. "Remember me" keeps this computer signed in.
import { html, useState, useEffect, useRef } from '../core/h.js';
import { t, LANGS, getLang, setLang } from '../core/i18n.js';
import { api } from '../core/api.js';
import { initials } from '../core/format.js';
import { Btn, Icon, Input, Field, Check, Spinner } from '../core/ui.js';
import { loadBoot } from '../core/session.js';

export function Login() {
  const [users, setUsers] = useState(null);
  const [sel, setSel] = useState(null);
  const [byName, setByName] = useState(false);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  // the PIN typed so far; kept in a ref too, so quick typing never loses a digit between two screen updates
  const pinRef = useRef('');
  const busyRef = useRef(false);
  const setPin = (v) => { pinRef.current = v; setSecret(v); };

  useEffect(() => {
    api.get('/api/auth/users').then((u) => {
      setUsers(u);
      if (u.length === 1) setSel(u[0]);
    }).catch(() => setUsers([]));
  }, []);

  const submit = async (val) => {
    if (busyRef.current) return;
    const s = val !== undefined ? val : secret;
    busyRef.current = true;
    setBusy(true); setErr('');
    try {
      const body = byName ? { username, password: s, remember } : { user_id: sel.id, password: s, pin: s, remember };
      const r = await api.post('/api/auth/login', body);
      await loadBoot(r.user);
    } catch (e) {
      setErr(e.message); setPin('');
    } finally { busyRef.current = false; setBusy(false); }
  };

  const usePin = sel && sel.has_pin && !sel.has_password && !byName;
  const noSecret = sel && !sel.has_pin && !sel.has_password && !byName;

  const press = (d) => {
    if (busyRef.current) return;
    if (d === 'del') { setPin(pinRef.current.slice(0, -1)); return; }
    setPin((pinRef.current + d).slice(0, 8));
    setErr('');
  };
  const submitPin = () => { if (pinRef.current.length >= 4) submit(pinRef.current); };

  useEffect(() => {
    if (!usePin) return undefined;
    const onKey = (e) => {
      if (e.target && e.target.tagName === 'SELECT') return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); press('del'); } else if (e.key === 'Enter') { e.preventDefault(); submitPin(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [usePin, sel, remember]);

  return html`<div class="auth-screen">
    <aside class="auth-side">
      <div class="row"><img src="img/icon.svg" width="44" height="44" alt="" /><div class="brand-name" style="font-size:20px">Recep Muhasebe</div></div>
      <div>
        <div class="big">${t('login.headline')}</div>
        <p class="tag">${t('login.tagline')}</p>
      </div>
      <div class="small" style="color:var(--chrome-dim)">v3</div>
    </aside>
    <main class="auth-main">
      <div class="auth-card">
        <div class="row between mb-16">
          <h2 style="font-family:var(--font-cond);font-size:26px">${t('login.title')}</h2>
          <select class="select" style="width:auto" value=${getLang()} onChange=${(e) => setLang(e.target.value)} aria-label=${t('common.language')}>
            ${LANGS.map((l) => html`<option value=${l.code} selected=${l.code === getLang()}>${l.name}</option>`)}
          </select>
        </div>
        ${users === null ? html`<${Spinner} />` : byName ? html`
          <form class="col gap-12" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
            <${Field} label=${t('login.username')}><${Input} value=${username} onValue=${setUsername} autoFocus autocomplete="username" /></${Field}>
            <${Field} label=${t('login.password')}><${Input} type="password" value=${secret} onValue=${setSecret} autocomplete="current-password" /></${Field}>
            <${Check} checked=${remember} onValue=${setRemember} label=${t('login.remember')} />
            ${err && html`<div class="notice err">${err}</div>`}
            <${Btn} type="submit" kind="primary" size="lg" disabled=${busy || !username}>${t('login.submit')}</${Btn}>
            <button type="button" class="link-btn small" onClick=${() => { setByName(false); setErr(''); }}>${t('login.choose_user')}</button>
          </form>` : html`
          <div class="user-tiles">
            ${users.map((u) => html`<button type="button" class=${`user-tile ${sel && sel.id === u.id ? 'on' : ''}`} onClick=${() => { setSel(u); setPin(''); setErr(''); }}>
              <div class="avatar">${initials(u.full_name)}</div><div><div class="strong" dir="auto">${u.full_name}</div><div class="tiny muted">${u.role_name || ''}</div></div>
            </button>`)}
          </div>
          ${sel && html`<div class="mt-24">
            ${usePin ? html`
              <div class="center small muted" style="text-align:center">${t('login.enter_pin')}</div>
              <div class="pin-dots" aria-live="polite">${[0, 1, 2, 3].concat(secret.length > 4 ? [...Array(secret.length - 4).keys()].map((i) => i + 4) : []).map((i) => html`<i class=${i < secret.length ? 'on' : ''}></i>`)}</div>
              <div class="keypad">
                ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => html`<button type="button" onClick=${() => press(d)}>${d}</button>`)}
                <button type="button" onClick=${() => press('del')} aria-label=${t('common.delete')}><${Icon} name="undo-2" /></button>
                <button type="button" onClick=${() => press('0')}>0</button>
                <button type="button" style="background:var(--graphite);color:#fff" disabled=${secret.length < 4 || busy} onClick=${submitPin} aria-label=${t('login.submit')}><${Icon} name="check" /></button>
              </div>` : noSecret ? html`
              <${Btn} kind="primary" size="lg" cls="mt-8" style="width:100%" disabled=${busy} onClick=${() => submit('')}>${t('login.submit')}</${Btn}>
              <p class="small muted mt-8">${t('login.no_secret_hint')}</p>` : html`
              <form class="col gap-12" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
                <${Field} label=${sel.has_pin ? t('login.password_or_pin') : t('login.password')}><${Input} type="password" value=${secret} onValue=${setSecret} autoFocus /></${Field}>
                <${Btn} type="submit" kind="primary" size="lg" disabled=${busy || !secret}>${t('login.submit')}</${Btn}>
              </form>`}
            <div class="row between mt-12">
              <${Check} checked=${remember} onValue=${setRemember} label=${t('login.remember')} />
            </div>
            ${err && html`<div class="notice err mt-12">${err}</div>`}
          </div>`}
          <div class="mt-24 row between gap-12 wrap">
            <button type="button" class="link-btn small" onClick=${() => { setByName(true); setPin(''); setErr(''); }}>${t('login.by_username')}</button>
            <button type="button" class="link-btn small" aria-expanded=${help} onClick=${() => setHelp(!help)}>${t('login.forgot')}</button>
          </div>
          ${help && html`<div class="notice mt-12 small">${t('login.forgot_text')}</div>`}
        `}
      </div>
    </main>
  </div>`;
}
