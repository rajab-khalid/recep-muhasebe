// Barcode SVG generator: EAN-13 for valid 12/13-digit codes, Code 128 (B/C) for everything else.
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const STOP = 106;

/** encode text as Code 128 symbol values: set C for all-digit even-length codes, otherwise set B */
function code128Values(text) {
  const s = String(text);
  const vals = [];
  if (/^\d+$/.test(s) && s.length % 2 === 0 && s.length >= 4) {
    vals.push(START_C);
    for (let i = 0; i < s.length; i += 2) vals.push(Number(s.substr(i, 2)));
  } else {
    vals.push(START_B);
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      vals.push(code >= 32 && code <= 127 ? code - 32 : 31); // unsupported characters become "?"
    }
  }
  let sum = vals[0];
  for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
  vals.push(sum % 103);
  vals.push(STOP);
  return vals;
}

function code128Modules(text) {
  let bits = '';
  for (const v of code128Values(text)) {
    const w = C128[v];
    for (let k = 0; k < w.length; k++) bits += (k % 2 === 0 ? '1' : '0').repeat(Number(w[k]));
  }
  return bits;
}

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function eanCheckDigit(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export function isEan13(code) {
  return /^\d{13}$/.test(code) && eanCheckDigit(code.slice(0, 12)) === code[12];
}

function ean13Modules(code) {
  const par = EAN_PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? EAN_L : EAN_G)[Number(code[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(code[i])];
  bits += '101';
  return bits;
}

/** generate an in-store EAN-13 (prefix 2 = for internal use) */
export function generateEan13() {
  const base = '2' + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const d12 = base.slice(0, 12);
  return d12 + eanCheckDigit(d12);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/**
 * SVG string. opts: { height (px in viewBox units), showText, quiet (modules) }
 */
export function barcodeSvg(code, { height = 50, showText = true, quiet = 10 } = {}) {
  const text = String(code || '').trim();
  if (!text) return '';
  let bits;
  let ean = false;
  if (/^\d{12}$/.test(text)) { bits = ean13Modules(text + eanCheckDigit(text)); ean = true; } else if (isEan13(text)) { bits = ean13Modules(text); ean = true; } else bits = code128Modules(text);
  const total = bits.length + quiet * 2;
  const fs = 11;
  const textH = showText ? fs + 4 : 0;
  let rects = '';
  let run = 0;
  for (let i = 0; i <= bits.length; i++) {
    if (bits[i] === '1') { run++; continue; }
    if (run) {
      const x = quiet + i - run;
      // EAN guard bars are slightly longer
      const isGuard = ean && (x - quiet < 3 || (x - quiet >= 45 && x - quiet < 50) || x - quiet >= 92);
      rects += `<rect x="${x}" y="0" width="${run}" height="${height + (isGuard && showText ? 5 : 0)}"/>`;
      run = 0;
    }
  }
  const label = showText ? `<text x="${total / 2}" y="${height + fs + 2}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" letter-spacing="1">${esc(ean && text.length === 12 ? text + eanCheckDigit(text) : text)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height + textH}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g>${label}</svg>`;
}
