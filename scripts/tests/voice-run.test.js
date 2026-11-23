'use strict';
// The voice worker host and the voice service, with fake child processes and fake downloads. A real-engine test is in voice-real.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHost } = require('../../desktop/voice/host');
const { createVoiceService } = require('../../desktop/voice/service');
const { createCache } = require('../../desktop/voice/cache');
const { loadVoiceCatalog } = require('../../desktop/voice/catalog');
const { wavBytes } = require('../../desktop/voice/worker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-voice-'));

// A fake worker process that speaks the same messages as worker.js.
function fakeFork(log, behave = {}) {
  return (file, args, opts) => {
    const c = new EventEmitter(); c.killed = false; c.sent = [];
    c.send = m => {
      c.sent.push(m);
      setImmediate(() => {
        if (m.type === 'init') c.emit('message', behave.initFail ? { type: 'error', message: 'boom' } : { type: 'ready' });
        if (m.type === 'speak' && !behave.hang) {
          if (behave.fail) c.emit('message', { type: 'error', id: m.id, message: 'no sound' });
          else { fs.writeFileSync(m.out, wavBytes(new Float32Array(2400), 24000)); c.emit('message', { type: 'done', id: m.id, ms: 5, seconds: 0.1 }); }
        }
      });
    };
    c.kill = () => { c.killed = true; };
    log.push({ file, opts, c });
    if (!behave.silent) setImmediate(() => c.emit('message', { type: 'hello' }));
    return c;
  };
}
const SPEC = { key: 'kokoro-en', wrapperDir: '/w', platformDir: '/p', kind: 'kokoro', packDir: '/k', threads: 2 };

test('the host starts the worker with Electron as plain Node, loads the model once and makes the files in order', async () => {
  const log = [], d = tmp();
  const h = createHost({ fork: fakeFork(log), execPath: '/app/study-desk', workerPath: '/w.js' });
  const a = h.speak(SPEC, { text: 'one', sid: 3, speed: 1, lang: 'en', out: path.join(d, '1.wav') });
  const b = h.speak(SPEC, { text: 'two', sid: 3, speed: 1, lang: 'en', out: path.join(d, '2.wav') });
  await Promise.all([a, b]);
  assert.strictEqual(log.length, 1, 'one worker for two requests');
  assert.strictEqual(log[0].opts.env.ELECTRON_RUN_AS_NODE, '1'); assert.strictEqual(log[0].opts.execPath, '/app/study-desk');
  const types = log[0].c.sent.map(m => m.type + (m.text ? ':' + m.text : ''));
  assert.deepStrictEqual(types, ['init', 'speak:one', 'speak:two']);
  assert.deepStrictEqual(log[0].c.sent[0], { type: 'init', wrapperDir: '/w', kind: 'kokoro', packDir: '/k', threads: 2 });
  assert.ok(fs.existsSync(path.join(d, '1.wav')) && fs.existsSync(path.join(d, '2.wav')));
  assert.strictEqual(h.loaded(), 'kokoro-en');
  h.stop();
});

test('asking for another voice pack restarts the worker with that pack', async () => {
  const log = [], d = tmp(); const h = createHost({ fork: fakeFork(log) });
  await h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') });
  await h.speak({ ...SPEC, key: 'supertonic-3', kind: 'supertonic' }, { text: 'b', sid: 0, speed: 1, lang: 'tr', out: path.join(d, 'b.wav') });
  assert.strictEqual(log.length, 2); assert.ok(log[0].c.killed); assert.strictEqual(h.loaded(), 'supertonic-3'); h.stop();
});

test('a worker error rejects only that request; stopping rejects waiting requests as cancelled', async () => {
  const log = [], d = tmp(); const h = createHost({ fork: fakeFork(log, { fail: true }) });
  await assert.rejects(() => h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') }), e => e.kind === 'engine' && /no sound/.test(e.message));
  h.stop();
  const log2 = []; const h2 = createHost({ fork: fakeFork(log2, { hang: true }) });
  const p = h2.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'x.wav') });
  setTimeout(() => h2.stop(), 20);
  await assert.rejects(() => p, e => e.kind === 'cancelled');
  assert.ok(!h2.running());
});

test('a worker that never starts, or dies while starting, gives a clear error and is cleaned up', async () => {
  const timers = []; const log = [];
  const h = createHost({ fork: fakeFork(log, { silent: true }), setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: () => {} });
  const p = h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: '/x' });
  await new Promise(r => setImmediate(r));
  const start = timers.find(t => t[1] === 120000); assert.ok(start, 'a start timeout exists'); start[0]();
  await assert.rejects(() => p, /too long to start/); assert.ok(log[0].c.killed);
  const log2 = []; const h2 = createHost({ fork: (f, a, o) => { const c = fakeFork(log2, { silent: true })(f, a, o); setImmediate(() => c.emit('exit', 1)); return c; } });
  await assert.rejects(() => h2.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: '/x' }), /stopped/);
  assert.ok(!h2.running());
});

test('the worker is stopped after it has been idle', async () => {
  const log = [], d = tmp(); const timers = [];
  const h = createHost({ fork: fakeFork(log), setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimeout: t => { t.cleared = true; } });
  await h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') });
  const idle = timers.filter(t => t.ms === 300000 && !t.cleared); assert.strictEqual(idle.length, 1); idle[0].fn();
  assert.ok(log[0].c.killed && !h.running());
});

test('the cache keeps the newest files and removes the oldest when it is too big', async () => {
  const d = tmp(); const c = createCache(d, { maxBytes: 250 });
  for (const [n, age] of [['a', 300], ['b', 200], ['c', 100]]) { const f = c.file(n); fs.writeFileSync(f, Buffer.alloc(100)); const t = new Date(Date.now() - age * 1000); fs.utimesSync(f, t, t); }
  await c.prune();
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['b.wav', 'c.wav']);
  await c.clear(); assert.ok(!fs.existsSync(d));
});

// ---- service ------------------------------------------------------------------------------------------------------
function svc(o = {}) {
  const dataDir = tmp(), catalog = loadVoiceCatalog(), hostCalls = [], studioCalls = [];
  const host = { loaded: () => '', stop() { this.stopped = (this.stopped || 0) + 1; }, async speak(spec, req) { hostCalls.push([spec, req]); if (o.hostDelay) await o.hostDelay(req); fs.writeFileSync(req.out, wavBytes(new Float32Array(480), 24000)); return { ms: 1 }; } };
  const studio = { async detect() { return o.studio || { found: false, voices: [] }; }, async speak(a) { studioCalls.push(a); if (a.signal && o.studioWait) await o.studioWait(a.signal); return wavBytes(new Float32Array(48), 24000); } };
  const prog = [];
  const s = createVoiceService({ dataDir, catalog, hardware: o.hardware || { platform: 'win32', arch: 'x64' }, host, studio, cache: createCache(path.join(dataDir, 'voice', 'cache')), download: o.download, extract: o.extract, sign: async () => {}, onProgress: p => prog.push(p) });
  return { s, dataDir, catalog, hostCalls, studioCalls, prog };
}
function markInstalled(dataDir, catalog, ids) {
  const { enginePaths, packDir } = require('../../desktop/voice/install');
  const e = enginePaths(dataDir, catalog, { platform: 'win32', arch: 'x64' });
  fs.mkdirSync(e.platformDir, { recursive: true }); fs.writeFileSync(path.join(e.platformDir, 'sherpa-onnx.node'), 'n'); fs.writeFileSync(e.marker, '{}');
  for (const id of ids) { const d = packDir(dataDir, catalog.packs.find(p => p.id === id)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'installed.json'), '{}'); }
}
const ASK = { source: 'pack', packId: 'kokoro-en', voiceId: 'af_heart', text: 'Hello there.', speed: 1, lang: 'en' };

test('status lists the packs with their voices, licences and install state, and any VoiceStudio found', async () => {
  const r = svc({ studio: { found: true, voices: [{ id: 'a', name: 'A' }] } }); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  const st = await r.s.status();
  assert.strictEqual(st.available, true); assert.strictEqual(st.engine.installed, true);
  assert.deepStrictEqual(st.packs.map(p => [p.id, p.installed]), [['kokoro-en', true], ['supertonic-3', false]]);
  assert.ok(st.packs[0].license.name && st.packs[0].voices[0].name && !('sid' in st.packs[0].voices[0]), 'the page never sees internal ids');
  assert.deepStrictEqual(st.studio, { found: true, voices: [{ id: 'a', name: 'A' }] });
  assert.strictEqual((await svc({ hardware: { platform: 'linux', arch: 'x64' } }).s.status()).available, false);
});

test('speaking makes the sound with the right voice id, then answers the same line from the cache', async () => {
  const r = svc(); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  const a = await r.s.speak(ASK); assert.strictEqual(a.cached, false); assert.strictEqual(a.wav.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(r.hostCalls.length, 1); assert.strictEqual(r.hostCalls[0][1].sid, 3); assert.strictEqual(r.hostCalls[0][0].key, 'kokoro-en');
  const b = await r.s.speak(ASK); assert.strictEqual(b.cached, true); assert.strictEqual(r.hostCalls.length, 1);
  await r.s.speak({ ...ASK, speed: 1.2 }); assert.strictEqual(r.hostCalls.length, 2, 'another speed is another sound');
  assert.ok(!fs.readdirSync(path.join(r.dataDir, 'voice', 'cache')).some(n => n.endsWith('.part')));
});

test('requests that cannot work are refused with a plain reason before the engine is touched', async () => {
  const r = svc(); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  const refused = async (patch, re) => { await assert.rejects(() => r.s.speak({ ...ASK, ...patch }), e => re.test(e.message) && ['bad', 'engine'].includes(e.kind)); };
  await refused({ text: '   ' }, /nothing to say/); await refused({ text: 'x'.repeat(1001) }, /too long/);
  await refused({ voiceId: 'nobody' }, /not in the list/); await refused({ packId: 'nope' }, /not in the list/);
  await refused({ lang: 'tr' }, /does not speak/); await refused({ packId: 'supertonic-3', voiceId: 'v1', lang: 'tr' }, /not installed/);
  assert.strictEqual(r.hostCalls.length, 0);
  const { s } = svc({ hardware: { platform: 'linux', arch: 'x64' } }); await assert.rejects(() => s.speak(ASK), /not installed/);
});

test('speed is kept inside a safe range and text spacing is tidied', async () => {
  const r = svc(); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  await r.s.speak({ ...ASK, speed: 9, text: ' Hi \n  there ' }); assert.strictEqual(r.hostCalls[0][1].speed, 1.6); assert.strictEqual(r.hostCalls[0][1].text, 'Hi there');
  await r.s.speak({ ...ASK, speed: 0.1, text: 'Low' }); assert.strictEqual(r.hostCalls[1][1].speed, 0.6);
});

test('stopping cancels the lines being made', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const r = svc({ hostDelay: () => gate }); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  const p = r.s.speak(ASK); setTimeout(() => r.s.cancelSpeak(), 10);
  await assert.rejects(() => p, e => e.kind === 'cancelled'); release();
  assert.ok(!fs.readdirSync(path.join(r.dataDir, 'voice', 'cache')).some(n => n.endsWith('.wav')), 'a stopped line is not cached');
});

test('VoiceStudio is used only when it is running and has the voice; its sound is cached too', async () => {
  const r = svc({ studio: { found: true, voices: [{ id: 'alloy', name: 'Alloy' }] } }); await r.s.status();
  const a = await r.s.speak({ source: 'studio', voiceId: 'alloy', text: 'Hi', speed: 1 }); assert.strictEqual(a.cached, false);
  const b = await r.s.speak({ source: 'studio', voiceId: 'alloy', text: 'Hi', speed: 1 }); assert.strictEqual(b.cached, true); assert.strictEqual(r.studioCalls.length, 1);
  await assert.rejects(() => r.s.speak({ source: 'studio', voiceId: 'other', text: 'Hi', speed: 1 }), /does not have that voice/);
  const none = svc(); await none.s.status(); await assert.rejects(() => none.s.speak({ source: 'studio', voiceId: 'alloy', text: 'Hi', speed: 1 }), /not running/);
});

test('installing a voice downloads the engine and the pack, reports progress, and a second install is refused while one runs', async () => {
  const base = tmp(); const sizes = [];
  const mk = (name, files) => { const src = path.join(base, 's-' + name); for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), b); } const o = path.join(base, name); require('node:child_process').execFileSync('tar', ['-czf', o, '-C', src, '.']); return o; };
  const cat = loadVoiceCatalog(), pack = cat.packs[0];
  const tars = { wrap: mk('w.tgz', { 'package/a.js': 'x' }), plat: mk('p.tgz', { 'package/sherpa-onnx.node': 'n' }), pack: mk('k.tgz', { [pack.dir + '/model.int8.onnx']: 'm' }) };
  let release; const gate = new Promise(r => { release = r; });
  const download = async o => { sizes.push(o.sizeBytes); const t = o.url.includes('node/-/') ? tars.wrap : o.url.includes('registry') ? tars.plat : tars.pack; await gate; fs.copyFileSync(t, o.destPath); o.onProgress(o.sizeBytes, o.sizeBytes); };
  const r = svc({ download });
  const first = r.s.install({ packId: 'kokoro-en' });
  await new Promise(x => setTimeout(x, 20));
  await assert.rejects(() => r.s.install({ packId: 'supertonic-3' }), /already being installed/);
  assert.strictEqual((await r.s.status()).installing, 'kokoro-en');
  release(); const out = await first;
  assert.strictEqual(out.packs[0].installed, true);
  assert.ok(r.prog.length && r.prog.every(p => p.packId === 'kokoro-en' && p.total > 0 && p.done <= p.total) && r.prog[r.prog.length - 1].done === r.prog[r.prog.length - 1].total);
  assert.strictEqual((await r.s.status()).installing, '');
  await assert.rejects(() => r.s.install({ packId: 'nope' }), /not in the list/);
});

test('a cancelled or failed download is reported with its kind, and removing a voice deletes its files', async () => {
  const fail = code => async () => { throw Object.assign(new Error('x ' + code), { code }); };
  for (const [code, kind] of [['cancelled', 'cancelled'], ['checksum', 'checksum'], ['disk', 'disk'], ['network', 'network'], ['host', 'bad']]) {
    const r = svc({ download: fail(code) }); await assert.rejects(() => r.s.install({ packId: 'kokoro-en' }), e => e.kind === kind, code);
    assert.strictEqual((await r.s.status()).installing, '', 'a failure frees the installer');
  }
  const r = svc(); markInstalled(r.dataDir, r.catalog, ['kokoro-en', 'supertonic-3']);
  const out = await r.s.remove({ packId: 'kokoro-en' }); assert.deepStrictEqual(out.packs.map(p => p.installed), [false, true]);
  await r.s.removeAll(); assert.ok(!fs.existsSync(path.join(r.dataDir, 'voice')));
});

// ---- review fixes: the worker host ----
const lateTimers = () => { const t = []; return { t, setTimeout: (fn, ms) => { const x = { fn, ms, cleared: false, unref() {} }; t.push(x); return x; }, clearTimeout: x => { if (x) x.cleared = true; } }; };
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('a model that fails to load rejects at once with the worker\'s own message, not after the start timeout', async () => {
  const log = [], d = tmp(), tm = lateTimers();
  const h = createHost({ fork: fakeFork(log, { initFail: true }), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout });
  await assert.rejects(h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') }), /boom/);
  assert.strictEqual(h.running(), false, 'the broken worker is gone');
  assert.ok(tm.t.every(x => x.cleared), 'no start timer is left to fire later');
});

test('stopping while the model is still loading frees the queue: the next request starts a fresh worker at once', async () => {
  const log = [], d = tmp(), tm = lateTimers();
  const h = createHost({ fork: fakeFork(log, { silent: true }), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout });
  const first = h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') });
  first.catch(() => {});
  await flush();
  h.stop();
  await assert.rejects(first, e => e.kind === 'cancelled');
  assert.ok(tm.t.every(x => x.cleared), 'the start timer was cleared by stop');
  const log2 = log.length;
  const second = h.speak(SPEC, { text: 'b', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'b.wav') });
  second.catch(() => {});
  await flush();
  assert.strictEqual(log.length, log2 + 1, 'a new worker was started without waiting for the old timer');
  h.stop();
});

test('requests still waiting in the queue when stop is called are dropped, not run by a new worker', async () => {
  const log = [], d = tmp();
  const h = createHost({ fork: fakeFork(log, { hang: true }) });
  const a = h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') });
  const b = h.speak(SPEC, { text: 'b', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'b.wav') });
  a.catch(() => {}); b.catch(() => {});
  await flush();
  h.stop();
  await assert.rejects(a, e => e.kind === 'cancelled');
  await assert.rejects(b, e => e.kind === 'cancelled');
  await flush();
  assert.strictEqual(log.length, 1, 'no second worker was started for the dropped request');
  assert.strictEqual(h.running(), false);
});

test('the idle timer is paused while a request runs, and a send that throws leaves no stray timer', async () => {
  const log = [], d = tmp(), tm = lateTimers();
  const h = createHost({ fork: fakeFork(log), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout });
  await h.speak(SPEC, { text: 'a', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'a.wav') });
  const idle1 = tm.t.filter(x => x.ms === 5 * 60 * 1000 && !x.cleared);
  assert.strictEqual(idle1.length, 1, 'idle timer armed after the request');
  const slow = h.speak(SPEC, { text: 'b', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'b.wav') });
  await flush();
  await slow;
  assert.ok(idle1[0].cleared, 'the old idle timer was cleared when the next request began');
  // a worker whose channel just closed: send throws
  const log2 = [], tm2 = lateTimers();
  const h2 = createHost({ fork: (f, a, o) => { const c = fakeFork(log2)(f, a, o); const s = c.send; c.send = m => { if (m.type === 'speak') throw new Error('ERR_IPC_CHANNEL_CLOSED'); return s(m); }; return c; }, setTimeout: tm2.setTimeout, clearTimeout: tm2.clearTimeout });
  await assert.rejects(h2.speak(SPEC, { text: 'c', sid: 0, speed: 1, lang: 'en', out: path.join(d, 'c.wav') }), /stopped|could not/i);
  assert.ok(tm2.t.filter(x => x.ms === 120000).every(x => x.cleared), 'the speak timer was cleared');
  h2.stop();
});

// ---- review fixes: service and cache ----
test('a stopped line leaves no half-written file behind, even when the worker finishes it after the stop', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const r = svc({ hostDelay: () => gate }); markInstalled(r.dataDir, r.catalog, ['kokoro-en']);
  const p = r.s.speak(ASK); setTimeout(() => r.s.cancelSpeak(), 10);
  await assert.rejects(() => p, e => e.kind === 'cancelled');
  release(); await flush(); await new Promise(res => setTimeout(res, 30));
  assert.deepStrictEqual(fs.readdirSync(path.join(r.dataDir, 'voice', 'cache')), [], 'no .part and no .wav left');
});

test('VoiceStudio sound is stored whole or not at all, and a cache file that vanished is simply made again', async () => {
  const r = svc({ studio: { found: true, voices: [{ id: 'alloy', name: 'Alloy' }] } }); await r.s.status();
  const ask = { source: 'studio', voiceId: 'alloy', text: 'Hi', speed: 1 };
  await r.s.speak(ask);
  const dir = path.join(r.dataDir, 'voice', 'cache');
  assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), 'no .part left');
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n)); // the cache pruned it between has() and read
  const again = await r.s.speak(ask);
  assert.strictEqual(again.wav.toString('latin1', 0, 4), 'RIFF');
  // a cache that cannot be written must not stop the voice
  fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, 'a file where the folder should be');
  const third = await r.s.speak({ ...ask, text: 'Different words' });
  assert.strictEqual(third.wav.toString('latin1', 0, 4), 'RIFF');
});

test('pruning removes old unfinished .part files but leaves a fresh one that is still being written', async () => {
  const d = tmp(); const c = createCache(d, { maxBytes: 1e9 });
  fs.writeFileSync(path.join(d, 'old.wav.part'), 'x'); fs.writeFileSync(path.join(d, 'new.wav.part'), 'x');
  const t = new Date(Date.now() - 3600 * 1000); fs.utimesSync(path.join(d, 'old.wav.part'), t, t);
  await c.prune();
  assert.deepStrictEqual(fs.readdirSync(d), ['new.wav.part']);
});
