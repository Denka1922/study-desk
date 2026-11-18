'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../desktop/sync/crypto');
const { RelayError } = require('../../desktop/sync/relay-client');
const { createSyncService, listAddresses } = require('../../desktop/sync/service');

const SECRET = C.b64url(Buffer.alloc(32, 4));
const keys = C.deriveKeys(Buffer.alloc(32, 4));
const OS = { networkInterfaces: () => ({
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  Wi: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }],
  Eth: [{ family: 'IPv4', address: '10.0.0.7', internal: false }, { family: 'IPv4', address: '169.254.9.9', internal: false }],
  Pub: [{ family: 'IPv4', address: '8.8.4.4', internal: false }],
  Old: [{ family: 4, address: '172.20.1.1', internal: false }],
}) };

// a tiny stand-in for the page: merges by taking the union of two string lists
const pageMerge = (local) => async (msg) => {
  const set = [...new Set([...(local.doc.items || []), ...(msg.doc.items || [])])].sort();
  local.doc = { items: set }; local.rev = 'r:' + set.join(',');
  return { rev: local.rev, doc: local.doc };
};
function setup(over = {}) {
  const page = { doc: { items: ['a'] }, rev: 'r:a' };
  const status = [];
  const lan = { handler: null, started: 0, stopped: 0 };
  const relayStore = { rec: null, puts: [], getErr: null, beforePut: null };
  const timers = [];
  let clock = Date.UTC(2026, 10, 18, 11, 5, 0);
  const svc = createSyncService({
    os: OS, name: 'Test PC', now: () => clock,
    askPage: over.askPage || pageMerge(page),
    emitStatus: s => status.push(s),
    makeLan: ({ onMessage }) => { lan.handler = onMessage; return { start: async () => { lan.started++; return { port: 47821 }; }, stop: async () => { lan.stopped++; } }; },
    makeRelay: () => ({
      async get() { if (relayStore.getErr) throw relayStore.getErr; return relayStore.rec ? { ...relayStore.rec } : null; },
      async put(body, prev) {
        if (relayStore.beforePut) { const h = relayStore.beforePut; relayStore.beforePut = null; h(); }
        const cur = relayStore.rec ? Number(relayStore.rec.rev) : 0;
        if (prev !== undefined && Number(prev) !== cur) throw new RelayError('conflict', 'x', { rev: String(cur) });
        relayStore.rec = { rev: String(cur + 1), body }; relayStore.puts.push(body); return { rev: String(cur + 1) };
      },
      async del() { relayStore.rec = null; },
    }),
    setTimer: (fn, ms) => { const t = { fn, ms, off: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.off = true; },
  });
  return { svc, page, status, lan, relayStore, timers, tick: ms => { clock += ms; } };
}
const body = (rev, items) => JSON.stringify(C.seal(keys, { rev, doc: { items } }));
const open = b => C.open(keys, JSON.parse(b));

test('listAddresses: private IPv4 only, 192.168 first, no loopback, link-local or public', () => {
  assert.deepStrictEqual(listAddresses(OS), ['192.168.1.20', '10.0.0.7', '172.20.1.1']);
});

test('start in wifi mode starts the LAN door and reports port and addresses; status is waiting', async () => {
  const t = setup();
  const r = await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'dev1', name: 'Test PC' });
  assert.deepStrictEqual(r, { ok: true, port: 47821, addresses: ['192.168.1.20', '10.0.0.7', '172.20.1.1'] });
  assert.strictEqual(t.lan.started, 1);
  assert.strictEqual(t.status.at(-1).state, 'waiting');
  assert.match(t.status.at(-1).text, /Waiting for your phone/);
  assert.strictEqual(t.timers.filter(x => !x.off).length, 0, 'no relay timer in wifi mode');
});

test('hello, peek and sync over the LAN', async () => {
  const t = setup();
  await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'dev1', name: 'Test PC' });
  assert.deepStrictEqual(await t.lan.handler({ op: 'peek' }), { ok: true, rev: '' }, 'nothing published yet');
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  assert.deepStrictEqual(await t.lan.handler({ op: 'peek' }), { ok: true, rev: 'r:a' });
  assert.deepStrictEqual(await t.lan.handler({ op: 'hello', nonce: 'n1' }), { ok: true, nonce: 'n1', name: 'Test PC', rev: 'r:a' });
  const r = await t.lan.handler({ op: 'sync', rev: 'r:b', doc: { items: ['b'] } });
  assert.deepStrictEqual(r, { ok: true, rev: 'r:a,b', doc: { items: ['a', 'b'] } });
  assert.strictEqual((await t.lan.handler({ op: 'peek' })).rev, 'r:a,b', 'the merged data is now the latest');
  assert.strictEqual(t.status.at(-1).state, 'connected');
  assert.match(t.status.at(-1).text, /^Synced \d\d:\d\d$/);
});

test('bad messages are refused: unknown op, missing doc, non-object doc, page failure', async () => {
  const t = setup({ askPage: async () => { throw new Error('page gone'); } });
  await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'd', name: 'x' });
  await assert.rejects(t.lan.handler({ op: 'format' }));
  await assert.rejects(t.lan.handler({ op: 'sync', rev: 'x' }));
  await assert.rejects(t.lan.handler({ op: 'sync', rev: 'x', doc: [] }));
  await assert.rejects(t.lan.handler({ op: 'sync', rev: 'x', doc: { items: [] } }), /page gone/);
  await assert.rejects(t.lan.handler(null));
});

test('a page answer without rev or doc is not trusted', async () => {
  const t = setup({ askPage: async () => ({ rev: 5 }) });
  await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'd', name: 'x' });
  await assert.rejects(t.lan.handler({ op: 'sync', rev: 'x', doc: { items: [] } }));
});

test('start rejects a bad secret, a bad mode, and net mode without a relay address', async () => {
  const t = setup();
  await assert.rejects(t.svc.start({ secretB64: 'short', mode: 'wifi', deviceId: 'd', name: 'x' }));
  await assert.rejects(t.svc.start({ secretB64: SECRET, mode: 'lan', deviceId: 'd', name: 'x' }));
  await assert.rejects(t.svc.start({ secretB64: SECRET, mode: 'net', deviceId: 'd', name: 'x' }));
  await assert.rejects(t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'http://example.com', deviceId: 'd', name: 'x' }));
});

test('relay: with no data there yet, the first cycle puts the published data (prev 0)', async () => {
  const t = setup();
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  assert.strictEqual(t.timers.filter(x => !x.off).length >= 1, true, 'a repeating timer is set');
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  await t.svc.runCycle();
  assert.strictEqual(t.relayStore.puts.length, 1);
  assert.deepStrictEqual(open(t.relayStore.puts[0]), { rev: 'r:a', doc: { items: ['a'] } });
});

test('relay: remote data that differs is merged through the page and written back', async () => {
  const t = setup();
  t.relayStore.rec = { rev: '4', body: body('r:z', ['z']) };
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  await t.svc.runCycle();
  assert.deepStrictEqual(t.page.doc, { items: ['a', 'z'] });
  assert.strictEqual(t.relayStore.rec.rev, '5');
  assert.deepStrictEqual(open(t.relayStore.rec.body), { rev: 'r:a,z', doc: { items: ['a', 'z'] } });
  assert.match(t.status.at(-1).text, /^Synced/);
});

test('relay: when the remote already equals ours nothing is written', async () => {
  const t = setup();
  t.relayStore.rec = { rev: '2', body: body('r:a', ['a']) };
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  await t.svc.runCycle();
  assert.strictEqual(t.relayStore.puts.length, 0);
});

test('relay: a conflict (someone wrote between our read and our write) is retried and nothing is lost', async () => {
  const t = setup();
  t.relayStore.rec = { rev: '1', body: body('r:z', ['z']) };
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  t.relayStore.beforePut = () => { t.relayStore.rec = { rev: '2', body: body('r:q', ['q']) }; };
  await t.svc.runCycle();
  assert.deepStrictEqual(open(t.relayStore.rec.body).doc.items, ['a', 'q', 'z']);
  assert.strictEqual(t.relayStore.rec.rev, '3');
  assert.match(t.status.at(-1).text, /^Synced/);
});

test('relay: unreadable or unreachable relay gives a plain status, never a thrown error, and the timer survives', async () => {
  const t = setup();
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  t.relayStore.getErr = new RelayError('network', 'Cannot reach the relay.');
  await t.svc.runCycle();
  assert.strictEqual(t.status.at(-1).state, 'error'); assert.match(t.status.at(-1).text, /Cannot reach the relay/);
  t.relayStore.getErr = new RelayError('auth', 'x');
  await t.svc.runCycle();
  assert.match(t.status.at(-1).text, /not recogni[sz]ed|connection/i);
  t.relayStore.getErr = null;
  t.relayStore.rec = { rev: '1', body: JSON.stringify({ v: 1, i: 'AAAA', c: 'BBBB' }) };
  await t.svc.runCycle();
  assert.strictEqual(t.status.at(-1).state, 'error');
  for (const s of t.status) assert.ok(!JSON.stringify(s).includes(SECRET) && !JSON.stringify(s).includes(keys.token));
});

test('publish schedules a prompt relay cycle; stop clears timers, stops the LAN door and goes quiet', async () => {
  const t = setup();
  await t.svc.start({ secretB64: SECRET, mode: 'both', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  const before = t.timers.length;
  t.svc.publish({ rev: 'r:a', doc: { items: ['a'] } });
  assert.ok(t.timers.length > before, 'a short timer was added');
  await t.svc.stop();
  assert.strictEqual(t.lan.stopped, 1);
  assert.ok(t.timers.every(x => x.off));
  assert.strictEqual(t.status.at(-1).state, 'off');
  const n = t.relayStore.puts.length; await t.svc.runCycle(); assert.strictEqual(t.relayStore.puts.length, n, 'no cycle after stop');
});

test('forget(): stops and deletes the room on the relay', async () => {
  const t = setup();
  t.relayStore.rec = { rev: '1', body: 'x' };
  await t.svc.start({ secretB64: SECRET, mode: 'net', relayUrl: 'https://r.example.dev', deviceId: 'd', name: 'x' });
  await t.svc.forget();
  assert.strictEqual(t.relayStore.rec, null);
  assert.strictEqual(t.status.at(-1).state, 'off');
});

test('start twice replaces the first run (one LAN door at a time)', async () => {
  const t = setup();
  await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'd', name: 'x' });
  await t.svc.start({ secretB64: SECRET, mode: 'wifi', deviceId: 'd', name: 'x' });
  assert.strictEqual(t.lan.started, 2); assert.strictEqual(t.lan.stopped, 1);
});
