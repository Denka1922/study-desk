'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildServerArgs, ensureEngine, createEngine, extractArchive, EngineError } = require('../../desktop/ai/engine');

const FIX = path.join(__dirname, 'fixtures');
const FAKE = path.join(FIX, 'fake-llama-server.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-eng-'));
const GiB = 1024 ** 3;
const hw = (o = {}) => Object.assign({ platform: 'win32', arch: 'x64', totalRamBytes: 16 * GiB, freeRamBytes: 12 * GiB, cores: 8, gpu: { present: false, vendor: 'unknown', name: '' }, appleSilicon: false }, o);
const mac = () => hw({ platform: 'darwin', arch: 'arm64', appleSilicon: true, gpu: { present: true, vendor: 'apple', name: 'Apple GPU' } });
const catalog = () => ({ engine: { tag: 'bTEST', assets: {
  'win-x64-cpu': { file: 'win.zip', url: 'https://github.com/x/win.zip', sha256: 'a'.repeat(64), sizeBytes: 100, format: 'zip', serverPath: 'llama-server.exe' },
  'mac-arm64': { file: 'mac.tar.gz', url: 'https://github.com/x/mac.tar.gz', sha256: 'b'.repeat(64), sizeBytes: 100, format: 'tar.gz', serverPath: 'llama-bX/llama-server' },
} } });
const fakeDownload = (fixture, counter) => async o => { counter.n++; fs.copyFileSync(path.join(FIX, fixture), o.destPath); return { path: o.destPath }; };
const mkSpawn = (env = {}) => (p, args, o) => cp.spawn(process.execPath, [FAKE, ...args], Object.assign({}, o, { env: Object.assign({}, process.env, env) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rejects(p) { try { await p; } catch (e) { return e; } assert.fail('should have rejected'); }

test('buildServerArgs: pinned flags, each value its own item, no shell string', () => {
  const model = 'C:\\Users\\Öğrenci Çalışma ı ş\\AppData\\m & "x" $(y).gguf';
  const a = buildServerArgs({ modelPath: model, ctx: 8192, threads: 4, gpuLayers: 'auto', port: 5000, token: 't'.repeat(40) });
  const val = f => a[a.indexOf(f) + 1];
  assert.strictEqual(val('-m'), model);
  assert.strictEqual(val('--host'), '127.0.0.1'); assert.strictEqual(val('--port'), '5000');
  assert.strictEqual(val('--api-key'), 't'.repeat(40)); assert.strictEqual(val('--ctx-size'), '8192');
  assert.strictEqual(val('--threads'), '4'); assert.strictEqual(val('--gpu-layers'), 'auto');
  assert.strictEqual(val('--parallel'), '1'); assert.strictEqual(val('--reasoning-format'), 'deepseek');
  assert.ok(a.includes('--no-webui'));
  assert.ok(a.every(x => typeof x === 'string'));
  assert.strictEqual(buildServerArgs({ modelPath: 'm', ctx: 1, threads: 1, gpuLayers: 0, port: 1, token: 'x' })[a.indexOf('--gpu-layers') + 1], '0');
});

test('extractArchive reads a real .zip (deflate, stored, folders, non-ASCII names) and a real .tar.gz', async () => {
  const d = tmp();
  await extractArchive(path.join(FIX, 'engine-fixture.zip'), path.join(d, 'z'), 'zip');
  assert.ok(fs.readFileSync(path.join(d, 'z', 'llama-server.exe'), 'utf8').startsWith('fake server exe'));
  assert.strictEqual(fs.readFileSync(path.join(d, 'z', 'sub dir', 'Ünlü dosya.txt'), 'utf8'), 'hello\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'z', 'stored.txt'), 'utf8'), 'stored\n');
  await extractArchive(path.join(FIX, 'engine-fixture.tar.gz'), path.join(d, 't'), 'tar.gz');
  assert.ok(fs.existsSync(path.join(d, 't', 'llama-bX', 'llama-server')));
});

test('a zip with ../ or absolute names is refused and writes nothing outside the folder', async () => {
  const d = tmp();
  for (const f of ['zipslip.zip', 'zipslip-abs.zip']) {
    const e = await rejects(extractArchive(path.join(FIX, f), path.join(d, 'out'), 'zip'));
    assert.ok(e instanceof EngineError && e.kind === 'engine', f);
  }
  assert.ok(!fs.existsSync(path.join(d, 'evil.txt')) && !fs.existsSync('/tmp/evil-abs.txt'));
});

test('ensureEngine (Mac): downloads, extracts, marks executable, signs; second call does nothing', async () => {
  const dataDir = path.join(tmp(), 'Öğrenci Çalışma ı ş'); const n = { n: 0 }; const signed = [];
  const o = { dataDir, hardware: mac(), catalog: catalog(), download: fakeDownload('engine-fixture.tar.gz', n), sign: async (dir, server) => signed.push([dir, server]) };
  const r = await ensureEngine(o);
  assert.ok(r.serverPath.startsWith(path.join(dataDir, 'engine', 'bTEST')), r.serverPath);
  assert.ok(fs.existsSync(r.serverPath) && (fs.statSync(r.serverPath).mode & 0o111));
  assert.strictEqual(signed.length, 1); assert.strictEqual(signed[0][1], r.serverPath);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(path.dirname(r.serverPath))).filter(f => f.endsWith('.tar.gz') || f.endsWith('.part')), [], 'the archive is removed');
  const r2 = await ensureEngine(o);
  assert.strictEqual(r2.serverPath, r.serverPath); assert.strictEqual(n.n, 1); assert.strictEqual(signed.length, 1);
});

test('ensureEngine (Windows): extracts the zip, never signs, and repairs a half-installed folder', async () => {
  const dataDir = tmp(); const n = { n: 0 }; let signed = 0;
  const o = { dataDir, hardware: hw(), catalog: catalog(), download: fakeDownload('engine-fixture.zip', n), sign: async () => { signed++; } };
  const r = await ensureEngine(o);
  assert.ok(r.serverPath.endsWith('llama-server.exe') && fs.existsSync(r.serverPath)); assert.strictEqual(signed, 0);
  fs.rmSync(path.join(path.dirname(r.serverPath), 'installed.json')); // simulate an interrupted install
  await ensureEngine(o);
  assert.strictEqual(n.n, 2);
});

test('ensureEngine refuses an unsupported computer', async () => {
  const e = await rejects(ensureEngine({ dataDir: tmp(), hardware: hw({ platform: 'linux' }), catalog: catalog(), download: async () => { throw new Error('no'); } }));
  assert.strictEqual(e.kind, 'engine');
});

test('createEngine.start runs the server on 127.0.0.1 with a random token and waits for /health', async () => {
  const d = tmp(); const argsFile = path.join(d, 'args.json');
  const eng = createEngine({ spawn: mkSpawn({ FAKE_ARGS_FILE: argsFile, FAKE_LOAD_MS: '400' }), pollMs: 50 });
  const t0 = Date.now();
  const { port, token } = await eng.start({ serverPath: 'ignored', modelPath: path.join(d, 'Ö m.gguf'), level: 'medium', hardware: hw() });
  assert.ok(Date.now() - t0 >= 300, 'waited for the model to load');
  assert.ok(port > 1023 && token.length >= 32 && eng.running());
  const a = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.strictEqual(a[a.indexOf('--api-key') + 1], token); assert.strictEqual(a[a.indexOf('--host') + 1], '127.0.0.1');
  assert.strictEqual(a[a.indexOf('-m') + 1], path.join(d, 'Ö m.gguf'));
  assert.strictEqual(a[a.indexOf('--gpu-layers') + 1], '0', 'the CPU build keeps everything on the processor');
  assert.strictEqual(a[a.indexOf('--ctx-size') + 1], '8192'); assert.strictEqual(a[a.indexOf('--threads') + 1], '4');
  await eng.stop(); assert.ok(!eng.running());
});

test('GPU builds use gpu-layers auto', async () => {
  const d = tmp(); const argsFile = path.join(d, 'args.json');
  const eng = createEngine({ spawn: mkSpawn({ FAKE_ARGS_FILE: argsFile }), pollMs: 20 });
  await eng.start({ serverPath: 'x', modelPath: 'm', level: 'high', hardware: hw({ gpu: { present: true, vendor: 'nvidia', name: 'RTX' } }) });
  const a = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.strictEqual(a[a.indexOf('--gpu-layers') + 1], 'auto');
  await eng.stop();
});

test('a second start stops the first server', async () => {
  const eng = createEngine({ spawn: mkSpawn(), pollMs: 20 });
  const one = await eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() });
  const two = await eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() });
  assert.notStrictEqual(one.port, two.port);
  const dead = await fetch('http://127.0.0.1:' + one.port + '/health').then(() => false, () => true);
  assert.ok(dead, 'the first server is gone');
  await eng.stop();
});

test('a server that exits at once, or never becomes healthy, makes start reject with kind engine', async () => {
  let eng = createEngine({ spawn: mkSpawn({ FAKE_MODE: 'exit' }), pollMs: 20 });
  let e = await rejects(eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() }));
  assert.strictEqual(e.kind, 'engine'); assert.ok(/cannot load model/.test(e.message) || e.message.length > 10); assert.ok(!eng.running());
  eng = createEngine({ spawn: mkSpawn({ FAKE_MODE: 'never' }), pollMs: 20, healthTimeoutMs: 300 });
  e = await rejects(eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() }));
  assert.strictEqual(e.kind, 'engine'); assert.ok(!eng.running(), 'killed after the timeout');
});

test('onExit fires when the server dies by itself, not when stop() ends it', async () => {
  const eng = createEngine({ spawn: mkSpawn(), pollMs: 20 }); const codes = [];
  eng.onExit(c => codes.push(c));
  await eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() });
  await eng.stop(); await sleep(100); assert.deepStrictEqual(codes, []);
  let child;
  const spawn = (p, a, o) => (child = mkSpawn()(p, a, o));
  const eng2 = createEngine({ spawn, pollMs: 20 }); eng2.onExit(c => codes.push(c));
  await eng2.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() });
  child.kill('SIGKILL'); await sleep(300);
  assert.strictEqual(codes.length, 1); assert.ok(!eng2.running());
});

test('when the chosen port is already taken the engine picks another (up to 3 tries)', async () => {
  const net = require('node:net');
  // a server that accepts connections but never answers, like another program using the port
  const blocker = net.createServer(() => {}); await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port; let asked = 0;
  const pickPort = async () => asked++ === 0 ? taken : require('../../desktop/ai/engine').freePort();
  const eng = createEngine({ spawn: mkSpawn(), pollMs: 20, pickPort });
  const { port } = await eng.start({ serverPath: 'x', modelPath: 'm', level: 'light', hardware: hw() });
  assert.notStrictEqual(port, taken); assert.strictEqual(asked, 2);
  await eng.stop(); blocker.close();
});
