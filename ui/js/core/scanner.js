// Camera barcode reading for the phone app. Android phones read codes themselves (BarcodeDetector); on the
// iPhone the bundled ZXing reader is loaded the first time it is needed. Nothing is shown inside the desktop
// program or on a computer without a touch screen.
import { html, useState, useEffect, useRef } from './h.js';
import { t } from './i18n.js';
import { Icon, openModal, isPhone, useBackCloses } from './ui.js';
import { useStore } from './store.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'];

/** the camera can be used here: the phone app (https), not the desktop program */
export function canScan() {
  if (window.desktop) return false;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  return isPhone() || window.matchMedia('(pointer: coarse)').matches;
}

let zxingLoad = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoad) {
    zxingLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing.min.js';
      s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('zxing')));
      s.onerror = () => { zxingLoad = null; reject(new Error('zxing')); };
      document.head.appendChild(s);
    });
  }
  return zxingLoad;
}

/** a reader: read(video) -> the code in the picture, or null */
async function makeReader() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const det = new window.BarcodeDetector({ formats });
        return {
          native: true,
          read: async (video) => { const r = await det.detect(video); return r && r.length ? String(r[0].rawValue || '') : null; },
        };
      }
    } catch (e) { /* use ZXing */ }
  }
  const Z = await loadZXing();
  const F = Z.BarcodeFormat;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    native: false,
    read: async (video) => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      // the middle of the picture, where the frame is drawn; a smaller picture is read faster
      const sw = Math.round(vw * 0.86);
      const sh = Math.min(vh, Math.round(vw * 0.5));
      const scale = Math.min(1, 800 / sw);
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      ctx.drawImage(video, Math.round((vw - sw) / 2), Math.round((vh - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height);
      try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
        return reader.decodeWithState(bmp).getText();
      } catch (e) { return null; } // nothing found in this picture
    },
  };
}

/* a short beep and a buzz when a code is read (the sound needs a tap first on the iPhone, see primeAudio) */
let audio = null;
function primeAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch (e) { audio = null; }
}
function beep() {
  try { if (navigator.vibrate) navigator.vibrate(45); } catch (e) { /* */ }
  try {
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'square';
    o.frequency.value = 1900;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.07);
  } catch (e) { /* */ }
}

/**
 * Full-screen camera view. Single mode closes with the code read; continuous mode (counting, quick sale) stays
 * open and hands every code to onCode (the same code again only after a short pause).
 */
function ScannerDialog({ close, continuous, onCode, title }) {
  useBackCloses(() => close(null));
  // the program locked itself (or someone locked it): the camera goes off
  const locked = useStore((s) => s.locked);
  useEffect(() => { if (locked) close(null); }, [locked]);
  const video = useRef(null);
  const stream = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(null); // null: the camera has no light
  const [last, setLast] = useState(null);
  const [typed, setTyped] = useState('');
  // continuous mode: the page may answer with what it did ({ ok, text }), shown under the camera picture
  const take = (code) => {
    beep();
    window.dispatchEvent(new Event('rm-activity')); // reading codes counts as using the program (idle lock)
    if (!continuous) { close(code); return; }
    const at = Date.now();
    setLast({ code, at, ok: true, text: null });
    Promise.resolve(onCode ? onCode(code) : null)
      .then((r) => { if (r && r.text) setLast((l) => (l && l.at === at ? { ...l, ok: r.ok !== false, text: r.text } : l)); })
      .catch(() => {});
  };
  useEffect(() => {
    let alive = true;
    let timer = null;
    let prev = '';
    let prevAt = 0;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (!alive) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream.current = s;
        const v = video.current;
        v.srcObject = s;
        try { await v.play(); } catch (e) { /* autoplay is allowed for a muted inline video */ }
        const track = s.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) setTorch(false);
        if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        const reader = await makeReader();
        if (!alive) return;
        setReady(true);
        const tick = async () => {
          if (!alive) return;
          let code = null;
          try { if (v.readyState >= 2) code = await reader.read(v); } catch (e) { /* try the next picture */ }
          if (!alive) return;
          if (code) {
            const now = Date.now();
            if (code !== prev || now - prevAt > 1600) {
              prev = code;
              prevAt = now;
              take(code);
              if (!continuous) return;
            }
          }
          timer = setTimeout(tick, reader.native ? 110 : 160);
        };
        tick();
      } catch (e) {
        const n = e && e.name;
        setErr(n === 'NotAllowedError' || n === 'SecurityError' ? t('scan.denied') : n === 'NotFoundError' || n === 'OverconstrainedError' ? t('scan.no_camera') : t('scan.failed'));
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (stream.current) stream.current.getTracks().forEach((tr) => tr.stop());
    };
  }, []);
  const toggleTorch = () => {
    const track = stream.current && stream.current.getVideoTracks()[0];
    if (!track) return;
    const on = !torch;
    track.applyConstraints({ advanced: [{ torch: on }] }).then(() => setTorch(on)).catch(() => setTorch(null));
  };
  const submitTyped = (e) => {
    e.preventDefault();
    const code = typed.trim();
    if (!code) return;
    setTyped('');
    take(code);
  };
  const fresh = last && Date.now() - last.at < 2500;
  return html`<div class="scan-screen" role="dialog" aria-modal="true" aria-label=${title || t('scan.title')}>
    <video ref=${video} playsinline muted autoplay></video>
    ${!err && html`<div class="scan-frame"><i class=${`scan-line ${ready ? '' : 'idle'}`}></i></div>`}
    <div class="scan-top">
      <button type="button" class="scan-round" onClick=${() => close(null)} aria-label=${t('common.close')}><${Icon} name="x" /></button>
      <div class="scan-title">${title || t('scan.title')}</div>
      ${torch !== null ? html`<button type="button" class=${`scan-round ${torch ? 'on' : ''}`} onClick=${toggleTorch} aria-label=${t('scan.light')} aria-pressed=${torch}><${Icon} name="flashlight" /></button>` : html`<span class="scan-round-space"></span>`}
    </div>
    <div class="scan-bottom">
      ${err ? html`<div class="scan-err">${err}</div>` : html`<div class="scan-hint">${ready ? t(continuous ? 'scan.hint_many' : 'scan.hint') : t('scan.starting')}</div>`}
      ${last && html`<div class=${`scan-last ${fresh ? 'fresh' : ''} ${last.ok ? '' : 'bad'}`} key=${last.at}><${Icon} name=${last.ok ? 'circle-check' : 'circle-x'} size="sm" />
        ${last.text ? html`<span dir="auto">${last.text}</span>` : html`<span class="ltr">${last.code}</span>`}</div>`}
      <form class="scan-type" onSubmit=${submitTyped}>
        <input class="input" value=${typed} onInput=${(e) => setTyped(e.target.value)} placeholder=${t('scan.type_ph')} inputmode="text" autocomplete="off" aria-label=${t('scan.type_ph')} />
        <button type="submit" class="btn primary" disabled=${!typed.trim()}>${t('common.ok')}</button>
      </form>
      ${continuous && html`<button type="button" class="btn scan-done" onClick=${() => close(null)}>${t('scan.done')}</button>`}
    </div>
  </div>`;
}

/** read one code with the camera: the code, or null when closed */
export function scanBarcode(opts = {}) {
  primeAudio();
  return openModal(ScannerDialog, { title: opts.title });
}

/** read codes one after another (counting, quick sale) until closed */
export function scanMany(onCode, opts = {}) {
  primeAudio();
  return openModal(ScannerDialog, { continuous: true, onCode, title: opts.title });
}

/**
 * Camera button next to a search or code box; shown only where a camera can be used.
 * onCode(code) gets each code read (always the latest handler of the page, so its data is current).
 */
export function ScanButton({ onCode, continuous, big, title, cls = '' }) {
  const fn = useRef(onCode);
  fn.current = onCode;
  if (!canScan()) return null;
  const open = () => {
    if (continuous) scanMany((c) => fn.current && fn.current(c), { title });
    else scanBarcode({ title }).then((c) => { if (c && fn.current) fn.current(c); });
  };
  return html`<button type="button" class=${`scan-btn ${big ? 'big' : ''} ${cls}`} onClick=${open} title=${title || t('scan.title')} aria-label=${title || t('scan.title')}>
    <${Icon} name="scan-barcode" /></button>`;
}
