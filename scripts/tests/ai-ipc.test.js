'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { registerAiIpc, AI_CHANNELS, AI_PROGRESS_CHANNEL, createProgressSender } = require('../../desktop/ai/ipc');

const APP = 'file:///C:/Program%20Files/Study%20Desk/resources/app/index.html';
const ok = { senderFrame: { url: APP } };

function rig(serviceOverrides = {}) {
  const handlers = new Map(); const touched = [];
  const ipcMain = { handle: (ch, fn) => { handlers.set(ch, fn); } };
  const service = new Proxy({}, { get: (_, name) => (...a) => { touched.push([name, a]); if (serviceOverrides[name]) return serviceOverrides[name](...a); return Promise.resolve({ said: name }); } });
  registerAiIpc({ ipcMain, service, appFileUrl: APP });
  return { handlers, touched, call: (name, event, arg) => handlers.get('study-desk:ai:' + name)(event, arg) };
}
const GOOD_CHAT = { mode: 'local', system: 'sys', messages: [{ role: 'user', text: 'hi' }], maxTokens: 100, json: false };

test('registerAiIpc registers exactly the listed channels, all under the study-desk:ai: prefix', () => {
  const r = rig();
  assert.deepStrictEqual([...r.handlers.keys()].sort(), [...AI_CHANNELS].sort());
  assert.ok(AI_CHANNELS.every(c => c.startsWith('study-desk:ai:')));
  assert.strictEqual(new Set(AI_CHANNELS).size, AI_CHANNELS.length);
  assert.ok(!AI_CHANNELS.includes(AI_PROGRESS_CHANNEL), 'progress flows main to page only');
});

test('a call from any frame other than the app page is rejected without touching the service', async () => {
  const r = rig();
  for (const url of ['https://evil.example/', 'file:///C:/other/index.html', 'about:blank', '', undefined]) {
    const res = await r.call('local:status', { senderFrame: { url } });
    assert.strictEqual(res.ok, false, String(url)); assert.strictEqual(res.error.kind, 'bad');
  }
  assert.strictEqual((await r.call('local:status', {})).ok, false);
  assert.strictEqual((await r.call('local:status', { senderFrame: null })).ok, false);
  assert.strictEqual(r.touched.length, 0);
  assert.strictEqual((await r.call('local:status', { senderFrame: { url: APP + '#tutor?x=1' } })).ok, true, 'hash and query are ignored');
  assert.strictEqual(r.touched.length, 1);
});

test('arguments are validated before the service sees them', async () => {
  const r = rig();
  const invalid = [
    ['recommend', { level: 'turbo', language: 'English' }], ['recommend', { level: 'high', language: 5 }], ['recommend', null], ['recommend', 'high'],
    ['local:install', { modelId: '../x', level: 'high' }], ['local:install', { modelId: 'A', level: 'high' }], ['local:install', { modelId: 'x'.repeat(61), level: 'high' }], ['local:install', { modelId: 'ok-id', level: 'nope' }], ['local:install', {}],
    ['local:start', { modelId: 5, level: 'high' }], ['local:remove', { modelId: 'a/b' }], ['local:remove', undefined],
    ['chat', Object.assign({}, GOOD_CHAT, { mode: 'bash' })],
    ['chat', Object.assign({}, GOOD_CHAT, { mode: 'cli' })],
    ['chat', Object.assign({}, GOOD_CHAT, { mode: 'cli', cliId: '../codex' })],
    ['chat', Object.assign({}, GOOD_CHAT, { messages: 'x' })],
    ['chat', Object.assign({}, GOOD_CHAT, { messages: new Array(61).fill({ role: 'user', text: 'x' }) })],
    ['chat', Object.assign({}, GOOD_CHAT, { messages: [{ role: 'system', text: 'x' }] })],
    ['chat', Object.assign({}, GOOD_CHAT, { messages: [{ role: 'user', text: 5 }] })],
    ['chat', Object.assign({}, GOOD_CHAT, { messages: [{ role: 'user', text: 'x'.repeat(200001) }] })],
    ['chat', Object.assign({}, GOOD_CHAT, { system: 'x'.repeat(100001) })],
    ['chat', Object.assign({}, GOOD_CHAT, { maxTokens: 0 })], ['chat', Object.assign({}, GOOD_CHAT, { maxTokens: 32769 })], ['chat', Object.assign({}, GOOD_CHAT, { maxTokens: 1.5 })],
    ['chat', Object.assign({}, GOOD_CHAT, { json: 'yes' })], ['chat', null],
  ];
  for (const [name, arg] of invalid) {
    const res = await r.call(name, ok, arg);
    assert.strictEqual(res.ok, false, name + ' ' + String(JSON.stringify(arg)).slice(0, 80)); assert.strictEqual(res.error.kind, 'bad');
  }
  assert.strictEqual(r.touched.length, 0);
  for (const [name, arg] of [['recommend', { level: 'max', language: 'Turkish' }], ['local:install', { modelId: 'nemotron-3-nano-4b', level: 'high' }], ['chat', GOOD_CHAT], ['chat', Object.assign({}, GOOD_CHAT, { mode: 'cli', cliId: 'codex', json: true })], ['local:status'], ['cli:detect'], ['cancelChat'], ['local:removeAll'], ['getHardware']]) {
    const res = await r.call(name, ok, arg);
    assert.strictEqual(res.ok, true, name);
  }
});

test('results are wrapped as {ok, value} and errors as {ok:false, error:{kind, message}} without stack traces', async () => {
  const r = rig({
    'local:status': undefined,
    start: () => Promise.reject(Object.assign(new Error('too big'), { kind: 'ram', suggestion: { modelId: 'small', level: 'high' } })),
    stop: () => Promise.reject(new Error('internal path /home/x/secret failed')),
  });
  assert.deepStrictEqual(await r.call('getHardware', ok), { ok: true, value: { said: 'getHardware' } });
  const e = await r.call('local:start', ok, { modelId: 'a', level: 'high' });
  assert.deepStrictEqual(e, { ok: false, error: { kind: 'ram', message: 'too big', suggestion: { modelId: 'small', level: 'high' } } });
  const e2 = await r.call('local:stop', ok);
  assert.strictEqual(e2.error.kind, 'bad'); assert.ok(!/secret|home/.test(e2.error.message), 'no internal details');
});

test('every channel reaches the matching service method', async () => {
  const r = rig();
  const map = { 'getHardware': 'getHardware', 'recommend': 'recommend', 'local:status': 'localStatus', 'local:install': 'install', 'local:cancel': 'cancelInstall', 'local:remove': 'remove', 'local:removeAll': 'removeAll', 'local:start': 'start', 'local:stop': 'stop', 'cli:detect': 'cliDetect', 'chat': 'chat', 'cancelChat': 'cancelChat' };
  const args = { recommend: { level: 'high', language: 'English' }, 'local:install': { modelId: 'a', level: 'high' }, 'local:start': { modelId: 'a', level: 'high' }, 'local:remove': { modelId: 'a' }, chat: GOOD_CHAT };
  assert.deepStrictEqual(Object.keys(map).map(c => 'study-desk:ai:' + c).sort(), [...AI_CHANNELS].sort());
  for (const [ch, method] of Object.entries(map)) { await r.call(ch, ok, args[ch]); assert.strictEqual(r.touched.at(-1)[0], method, ch); }
});

test('progress is throttled but the last event of a download always gets through', () => {
  const sent = []; let t = 0;
  const send = createProgressSender(p => sent.push(p), { intervalMs: 250, now: () => t });
  for (let i = 1; i <= 1000; i++) { t += 1; send({ phase: 'model', modelId: 'm', done: i, total: 1000 }); }
  assert.ok(sent.length <= 6, 'about 4 per second, got ' + sent.length);
  assert.deepStrictEqual(sent.at(-1), { phase: 'model', modelId: 'm', done: 1000, total: 1000 });
  const before = sent.length; t += 10; send({ phase: 'engine', modelId: 'm', done: 1, total: 5 });
  assert.strictEqual(sent.length, before + 1, 'a different phase is not held back');
});

// ---- preload ----------------------------------------------------------------------------------------------------
function loadPreload() {
  const exposed = []; const invoked = []; const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push([name, api]) },
    ipcRenderer: {
      invoke: (ch, arg) => { invoked.push([ch, arg]); return Promise.resolve(electron.reply ? electron.reply(ch, arg) : { ok: true, value: { ch } }); },
      on: (ch, fn) => { listeners.set(ch, fn); }, removeListener: (ch, fn) => { if (listeners.get(ch) === fn) listeners.delete(ch); },
    },
  };
  const PRE = path.resolve(__dirname, '../../desktop/preload.js'); const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  delete require.cache[PRE];
  try { require(PRE); } finally { Module._load = orig; delete require.cache[PRE]; }
  return { exposed, invoked, listeners, electron };
}

test('preload exposes exactly studyDesk.ai, studyDesk.sync and studyDesk.voice with the documented methods and never ipcRenderer', async () => {
  const p = loadPreload();
  assert.strictEqual(p.exposed.length, 1); assert.strictEqual(p.exposed[0][0], 'studyDesk');
  const root = p.exposed[0][1]; assert.deepStrictEqual(Object.keys(root), ['ai', 'sync', 'voice']);
  const ai = root.ai;
  assert.deepStrictEqual(Object.keys(ai).sort(), ['chat', 'cancelChat', 'cli', 'getHardware', 'local', 'recommend', 'version'].sort());
  assert.strictEqual(ai.version, 1);
  assert.deepStrictEqual(Object.keys(ai.local).sort(), ['cancel', 'install', 'onProgress', 'remove', 'removeAll', 'start', 'status', 'stop']);
  assert.deepStrictEqual(Object.keys(ai.cli), ['detect']);
  assert.ok(!JSON.stringify(Object.keys(root)).includes('ipcRenderer'));
  const calls = [['getHardware'], ['recommend', {}], ['chat', {}], ['cancelChat']];
  for (const [n, a] of calls) await ai[n](a);
  await ai.local.status(); await ai.local.install({}); await ai.local.cancel(); await ai.local.remove({}); await ai.local.removeAll(); await ai.local.start({}); await ai.local.stop(); await ai.cli.detect();
  assert.deepStrictEqual(p.invoked.map(x => x[0]).sort(), [...AI_CHANNELS].sort(), 'calling every AI method touches only AI channels');
});

test('preload unwraps {ok,value} and rejects with a plain {kind, message}', async () => {
  const p = loadPreload();
  p.electron.reply = ch => (ch.endsWith(':chat') ? { ok: false, error: { kind: 'ram', message: 'no room', suggestion: { modelId: 'x' } } } : { ok: true, value: 42 });
  const ai = p.exposed[0][1].ai;
  assert.strictEqual(await ai.getHardware(), 42);
  try { await ai.chat({}); assert.fail('should reject'); } catch (e) { assert.deepStrictEqual(e, { kind: 'ram', message: 'no room', suggestion: { modelId: 'x' } }); assert.ok(!(e instanceof Error)); }
});

test('preload progress subscription passes the payload (not the event) and can be undone', () => {
  const p = loadPreload(); const ai = p.exposed[0][1].ai; const got = [];
  const off = ai.local.onProgress(x => got.push(x));
  assert.strictEqual(typeof off, 'function');
  p.listeners.get(AI_PROGRESS_CHANNEL)({ sender: 'secret' }, { phase: 'model', done: 1, total: 2 });
  assert.deepStrictEqual(got, [{ phase: 'model', done: 1, total: 2 }]);
  off(); assert.strictEqual(p.listeners.has(AI_PROGRESS_CHANNEL), false);
  assert.throws(() => ai.local.onProgress('not a function'), /function/);
});
