'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCatalog } = require('../../desktop/ai/catalog');
const { createAiService } = require('../../desktop/ai/service');
const { DownloadError } = require('../../desktop/ai/download');
const { EngineError } = require('../../desktop/ai/engine');

const GiB = 1024 ** 3;
const hw = (gib, o = {}) => Object.assign({ platform: 'win32', arch: 'x64', totalRamBytes: gib * GiB, freeRamBytes: gib * GiB * 0.9, cores: 8, gpu: { present: false, vendor: 'unknown', name: '' }, appleSilicon: false }, o);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-svc-'));
async function err(p) { try { await p; } catch (e) { return e; } assert.fail('should have rejected'); }
const wait = ms => new Promise(r => setTimeout(r, ms));

// every dependency is a fake that records what it was asked
function rig(o = {}) {
  const dataDir = o.dataDir || path.join(tmp(), 'Öğrenci Çalışma ı ş');
  const r = { dataDir, hardware: o.hardware || hw(16), calls: { engineStart: [], engineStop: 0, install: [], download: [], chat: [], cli: [] }, exitCbs: [], running: false, signals: {} };
  r.engine = {
    start: async x => { r.calls.engineStart.push(x); if (r.failStart) throw new EngineError('could not start'); r.running = true; return { port: 4000 + r.calls.engineStart.length, token: 't'.repeat(40) }; },
    stop: async () => { r.calls.engineStop++; r.running = false; },
    running: () => r.running,
    onExit: cb => r.exitCbs.push(cb),
  };
  const deps = {
    dataDir, catalog: loadCatalog(),
    hardwareReader: o.hardwareReader ? async () => o.hardwareReader(r) : async () => r.hardware,
    engine: r.engine,
    engineInstaller: async x => { r.calls.install.push(x); if (x.onProgress) x.onProgress(5, 10); return { serverPath: '/fake/llama-server' }; },
    download: o.download || (async x => { r.calls.download.push(x); if (x.onProgress) x.onProgress(1, 2); fs.mkdirSync(path.dirname(x.destPath), { recursive: true }); fs.writeFileSync(x.destPath, 'model'); return { path: x.destPath }; }),
    chatLocal: o.chatLocal || (async x => { r.calls.chat.push(x); return { text: 'hi', cut: false, usage: { input: 3, output: 2, estimated: false } }; }),
    runCli: o.runCli || (async x => { r.calls.cli.push(x); return { text: 'cli says hi', cut: false, usage: { input: 3, output: 2, estimated: true } }; }),
    detectTools: async () => [{ id: 'codex', found: true }],
    freeBytes: async () => 50 * GiB,
    idleMs: o.idleMs || 60000,
    onProgress: p => { (r.progress = r.progress || []).push(p); },
  };
  r.svc = createAiService(deps);
  return r;
}
const REQ = (text = 'hello') => ({ mode: 'local', system: 'SYS', messages: [{ role: 'user', text }], maxTokens: 500, json: false });
const model9 = 'nemotron-nano-9b-v2', model4 = 'nemotron-3-nano-4b';

test('install refuses unknown, malformed and disabled models', async () => {
  const r = rig();
  for (const id of ['nope', '../x', 'qwen3-4b', 'glm-4.7-flash', '', undefined]) assert.strictEqual((await err(r.svc.install({ modelId: id, level: 'high' }))).kind, 'bad', String(id));
  assert.strictEqual((await err(r.svc.install({ modelId: model4, level: 'turbo' }))).kind, 'bad');
  assert.strictEqual(r.calls.download.length, 0);
});

test('install that does not fit the level says ram and suggests a smaller model', async () => {
  const r = rig({ hardware: hw(8) });
  const e = await err(r.svc.install({ modelId: model9, level: 'high' }));
  assert.strictEqual(e.kind, 'ram'); assert.strictEqual(e.suggestion.modelId, model4); assert.ok(e.message.length > 20);
  assert.strictEqual(r.calls.download.length, 0);
});

test('install fetches the engine then the model, reports progress and stores the model under dataDir/models', async () => {
  const r = rig();
  const res = await r.svc.install({ modelId: model9, level: 'high' });
  assert.strictEqual(res.modelId, model9);
  assert.strictEqual(r.calls.install.length, 1);
  const file = path.join(r.dataDir, 'models', loadCatalog().models.find(m => m.id === model9).file);
  assert.strictEqual(r.calls.download[0].destPath, file); assert.ok(fs.existsSync(file));
  assert.strictEqual(r.calls.download[0].sha256, loadCatalog().models.find(m => m.id === model9).sha256);
  assert.ok(r.progress.some(p => p.phase === 'engine') && r.progress.some(p => p.phase === 'model'));
  const st = await r.svc.localStatus();
  assert.deepStrictEqual(st.installed.map(m => m.modelId), [model9]); assert.strictEqual(st.running, null); assert.ok(st.diskFreeBytes > 0);
});

test('a second install while one is running is refused; cancel stops the first', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const r = rig({ download: async x => { await new Promise((res, rej) => { x.signal.addEventListener('abort', () => rej(new DownloadError('cancelled'))); gate.then(res); }); return { path: x.destPath }; } });
  const first = r.svc.install({ modelId: model4, level: 'high' });
  await wait(20);
  assert.strictEqual((await err(r.svc.install({ modelId: model4, level: 'high' }))).kind, 'bad');
  r.svc.cancelInstall();
  assert.strictEqual((await err(first)).kind, 'cancelled');
  release();
});

test('download and engine errors become the page kinds', async () => {
  for (const [code, kind] of [['disk', 'disk'], ['checksum', 'checksum'], ['network', 'network'], ['cancelled', 'cancelled']]) {
    const r = rig({ download: async () => { throw new DownloadError(code); } });
    assert.strictEqual((await err(r.svc.install({ modelId: model4, level: 'high' }))).kind, kind, code);
  }
  const bad = rig({}); // engine installer failure
  const s2 = createAiService(Object.assign({}, { dataDir: tmp(), catalog: loadCatalog(), hardwareReader: async () => hw(16), engine: bad.engine, engineInstaller: async () => { throw new EngineError('engine broke'); }, download: async () => ({}), chatLocal: async () => ({}), runCli: async () => ({}), detectTools: async () => [], freeBytes: async () => 1e12 }));
  assert.strictEqual((await err(s2.install({ modelId: model4, level: 'high' }))).kind, 'engine');
});

test('start needs an installed model, and a level change restarts the engine without deleting anything', async () => {
  const r = rig();
  assert.strictEqual((await err(r.svc.start({ modelId: model9, level: 'high' }))).kind, 'bad');
  await r.svc.install({ modelId: model9, level: 'high' });
  await r.svc.start({ modelId: model9, level: 'high' });
  assert.deepStrictEqual((await r.svc.localStatus()).running, { modelId: model9, level: 'high' });
  const first = r.calls.engineStart[0]; assert.strictEqual(first.level, 'high'); assert.ok(first.modelPath.endsWith(loadCatalog().models.find(m => m.id === model9).file)); assert.strictEqual(first.serverPath, '/fake/llama-server');
  await r.svc.start({ modelId: model9, level: 'xhigh' });
  assert.strictEqual(r.calls.engineStart.length, 2); assert.strictEqual(r.calls.engineStart[1].level, 'xhigh');
  assert.strictEqual((await r.svc.localStatus()).installed.length, 1);
  await r.svc.start({ modelId: model9, level: 'xhigh' }); // same again: nothing to do
  assert.strictEqual(r.calls.engineStart.length, 2);
});

test('when the installed model no longer fits a lower level, start says ram and recommend offers a smaller one (C9)', async () => {
  const r = rig();
  await r.svc.install({ modelId: model9, level: 'high' });
  const e = await err(r.svc.start({ modelId: model9, level: 'light' }));
  assert.strictEqual(e.kind, 'ram'); assert.strictEqual(e.suggestion.modelId, model4);
  const rec = await r.svc.recommend({ level: 'light', language: 'English' });
  assert.strictEqual(rec.ok, true); assert.strictEqual(rec.model.id, model4);
  assert.strictEqual(r.calls.engineStart.length, 0);
  assert.strictEqual((await r.svc.localStatus()).installed.length, 1, 'nothing deleted');
});

test('free memory is re-read at every start', async () => {
  const r = rig();
  await r.svc.install({ modelId: model9, level: 'high' });
  r.hardware = hw(16, { freeRamBytes: 3 * GiB });
  assert.strictEqual((await err(r.svc.start({ modelId: model9, level: 'high' }))).kind, 'ram');
  r.hardware = hw(16);
  await r.svc.start({ modelId: model9, level: 'high' });
  assert.strictEqual(r.calls.engineStart.length, 1);
});

test('recommend returns an upgrade when a higher level allows a bigger model', async () => {
  const c = loadCatalog(); c.models.find(m => m.id === 'glm-4.7-flash').enabled = true; c.models.find(m => m.id === 'glm-4.7-flash').sha256 = 'a'.repeat(64);
  const r = rig({ hardware: hw(32, { freeRamBytes: 28 * GiB }) });
  const svc = createAiService({ dataDir: r.dataDir, catalog: c, hardwareReader: async () => r.hardware, engine: r.engine, engineInstaller: async () => ({}), download: async () => ({}), chatLocal: async () => ({}), runCli: async () => ({}), detectTools: async () => [], freeBytes: async () => 1e12 });
  const rec = await svc.recommend({ level: 'high', language: 'English' });
  assert.strictEqual(rec.model.id, model9); assert.strictEqual(rec.upgrade.id, 'glm-4.7-flash');
  assert.strictEqual((await err(svc.recommend({ level: 'turbo', language: 'English' }))).kind, 'bad');
});

test('local chat starts the engine on first use, then reuses it', async () => {
  const r = rig();
  await r.svc.install({ modelId: model9, level: 'high' });
  const a = await r.svc.chat(REQ('one'));
  assert.deepStrictEqual(a.usage, { input: 3, output: 2, estimated: false }); assert.strictEqual(a.text, 'hi');
  await r.svc.chat(REQ('two'));
  assert.strictEqual(r.calls.engineStart.length, 1);
  const c = r.calls.chat[0]; assert.strictEqual(c.port, 4001); assert.strictEqual(c.token.length, 40); assert.strictEqual(c.system, 'SYS'); assert.strictEqual(c.json, false);
});

test('chat before any model is chosen is a plain error', async () => {
  const r = rig();
  assert.strictEqual((await err(r.svc.chat(REQ()))).kind, 'bad');
  assert.strictEqual((await err(r.svc.chat({ mode: 'weird', system: 's', messages: [], maxTokens: 5, json: false }))).kind, 'bad');
});

test('Review focus 2: a dead engine is restarted once for the next chat; if that fails the kind is engine', async () => {
  const r = rig();
  await r.svc.install({ modelId: model4, level: 'high' });
  await r.svc.chat(REQ());
  r.running = false; r.exitCbs.forEach(cb => cb(1)); // the program died by itself
  assert.strictEqual((await r.svc.localStatus()).running, null);
  await r.svc.chat(REQ());
  assert.strictEqual(r.calls.engineStart.length, 2);
  r.running = false; r.exitCbs.forEach(cb => cb(1)); r.failStart = true;
  assert.strictEqual((await err(r.svc.chat(REQ()))).kind, 'engine');
});

test('a connection error while the engine has died is reported as engine, not network', async () => {
  let n = 0;
  const r = rig({ chatLocal: async () => { n++; r.running = false; const e = new Error('Could not reach the local AI.'); e.kind = 'network'; throw e; } });
  await r.svc.install({ modelId: model4, level: 'high' });
  const e = await err(r.svc.chat(REQ()));
  assert.strictEqual(e.kind, 'engine'); assert.strictEqual(n, 1);
});

test('a conversation that cannot fit the context is refused with a plain message', async () => {
  const r2 = rig({ hardware: hw(16) });
  await r2.svc.install({ modelId: model4, level: 'medium' });
  const e = await err(r2.svc.chat(Object.assign(REQ('x'.repeat(40000)), { maxTokens: 2000 })));
  assert.strictEqual(e.kind, 'bad'); assert.match(e.message, /too long/i);
  assert.strictEqual(r2.calls.chat.length, 0);
});

test('cancelChat stops the active request only', async () => {
  const r = rig({ chatLocal: async x => { if (/WAIT/.test(x.messages[0].text)) await new Promise((res, rej) => x.signal.addEventListener('abort', () => rej(Object.assign(new Error('Cancelled.'), { kind: 'cancelled' })))); return { text: 'ok', cut: false, usage: { input: 1, output: 1, estimated: true } }; } });
  await r.svc.install({ modelId: model4, level: 'high' });
  const p = r.svc.chat(REQ('WAIT')); await wait(30);
  r.svc.cancelChat();
  assert.strictEqual((await err(p)).kind, 'cancelled');
  assert.strictEqual((await r.svc.chat(REQ('fine'))).text, 'ok');
  assert.ok(r.running, 'the engine keeps running');
  r.svc.cancelChat(); // nothing active: harmless
});

test('idle: the engine is stopped after idleMs and a later chat starts it again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig({ idleMs: 60000 });
  await r.svc.install({ modelId: model4, level: 'high' });
  await r.svc.chat(REQ());
  assert.ok(r.running);
  t.mock.timers.tick(59000); assert.ok(r.running);
  t.mock.timers.tick(2000); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(r.running, false); assert.strictEqual(r.calls.engineStop >= 1, true);
  assert.strictEqual((await r.svc.localStatus()).running, null);
  await r.svc.chat(REQ());
  assert.strictEqual(r.calls.engineStart.length, 2);
});

test('cli chat builds one prompt from system and messages and passes the tool id', async () => {
  const r = rig();
  const out = await r.svc.chat({ mode: 'cli', cliId: 'codex', system: 'SYSTEM TEXT', messages: [{ role: 'user', text: 'Q1' }, { role: 'assistant', text: 'A1' }, { role: 'user', text: 'Q2' }], maxTokens: 500, json: true });
  assert.strictEqual(out.text, 'cli says hi');
  const c = r.calls.cli[0]; assert.strictEqual(c.toolId, 'codex');
  assert.ok(c.prompt.startsWith('SYSTEM TEXT') && c.prompt.includes('Q1') && c.prompt.includes('A1') && c.prompt.indexOf('Q1') < c.prompt.indexOf('A1') && c.prompt.indexOf('A1') < c.prompt.indexOf('Q2'));
  assert.match(c.prompt, /JSON/);
  const bad = rig({ runCli: async () => { throw Object.assign(new Error('x'), { kind: 'auth' }); } });
  assert.strictEqual((await err(bad.svc.chat({ mode: 'cli', cliId: 'codex', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 5, json: false }))).kind, 'auth');
  assert.deepStrictEqual(await r.svc.cliDetect(), [{ id: 'codex', found: true }]);
});

test('Review focus 2: shutdown stops the engine, cancels downloads and CLI runs, and is harmless twice', async () => {
  let dlSignal, cliSignal;
  const r = rig({ download: async x => { dlSignal = x.signal; await new Promise((res, rej) => x.signal.addEventListener('abort', () => rej(new DownloadError('cancelled')))); }, runCli: async x => { cliSignal = x.signal; await new Promise((res, rej) => x.signal.addEventListener('abort', () => rej(Object.assign(new Error('c'), { kind: 'cancelled' })))); } });
  const inst = r.svc.install({ modelId: model4, level: 'high' }); await wait(30);
  const cli = r.svc.chat({ mode: 'cli', cliId: 'codex', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 5, json: false }); await wait(30);
  r.running = true;
  await r.svc.shutdown(); await r.svc.shutdown();
  assert.ok(dlSignal.aborted && cliSignal.aborted); assert.strictEqual(r.running, false);
  await err(inst); await err(cli);
});

test('remove deletes only the chosen model; removeAll deletes models and engine under dataDir and nothing else', async () => {
  const r = rig();
  await r.svc.install({ modelId: model4, level: 'high' }); await r.svc.install({ modelId: model9, level: 'high' });
  fs.mkdirSync(path.join(r.dataDir, 'engine', 'b1'), { recursive: true }); fs.writeFileSync(path.join(r.dataDir, 'engine', 'b1', 'x'), 'x');
  const outside = path.join(tmp(), 'precious.txt'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(r.dataDir, 'models', 'evil.gguf'));
  for (const id of ['../x', '..', 'a/b', 'evil.gguf', 'nope']) assert.strictEqual((await err(r.svc.remove({ modelId: id }))).kind, 'bad', id);
  await r.svc.remove({ modelId: model4 });
  assert.deepStrictEqual((await r.svc.localStatus()).installed.map(m => m.modelId), [model9]);
  await r.svc.removeAll();
  assert.ok(!fs.existsSync(path.join(r.dataDir, 'models')) && !fs.existsSync(path.join(r.dataDir, 'engine')));
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.ok(fs.existsSync(r.dataDir));
});

test('recommend also lists every enabled model with a fits flag for the chosen level', async () => {
  const r = rig({ hardware: hw(16) });
  const light = await r.svc.recommend({ level: 'light', language: 'Turkish' });
  const max = await r.svc.recommend({ level: 'max', language: 'English' });
  for (const rec of [light, max]) {
    assert.deepStrictEqual(rec.models.filter(m => !m.tooBig).map(m => m.id).sort(), [model4, model9].sort(), 'only enabled models can be downloaded');
    assert.ok(rec.models.filter(m => m.tooBig).length >= 3, 'the too-big models are listed too');
    for (const m of rec.models.filter(x => !x.tooBig)) {
      assert.strictEqual(typeof m.fits, 'boolean'); assert.ok(m.name && m.line && m.sizeBytes > 0 && m.license.name && /^https:/.test(m.license.url), m.id);
      assert.ok(['strong', 'fair', 'weak'].includes(m.fit), m.id); assert.strictEqual(m.sha256, undefined, 'internal fields are not sent');
    }
  }
  assert.strictEqual(light.models.find(m => m.id === model9).fits, false);
  assert.strictEqual(max.models.find(m => m.id === model9).fits, true);
  assert.strictEqual(light.models.find(m => m.id === model4).fit, 'weak', 'Turkish is weak for the 4B model');
  const tiny = await rig({ hardware: hw(3) }).svc.recommend({ level: 'max', language: 'English' });
  assert.strictEqual(tiny.ok, false); assert.ok(tiny.models.filter(m => !m.tooBig).length === 2 && tiny.models.every(m => m.fits === false), 'a too-small PC still gets the list, with nothing fitting');
});

test('a too-large answer allowance is trimmed to fit the context instead of refusing the question', async () => {
  const r = rig({ hardware: hw(16) });
  await r.svc.install({ modelId: model4, level: 'medium' }); // medium context is 8192 tokens
  const q = Object.assign(REQ('x'.repeat(8000)), { maxTokens: 9000 }); // about 2000 tokens in, 9000 asked for out
  const res = await r.svc.chat(q);
  assert.strictEqual(res.text, 'hi');
  const sent = r.calls.chat[0].maxTokens;
  assert.ok(Number.isInteger(sent) && sent >= 256 && sent < 9000 && sent <= 8192 - 2000, 'trimmed to ' + sent);
});

test('review: changing the model or power level while the engine runs does not count the old engine\'s memory against the new one', async () => {
  // free memory is 14.4 GiB with nothing running, but only 6 GiB while the old engine holds its share
  const r = rig({ hardwareReader: r => Object.assign({}, r.hardware, r.running ? { freeRamBytes: 6 * GiB } : {}) });
  await r.svc.install({ modelId: model4, level: 'high' }); await r.svc.install({ modelId: model9, level: 'high' });
  await r.svc.start({ modelId: model4, level: 'medium' });
  assert.strictEqual(r.running, true);
  const out = await r.svc.start({ modelId: model9, level: 'high' });
  assert.deepStrictEqual(out.running, { modelId: model9, level: 'high' });
  assert.strictEqual(r.calls.engineStart.length, 2);
});

test('review: a refused change leaves the earlier choice so the next chat restarts the working engine', async () => {
  const r = rig({ hardware: hw(8) });
  await r.svc.install({ modelId: model4, level: 'high' });
  await r.svc.start({ modelId: model4, level: 'high' });
  const e = await err(r.svc.start({ modelId: model4, level: 'light' }));
  assert.strictEqual(e.kind, 'ram');
  await r.svc.chat(REQ());
  assert.strictEqual(r.calls.chat.length, 1); assert.strictEqual(r.calls.engineStart.length, 2);
  assert.strictEqual(r.calls.engineStart[1].level, 'high');
});

test('review: two overlapping start calls for the same model start one engine', async () => {
  const r = rig();
  await r.svc.install({ modelId: model4, level: 'high' });
  const [a, b] = await Promise.all([r.svc.start({ modelId: model4, level: 'high' }), r.svc.start({ modelId: model4, level: 'high' })]);
  assert.deepStrictEqual(a.running, b.running);
  assert.strictEqual(r.calls.engineStart.length, 1);
});

test('recommend lists too-big models as unavailable with a plain need, and they cannot be installed', async () => {
  const r = rig({ hardware: hw(64) });
  const rec = await r.svc.recommend({ level: 'max', language: 'English' });
  const ultra = rec.models.find(m => m.id === 'nemotron-3-ultra-550b-a55b');
  assert.ok(ultra, 'Ultra is listed');
  assert.strictEqual(ultra.tooBig, true); assert.strictEqual(ultra.fits, false);
  assert.ok(ultra.needs.length > 10);
  for (const k of ['url', 'file', 'sha256', 'minRamBytes', 'kvBytesPerToken']) assert.ok(!(k in ultra), k + ' must not reach the page');
  assert.ok(rec.models.filter(m => !m.tooBig).every(m => m.fits === true || m.fits === false));
  assert.strictEqual((await err(r.svc.install({ modelId: 'nemotron-3-ultra-550b-a55b', level: 'max' }))).kind, 'bad');
  assert.strictEqual(r.calls.download.length, 0);
  const st = await r.svc.localStatus();
  assert.ok(Array.isArray(st.installed));
});
