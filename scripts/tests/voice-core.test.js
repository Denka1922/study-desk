'use strict';
// Voice catalog, unpacking and installing. Real tar files are made on the fly; no network is used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { hostAllowed, loadVoiceCatalog, validateVoiceCatalog, platformKey } = require('../../desktop/voice/catalog');
const { extractTarball, unsafeName, tarProgram } = require('../../desktop/voice/extract');
const { ensureEngine, ensurePack, engineInstalled, packInstalled, packDir } = require('../../desktop/voice/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-voice-'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const clone = o => JSON.parse(JSON.stringify(o));

test('the shipped voice catalog is valid and every download is pinned and from an allowed host', () => {
  const c = loadVoiceCatalog();
  assert.deepStrictEqual(validateVoiceCatalog(c), []);
  assert.deepStrictEqual(c.packs.map(p => p.id), ['kokoro-en', 'supertonic-3']);
  for (const a of [c.engine.wrapper, ...Object.values(c.engine.platforms), ...c.packs]) { assert.ok(hostAllowed(a.url)); assert.match(a.sha256, /^[0-9a-f]{64}$/); }
  assert.ok(c.packs.find(p => p.id === 'supertonic-3').languages.includes('tr'), 'Turkish is offered');
  assert.deepStrictEqual(c.packs.find(p => p.id === 'kokoro-en').languages, ['en']);
});

test('the catalog check rejects bad checksums, foreign hosts, duplicate voices and missing licences', () => {
  const c = loadVoiceCatalog();
  const bad = f => { const x = clone(c); f(x); return validateVoiceCatalog(x).length > 0; };
  assert.ok(bad(x => { x.packs[0].sha256 = 'abc'; }));
  assert.ok(bad(x => { x.packs[0].url = 'https://evil.example/' + x.packs[0].file; }));
  assert.ok(bad(x => { x.packs[0].url = 'http://github.com/x/' + x.packs[0].file; }));
  assert.ok(bad(x => { x.packs[0].voices.push(clone(x.packs[0].voices[0])); }));
  assert.ok(bad(x => { delete x.packs[1].license; }));
  assert.ok(bad(x => { x.packs[0].dir = '../x'; }));
  assert.ok(bad(x => { delete x.engine.platforms['win-x64']; }));
  assert.ok(bad(x => { x.schema = 2; }));
});

test('only https downloads from the listed hosts are allowed', () => {
  assert.ok(hostAllowed('https://registry.npmjs.org/a/-/a-1.tgz'));
  assert.ok(hostAllowed('https://objects.githubusercontent.com/x'));
  for (const u of ['http://github.com/a', 'https://github.com.evil.example/a', 'https://user:pw@github.com/a', 'ftp://github.com/a', 'nope', '']) assert.ok(!hostAllowed(u), u);
});

test('the engine has a build for 64-bit Windows and both kinds of Mac, and nothing else', () => {
  assert.strictEqual(platformKey('win32', 'x64'), 'win-x64');
  assert.strictEqual(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.strictEqual(platformKey('darwin', 'x64'), 'darwin-x64');
  assert.strictEqual(platformKey('linux', 'x64'), null);
  assert.strictEqual(platformKey('win32', 'ia32'), null);
});

test('unsafe archive names are recognised; Windows uses its own tar.exe', () => {
  for (const n of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', 'c:/x', 'a\\..\\x', 'a\0b', '']) assert.ok(unsafeName(n), JSON.stringify(n));
  for (const n of ['package/a.js', 'dir/', 'a b/c.txt']) assert.ok(!unsafeName(n), n);
  assert.strictEqual(tarProgram('win32', { SystemRoot: 'C:\\Windows' }), path.join('C:\\Windows', 'System32', 'tar.exe'));
  assert.strictEqual(tarProgram('linux', {}), 'tar');
});

function makeTar(dir, name, files, flag) {
  const src = path.join(dir, 'src-' + name); fs.mkdirSync(src, { recursive: true });
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), body); }
  const out = path.join(dir, name); cp.execFileSync('tar', [flag, out, '-C', src, '.']); return out;
}

test('a real .tar.gz and .tar.bz2 are unpacked into the target folder', async () => {
  const d = tmp();
  for (const [n, flag] of [['a.tar.gz', '-czf'], ['b.tar.bz2', '-cjf']]) {
    const t = makeTar(d, n, { 'model/x.onnx': 'hello', 'model/sub/y.txt': 'yo' }, flag);
    const dest = path.join(d, 'out-' + n); await extractTarball(t, dest);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'model/sub/y.txt'), 'utf8'), 'yo');
  }
});

test('an archive with an unsafe name is refused before anything is written', async () => {
  const d = tmp(); const calls = [];
  const run = async (cmd, args) => { calls.push(args[0]); return args[0] === '-tf' ? 'ok/a\n../evil\n' : ''; };
  await assert.rejects(() => extractTarball(path.join(d, 'x.tgz'), path.join(d, 'out'), { run, tar: 'tar' }), /unsafe/);
  assert.deepStrictEqual(calls, ['-tf'], 'it only listed the archive, never extracted');
  assert.ok(!fs.existsSync(path.join(d, 'out')));
  await assert.rejects(() => extractTarball(path.join(d, 'x.tgz'), path.join(d, 'out2'), { run: async () => { throw new Error('bad'); }, tar: 'tar' }), /could not be opened/);
  await assert.rejects(() => extractTarball(path.join(d, 'x.tgz'), path.join(d, 'out3'), { run: async () => '\n', tar: 'tar' }), /empty/);
});

// a fake download: copies a prepared tarball and checks it was asked for with the pinned values
function rig(files) {
  const d = tmp(), calls = [];
  const download = async o => { calls.push(o); fs.copyFileSync(files[path.basename(o.url)] || files['*'], o.destPath); if (o.onProgress) { o.onProgress(1, 2); o.onProgress(2, 2); } return { path: o.destPath }; };
  return { d, calls, download };
}

test('the engine is downloaded once: wrapper and platform build land where the engine looks for them', async () => {
  const c = clone(loadVoiceCatalog()); const base = tmp();
  const w = makeTar(base, 'wrap.tgz', { 'package/sherpa-onnx.js': 'w' }, '-czf'), p = makeTar(base, 'plat.tgz', { 'package/sherpa-onnx.node': 'n', 'package/lib.dll': 'l' }, '-czf');
  const r = rig({ [c.engine.wrapper.file]: w, [c.engine.platforms['win-x64'].file]: p });
  const hw = { platform: 'win32', arch: 'x64' }, prog = [];
  const eng = await ensureEngine({ dataDir: r.d, catalog: c, hardware: hw, download: r.download, onProgress: (a, b) => prog.push(a / b) });
  assert.ok(fs.existsSync(path.join(eng.wrapperDir, 'sherpa-onnx.js')) && fs.existsSync(path.join(eng.platformDir, 'sherpa-onnx.node')));
  assert.ok(eng.platformDir.endsWith('sherpa-onnx-win-x64'));
  assert.deepStrictEqual(r.calls.map(x => [x.sha256, x.sizeBytes]), [[c.engine.wrapper.sha256, c.engine.wrapper.sizeBytes], [c.engine.platforms['win-x64'].sha256, c.engine.platforms['win-x64'].sizeBytes]]);
  assert.ok(r.calls.every(x => typeof x.hostAllowed === 'function' && !x.hostAllowed('https://evil.example/x')), 'the voice host list is used');
  assert.ok(engineInstalled(r.d, c, hw));
  assert.ok(prog.length && prog.every(x => x >= 0 && x <= 1.0001) && prog[prog.length - 1] > 0.99);
  await ensureEngine({ dataDir: r.d, catalog: c, hardware: hw, download: r.download });
  assert.strictEqual(r.calls.length, 2, 'a second call downloads nothing');
  assert.ok(!fs.readdirSync(path.join(r.d, 'voice', 'engine', c.engine.version)).some(n => n.endsWith('.tgz')), 'archives are deleted');
});

test('on a Mac the unpacked native files are signed; on an unsupported computer nothing is downloaded', async () => {
  const c = clone(loadVoiceCatalog()); const base = tmp();
  const w = makeTar(base, 'wrap.tgz', { 'package/a.js': 'w' }, '-czf'), p = makeTar(base, 'plat.tgz', { 'package/sherpa-onnx.node': 'n' }, '-czf');
  const r = rig({ [c.engine.wrapper.file]: w, [c.engine.platforms['darwin-arm64'].file]: p }); let signed = null;
  await ensureEngine({ dataDir: r.d, catalog: c, hardware: { platform: 'darwin', arch: 'arm64' }, download: r.download, sign: async dir => { signed = dir; } });
  assert.ok(signed && signed.endsWith('sherpa-onnx-darwin-arm64'));
  const r2 = rig({ '*': w });
  await assert.rejects(() => ensureEngine({ dataDir: r2.d, catalog: c, hardware: { platform: 'linux', arch: 'x64' }, download: r2.download }), /not available/);
  assert.strictEqual(r2.calls.length, 0);
});

test('an engine download without the native file is rejected and leaves nothing half installed', async () => {
  const c = clone(loadVoiceCatalog()); const base = tmp();
  const w = makeTar(base, 'wrap.tgz', { 'package/a.js': 'w' }, '-czf'), p = makeTar(base, 'plat.tgz', { 'package/readme': 'x' }, '-czf');
  const r = rig({ [c.engine.wrapper.file]: w, [c.engine.platforms['win-x64'].file]: p });
  await assert.rejects(() => ensureEngine({ dataDir: r.d, catalog: c, hardware: { platform: 'win32', arch: 'x64' }, download: r.download }), /expected program/);
  assert.ok(!engineInstalled(r.d, c, { platform: 'win32', arch: 'x64' }));
});

test('a voice pack is unpacked from its folder, marked installed, and a wrong archive is refused', async () => {
  const c = clone(loadVoiceCatalog()); const pack = c.packs[0]; const base = tmp();
  const good = makeTar(base, 'k.tar.bz2', { [pack.dir + '/model.int8.onnx']: 'm', [pack.dir + '/tokens.txt']: 't' }, '-cjf');
  const r = rig({ '*': good });
  const dir = await ensurePack({ dataDir: r.d, pack, download: r.download });
  assert.strictEqual(dir, packDir(r.d, pack)); assert.ok(fs.existsSync(path.join(dir, 'model.int8.onnx')) && packInstalled(r.d, pack));
  assert.strictEqual(r.calls[0].sha256, pack.sha256);
  const wrong = makeTar(base, 'w.tar.bz2', { 'other/x': 'x' }, '-cjf'); const r2 = rig({ '*': wrong });
  await assert.rejects(() => ensurePack({ dataDir: r2.d, pack, download: r2.download }), /expected files/);
  assert.ok(!packInstalled(r2.d, pack));
});
