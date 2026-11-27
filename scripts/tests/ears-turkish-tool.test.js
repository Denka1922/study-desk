'use strict';
// The one-time check of the Turkish listening model (scripts/verify-turkish-listener.js, run from GitHub Actions because the
// model is on Hugging Face). These are the parts that need no network: scoring, and the catalog entry it prints.
const test = require('node:test');
const assert = require('node:assert');
const { normalizeTr, wer, buildEntry, resample, SENTENCES, HF_FILES } = require('../verify-turkish-listener');
const { loadVoiceCatalog, validateVoiceCatalog } = require('../../desktop/voice/catalog');

test('Turkish text is compared without capitals, marks or circumflexes, and İ/I keep their Turkish lower case', () => {
  assert.strictEqual(normalizeTr('Işık, su VE İlk! "Kâğıt" — (bu) Ankara\'dır.'), 'ışık su ve ilk kağıt bu ankaradır');
  assert.strictEqual(normalizeTr('  '), '');
});

test('word error rate counts replaced, missing and extra words', () => {
  assert.strictEqual(wer('a b c', 'a b c'), 0);
  assert.strictEqual(wer('a b c', 'a x c'), 1 / 3);
  assert.strictEqual(wer('a b c', 'a c'), 1 / 3);
  assert.strictEqual(wer('a b', 'a b c d'), 1);
  assert.strictEqual(wer('a b', ''), 1);
  assert.strictEqual(wer('', ''), 0);
});

test('resampling keeps the length in proportion and the sound the same shape', () => {
  const x = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 44100 * 2 * Math.PI * 440));
  const y = resample(x, 44100, 16000);
  assert.ok(Math.abs(y.length - 16000) <= 1); assert.ok(Math.abs(y[100] - Math.sin(100 / 16000 * 2 * Math.PI * 440)) < 0.02);
  assert.strictEqual(resample(x, 16000, 16000), x);
});

test('the printed catalog entry is pinned to one version of the model and passes the catalog rules', () => {
  const files = HF_FILES.map((f, i) => ({ file: f, sizeBytes: 1000 * (i + 1), sha256: String(i).repeat(64).slice(0, 64) }));
  const e = buildEntry('c0ffee'.repeat(6) + 'abcd', files);
  assert.strictEqual(e.id, 'kulak-tr'); assert.deepStrictEqual(e.languages, ['tr']); assert.strictEqual(e.kind, 'transducer'); assert.deepStrictEqual(e.tune, { gain: 8, context: 0.3 });
  assert.strictEqual(e.sizeBytes, 10000); assert.match(e.files[0].url, /^https:\/\/huggingface\.co\/ufakai\/ufakzeka-kulak\/resolve\/c0ffee[0-9a-f]+\/sherpa-onnx-tdt\/encoder\.int8\.onnx$/);
  assert.strictEqual(e.license.name, 'Apache-2.0');
  const c = JSON.parse(JSON.stringify(loadVoiceCatalog())); c.ears.packs.push(e);
  assert.deepStrictEqual(validateVoiceCatalog(c), []);
  assert.throws(() => buildEntry('main', files), /commit/i, 'a moving name like "main" is not a version');
  assert.throws(() => buildEntry('c0ffee'.repeat(6) + 'abcd', files.slice(1)), /files/i);
});

test('the test sentences are Turkish, with numbers written as words (as the model writes them)', () => {
  assert.ok(SENTENCES.length >= 8 && SENTENCES.every(s => s.length > 20 && !/\d/.test(s)));
  assert.ok(SENTENCES.some(s => /[ğışİöüç]/.test(s)));
});

test('the Turkish check workflow is manual-only, read-only, uses pinned actions and needs no secrets', () => {
  const y = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '.github', 'workflows', 'verify-turkish-listener.yml'), 'utf8');
  assert.match(y, /on:\s*\n\s*workflow_dispatch:\s*\n/); assert.ok(!/push:|pull_request|schedule:/.test(y));
  assert.match(y, /permissions:\s*\{\}/); assert.match(y, /contents: read/); assert.ok(!/secrets\./.test(y) && !/write/.test(y.replace(/read-only/g, '')));
  for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, 'every action is pinned to a full commit: ' + m[1]);
  assert.match(y, /verify-turkish-listener\.js/);
});
