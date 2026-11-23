'use strict';
// The door between the page and the voice service (IPC and preload), and the VoiceStudio link.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { registerVoiceIpc, VOICE_CHANNELS, VOICE_PROGRESS_CHANNEL } = require('../../desktop/voice/ipc');
const { createStudio, readVoices, BASE } = require('../../desktop/voice/studio');

const APP = 'file:///C:/Program%20Files/Study%20Desk/resources/app/index.html';
const ok = { senderFrame: { url: APP } };
function rig(over = {}) {
  const handlers = new Map(), touched = [];
  const service = new Proxy({}, { get: (_, n) => (...a) => { touched.push([n, a]); return over[n] ? over[n](...a) : Promise.resolve({ n }); } });
  registerVoiceIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, service, appFileUrl: APP });
  return { handlers, touched, call: (n, ev, arg) => handlers.get('study-desk:voice:' + n)(ev, arg) };
}
const SPEAK = { source: 'pack', packId: 'kokoro-en', voiceId: 'af_heart', text: 'Hi.', speed: 1, lang: 'en' };

test('exactly the listed voice channels are registered, all under study-desk:voice:', () => {
  const r = rig();
  assert.deepStrictEqual([...r.handlers.keys()].sort(), [...VOICE_CHANNELS].sort());
  assert.ok(VOICE_CHANNELS.every(c => c.startsWith('study-desk:voice:')) && !VOICE_CHANNELS.includes(VOICE_PROGRESS_CHANNEL));
});

test('only the app page may call; every other frame is refused without touching the service', async () => {
  const r = rig();
  for (const url of ['https://evil.example/', 'file:///C:/other/index.html', 'about:blank', '', undefined]) {
    const res = await r.call('status', { senderFrame: { url } }); assert.strictEqual(res.ok, false, String(url)); assert.strictEqual(res.error.kind, 'bad');
  }
  assert.strictEqual((await r.call('status', {})).ok, false); assert.strictEqual(r.touched.length, 0);
  assert.strictEqual((await r.call('status', { senderFrame: { url: APP + '#tutor?x=1' } })).ok, true);
});

test('arguments are checked before the service sees them', async () => {
  const r = rig();
  const bad = [['install', { packId: '../x' }], ['install', {}], ['install', null], ['remove', { packId: 'A' }], ['remove', { packId: 5 }],
    ['speak', { ...SPEAK, source: 'shell' }], ['speak', { ...SPEAK, text: '' }], ['speak', { ...SPEAK, text: 'x'.repeat(1001) }], ['speak', { ...SPEAK, speed: 3 }], ['speak', { ...SPEAK, speed: '1' }],
    ['speak', { ...SPEAK, voiceId: '../../x' }], ['speak', { ...SPEAK, packId: '../x' }], ['speak', { ...SPEAK, lang: 'english' }], ['speak', { ...SPEAK, lang: undefined }], ['speak', 'hi'], ['speak', null],
    ['speak', { source: 'studio', voiceId: 'x'.repeat(81), text: 'a', speed: 1 }]];
  for (const [n, a] of bad) { const res = await r.call(n, ok, a); assert.strictEqual(res.ok, false, n + ' ' + JSON.stringify(a)); }
  assert.strictEqual(r.touched.length, 0);
  assert.strictEqual((await r.call('speak', ok, SPEAK)).ok, true);
  assert.strictEqual((await r.call('speak', ok, { source: 'studio', voiceId: 'Alloy 2', text: 'a', speed: 1.2 })).ok, true);
  assert.deepStrictEqual(r.touched[0][1][0], SPEAK);
  assert.deepStrictEqual(r.touched[1][1][0], { source: 'studio', voiceId: 'Alloy 2', text: 'a', speed: 1.2 }, 'studio calls carry no pack or language');
  assert.deepStrictEqual(Object.keys(r.touched[0][1][0]).sort(), Object.keys(SPEAK).sort(), 'extra fields are dropped');
});

test('errors reach the page as a known kind with a plain message; surprises are made generic', async () => {
  const r = rig({ speak: async () => { throw Object.assign(new Error('The voice was stopped.'), { kind: 'cancelled' }); }, status: async () => { throw new Error('C:\\Users\\secret\\path failed'); } });
  assert.deepStrictEqual(await r.call('speak', ok, SPEAK), { ok: false, error: { kind: 'cancelled', message: 'The voice was stopped.' } });
  const res = await r.call('status', ok); assert.strictEqual(res.error.kind, 'bad'); assert.ok(!/secret/.test(res.error.message));
});

// ---- preload ------------------------------------------------------------------------------------------------------
function loadPreload(reply) {
  const exposed = [], invoked = [], listeners = new Map();
  const electron = { contextBridge: { exposeInMainWorld: (n, a) => exposed.push([n, a]) }, ipcRenderer: {
    invoke: (c, a) => { invoked.push([c, a]); return Promise.resolve(reply ? reply(c, a) : { ok: true, value: { c } }); },
    on: (c, f) => listeners.set(c, f), removeListener: (c, f) => { if (listeners.get(c) === f) listeners.delete(c); } } };
  const PRE = path.resolve(__dirname, '../../desktop/preload.js'), orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  delete require.cache[PRE];
  try { require(PRE); } finally { Module._load = orig; delete require.cache[PRE]; }
  return { exposed, invoked, listeners };
}

test('preload gives the page studyDesk.voice with the documented methods, touching only voice channels', async () => {
  const p = loadPreload(); const v = p.exposed[0][1].voice;
  assert.deepStrictEqual(Object.keys(v).sort(), ['cancel', 'cancelSpeak', 'install', 'onProgress', 'refreshStudio', 'remove', 'removeAll', 'speak', 'status', 'version']);
  await v.status(); await v.refreshStudio(); await v.install({}); await v.cancel(); await v.remove({}); await v.removeAll(); await v.speak({}); await v.cancelSpeak();
  assert.deepStrictEqual(p.invoked.map(x => x[0]).sort(), [...VOICE_CHANNELS].sort());
});

test('preload unwraps the answer, rejects with a plain {kind, message}, and passes progress without the event', async () => {
  const p = loadPreload(c => (c.endsWith(':speak') ? { ok: false, error: { kind: 'engine', message: 'nope' } } : { ok: true, value: 7 }));
  const v = p.exposed[0][1].voice;
  assert.strictEqual(await v.status(), 7);
  await assert.rejects(() => v.speak({}), e => !(e instanceof Error) && e.kind === 'engine' && e.message === 'nope');
  const got = []; const off = v.onProgress(x => got.push(x));
  p.listeners.get(VOICE_PROGRESS_CHANNEL)({ sender: 'secret' }, { packId: 'a', done: 1, total: 2 });
  assert.deepStrictEqual(got, [{ packId: 'a', done: 1, total: 2 }]); off(); assert.strictEqual(p.listeners.has(VOICE_PROGRESS_CHANNEL), false);
  assert.throws(() => v.onProgress(5), /function/);
});

// ---- VoiceStudio --------------------------------------------------------------------------------------------------
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))) });

test('VoiceStudio is only ever contacted on this computer, port 3900', () => { assert.strictEqual(BASE, 'http://127.0.0.1:3900'); });

test('VoiceStudio is found only when its health check answers; voices are read defensively', async () => {
  const urls = [];
  const s = createStudio({ fetchImpl: async u => { urls.push(u); return u.endsWith('/health') ? reply(200, { ok: true }) : reply(200, { voices: [{ id: 'alloy', name: 'Alloy' }, { id: '<script>' }, 'echo', 5, null] }); } });
  assert.deepStrictEqual(await s.detect(), { found: true, voices: [{ id: 'alloy', name: 'Alloy' }, { id: 'echo', name: 'echo' }] });
  assert.ok(urls.every(u => u.startsWith(BASE)));
  assert.deepStrictEqual(await createStudio({ fetchImpl: async () => { throw new Error('refused'); } }).detect(), { found: false, voices: [] });
  assert.deepStrictEqual(await createStudio({ fetchImpl: async () => reply(404, {}) }).detect(), { found: false, voices: [] });
  assert.deepStrictEqual((await createStudio({ fetchImpl: async u => (u.endsWith('/health') ? reply(200, {}) : reply(500, {})) }).detect()).voices, [{ id: 'default', name: 'Default voice' }]);
  assert.deepStrictEqual(readVoices({ data: [{ voice_id: 'v1' }] }), [{ id: 'v1', name: 'v1' }]);
});

test('VoiceStudio speech must be a real WAV; failures say what went wrong', async () => {
  let sent; const s = createStudio({ fetchImpl: async (u, o) => { sent = { u, o }; return reply(200, wav()); } });
  const buf = await s.speak({ text: 'Hi', voice: 'alloy', speed: 1 });
  assert.strictEqual(buf.toString('latin1', 0, 4), 'RIFF'); assert.strictEqual(sent.u, BASE + '/v1/audio/speech'); assert.strictEqual(sent.o.method, 'POST'); assert.strictEqual(sent.o.redirect, 'error');
  assert.deepStrictEqual(JSON.parse(sent.o.body), { input: 'Hi', voice: 'alloy', speed: 1, response_format: 'wav' });
  const fail = (f, re, kind) => assert.rejects(() => createStudio({ fetchImpl: f }).speak({ text: 'a', voice: 'v', speed: 1 }), e => re.test(e.message) && e.kind === kind);
  await fail(async () => reply(200, 'not audio at all, just words and more words, enough to pass the size check'), /did not send a WAV/, 'engine');
  await fail(async () => reply(500, ''), /answered 500/, 'engine');
  await fail(async () => { throw new TypeError('fetch failed'); }, /Could not reach VoiceStudio/, 'network');
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(() => createStudio({ fetchImpl: async (u, o) => { if (o.signal.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' }); return reply(200, wav()); } }).speak({ text: 'a', voice: 'v', speed: 1, signal: ctl.signal }), e => e.kind === 'cancelled');
});
