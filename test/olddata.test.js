'use strict';
/* Reading the previous program's browser storage (a small LevelDB folder written by Chromium). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const od = require('../desktop/olddata');

const FIXTURE = path.join(__dirname, 'fixtures', 'old-localstorage');

test('reads the newest saved state from a Chromium LevelDB folder', () => {
  const json = od.readLevelDb(FIXTURE);
  assert.ok(json, 'state found');
  const raw = JSON.parse(json);
  assert.equal(raw.savedAt, '2026-09-13T17:00:13.177Z');
  assert.equal(raw.data.settings.companyName, 'جوانکاریا شێروان');
  assert.equal(raw.data.products[0].name, 'Paspas — پاسپاس');
});

test('finds the old folder under the application data folder and leaves it unchanged', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-appdata-'));
  const ldb = path.join(appData, 'recep-muhasebe', 'Local Storage', 'leveldb');
  fs.mkdirSync(ldb, { recursive: true });
  for (const f of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, f), path.join(ldb, f));
  fs.writeFileSync(path.join(ldb, 'LOCK'), '');
  const before = fs.readdirSync(ldb).map((f) => `${f}:${fs.statSync(path.join(ldb, f)).size}`).join(',');
  const found = od.candidates(appData);
  assert.equal(found.length, 1);
  const r = od.readCandidate(found[0]);
  assert.equal(r.info.counts.products, 1);
  assert.equal(r.info.company, 'جوانکاریا شێروان');
  const after = fs.readdirSync(ldb).map((f) => `${f}:${fs.statSync(path.join(ldb, f)).size}`).join(',');
  assert.equal(after, before);
  fs.rmSync(appData, { recursive: true, force: true });
});

test('snappy: literal and copy elements', () => {
  // "abcabcabcabc": literal "abc" then a 9-byte copy at offset 3
  const src = Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03]);
  assert.equal(od.snappy(src).toString(), 'abcabcabcabc');
});
