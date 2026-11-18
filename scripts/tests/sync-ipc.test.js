'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { registerSyncIpc, SYNC_CHANNELS, SYNC_REQUEST_CHANNEL, SYNC_STATUS_CHANNEL } = require('../../desktop/sync/ipc');

const APP = 'file:///C:/Program%20Files/Study%20Desk/resources/app/index.html';
const ok = { senderFrame: { url: APP } };
const SECRET = 'A'.repeat(43);
const GOOD_START = { secretB64: SECRET, mode: 'wifi', deviceId: '0123456789abcdef', name: 'PC' };

function rig(over = {}) {
  const handlers = new Map(); const sent = []; const calls = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
  let ask;
  const service = { start: async a => { calls.push(['start', a]); return { ok: true, addresses: [] }; }, stop: async () => { calls.push(['stop']); }, forget: async () => { calls.push(['forget']); }, publish: a => { calls.push(['publish', a]); } };
  const reg = registerSyncIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, getWindow: () => over.noWindow ? null : win, appFileUrl: APP, createService: ({ askPage, emitStatus }) => { ask = askPage; service.emit = emitStatus; return service; } });
  return { handlers, sent, calls, service, reg, ask: (m, t) => ask(m, t), call: (name, event, arg) => handlers.get('study-desk:sync:' + name)(event, arg) };
}

test('registers exactly the listed channels, all under study-desk:sync:, and never the main-to-page ones', () => {
  const r = rig();
  assert.deepStrictEqual([...r.handlers.keys()].sort(), [...SYNC_CHANNELS].sort());
  assert.ok(SYNC_CHANNELS.every(c => c.startsWith('study-desk:sync:')));
  assert.ok(!SYNC_CHANNELS.includes(SYNC_REQUEST_CHANNEL) && !SYNC_CHANNELS.includes(SYNC_STATUS_CHANNEL));
});

test('only the app\'s own page may call (other frames, no frame, other pages: refused, service untouched)', async () => {
  const r = rig();
  for (const ev of [undefined, {}, { senderFrame: { url: 'https://evil.example/' } }, { senderFrame: { url: APP + '/../x.html' } }, { senderFrame: { url: 'file:///C:/other.html' } }]) {
    const res = await r.call('start', ev, GOOD_START);
    assert.strictEqual(res.ok, false);
  }
  assert.deepStrictEqual(r.calls, []);
  assert.strictEqual((await r.call('start', { senderFrame: { url: APP + '#sync' } }, GOOD_START)).ok, true, 'hash and query are allowed');
});

test('start validates mode, secret, device id, name and relay address', async () => {
  const r = rig();
  const bad = [undefined, null, 'x', [], {}, { ...GOOD_START, mode: 'lan' }, { ...GOOD_START, secretB64: 'short' }, { ...GOOD_START, secretB64: '+'.repeat(43) },
    { ...GOOD_START, deviceId: 'XYZ' }, { ...GOOD_START, name: 'n'.repeat(41) }, { ...GOOD_START, name: 5 }, { ...GOOD_START, relayUrl: 'h'.repeat(201) }, { ...GOOD_START, relayUrl: 5 }];
  for (const b of bad) assert.strictEqual((await r.call('start', ok, b)).ok, false, JSON.stringify(b));
  assert.deepStrictEqual(r.calls, []);
  const good = await r.call('start', ok, { ...GOOD_START, mode: 'both', relayUrl: 'https://r.example.dev', extra: 'ignored' });
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(r.calls[0][1], { secretB64: SECRET, mode: 'both', deviceId: '0123456789abcdef', name: 'PC', relayUrl: 'https://r.example.dev' });
});

test('publish needs a rev and an object doc, and refuses a doc over 8 MB', async () => {
  const r = rig();
  for (const b of [null, {}, { rev: 5, doc: {} }, { rev: 'x' }, { rev: 'x', doc: [] }, { rev: 'x', doc: 'text' }, { rev: 'r'.repeat(129), doc: {} }, { rev: 'x', doc: { big: 'a'.repeat(8 * 1024 * 1024) } }])
    assert.strictEqual((await r.call('publish', ok, b)).ok, false);
  assert.strictEqual((await r.call('publish', ok, { rev: 'abc', doc: { items: {} } })).ok, true);
  assert.deepStrictEqual(r.calls, [['publish', { rev: 'abc', doc: { items: {} } }]]);
});

test('stop, forget and status work and ignore arguments', async () => {
  const r = rig();
  assert.strictEqual((await r.call('stop', ok, { whatever: 1 })).ok, true);
  assert.strictEqual((await r.call('forget', ok)).ok, true);
  assert.deepStrictEqual((await r.call('status', ok)).value, { state: 'off', text: 'Sync is off', lastSync: 0, mode: 'off' });
  r.service.emit({ state: 'connected', text: 'Synced 10:00', lastSync: 5, mode: 'wifi' });
  assert.strictEqual((await r.call('status', ok)).value.state, 'connected');
  assert.deepStrictEqual(r.sent.at(-1), [SYNC_STATUS_CHANNEL, { state: 'connected', text: 'Synced 10:00', lastSync: 5, mode: 'wifi' }]);
});

test('askPage sends a numbered request to the window and resolves with the page reply', async () => {
  const r = rig();
  const p = r.ask({ op: 'sync', rev: 'a', doc: { items: {} } });
  const [ch, payload] = r.sent.at(-1);
  assert.strictEqual(ch, SYNC_REQUEST_CHANNEL); assert.deepStrictEqual(payload.msg, { op: 'sync', rev: 'a', doc: { items: {} } });
  assert.strictEqual((await r.call('reply', ok, { id: payload.id, ok: true, value: { rev: 'b', doc: { items: { x: 1 } } } })).ok, true);
  assert.deepStrictEqual(await p, { rev: 'b', doc: { items: { x: 1 } } });
  // answering twice, or an unknown id, does nothing
  assert.strictEqual((await r.call('reply', ok, { id: payload.id, ok: true, value: { rev: 'c', doc: {} } })).ok, true);
  assert.strictEqual((await r.call('reply', ok, { id: 9999, ok: false })).ok, true);
});

test('a failed page reply rejects; a reply from another frame is refused and the request stays open until timeout', async () => {
  const r = rig();
  const p1 = r.ask({ op: 'sync' }); const id1 = r.sent.at(-1)[1].id;
  await r.call('reply', ok, { id: id1, ok: false });
  await assert.rejects(p1, /could not merge/);
  const p2 = r.ask({ op: 'sync' }, 60); const id2 = r.sent.at(-1)[1].id;
  assert.strictEqual((await r.call('reply', { senderFrame: { url: 'https://evil.example/' } }, { id: id2, ok: true, value: { rev: 'x', doc: {} } })).ok, false);
  await assert.rejects(p2, /did not answer/);
});

test('no window means askPage fails at once', async () => {
  const r = rig({ noWindow: true });
  await assert.rejects(r.ask({ op: 'sync' }), /not available/);
});

test('reply validates its shape', async () => {
  const r = rig();
  for (const b of [null, {}, { id: 'x', ok: true }, { id: 0, ok: false }, { id: 1, ok: 'yes' }, { id: 1, ok: true }, { id: 1, ok: true, value: { rev: 1, doc: {} } }, { id: 1, ok: true, value: { rev: 'x', doc: [] } }])
    assert.strictEqual((await r.call('reply', ok, b)).ok, false, JSON.stringify(b));
});

test('error messages that go back to the page are short plain text', async () => {
  const r = rig(); r.service.start = async () => { throw new Error('No free port for sync on this computer.'); };
  const res = await r.call('start', ok, GOOD_START);
  assert.deepStrictEqual(res, { ok: false, error: { message: 'No free port for sync on this computer.' } });
});

// ---- preload -----------------------------------------------------------------------------------------------------
function loadPreload() {
  const exposed = []; const invoked = []; const listeners = new Map();
  const electron = { contextBridge: { exposeInMainWorld: (n, api) => exposed.push([n, api]) },
    ipcRenderer: { invoke: (ch, arg) => { invoked.push([ch, arg]); return Promise.resolve(electron.reply ? electron.reply(ch, arg) : { ok: true, value: {} }); },
      on: (ch, fn) => listeners.set(ch, fn), removeListener: (ch, fn) => { if (listeners.get(ch) === fn) listeners.delete(ch); } } };
  const PRE = path.resolve(__dirname, '../../desktop/preload.js'); const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  delete require.cache[PRE];
  try { require(PRE); } finally { Module._load = orig; delete require.cache[PRE]; }
  return { exposed, invoked, listeners, electron, sync: exposed[0][1].sync };
}

test('preload: studyDesk.sync has the documented methods and every call uses a registered channel', async () => {
  const p = loadPreload();
  assert.deepStrictEqual(Object.keys(p.sync).sort(), ['forget', 'onRequest', 'onStatus', 'publish', 'start', 'status', 'stop', 'version']);
  await p.sync.start({}); await p.sync.stop(); await p.sync.forget(); await p.sync.publish({}); await p.sync.status();
  const names = p.invoked.map(x => x[0]);
  assert.deepStrictEqual(names.sort(), ['start', 'stop', 'forget', 'publish', 'status'].map(n => 'study-desk:sync:' + n).sort());
  assert.ok(names.every(n => SYNC_CHANNELS.includes(n)));
});

test('preload: failures become a plain {message}; the string channel names match ipc.js', async () => {
  const p = loadPreload();
  p.electron.reply = () => ({ ok: false, error: { message: 'No free port' } });
  await assert.rejects(p.sync.start({}), e => e.message === 'No free port' && !(e instanceof Error));
  p.electron.reply = () => undefined;
  await assert.rejects(p.sync.status(), e => typeof e.message === 'string');
  p.sync.onRequest(() => Promise.resolve({})); p.sync.onStatus(() => {});
  assert.ok(p.listeners.has(SYNC_REQUEST_CHANNEL) && p.listeners.has(SYNC_STATUS_CHANNEL));
});

test('preload: onRequest answers the main process with the page result, or with a failure, and can be undone', async () => {
  const p = loadPreload(); p.electron.reply = undefined;
  let mode = 'good';
  const off = p.sync.onRequest(async msg => { if (mode === 'bad') throw new Error('x'); return { rev: 'r', doc: { echo: msg } }; });
  const h = p.listeners.get(SYNC_REQUEST_CHANNEL);
  h({ sender: 'secret' }, { id: 7, msg: { op: 'sync' } });
  await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(p.invoked.at(-1), ['study-desk:sync:reply', { id: 7, ok: true, value: { rev: 'r', doc: { echo: { op: 'sync' } } } }]);
  mode = 'bad'; h({}, { id: 8, msg: {} });
  await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(p.invoked.at(-1), ['study-desk:sync:reply', { id: 8, ok: false }]);
  const n = p.invoked.length; h({}, null); h({}, { id: 'x' }); await new Promise(r => setTimeout(r, 5)); assert.strictEqual(p.invoked.length, n, 'junk requests are ignored');
  off(); assert.strictEqual(p.listeners.has(SYNC_REQUEST_CHANNEL), false);
  assert.throws(() => p.sync.onRequest('no'), /function/); assert.throws(() => p.sync.onStatus(5), /function/);
});

test('preload: onStatus passes the payload, not the event', () => {
  const p = loadPreload(); const got = [];
  const off = p.sync.onStatus(x => got.push(x));
  p.listeners.get(SYNC_STATUS_CHANNEL)({ sender: 'secret' }, { state: 'waiting' });
  assert.deepStrictEqual(got, [{ state: 'waiting' }]); off();
  assert.strictEqual(p.listeners.has(SYNC_STATUS_CHANNEL), false);
});
