'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTools, detectTools, buildInvocation, runCli, windowsCommand, resolveBinary } = require('../../desktop/ai/cli');
const { estimateTokens } = require('../../desktop/ai/usage');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake.js');
const unix = process.platform !== 'win32';
const tmp = (name = 'sd-cli-') => fs.mkdtempSync(path.join(os.tmpdir(), name));

// a folder with fake "codex", "gemini", "goose" programs on it
function binDir(names = ['codex', 'gemini', 'goose']) {
  const d = path.join(tmp(), 'bin dir Öğrenci');
  fs.mkdirSync(d, { recursive: true });
  for (const n of names) {
    const f = path.join(d, n);
    fs.writeFileSync(f, `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE)})(${JSON.stringify(n)});\n`);
    fs.chmodSync(f, 0o755);
  }
  return d;
}
async function err(p) { try { await p; } catch (e) { return e; } assert.fail('should have rejected'); }
function withEnv(env, fn) {
  const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  return Promise.resolve().then(fn).then(r => { restore(); return r; }, e => { restore(); throw e; });
}

test('the tool list holds only the tools whose one-shot safe mode was confirmed', () => {
  const t = loadTools();
  assert.deepStrictEqual(t.map(x => x.id).sort(), ['codex', 'gemini', 'goose']);
  for (const x of t) {
    assert.ok(x.name && x.install && x.login && x.binaries.length && ['cloud', 'local', 'depends'].includes(x.dataGoes) && x.stdin === true, x.id);
  }
  assert.strictEqual(t.find(x => x.id === 'codex').dataGoes, 'cloud'); assert.strictEqual(t.find(x => x.id === 'goose').dataGoes, 'depends');
});

test('buildInvocation: fixed safe arguments, the prompt only on stdin', () => {
  const tools = Object.fromEntries(loadTools().map(t => [t.id, t]));
  const prompt = '--help "x" $(y)';
  const c = buildInvocation(tools.codex, prompt, '/s');
  assert.strictEqual(c.stdin, prompt);
  for (const f of ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--ignore-user-config', '--color', 'never', '-o']) assert.ok(c.args.includes(f), 'codex ' + f);
  assert.strictEqual(c.args[c.args.indexOf('--sandbox') + 1], 'read-only'); assert.strictEqual(c.args.at(-1), '-');
  const g = buildInvocation(tools.gemini, prompt, '/s');
  assert.ok(g.args.includes('--approval-mode') && g.args[g.args.indexOf('--approval-mode') + 1] === 'plan' && g.args.includes('--skip-trust'));
  assert.strictEqual(g.args[g.args.indexOf('-o') + 1], 'json'); assert.strictEqual(g.stdin, prompt);
  const o = buildInvocation(tools.goose, prompt, '/s');
  assert.deepStrictEqual(o.args.slice(0, 2), ['run', '-i']); assert.strictEqual(o.args[2], '-');
  assert.ok(o.args.includes('--no-session') && o.args.includes('--no-profile') && o.args.includes('--quiet'));
  assert.strictEqual(o.env.GOOSE_MODE, 'chat');
  for (const inv of [c, g, o]) assert.ok(!inv.args.some(a => a.includes(prompt)), 'the prompt is never an argument');
});

test('Windows .cmd shims are started through cmd.exe with fixed arguments only', () => {
  const w = windowsCommand('C:\\Users\\Öğrenci Çalışma ı ş\\AppData\\Roaming\\npm\\codex.cmd', ['exec', '--color', 'never', '-']);
  assert.strictEqual(w.file, 'cmd.exe'); assert.strictEqual(w.verbatim, true);
  assert.deepStrictEqual(w.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.strictEqual(w.args[3], '""C:\\Users\\Öğrenci Çalışma ı ş\\AppData\\Roaming\\npm\\codex.cmd" exec --color never -"');
  assert.throws(() => windowsCommand('C:\\x\\a.cmd', ['--bad&arg']), /unsafe/i);
  assert.throws(() => windowsCommand('C:\\x\\%PATH%\\a.cmd', ['a']), /unsafe/i);
  assert.throws(() => windowsCommand('C:\\x"y\\a.cmd', ['a']), /unsafe/i);
  assert.strictEqual(windowsCommand('C:\\x\\a.exe', ['a']).file, 'C:\\x\\a.exe');
});

test('resolveBinary follows PATHEXT-style names on Windows and plain names elsewhere', () => {
  const exists = f => f === 'C:\\bin\\codex.cmd' || f === '/bin/goose';
  assert.strictEqual(resolveBinary('codex', 'C:\\bin;C:\\other', { platform: 'win32', exists }), 'C:\\bin\\codex.cmd');
  assert.strictEqual(resolveBinary('goose', '/usr/bin:/bin', { platform: 'linux', exists }), '/bin/goose');
  assert.strictEqual(resolveBinary('nope', '/bin', { platform: 'linux', exists }), null);
});

test('detectTools finds fakes on a given PATH and gives install and login hints for missing ones', { skip: !unix }, async () => {
  const d = binDir(['codex']);
  const list = await detectTools({ pathEnv: d });
  assert.deepStrictEqual(list.map(x => x.id), ['codex', 'gemini', 'goose']);
  const c = list[0]; assert.strictEqual(c.found, true); assert.strictEqual(c.version, 'codex-cli 9.9.9');
  const m = list[1]; assert.strictEqual(m.found, false); assert.strictEqual(m.version, null); assert.ok(m.install.length > 10 && m.login.length > 10 && m.dataGoes);
});

test('runCli refuses anything that is not in the tool list before starting a program', async () => {
  let spawned = 0;
  for (const id of ['bash', '../x', 'codex; rm', '', undefined, 'CODEX']) {
    const e = await err(runCli({ toolId: id, prompt: 'hi', spawn: () => { spawned++; } }));
    assert.strictEqual(e.kind, 'bad', String(id));
  }
  assert.strictEqual(spawned, 0);
});

test('a tool that is not installed gives kind nocli', async () => {
  const e = await err(runCli({ toolId: 'codex', prompt: 'hi', pathEnv: tmp() }));
  assert.strictEqual(e.kind, 'nocli'); assert.match(e.message, /npm install/);
});

test('runCli starts the program without a shell, in an empty temporary folder that is removed afterwards', { skip: !unix }, async () => {
  const d = binDir(); const rec = path.join(tmp(), 'rec.json'); const calls = [];
  const spawn = (f, a, o) => { calls.push({ f, a, o }); return cp.spawn(f, a, o); };
  const r = await withEnv({ FAKE_RECORD: rec }, () => runCli({ toolId: 'codex', prompt: 'hello', pathEnv: d, spawn }));
  assert.strictEqual(r.text, 'hello'); assert.strictEqual(r.cut, false);
  const seen = JSON.parse(fs.readFileSync(rec, 'utf8'));
  assert.deepStrictEqual(seen.ls, [], 'the working folder was empty');
  assert.strictEqual(calls.length, 1); assert.ok(!calls[0].o.shell, 'no shell');
  // on a Mac the temp folder /var/... is really /private/var/..., and the program reports the real one
  const real = p => p.replace(/^\/private(?=\/var\/)/, '');
  assert.strictEqual(real(calls[0].o.cwd), real(seen.cwd));
  assert.ok(!fs.existsSync(seen.cwd), 'scratch folder removed');
  assert.deepStrictEqual(calls[0].a, buildInvocation(loadTools().find(t => t.id === 'codex'), 'hello', seen.cwd).args);
});

const HOSTILE = [
  'a "quoted" \'text\'', 'line1\nline2\r\nline3', '& echo hi', '%PATH% and %USERPROFILE%', '$(touch PWNED)', '`touch PWNED`',
  '--help', '; touch PWNED; # ', '| touch PWNED', 'ş'.repeat(50000), 'x'.repeat(50000),
];
for (const id of ['codex', 'gemini', 'goose']) {
  test(`Review focus 3: hostile prompts reach ${id} byte for byte and run nothing`, { skip: !unix }, async () => {
    const d = binDir(); const marker = path.join(tmp(), 'PWNED');
    for (const p0 of HOSTILE) {
      const p = p0.replace(/PWNED/g, marker);
      const r = await runCli({ toolId: id, prompt: p, pathEnv: d });
      assert.strictEqual(r.text, p.trim());
    }
    assert.ok(!fs.existsSync(marker), 'nothing was executed');
  });
}

test('goose runs in chat-only mode', { skip: !unix }, async () => {
  const d = binDir(); const rec = path.join(tmp(), 'rec.json');
  await withEnv({ FAKE_RECORD: rec }, () => runCli({ toolId: 'goose', prompt: 'x', pathEnv: d }));
  assert.strictEqual(JSON.parse(fs.readFileSync(rec, 'utf8')).gooseMode, 'chat');
});

test('failures are sorted into bad, auth and rate with a plain message', { skip: !unix }, async () => {
  const d = binDir();
  let e = await withEnv({ FAKE_MODE: 'fail' }, () => err(runCli({ toolId: 'gemini', prompt: 'x', pathEnv: d })));
  assert.strictEqual(e.kind, 'bad'); assert.match(e.message, /boom: it broke/); assert.ok(!/second line/.test(e.message));
  e = await withEnv({ FAKE_MODE: 'auth' }, () => err(runCli({ toolId: 'gemini', prompt: 'x', pathEnv: d })));
  assert.strictEqual(e.kind, 'auth'); assert.match(e.message, /login/i);
  e = await withEnv({ FAKE_MODE: 'rate' }, () => err(runCli({ toolId: 'gemini', prompt: 'x', pathEnv: d })));
  assert.strictEqual(e.kind, 'rate');
  e = await withEnv({ FAKE_MODE: 'empty' }, () => err(runCli({ toolId: 'goose', prompt: 'x', pathEnv: d })));
  assert.strictEqual(e.kind, 'bad'); assert.match(e.message, /empty reply/);
});

test('a slow program is killed at the time limit, a flood is cut, and cancel stops the program', { skip: !unix }, async () => {
  const d = binDir();
  let e = await withEnv({ FAKE_MODE: 'sleep' }, () => err(runCli({ toolId: 'goose', prompt: 'x', pathEnv: d, timeoutMs: 400 })));
  assert.strictEqual(e.kind, 'timeout');
  e = await withEnv({ FAKE_MODE: 'flood' }, () => err(runCli({ toolId: 'goose', prompt: 'x', pathEnv: d, maxOutputBytes: 1024 * 1024 })));
  assert.strictEqual(e.kind, 'bad'); assert.match(e.message, /too long/i);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  e = await withEnv({ FAKE_MODE: 'sleep' }, () => err(runCli({ toolId: 'goose', prompt: 'x', pathEnv: d, signal: ac.signal })));
  assert.strictEqual(e.kind, 'cancelled'); assert.ok(Date.now() - t0 < 5000);
  e = await err(runCli({ toolId: 'goose', prompt: 'x', pathEnv: d, signal: AbortSignal.abort() }));
  assert.strictEqual(e.kind, 'cancelled');
});

test('usage is real when the tool reports it, otherwise estimated from the text', { skip: !unix }, async () => {
  const d = binDir();
  let r = await withEnv({ FAKE_USAGE: '1' }, () => runCli({ toolId: 'codex', prompt: 'hello there', pathEnv: d }));
  assert.deepStrictEqual(r.usage, { input: 21, output: 4, estimated: false });
  r = await withEnv({ FAKE_USAGE: '1' }, () => runCli({ toolId: 'gemini', prompt: 'hello there', pathEnv: d }));
  assert.deepStrictEqual(r.usage, { input: 21, output: 4, estimated: false });
  r = await runCli({ toolId: 'codex', prompt: 'hello there', pathEnv: d });
  assert.deepStrictEqual(r.usage, { input: estimateTokens('hello there'), output: estimateTokens('hello there'), estimated: true });
  r = await runCli({ toolId: 'goose', prompt: 'hello there', pathEnv: d });
  assert.strictEqual(r.usage.estimated, true);
});

test('Review focus 4: a scratch folder under a path with spaces and Turkish letters works', { skip: !unix }, async () => {
  const d = binDir(); const root = path.join(tmp(), 'Öğrenci Çalışma ı ş'); fs.mkdirSync(root);
  const r = await runCli({ toolId: 'codex', prompt: 'merhaba dünya', pathEnv: d, scratchRoot: root });
  assert.strictEqual(r.text, 'merhaba dünya'); assert.deepStrictEqual(fs.readdirSync(root), []);
});
