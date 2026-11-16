'use strict';
// Fixes from the whole-change review. Every test here failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { augmentPath, resolveBinary, runCli } = require('../../desktop/ai/cli');
const { createEngine, reapStale } = require('../../desktop/ai/engine');
const { downloadVerified, DownloadError } = require('../../desktop/ai/download');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-rev-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rejects(p) { try { await p; } catch (e) { return e; } assert.fail('should have rejected'); }

// ---- 1. a Mac app started from Finder has a tiny PATH ---------------------------------------------------------
test('augmentPath adds the usual install folders on Mac/Linux after the existing PATH, without duplicates, and leaves Windows alone', () => {
  const readdir = d => (d === '/Users/o/.nvm/versions/node' ? ['v18.0.0', 'v20.11.1', 'v9.0.0'] : []);
  const p = augmentPath('/usr/bin:/bin:/usr/local/bin', { platform: 'darwin', home: '/Users/o', readdir }).split(':');
  assert.deepStrictEqual(p.slice(0, 3), ['/usr/bin', '/bin', '/usr/local/bin'], 'the existing PATH comes first and unchanged');
  for (const d of ['/opt/homebrew/bin', '/Users/o/.local/bin', '/Users/o/.npm-global/bin', '/Users/o/.bun/bin', '/Users/o/.cargo/bin', '/Users/o/.volta/bin']) assert.ok(p.includes(d), d);
  assert.strictEqual(p.filter(x => x === '/usr/local/bin').length, 1, 'no duplicates');
  assert.ok(p.indexOf('/Users/o/.nvm/versions/node/v20.11.1/bin') >= 0 && p.indexOf('/Users/o/.nvm/versions/node/v20.11.1/bin') < p.indexOf('/Users/o/.nvm/versions/node/v18.0.0/bin'), 'newest node version first');
  assert.ok(p.indexOf('/Users/o/.nvm/versions/node/v18.0.0/bin') < p.indexOf('/Users/o/.nvm/versions/node/v9.0.0/bin'), 'numeric, not alphabetical');
  assert.strictEqual(augmentPath('C:\\Windows;C:\\x', { platform: 'win32', home: 'C:\\Users\\o' }), 'C:\\Windows;C:\\x');
  assert.ok(augmentPath('', { platform: 'darwin', home: '/h', readdir }).split(':').includes('/opt/homebrew/bin'));
  assert.doesNotThrow(() => augmentPath('/usr/bin', { platform: 'darwin', home: '/h', readdir: () => { throw new Error('no dir'); } }));
});

test('a tool in /opt/homebrew/bin is found even when the app was started with a minimal PATH', () => {
  const found = resolveBinary('codex', augmentPath('/usr/bin:/bin', { platform: 'darwin', home: '/Users/o', readdir: () => [] }), { platform: 'darwin', exists: f => f === '/opt/homebrew/bin/codex' });
  assert.strictEqual(found, '/opt/homebrew/bin/codex');
});

test('the tool is started with the same PATH it was found on, so its "#!/usr/bin/env node" start line finds node', { skip: process.platform === 'win32' }, async () => {
  const d = tmp(); const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  const f = path.join(bin, 'codex'); fs.writeFileSync(f, '#!/bin/sh\nexit 1\n'); fs.chmodSync(f, 0o755);
  let seen = null;
  await rejects(runCli({ toolId: 'codex', prompt: 'hi', pathEnv: bin + ':/usr/bin:/bin', scratchRoot: d, spawn: (file, args, o) => { seen = o.env.PATH; return cp.spawn(file, args, o); } }));
  assert.ok(seen.startsWith(bin + ':/usr/bin:/bin'), seen);
  for (const d of String(process.env.PATH).split(':').filter(Boolean)) assert.ok(seen.split(':').includes(d), 'keeps ' + d);
});

// ---- 3. two overlapping engine starts ---------------------------------------------------------------------------
function fakeSpawn(procs) {
  return () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 1000 + procs.length; p.exitCode = null;
    p.kill = () => { setTimeout(() => { p.exitCode = 0; p.emit('exit', 0); }, 5); }; procs.push(p); return p;
  };
}
const HW = { platform: 'win32', arch: 'x64', cores: 8, gpu: { present: false }, totalRamBytes: 16e9, freeRamBytes: 12e9 };

test('a second start that replaces the first never makes the engine look stopped while its process is alive', async () => {
  const procs = [];
  const eng = createEngine({ spawn: fakeSpawn(procs), fetchImpl: async () => ({ status: 200 }), pollMs: 50, pickPort: async () => 1234 });
  const o = { serverPath: 'x', modelPath: 'm', level: 'medium', hardware: HW };
  const a = eng.start(o).then(() => 'ok', e => 'err');
  await sleep(20);
  const b = eng.start(o).then(() => 'ok', e => 'err');
  await Promise.all([a, b]); await sleep(300);
  const alive = procs.filter(p => p.exitCode === null);
  assert.strictEqual(alive.length, 1, 'exactly one engine process is alive');
  assert.strictEqual(eng.running(), true, 'and the engine knows about it');
  await eng.stop(); await sleep(50);
  assert.strictEqual(procs.filter(p => p.exitCode === null).length, 0, 'stop ends it');
});

// ---- 4. an app that was killed leaves llama-server behind --------------------------------------------------------
test('the engine writes a pid file when it starts and removes it on a normal stop', async () => {
  const procs = [], pidFile = path.join(tmp(), 'engine.pid');
  const eng = createEngine({ spawn: fakeSpawn(procs), fetchImpl: async () => ({ status: 200 }), pollMs: 50, pickPort: async () => 1234, pidFile, probe: async () => null, kill: () => {} });
  await eng.start({ serverPath: path.join('x', 'llama-server.exe'), modelPath: 'm', level: 'medium', hardware: HW });
  const j = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.strictEqual(j.pid, procs[0].pid); assert.strictEqual(j.exe, 'llama-server.exe');
  await eng.stop(); assert.strictEqual(fs.existsSync(pidFile), false);
});

test('reapStale kills a leftover llama-server from a crashed run, but never a different program that reused the pid', async () => {
  const d = tmp(), pidFile = path.join(d, 'engine.pid'), killed = [];
  const run = async (content, probeName) => {
    if (content === null) fs.rmSync(pidFile, { force: true }); else fs.writeFileSync(pidFile, content);
    killed.length = 0;
    await reapStale({ pidFile, probe: async pid => probeName, kill: pid => killed.push(pid) });
    return { killed: killed.slice(), left: fs.existsSync(pidFile) };
  };
  assert.deepStrictEqual(await run(JSON.stringify({ pid: 4242, exe: 'llama-server.exe' }), 'LLAMA-SERVER.EXE'), { killed: [4242], left: false });
  assert.deepStrictEqual(await run(JSON.stringify({ pid: 4242, exe: 'llama-server' }), 'chrome'), { killed: [], left: false }, 'pid reused by another program');
  assert.deepStrictEqual(await run(JSON.stringify({ pid: 4242, exe: 'llama-server' }), null), { killed: [], left: false }, 'already gone');
  assert.deepStrictEqual(await run('not json', 'llama-server'), { killed: [], left: false });
  assert.deepStrictEqual(await run(JSON.stringify({ pid: -1, exe: 'llama-server' }), 'llama-server'), { killed: [], left: false });
  assert.deepStrictEqual(await run(JSON.stringify({ pid: process.pid, exe: 'node' }), 'node'), { killed: [], left: false }, 'never the app itself');
  assert.deepStrictEqual(await run(null, 'llama-server'), { killed: [], left: false });
});

test('the first start and stop() reap a stale engine before doing anything else', async () => {
  const d = tmp(), pidFile = path.join(d, 'engine.pid'), killed = [];
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 777, exe: 'llama-server' }));
  const procs = [];
  const eng = createEngine({ spawn: fakeSpawn(procs), fetchImpl: async () => ({ status: 200 }), pollMs: 50, pickPort: async () => 1234, pidFile, probe: async () => 'llama-server', kill: p => killed.push(p) });
  await eng.stop(); // nothing running: still cleans up the leftover
  assert.deepStrictEqual(killed, [777]);
});

// ---- 5. disk full while writing is a disk problem, not a network problem ----------------------------------------
test('a write error ENOSPC during the download is reported as disk', { skip: !fs.existsSync('/dev/full') }, async () => {
  const d = tmp(); const dest = path.join(d, 'm.gguf');
  fs.symlinkSync('/dev/full', dest + '.part');
  const body = (async function* () { yield Buffer.alloc(1000, 1); })();
  const e = await rejects(downloadVerified({ url: 'https://huggingface.co/a/b', destPath: dest, sha256: '0'.repeat(64), sizeBytes: 1000, freeBytes: () => 1e12,
    fetchImpl: async () => ({ status: 206, headers: { get: () => null }, body }) })); // 206 so the .part symlink is not replaced
  assert.ok(e instanceof DownloadError); assert.strictEqual(e.code, 'disk');
});
