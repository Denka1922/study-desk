'use strict';
// Speech input ("ears") in the main process: catalog entries, recogniser settings, the background listener, installing the
// models, and the service the page talks to. Fake processes and fake downloads; a real-engine test is in ears-real.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadVoiceCatalog, validateVoiceCatalog } = require('../../desktop/voice/catalog');
const { recogConfig, vadConfig, prepareSegment, REQUIRED, EAR_KINDS, RATE } = require('../../desktop/voice/ears-config');
const { hearAll } = require('../../desktop/voice/ears-worker');
const { createHost } = require('../../desktop/voice/host');
const { createVoiceService } = require('../../desktop/voice/service');
const { createCache } = require('../../desktop/voice/cache');
const { ensureVad, ensureEarsPack, vadFile, packDir, enginePaths } = require('../../desktop/voice/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ears-'));
const clone = o => JSON.parse(JSON.stringify(o));
const HEX = 'a'.repeat(64);

// ---- catalog -------------------------------------------------------------------------------------------------------
test('the shipped catalog lists the listening models, each pinned and with its licence and credit, and is valid', () => {
  const c = loadVoiceCatalog();
  assert.deepStrictEqual(validateVoiceCatalog(c), []);
  assert.ok(c.ears.vad.sha256.length === 64 && c.ears.vad.url.startsWith('https://github.com/'));
  assert.deepStrictEqual(c.ears.packs.map(p => p.id), ['parakeet-en', 'moonshine-en']);
  for (const p of c.ears.packs) { assert.ok(p.license.name && p.credit && p.languages.includes('en'), p.id); assert.ok(EAR_KINDS.includes(p.kind)); }
  assert.match(c.ears.packs[0].license.name, /CC-BY/, 'the English model needs credit and says so');
});

test('listening entries with a bad model kind, address, hash, name, size or a clashing id are rejected', () => {
  const bad = fn => { const c = clone(loadVoiceCatalog()); fn(c); return validateVoiceCatalog(c).join('|'); };
  assert.match(bad(c => { c.ears.packs[0].kind = 'shell'; }), /parakeet-en.*kind/);
  assert.match(bad(c => { c.ears.packs[0].url = 'https://evil.example/x.tar.bz2'; }), /parakeet-en.*url/);
  assert.match(bad(c => { c.ears.packs[0].sha256 = 'abc'; }), /parakeet-en.*sha256/);
  assert.match(bad(c => { c.ears.packs[0].dir = '../x'; }), /parakeet-en.*dir/);
  assert.match(bad(c => { c.ears.packs[0].credit = ''; }), /parakeet-en.*credit/);
  assert.match(bad(c => { c.ears.packs[0].languages = ['english']; }), /parakeet-en.*languages/);
  assert.match(bad(c => { c.ears.packs[1].id = 'parakeet-en'; }), /parakeet-en.*id/);
  assert.match(bad(c => { c.ears.packs[1].id = 'kokoro-en'; }), /kokoro-en.*id/, 'a listening pack may not share an id with a voice pack');
  assert.match(bad(c => { c.ears.vad.sha256 = 'x'; }), /voice activity/);
  assert.match(bad(c => { delete c.ears.vad; }), /voice activity/);
  assert.match(bad(c => { c.ears.packs[0].tune = { gain: 1000 }; }), /parakeet-en.*tune/);
  assert.match(bad(c => { c.ears.packs[0].tune = { context: 5 }; }), /parakeet-en.*tune/);
});

test('a pack made of single files is accepted when every file is pinned and the sizes add up, and refused otherwise', () => {
  const f = (file, n) => ({ file, url: 'https://huggingface.co/x/y/resolve/main/' + file, sizeBytes: n, sha256: HEX });
  const tr = () => ({ id: 'kulak-tr', title: 'Turkish', blurb: 'b', kind: 'transducer', languages: ['tr'], license: { name: 'Apache-2.0', url: 'https://x.example/' }, credit: 'c', tune: { gain: 8, context: 0.3 },
    files: [f('encoder.int8.onnx', 10), f('decoder.int8.onnx', 5), f('joiner.int8.onnx', 3), f('tokens.txt', 2)], sizeBytes: 20, dir: 'kulak-tr' });
  const run = fn => { const c = clone(loadVoiceCatalog()); const p = tr(); fn(p); c.ears.packs.push(p); return validateVoiceCatalog(c).join('|'); };
  assert.strictEqual(run(() => {}), '');
  assert.match(run(p => { p.sizeBytes = 21; }), /kulak-tr.*size/);
  assert.match(run(p => { p.files[0].file = '../encoder.onnx'; }), /kulak-tr.*file/);
  assert.match(run(p => { p.files[1].url = 'http://huggingface.co/x/decoder.int8.onnx'; }), /kulak-tr/);
  assert.match(run(p => { p.files.pop(); }), /kulak-tr.*files/, 'a pack must list every file its model needs');
  assert.match(run(p => { p.files.push(f('tokens.txt', 1)); }), /kulak-tr.*files/, 'no repeated file names');
});

// ---- recogniser settings ---------------------------------------------------------------------------------------------
test('each kind of listening model gets the settings the engine expects', () => {
  const d = path.join('/m', 'pack');
  const p = recogConfig('nemo-ctc', d, 3).modelConfig;
  assert.deepStrictEqual(p.nemoCtc, { model: path.join(d, 'model.int8.onnx') }); assert.strictEqual(p.tokens, path.join(d, 'tokens.txt')); assert.strictEqual(p.numThreads, 3); assert.strictEqual(p.provider, 'cpu'); assert.strictEqual(p.debug, false);
  const m = recogConfig('moonshine', d, 2).modelConfig;
  assert.deepStrictEqual(m.moonshine, { encoder: path.join(d, 'encoder_model.ort'), mergedDecoder: path.join(d, 'decoder_model_merged.ort') });
  assert.ok(!('preprocessor' in m.moonshine) && !('uncachedDecoder' in m.moonshine), 'only the newer Moonshine layout is used');
  const t = recogConfig('transducer', d, 2).modelConfig;
  assert.deepStrictEqual(t.transducer, { encoder: path.join(d, 'encoder.int8.onnx'), decoder: path.join(d, 'decoder.int8.onnx'), joiner: path.join(d, 'joiner.int8.onnx') });
  assert.strictEqual(t.modelType, 'nemo_transducer');
  assert.strictEqual(recogConfig('nemo-ctc', d, 2).featConfig.sampleRate, RATE);
  assert.throws(() => recogConfig('shell', d, 2), /unknown/);
  assert.deepStrictEqual(Object.keys(REQUIRED).sort(), [...EAR_KINDS].sort());
  const v = vadConfig('/v/silero_vad.onnx');
  assert.strictEqual(v.sileroVad.model, '/v/silero_vad.onnx'); assert.strictEqual(v.sampleRate, RATE); assert.strictEqual(v.sileroVad.windowSize, 512);
});

test('a speech segment is cut with a little audio on each side and made louder only when the model needs it', () => {
  const all = Float32Array.from({ length: RATE }, (_, i) => i / RATE / 10); // 1 s ramp
  const seg = { start: 8000, samples: all.slice(8000, 12000) };
  const plain = prepareSegment(all, seg, {});
  assert.strictEqual(plain.length, 4000); assert.strictEqual(plain[0], all[8000]);
  const ctx = prepareSegment(all, seg, { context: 0.25 });
  assert.strictEqual(ctx.length, 4000 + 8000, '0.25 s before and after'); assert.strictEqual(ctx[0], all[4000]);
  const edge = prepareSegment(all, { start: 0, samples: all.slice(0, 2000) }, { context: 0.25 });
  assert.strictEqual(edge.length, 2000 + 4000, 'nothing is added before the start of the recording');
  const loud = prepareSegment(all, seg, { gain: 8 });
  assert.ok(Math.abs(loud[10] - all[8010] * 8) < 1e-6); assert.strictEqual(all[8010] === loud[10], false, 'the recording itself is not changed');
});

// A stand-in for the engine: the VAD finds the segments we give it, the recogniser answers per segment.
function fakeSherpa(segments, answers, seen = {}) {
  return {
    Vad: class { constructor(cfg, secs) { seen.vad = [cfg, secs]; this.q = []; }
      acceptWaveform(x) { seen.fed = (seen.fed || 0) + x.length; if (!this.done && seen.fed >= seen.all) { this.q.push(...segments); this.done = true; } }
      isEmpty() { return !this.q.length; } front() { return this.q[0]; } pop() { this.q.shift(); } flush() {} },
    OfflineRecognizer: class { constructor(cfg) { seen.rec = cfg; } createStream() { const s = { chunks: [] }; s.acceptWaveform = a => { s.chunks.push(a); }; return s; }
      decode(s) { seen.decoded = (seen.decoded || []).concat([s.chunks[0]]); s.text = answers.shift(); } getResult(s) { return { text: s.text }; } },
  };
}
test('the listener finds the speech, reads each part and joins the text; silence gives an empty answer', () => {
  const x = new Float32Array(RATE * 3).fill(0.1), seen = { all: x.length };
  const segs = [{ start: 1000, samples: new Float32Array(3000) }, { start: 20000, samples: new Float32Array(5000) }];
  const sh = fakeSherpa(segs, [' Hello there. ', 'Second part.'], seen);
  const out = hearAll({ sherpa: sh, recognizer: new sh.OfflineRecognizer({}), vadModel: '/v.onnx', samples: x, tune: {} });
  assert.strictEqual(out.text, 'Hello there. Second part.');
  assert.strictEqual(seen.fed, x.length + RATE, 'a second of quiet is added at the end so the last words are closed');
  const none = { all: 10 };
  const r2 = { createStream() { throw new Error('nothing to read'); } };
  assert.strictEqual(hearAll({ sherpa: fakeSherpa([], [], none), recognizer: r2, vadModel: '/v.onnx', samples: new Float32Array(5), tune: {} }).text, '');
});

test('the gain and context settings of a pack reach the recogniser', () => {
  const x = new Float32Array(RATE).fill(0.01), seen = { all: x.length };
  const segs = [{ start: 8000, samples: new Float32Array(2000).fill(0.01) }];
  const sh = fakeSherpa(segs, ['Merhaba.'], seen);
  const out = hearAll({ sherpa: sh, recognizer: new sh.OfflineRecognizer({}), vadModel: '/v.onnx', samples: x, tune: { gain: 8, context: 0.3 } });
  assert.strictEqual(out.text, 'Merhaba.');
  const got = seen.decoded[0];
  assert.strictEqual(got.sampleRate, RATE); assert.strictEqual(got.samples.length, 2000 + 2 * Math.round(0.3 * RATE)); assert.ok(Math.abs(got.samples[0] - 0.08) < 1e-6);
});

// ---- the background listener (same host as the voice worker) -------------------------------------------------------
function fakeEarsFork(log, behave = {}) {
  return (file, args, opts) => {
    const c = new EventEmitter(); c.sent = []; c.killed = false;
    c.send = m => { c.sent.push(m); setImmediate(() => {
      if (m.type === 'init') c.emit('message', { type: 'ready' });
      if (m.type === 'hear' && !behave.hang) c.emit('message', behave.fail ? { type: 'error', id: m.id } : { type: 'done', id: m.id, text: 'hi ' + m.samples.length, ms: 3, seconds: 1 });
    }); };
    c.kill = () => { c.killed = true; };
    log.push({ file, opts, c });
    setImmediate(() => c.emit('message', { type: 'hello' }));
    return c;
  };
}
const SPEC = { key: 'parakeet-en', wrapperDir: '/w', platformDir: '/p', kind: 'nemo-ctc', packDir: '/k', threads: 2, init: { vadModel: '/v.onnx', tune: { gain: 1 } } };
const HOST_OPTS = { requestType: 'hear', serialization: 'advanced', noun: 'listener', failed: 'The listener could not understand this.', slow: 'Listening took too long.' };

test('the host can run the listener: advanced messages, its own request type, extra start settings and its own wording', async () => {
  const log = []; const h = createHost({ fork: fakeEarsFork(log), execPath: '/app/x', workerPath: '/e.js', ...HOST_OPTS });
  const out = await h.speak(SPEC, { samples: new Float32Array(160) });
  assert.strictEqual(out.text, 'hi 160');
  assert.strictEqual(log[0].opts.serialization, 'advanced'); assert.strictEqual(log[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepStrictEqual(log[0].c.sent[0], { type: 'init', wrapperDir: '/w', kind: 'nemo-ctc', packDir: '/k', threads: 2, vadModel: '/v.onnx', tune: { gain: 1 } });
  assert.strictEqual(log[0].c.sent[1].type, 'hear'); assert.ok(log[0].c.sent[1].samples instanceof Float32Array);
  h.stop();
  await assert.rejects(() => createHost({ fork: fakeEarsFork([], { fail: true }), ...HOST_OPTS }).speak(SPEC, { samples: new Float32Array(1) }), /listener could not understand/);
  const g = createHost({ fork: fakeEarsFork([]), ...HOST_OPTS }); const p = g.speak(SPEC, { samples: new Float32Array(1) }); g.stop();
  await assert.rejects(p, /listener was stopped/);
});

test('the voice host keeps its old behaviour when no listener options are given', async () => {
  const log = []; const h = createHost({ fork: (f, a, o) => { const c = fakeEarsFork(log)(f, a, o); const send = c.send; c.send = m => { if (m.type === 'speak') setImmediate(() => c.emit('message', { type: 'done', id: m.id })); else send(m); c.sent.push(m); }; return c; } });
  await h.speak({ key: 'k', wrapperDir: '/w', platformDir: '/p', kind: 'kokoro', packDir: '/k', threads: 1 }, { text: 'a', sid: 0, speed: 1, lang: 'en', out: '/x' });
  assert.deepStrictEqual(log[0].c.sent[0], { type: 'init', wrapperDir: '/w', kind: 'kokoro', packDir: '/k', threads: 1 });
  assert.ok(!('serialization' in log[0].opts) || log[0].opts.serialization === undefined);
  h.stop();
});

// ---- installing ------------------------------------------------------------------------------------------------------
function tarOf(base, name, files) {
  const src = path.join(base, 's-' + name); for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), b); }
  const o = path.join(base, name); require('node:child_process').execFileSync('tar', ['-czf', o, '-C', src, '.']); return o;
}
test('the voice-activity file is downloaded once into its own folder and checked against its pinned hash', async () => {
  const d = tmp(), c = loadVoiceCatalog(), calls = [];
  const download = async o => { calls.push(o); fs.writeFileSync(o.destPath, 'silero'); o.onProgress(o.sizeBytes, o.sizeBytes); };
  const f = await ensureVad({ dataDir: d, catalog: c, download });
  assert.strictEqual(f, vadFile(d)); assert.strictEqual(fs.readFileSync(f, 'utf8'), 'silero');
  assert.strictEqual(calls[0].sha256, c.ears.vad.sha256); assert.strictEqual(calls[0].url, c.ears.vad.url);
  await ensureVad({ dataDir: d, catalog: c, download }); assert.strictEqual(calls.length, 1, 'already there');
});

test('a listening model in a tar file is unpacked and must contain the files its kind needs', async () => {
  const d = tmp(), c = loadVoiceCatalog(), pack = c.ears.packs[0];
  const good = tarOf(d, 'g.tgz', { [pack.dir + '/model.int8.onnx']: 'm', [pack.dir + '/tokens.txt']: 't' });
  const dir = await ensureEarsPack({ dataDir: d, pack, download: async o => { fs.copyFileSync(good, o.destPath); o.onProgress(1, 1); } });
  assert.ok(fs.existsSync(path.join(dir, 'model.int8.onnx')) && fs.existsSync(path.join(dir, 'installed.json')));
  const d2 = tmp(), thin = tarOf(d2, 't.tgz', { [pack.dir + '/model.int8.onnx']: 'm' });
  await assert.rejects(() => ensureEarsPack({ dataDir: d2, pack, download: async o => { fs.copyFileSync(thin, o.destPath); } }), /expected files/);
  assert.ok(!fs.existsSync(path.join(packDir(d2, pack), 'installed.json')), 'an incomplete model is never marked as installed');
});

test('a listening model made of single files downloads each one with its own hash and reports one running total', async () => {
  const d = tmp(), f = (file, n) => ({ file, url: 'https://huggingface.co/x/y/resolve/main/' + file, sizeBytes: n, sha256: HEX });
  const pack = { id: 'kulak-tr', kind: 'transducer', files: [f('encoder.int8.onnx', 10), f('decoder.int8.onnx', 5), f('joiner.int8.onnx', 3), f('tokens.txt', 2)], sizeBytes: 20, dir: 'kulak-tr' };
  const got = [], prog = [];
  const dir = await ensureEarsPack({ dataDir: d, pack, onProgress: (done, total) => prog.push([done, total]), download: async o => { got.push([path.basename(o.destPath), o.sha256, o.sizeBytes]); fs.writeFileSync(o.destPath, 'x'); o.onProgress(o.sizeBytes, o.sizeBytes); } });
  assert.deepStrictEqual(got.map(g => g[0]), ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']); assert.ok(got.every(g => g[1] === HEX));
  assert.deepStrictEqual(prog[prog.length - 1], [20, 20]); assert.ok(prog.every((p, i) => i === 0 || p[0] >= prog[i - 1][0]));
  assert.ok(REQUIRED.transducer.every(n => fs.existsSync(path.join(dir, n))) && fs.existsSync(path.join(dir, 'installed.json')));
  const d3 = tmp(); await assert.rejects(() => ensureEarsPack({ dataDir: d3, pack, download: async o => { if (o.destPath.endsWith('joiner.int8.onnx')) throw Object.assign(new Error('x'), { code: 'checksum' }); fs.writeFileSync(o.destPath, 'x'); } }), e => e.code === 'checksum');
  assert.ok(!fs.existsSync(packDir(d3, pack)), 'a failed download leaves no half model behind');
});

// ---- service -------------------------------------------------------------------------------------------------------
function svc(o = {}) {
  const dataDir = tmp(), catalog = loadVoiceCatalog(), calls = [], earsCalls = [];
  const host = { loaded: () => '', stop() {}, async speak() { throw new Error('not used'); } };
  const earsHost = { loaded: () => o.loaded || '', stopped: 0, stop() { this.stopped++; }, async speak(spec, req) { earsCalls.push([spec, req]); if (o.hearWait) await o.hearWait(); return o.reply || { text: 'hello world', ms: 2, seconds: 1 }; } };
  const studio = { async detect() { return { found: false, voices: [] }; } };
  const prog = [];
  const s = createVoiceService({ dataDir, catalog, hardware: o.hardware || { platform: 'win32', arch: 'x64' }, host, earsHost, studio, cache: createCache(path.join(dataDir, 'voice', 'cache')), download: o.download, extract: o.extract, sign: async () => {}, onProgress: p => prog.push(p) });
  return { s, dataDir, catalog, earsCalls, earsHost, prog, calls };
}
function installEngine(dataDir, catalog) {
  const e = enginePaths(dataDir, catalog, { platform: 'win32', arch: 'x64' });
  fs.mkdirSync(e.platformDir, { recursive: true }); fs.writeFileSync(path.join(e.platformDir, 'sherpa-onnx.node'), 'n'); fs.writeFileSync(e.marker, '{}');
}
function installEars(dataDir, catalog, ids, vad = true) {
  installEngine(dataDir, catalog);
  if (vad) { fs.mkdirSync(path.dirname(vadFile(dataDir)), { recursive: true }); fs.writeFileSync(vadFile(dataDir), 'v'); }
  for (const id of ids) { const p = catalog.ears.packs.find(x => x.id === id); fs.mkdirSync(packDir(dataDir, p), { recursive: true }); fs.writeFileSync(path.join(packDir(dataDir, p), 'installed.json'), '{}'); }
}
const SOUND = (n = RATE * 2) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 0.2);

test('status lists the listening models with size, licence, credit and whether each one is ready', async () => {
  const r = svc(); installEars(r.dataDir, r.catalog, ['parakeet-en']);
  const st = await r.s.status();
  assert.deepStrictEqual(st.listen.packs.map(p => [p.id, p.installed]), [['parakeet-en', true], ['moonshine-en', false]]);
  assert.ok(st.listen.packs[0].license.name && st.listen.packs[0].credit && st.listen.packs[0].sizeBytes > 1e6 && st.listen.packs[0].languages[0] === 'en');
  assert.strictEqual(st.listen.ready, true, 'one installed model and the voice-activity file is enough to listen');
  assert.ok(!('url' in st.listen.packs[0]) && !('sha256' in st.listen.packs[0]), 'the page never sees download details');
  const none = svc(); installEars(none.dataDir, none.catalog, [], false);
  assert.strictEqual((await none.s.status()).listen.ready, false);
});

test('listening gives back the text, using the right model, language and settings, and the page never sends a path', async () => {
  const r = svc(); installEars(r.dataDir, r.catalog, ['parakeet-en']);
  const out = await r.s.hear({ packId: 'parakeet-en', lang: 'en', samples: SOUND() });
  assert.deepStrictEqual(out, { text: 'hello world' });
  const [spec, req] = r.earsCalls[0];
  assert.strictEqual(spec.key, 'parakeet-en'); assert.strictEqual(spec.kind, 'nemo-ctc'); assert.ok(spec.packDir.endsWith('parakeet-en')); assert.strictEqual(spec.init.vadModel, vadFile(r.dataDir)); assert.deepStrictEqual(spec.init.tune, {});
  assert.ok(req.samples instanceof Float32Array && req.samples.length === RATE * 2);
});

test('listening requests that cannot work are refused with a plain reason before the engine is touched', async () => {
  const r = svc(); installEars(r.dataDir, r.catalog, ['parakeet-en']);
  const ok = { packId: 'parakeet-en', lang: 'en', samples: SOUND() };
  const refuse = async (a, re, kind) => { await assert.rejects(() => r.s.hear(a), e => re.test(e.message) && e.kind === kind, re + ''); };
  await refuse({ ...ok, packId: 'nope' }, /not in the list/, 'bad');
  await refuse({ ...ok, lang: 'tr' }, /does not understand that language/, 'bad');
  await refuse({ ...ok, packId: 'moonshine-en' }, /not installed yet/, 'engine');
  await refuse({ ...ok, samples: new Float32Array(100) }, /too short/, 'bad');
  await refuse({ ...ok, samples: new Float32Array(RATE * 121) }, /too long/, 'bad');
  await refuse({ ...ok, samples: Float32Array.from({ length: RATE }, (_, i) => (i === 7 ? NaN : 0.1)) }, /not valid/, 'bad');
  await refuse({ ...ok, samples: [1, 2, 3] }, /not valid/, 'bad');
  await refuse({ ...ok, samples: new Float64Array(RATE) }, /not valid/, 'bad');
  assert.strictEqual(r.earsCalls.length, 0);
  const lin = svc({ hardware: { platform: 'linux', arch: 'x64' } }); await assert.rejects(() => lin.s.hear(ok), e => e.kind === 'engine');
  const no = svc(); installEars(no.dataDir, no.catalog, ['parakeet-en'], false);
  await assert.rejects(() => no.s.hear(ok), /not installed yet/);
});

test('a very quiet or empty recording gives an empty text, not an error, and long text is trimmed to a safe size', async () => {
  const r = svc({ reply: { text: '   ', ms: 1 } }); installEars(r.dataDir, r.catalog, ['parakeet-en']);
  assert.deepStrictEqual(await r.s.hear({ packId: 'parakeet-en', lang: 'en', samples: SOUND() }), { text: '' });
  const big = svc({ reply: { text: 'word '.repeat(5000) } }); installEars(big.dataDir, big.catalog, ['parakeet-en']);
  const t = (await big.s.hear({ packId: 'parakeet-en', lang: 'en', samples: SOUND() })).text;
  assert.ok(t.length <= 4000 && !/\s$/.test(t));
});

test('stopping listening stops the listener and frees the page at once', async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = svc({ hearWait: () => gate }); installEars(r.dataDir, r.catalog, ['parakeet-en']);
  const p = r.s.hear({ packId: 'parakeet-en', lang: 'en', samples: SOUND() });
  await new Promise(x => setTimeout(x, 10));
  r.s.cancelHear();
  await assert.rejects(p, e => e.kind === 'cancelled'); assert.ok(r.earsHost.stopped >= 1); release();
});

test('installing a listening model downloads the engine, the voice-activity file and the model, and shares the one-install-at-a-time rule', async () => {
  const base = tmp(), cat = loadVoiceCatalog(), pack = cat.ears.packs[1], got = [];
  const tars = { wrap: tarOf(base, 'w.tgz', { 'package/a.js': 'x' }), plat: tarOf(base, 'p.tgz', { 'package/sherpa-onnx.node': 'n' }),
    pack: tarOf(base, 'k.tgz', { [pack.dir + '/encoder_model.ort']: 'e', [pack.dir + '/decoder_model_merged.ort']: 'd', [pack.dir + '/tokens.txt']: 't' }) };
  let release; const gate = new Promise(res => { release = res; });
  const download = async o => { got.push(o.url); await gate; if (o.url.endsWith('silero_vad.onnx')) fs.writeFileSync(o.destPath, 'v'); else fs.copyFileSync(o.url.includes('node/-/') ? tars.wrap : o.url.includes('registry') ? tars.plat : tars.pack, o.destPath); o.onProgress(o.sizeBytes, o.sizeBytes); };
  const r = svc({ download });
  const first = r.s.listenInstall({ packId: 'moonshine-en' });
  await new Promise(x => setTimeout(x, 20));
  await assert.rejects(() => r.s.listenInstall({ packId: 'parakeet-en' }), /already being installed/);
  await assert.rejects(() => r.s.install({ packId: 'kokoro-en' }), /already being installed/, 'a voice install waits for the listening install too');
  assert.strictEqual((await r.s.status()).installing, 'moonshine-en');
  release(); const out = await first;
  assert.deepStrictEqual(out.listen.packs.map(p => p.installed), [false, true]); assert.strictEqual(out.listen.ready, true);
  assert.ok(got.some(u => u.endsWith('silero_vad.onnx')) && got.some(u => u.includes('moonshine')));
  assert.ok(r.prog.length && r.prog.every(p => p.packId === 'moonshine-en' && p.total > 0 && p.done <= p.total) && r.prog[r.prog.length - 1].done === r.prog[r.prog.length - 1].total);
  assert.strictEqual((await r.s.status()).installing, '');
  await assert.rejects(() => r.s.listenInstall({ packId: 'kokoro-en' }), /not in the list/, 'a voice id is not a listening model');
});

test('a failed or cancelled listening download reports its kind, frees the installer, and removing a model deletes its files', async () => {
  for (const [code, kind] of [['cancelled', 'cancelled'], ['checksum', 'checksum'], ['disk', 'disk'], ['network', 'network']]) {
    const r = svc({ download: async () => { throw Object.assign(new Error('x'), { code }); } });
    await assert.rejects(() => r.s.listenInstall({ packId: 'parakeet-en' }), e => e.kind === kind, code);
    assert.strictEqual((await r.s.status()).installing, '');
  }
  const r = svc({ loaded: 'parakeet-en' }); installEars(r.dataDir, r.catalog, ['parakeet-en', 'moonshine-en']);
  const out = await r.s.listenRemove({ packId: 'parakeet-en' });
  assert.deepStrictEqual(out.listen.packs.map(p => p.installed), [false, true]); assert.ok(r.earsHost.stopped >= 1, 'a loaded model is unloaded first');
  await assert.rejects(() => r.s.listenRemove({ packId: 'nope' }), /not in the list/);
});

test('the ready-made listener host runs the listening worker with advanced messages and its own wording', async () => {
  const { createEarsHost } = require('../../desktop/voice/ears-host');
  const log = []; const h = createEarsHost({ fork: fakeEarsFork(log), execPath: '/app/x' });
  const out = await h.speak(SPEC, { samples: new Float32Array(8) });
  assert.strictEqual(out.text, 'hi 8'); assert.ok(log[0].file.endsWith('ears-worker.js')); assert.strictEqual(log[0].opts.serialization, 'advanced');
  h.stop();
  const g = createEarsHost({ fork: fakeEarsFork([]) }); const p = g.speak(SPEC, { samples: new Float32Array(1) }); g.stop();
  await assert.rejects(p, /listener|Listening/i);
});
