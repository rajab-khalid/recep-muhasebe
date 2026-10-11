'use strict';
/*
 * Phone app access through Tailscale (a free private network between the shop computer and the owner's own
 * phones). "tailscale serve" gives the program a secure https address (dukkan-pc.tailnet.ts.net) that only the
 * devices signed in to the same Tailscale account can open; nothing is opened to the internet (Funnel is never
 * used). https is what lets a phone use its camera and install the program on the home screen.
 *
 * The Tailscale program does the networking; this file only runs its command line:
 *   tailscale status --json                         is it installed, signed in, what is this computer's name
 *   tailscale serve status --json                   is the program's address already shared
 *   tailscale serve --bg --yes http://127.0.0.1:N   share the program (keeps working after a restart)
 *   tailscale serve --https=443 off                 stop sharing it ("serve reset" is never used: it would
 *                                                   also remove anything else the owner shares)
 */
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function candidates() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [path.join(pf, 'Tailscale', 'tailscale.exe'), path.join(pf86, 'Tailscale', 'tailscale.exe'), path.join(pf, 'Tailscale IPN', 'tailscale.exe')];
  }
  if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
}

/** the Tailscale command line program, or null when Tailscale is not installed */
function cli() {
  if (process.env.RM_TAILSCALE_CLI) return process.env.RM_TAILSCALE_CLI; // tests
  for (const p of candidates()) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ } }
  return null;
}

function run(args, timeout = 20000) {
  const exe = cli();
  if (!exe) return Promise.reject(Object.assign(new Error('Tailscale is not installed'), { code: 'not_installed' }));
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.output = `${stdout || ''}\n${stderr || ''}`.trim(); reject(err); return; }
      resolve(String(stdout || ''));
    });
  });
}

const lastLines = (s, n = 4) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-n).join('\n');
const errText = (e) => lastLines(e.output || e.message || String(e)).slice(0, 600);

/** the address the program is shared at for this port, from "serve status --json" */
function shared(cfg, port) {
  const out = { on: false, other: false, funnel: false };
  if (!cfg || typeof cfg !== 'object') return out;
  const web = cfg.Web || {};
  for (const [hostPort, site] of Object.entries(web)) {
    if (!/:443$/.test(hostPort)) continue;
    const h = (site && site.Handlers && site.Handlers['/']) || null;
    const proxy = h && h.Proxy ? String(h.Proxy) : '';
    if (!proxy) continue;
    const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy);
    if (m && Number(m[1]) === Number(port)) out.on = true;
    else out.other = true; // something else (or this program on an old port) is shared at the address
    if (cfg.AllowFunnel && cfg.AllowFunnel[hostPort]) out.funnel = true;
  }
  return out;
}

/** everything the settings screen shows */
async function status(port) {
  const exe = cli();
  if (!exe) return { installed: false };
  let st;
  try { st = JSON.parse(await run(['status', '--json'], 15000)); } catch (e) {
    return { installed: true, running: false, state: 'Stopped', error: errText(e) };
  }
  const self = st.Self || {};
  const dns = String(self.DNSName || '').replace(/\.$/, '');
  const state = st.BackendState || 'NoState';
  const users = st.User || {};
  const me = users[String(self.UserID)] || {};
  const res = {
    installed: true, running: state === 'Running', state, dns,
    url: dns ? `https://${dns}` : null,
    https: Array.isArray(st.CertDomains) && st.CertDomains.length > 0,
    account: me.LoginName || '', tailnet: (st.CurrentTailnet && st.CurrentTailnet.Name) || '',
    on: false, other: false, funnel: false,
  };
  if (res.running) {
    try {
      const out = (await run(['serve', 'status', '--json'], 15000)).trim();
      Object.assign(res, shared(out && out !== 'null' ? JSON.parse(out) : null, port));
    } catch (e) { res.serveError = errText(e); }
  }
  return res;
}

let pending = null; // a "serve" waiting for the owner to allow https once on the Tailscale website

/**
 * Share the program at the computer's Tailscale https address. Resolves with { ok } when done, or
 * { ok: false, approve: url } when Tailscale asks the owner to allow it once on its website first (the command
 * keeps waiting in the background and finishes by itself after that).
 */
function enable(port, onLater) {
  const exe = cli();
  if (!exe) return Promise.resolve({ ok: false, error: 'not_installed' });
  if (pending && pending.exitCode === null) { try { pending.kill(); } catch (e) { /* gone */ } }
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const child = spawn(exe, ['serve', '--bg', '--yes', `http://127.0.0.1:${Number(port)}`], { windowsHide: true });
    pending = child;
    const look = (chunk) => {
      out += String(chunk);
      const m = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(out);
      if (m) finish({ ok: false, approve: m[1].replace(/[)\].,]+$/, '') });
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    child.on('error', (e) => finish({ ok: false, error: errText(e) }));
    child.on('exit', (code) => {
      if (pending === child) pending = null;
      const r = code === 0 ? { ok: true } : { ok: false, error: lastLines(out) || `exit ${code}` };
      if (done && onLater) { try { onLater(r); } catch (e) { /* ignore */ } } // finished after the owner approved
      finish(r);
    });
    // waiting for the owner: give up after 10 minutes
    setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch (e) { /* gone */ } }, 10 * 60000).unref();
    setTimeout(() => finish({ ok: false, error: lastLines(out) || 'timeout' }), 45000).unref();
  });
}

/** stop sharing the program (the https address of this computer); other Tailscale settings are left alone */
async function disable(port) {
  if (pending && pending.exitCode === null) { try { pending.kill(); } catch (e) { /* gone */ } }
  try { await run(['serve', '--https=443', 'off'], 20000); return { ok: true }; } catch (e) {
    // "off" also fails when nothing was shared: that is fine
    try { const s = await status(port); if (s.installed && !s.on) return { ok: true }; } catch (x) { /* report the first error */ }
    return { ok: false, error: errText(e) };
  }
}

/** at start: the program may be listening on another port than last time; point the shared address at it again */
async function ensure(port) {
  try {
    const s = await status(port);
    if (s.installed && s.running && !s.on) return await enable(port);
    return { ok: !!s.on };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

module.exports = { cli, status, enable, disable, ensure, shared };
