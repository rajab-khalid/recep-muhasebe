'use strict';
/*
 * Recep Muhasebe 3 — desktop shell.
 * Starts the built-in server (database + screens) and shows it in a window. Other computers on the shop's
 * network can open the same address in their browser when network access is switched on in the settings.
 * Updates come from GitHub Releases (electron-updater), exactly like the previous version.
 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const olddata = require('./desktop/olddata');
const strings = require('./desktop/strings');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { autoUpdater = null; }

// The window keeps its storage apart from the old program's folder, so the old data is never touched.
const PARTITION = 'persist:recep3';
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

let backend = null;
let mainWin = null;
let quitting = false;
let updateState = { state: 'idle' };
const oldCache = new Map();

const tempRoots = new Set(); // temporary copies of the old program's storage, removed at the latest when closing

const lang = () => { try { return backend.app.getSetting('general').lang || 'tr'; } catch (e) { return 'tr'; } };

/** is this address one of the program's own pages? (the exact origin, not just a matching beginning) */
function own(url) {
  if (typeof url !== 'string' || !backend) return false;
  try { return new URL(url).origin === new URL(backend.url).origin; } catch (e) { return false; }
}
const S = () => strings(lang());

/* ------------------------------------------------------------------ start */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
  app.whenReady().then(start);
}

/** temporary copies left behind by an earlier run (Windows may keep them open until the program closes) */
function cleanLeftoverTemps() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('rm-old-')) { try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch (e) { /* still in use */ } }
    }
  } catch (e) { /* no temp folder access */ }
}

async function start() {
  Menu.setApplicationMenu(null);
  cleanLeftoverTemps();
  try {
    const { startServer } = require('./server');
    backend = await startServer({ dataDir: DATA_DIR, desktop: true, onRestartRequested: relaunch });
  } catch (e) {
    const s = strings('tr');
    dialog.showErrorBox(s.start_failed, s.start_failed_detail(DATA_DIR, (e && (e.stack || e.message)) || String(e)));
    app.exit(1);
    return;
  }
  registerIpc();
  createWindow();
  setupAutoUpdate();
}

/* ------------------------------------------------------------------ window */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function saveState(win, extra = {}) {
  if (!win || win.isDestroyed()) return;
  const prev = loadState() || {};
  const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...prev, ...bounds, isMaximized: win.isMaximized(), ...extra })); } catch (e) { /* ignore */ }
}

/** the saved position is used only when it is still on one of the screens */
function visible(saved) {
  if (!saved || saved.x === undefined) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 && saved.y < a.y + a.height - 40 && saved.y > a.y - 20;
  });
}

function createWindow() {
  const saved = loadState();
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: (saved && saved.width) || Math.min(1440, Math.round(area.width * 0.92)),
    height: (saved && saved.height) || Math.min(960, Math.round(area.height * 0.92)),
    x: visible(saved) ? saved.x : undefined,
    y: visible(saved) ? saved.y : undefined,
    minWidth: 980,
    minHeight: 620,
    title: 'Recep Muhasebe',
    backgroundColor: '#F3F4F2',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWin = win;
  guardContents(win.webContents);
  win.loadURL(`${backend.url}/`);
  win.once('ready-to-show', () => {
    if (!saved || saved.isMaximized) win.maximize();
    if (saved && saved.zoom) win.webContents.setZoomFactor(saved.zoom);
    win.show();
  });
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => saveState(win), 400); };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', () => saveState(win));
  win.on('closed', () => { mainWin = null; });
  // the screens failed to load (e.g. the server was busy starting): try again shortly
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !quitting) setTimeout(() => { if (!win.isDestroyed()) win.loadURL(`${backend.url}/`); }, 1500);
  });
}

/** links, new windows, keyboard shortcuts and the right-click menu for every window of the program */
function guardContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank' || own(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000, height: 820, autoHideMenuBar: true, title: 'Recep Muhasebe', backgroundColor: '#FFFFFF',
          webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
        },
      };
    }
    if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => guardContents(child.webContents));
  wc.on('will-navigate', (e, url) => {
    if (own(url)) return;
    e.preventDefault();
    if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(url)) shell.openExternal(url);
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    const win = BrowserWindow.fromWebContents(wc);
    if (key === 'f5' || (ctrl && key === 'r')) { e.preventDefault(); wc.reload(); } else if (key === 'f11' && win) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); } else if (ctrl && input.shift && key === 'i') { e.preventDefault(); wc.toggleDevTools(); } else if (ctrl && (key === '=' || key === '+' || key === 'add')) { e.preventDefault(); zoom(wc, 0.1); } else if (ctrl && (key === '-' || key === 'subtract')) { e.preventDefault(); zoom(wc, -0.1); } else if (ctrl && key === '0') { e.preventDefault(); zoom(wc, 0); }
  });
  wc.on('context-menu', (e, p) => {
    const s = S();
    const f = p.editFlags || {};
    const items = [];
    if (p.isEditable) {
      items.push({ label: s.undo, role: 'undo', enabled: f.canUndo }, { label: s.redo, role: 'redo', enabled: f.canRedo }, { type: 'separator' });
      items.push({ label: s.cut, role: 'cut', enabled: f.canCut }, { label: s.copy, role: 'copy', enabled: f.canCopy }, { label: s.paste, role: 'paste', enabled: f.canPaste }, { type: 'separator' }, { label: s.select_all, role: 'selectAll' });
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ label: s.copy, role: 'copy' }, { label: s.select_all, role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) });
  });
}

function zoom(wc, step) {
  const z = step === 0 ? 1 : Math.min(1.6, Math.max(0.7, Math.round((wc.getZoomFactor() + step) * 10) / 10));
  wc.setZoomFactor(z);
  if (mainWin && wc === mainWin.webContents) saveState(mainWin, { zoom: z });
}

/* ------------------------------------------------------------------ bridge for the screens */
function registerIpc() {
  // only our own screens may call the desktop functions
  const ours = (e) => {
    const url = (e.senderFrame && e.senderFrame.url) || '';
    if (!own(url)) throw new Error('not allowed');
  };
  const handle = (name, fn) => ipcMain.handle(name, async (e, ...args) => { ours(e); return fn(e, ...args); });

  handle('rm:version', () => app.getVersion());
  handle('rm:print', (e, o) => printHtml(o || {}));
  handle('rm:printers', async (e) => {
    const list = await e.sender.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  });
  handle('rm:find-old', () => findOld());
  handle('rm:read-old', (e, id) => readOld(String(id || '')));
  handle('rm:choose-folder', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // opens a folder of the program (data, backups) in Explorer; nothing else, and never a file
  handle('rm:open-path', (e, p) => {
    const target = path.resolve(String(p || '.'));
    let extra = null;
    try { extra = (backend.app.getSetting('backup') || {}).folder || null; } catch (x) { extra = null; }
    const allowed = [DATA_DIR, extra].filter(Boolean).map((d) => path.resolve(d));
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const inside = allowed.some((d) => same(target, d) || same(target.slice(0, d.length + 1), d + path.sep));
    if (!inside) return 'not allowed'; // checked before the disk is touched (no network paths are ever looked at)
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch (x) { isDir = false; }
    if (!isDir) return 'not allowed';
    return shell.openPath(target);
  });
  handle('rm:open-external', (e, url) => {
    if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(String(url || ''))) shell.openExternal(String(url));
    return true;
  });
  handle('rm:relaunch', () => { relaunch(); return true; });
  handle('rm:check-updates', () => checkUpdates());
}

/* ------------------------------------------------------------------ printing */
/**
 * Prints a finished HTML page: through the system print window, or straight to a named printer (receipts).
 * The page is opened on the program's own address so fonts, the logo and photos load.
 */
async function printHtml(o) {
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, spellcheck: false } });
  try {
    await win.loadURL(`${backend.url}/print.html`);
    await win.webContents.executeJavaScript(`(() => {
      document.open(); document.write(${JSON.stringify(String(o.html || ''))}); document.close();
      const imgs = [...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; setTimeout(r, 4000); })));
      return Promise.all(imgs).then(() => (document.fonts ? document.fonts.ready : null)).then(() => new Promise((r) => setTimeout(r, 150))).then(() => true);
    })()`);
    const opts = {
      silent: !!(o.silent && o.printer),
      printBackground: true,
      copies: Math.max(1, Math.min(20, Number(o.copies) || 1)),
      deviceName: o.printer || undefined,
    };
    if (o.page === 'receipt') {
      const px = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
      opts.pageSize = { width: 80000, height: Math.max(60000, Math.round((px * 25400) / 96) + 6000) };
      opts.margins = { marginType: 'none' };
    } else if (o.page === 'label') {
      opts.pageSize = { width: Math.round((Number(o.w) || 50) * 1000), height: Math.round((Number(o.h) || 30) * 1000) };
      opts.margins = { marginType: 'none' };
    } else {
      opts.pageSize = o.page === 'A5' ? 'A5' : 'A4';
    }
    return await new Promise((resolve) => {
      win.webContents.print(opts, (ok, reason) => resolve({ ok, error: ok || reason === 'cancelled' ? null : reason }));
    });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 1500);
  }
}

/* ------------------------------------------------------------------ the old program's data */
/** reads the old browser storage through Chromium itself, from a temporary copy (second way) */
async function readViaChromium(c) {
  if (typeof session.fromPath !== 'function') return null;
  const copy = olddata.copyLevelDb(c.leveldb);
  tempRoots.add(copy.root);
  const page = path.join(copy.root, 'read.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>r</title>');
  const ses = session.fromPath(copy.root);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } });
  try {
    await win.loadFile(page);
    const json = await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(olddata.KEY)})`);
    if (!json) return null;
    const info = olddata.summarize(json);
    return info ? { json, info } : null;
  } finally {
    win.destroy();
    setTimeout(() => removeTemp(copy.root), 3000);
  }
}

function removeTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); tempRoots.delete(dir); } catch (e) { /* still in use: tried again when closing */ }
}

async function findOld() {
  const found = [];
  for (const c of olddata.candidates(app.getPath('appData'))) {
    let r = null;
    try { r = olddata.readCandidate(c); } catch (e) { r = null; }
    if (!r) { try { r = await readViaChromium(c); } catch (e) { r = null; } }
    if (!r) continue;
    oldCache.set(c.id, r.json);
    found.push({ id: c.id, name: c.name, saved_at: r.info.saved_at, counts: r.info.counts, company: r.info.company });
  }
  found.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
  return found;
}

async function readOld(id) {
  if (oldCache.has(id)) return oldCache.get(id);
  const c = olddata.candidates(app.getPath('appData')).find((x) => x.id === id);
  if (!c) throw new Error('not found');
  const r = olddata.readCandidate(c) || (await readViaChromium(c));
  if (!r) throw new Error('not found');
  oldCache.set(id, r.json);
  return r.json;
}

/* ------------------------------------------------------------------ updates */
function newer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function backupBeforeUpdate() {
  try { backend.app.backup.backupNow({ reason: 'pre-update' }); } catch (e) { /* the regular daily backup still exists */ }
}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { if (updateState.state !== 'downloaded') updateState = { state: 'checking' }; });
  autoUpdater.on('update-available', (info) => { updateState = { state: 'available', version: info.version }; });
  autoUpdater.on('update-not-available', () => { updateState = { state: 'none' }; });
  autoUpdater.on('error', (err) => { if (updateState.state !== 'downloaded') updateState = { state: 'error', error: String((err && err.message) || err) }; });
  autoUpdater.on('update-downloaded', async (info) => {
    updateState = { state: 'downloaded', version: info.version };
    backupBeforeUpdate();
    const s = S();
    const r = await dialog.showMessageBox(mainWin || undefined, {
      type: 'info', title: s.update_title, message: s.update_ready(info.version), detail: s.update_detail,
      buttons: [s.restart_now, s.later], defaultId: 0, cancelId: 1,
    });
    if (r.response === 0) {
      quitting = true;
      await closeBackend();
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline: try again later */ });
  setTimeout(check, 10000);
  setInterval(check, 4 * 3600 * 1000);
}

async function checkUpdates() {
  if (!autoUpdater || !app.isPackaged) return { state: 'dev' };
  if (updateState.state === 'downloaded') return updateState;
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    if (v && newer(v, app.getVersion())) return { state: 'available', version: v };
    return { state: 'none', version: app.getVersion() };
  } catch (e) {
    return { state: 'error', error: e.message || String(e) };
  }
}

/* ------------------------------------------------------------------ closing */
async function closeBackend() {
  if (!backend) return;
  const b = backend;
  backend = { ...b, close: async () => {} };
  try { await b.close(); } catch (e) { /* ignore */ }
}

function relaunch() {
  quitting = true;
  closeBackend().finally(() => { app.relaunch(); app.exit(0); });
}

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  closeBackend().finally(() => app.quit());
});

app.on('will-quit', () => { [...tempRoots].forEach(removeTemp); });

app.on('window-all-closed', () => { app.quit(); });
