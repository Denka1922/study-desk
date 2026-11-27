#!/usr/bin/env node
'use strict';
// One-time check of the Turkish listening model (ufakzeka-kulak, on Hugging Face). Run it from GitHub Actions
// ("Verify Turkish listener" workflow), because the model files are not reachable from every network.
//
// It does three things:
//   1. downloads the model's four files from ONE pinned version, measures each and prints the catalog entry to add;
//   2. makes Turkish speech with the app's own Turkish voice (Supertonic) and plays it through the app's own listener
//      (voice-activity detection + recogniser, with the model's gain and context settings);
//   3. scores the words (word error rate) and fails if the result is poor.
//
//   node scripts/verify-turkish-listener.js [work-folder]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = 'ufakai/ufakzeka-kulak';
const SUBDIR = 'sherpa-onnx-tdt';
const HF_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
const SENTENCES = [
  'Fotosentezde bitkiler ışık enerjisini kimyasal enerjiye dönüştürür.',
  'Üçgenin iç açıları toplamı yüz seksen derecedir.',
  'Türkiye\'nin başkenti Ankara\'dır ve ülkenin ortasında yer alır.',
  'Hipotenüs dik üçgenin en uzun kenarıdır.',
  'Su yüz derecede kaynar ve sıfır derecede donar.',
  'Hücre canlıların en küçük yapı birimidir.',
  'Bu konuyu kendi cümlelerimle anlatmaya çalışacağım.',
  'Cumhuriyet bin dokuz yüz yirmi üçte ilan edildi.',
];
const MAX_WER = 0.5;

// ---- pure helpers (tested) ----
function normalizeTr(s) {
  return String(s).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase().replace(/['’‘`´]/g, '').replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function wer(ref, hyp) {
  const r = String(ref).split(' ').filter(Boolean), h = String(hyp).split(' ').filter(Boolean);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return Math.min(1, d[r.length][h.length] / r.length);
}
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.max(1, Math.round(x.length * to / from)), y = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) { const p = i * k, a = Math.floor(p), f = p - a; y[i] = x[Math.min(x.length - 1, a)] * (1 - f) + x[Math.min(x.length - 1, a + 1)] * f; }
  return y;
}
function buildEntry(commit, files) {
  if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error('A full commit id is needed to pin the model, not "' + commit + '"');
  if (files.length !== HF_FILES.length || !HF_FILES.every(f => files.some(x => x.file === f))) throw new Error('Every model files entry is needed: ' + HF_FILES.join(', '));
  const ordered = HF_FILES.map(f => files.find(x => x.file === f));
  return {
    id: 'kulak-tr', title: 'Turkish', blurb: 'Understands Turkish speech. Works without internet.', kind: 'transducer', languages: ['tr'],
    license: { name: 'Apache-2.0', url: 'https://huggingface.co/' + REPO }, credit: 'ufakzeka-kulak by ufak AI', tune: { gain: 8, context: 0.3 },
    files: ordered.map(f => ({ file: f.file, url: 'https://huggingface.co/' + REPO + '/resolve/' + commit + '/' + SUBDIR + '/' + f.file, sizeBytes: f.sizeBytes, sha256: f.sha256 })),
    sizeBytes: ordered.reduce((a, f) => a + f.sizeBytes, 0), dir: 'kulak-tr',
  };
}

// ---- the check itself ----
async function fetchOk(url) { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(r.status + ' ' + url); return r; }
async function download(url, dest) {
  const r = await fetchOk(url), h = crypto.createHash('sha256'); let n = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of r.body) { h.update(chunk); n += chunk.length; if (!out.write(chunk)) await new Promise(res => out.once('drain', res)); }
  await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
  return { sizeBytes: n, sha256: h.digest('hex') };
}
function pcm(file) { // 16-bit mono WAV as written by the voice worker
  const b = fs.readFileSync(file), rate = b.readUInt32LE(24), n = (b.length - 44) >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768; return { rate, x };
}

async function main() {
  const work = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tr-')));
  fs.mkdirSync(work, { recursive: true });
  const { loadVoiceCatalog } = require('../desktop/voice/catalog');
  const { ensurePack, ensureVad } = require('../desktop/voice/install');
  const { downloadVerified } = require('../desktop/ai/download');
  const { createHost } = require('../desktop/voice/host');
  const { createEarsHost } = require('../desktop/voice/ears-host');
  const catalog = loadVoiceCatalog();

  console.log('1/4 finding the model version');
  const meta = await (await fetchOk('https://huggingface.co/api/models/' + REPO)).json();
  const commit = meta.sha; console.log('    version', commit, '| licence tag:', (meta.tags || []).filter(t => /license/i.test(t)).join(',') || '(none listed)');
  const tree = await (await fetchOk('https://huggingface.co/api/models/' + REPO + '/tree/' + commit + '/' + SUBDIR)).json();
  const have = tree.map(t => path.basename(t.path)); const missing = HF_FILES.filter(f => !have.includes(f));
  if (missing.length) throw new Error('The model folder does not contain ' + missing.join(', ') + '. It has: ' + have.join(', '));

  console.log('2/4 downloading and measuring the model files');
  const model = path.join(work, 'kulak-tr'); fs.mkdirSync(model, { recursive: true });
  const files = [];
  for (const f of HF_FILES) { const m = await download('https://huggingface.co/' + REPO + '/resolve/' + commit + '/' + SUBDIR + '/' + f, path.join(model, f)); files.push({ file: f, ...m }); console.log('    ' + f.padEnd(20), String(m.sizeBytes).padStart(10), 'bytes', m.sha256); }
  const entry = buildEntry(commit, files);

  console.log('3/4 installing the engine and the Turkish voice, and making Turkish speech');
  const npmDir = path.join(work, 'npm'); fs.mkdirSync(npmDir, { recursive: true });
  const ver = catalog.engine.version, plat = 'sherpa-onnx-' + (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch;
  if (!fs.existsSync(path.join(npmDir, 'node_modules', plat))) execFileSync('npm', ['install', '--prefix', npmDir, '--no-audit', '--no-fund', '--ignore-scripts', 'sherpa-onnx-node@' + ver, plat + '@' + ver], { stdio: 'inherit', shell: process.platform === 'win32' });
  const wrapperDir = path.join(npmDir, 'node_modules', 'sherpa-onnx-node'), platformDir = path.join(npmDir, 'node_modules', plat);
  const sup = catalog.packs.find(p => p.id === 'supertonic-3');
  const supDir = await ensurePack({ dataDir: work, pack: sup, download: downloadVerified, onProgress: () => {} });
  const vadFile = await ensureVad({ dataDir: work, catalog, download: downloadVerified });

  const tts = createHost({}), speech = [];
  try {
    for (let i = 0; i < SENTENCES.length; i++) {
      const out = path.join(work, 's' + i + '.wav');
      await tts.speak({ key: 'supertonic-3', kind: 'supertonic', wrapperDir, platformDir, packDir: supDir, threads: 2 }, { text: SENTENCES[i], sid: 0, speed: 1, lang: 'tr', out });
      const { rate, x } = pcm(out); speech.push(resample(x, rate, 16000));
    }
  } finally { tts.stop(); }

  console.log('4/4 listening to it');
  const results = {};
  for (const [name, tune] of [['with the model settings (gain 8, context 0.3 s)', entry.tune], ['without them', {}]]) {
    const ears = createEarsHost({}), rows = []; let ms = 0, secs = 0;
    try {
      for (let i = 0; i < SENTENCES.length; i++) {
        const t0 = Date.now(), r = await ears.speak({ key: 'kulak-tr-' + name.length, kind: 'transducer', wrapperDir, platformDir, packDir: model, threads: 2, init: { vadModel: vadFile, tune } }, { samples: speech[i] });
        ms += Date.now() - t0; secs += speech[i].length / 16000; rows.push({ said: SENTENCES[i], heard: r.text, wer: wer(normalizeTr(SENTENCES[i]), normalizeTr(r.text)) });
      }
    } finally { ears.stop(); }
    const avg = rows.reduce((a, r) => a + r.wer, 0) / rows.length; results[name] = { avg, rows, realtime: ms / 1000 / secs };
    console.log('\n  ' + name + ': word error rate ' + (avg * 100).toFixed(1) + '%, ' + (ms / 1000 / secs).toFixed(2) + ' s of work per second of speech');
    for (const r of rows) console.log('   ' + (r.wer * 100).toFixed(0).padStart(3) + '%  said:  ' + r.said + '\n        heard: ' + r.heard);
  }
  const main = results['with the model settings (gain 8, context 0.3 s)'];
  const report = { commit, entry, results, passed: main.avg <= MAX_WER };
  fs.writeFileSync(path.join(work, 'turkish-listener-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\n===== CATALOG ENTRY (add to "ears.packs" in desktop/voice/catalog.json) =====');
  console.log(JSON.stringify(entry, null, 2));
  console.log('===== END CATALOG ENTRY =====');
  if (!report.passed) { console.error('The Turkish model scored ' + (main.avg * 100).toFixed(1) + '% word errors (limit ' + MAX_WER * 100 + '%). Do not ship it.'); process.exitCode = 1; }
  else console.log('\nPASS: ' + (main.avg * 100).toFixed(1) + '% word errors on clean Turkish speech (limit ' + MAX_WER * 100 + '%).');
}

module.exports = { normalizeTr, wer, resample, buildEntry, SENTENCES, HF_FILES };
if (require.main === module) main().catch(e => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
