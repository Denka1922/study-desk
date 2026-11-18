'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../desktop/sync/crypto');
const { createRelayClient, RelayError, cleanRelayUrl } = require('../../desktop/sync/relay-client');

const keys = C.deriveKeys(Buffer.alloc(32, 5));
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const r = await handler(url, init, calls.length); return new Response(r.body === undefined ? null : r.body, { status: r.status }); };
  f.calls = calls; return f;
}

test('cleanRelayUrl accepts https (and local http for tests), strips trailing slashes, refuses the rest', () => {
  assert.strictEqual(cleanRelayUrl('https://sd.example.workers.dev/'), 'https://sd.example.workers.dev');
  assert.strictEqual(cleanRelayUrl(' https://sd.example.workers.dev '), 'https://sd.example.workers.dev');
  assert.strictEqual(cleanRelayUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const bad of ['http://example.com', 'ftp://x', 'javascript:1', 'https://', 'https://user:pw@example.com', 'https://example.com/a?b=1', '', null, 5, 'https://' + 'a'.repeat(300) + '.com'])
    assert.strictEqual(cleanRelayUrl(bad), '', String(bad));
});

test('get: sends the bearer token to the room address; 404 means no data', async () => {
  const f = fakeFetch(() => ({ status: 404, body: '{"error":"No data yet"}' }));
  const c = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: f });
  assert.strictEqual(await c.get(), null);
  assert.strictEqual(f.calls[0].url, 'https://r.example.dev/v1/room/' + keys.room);
  assert.strictEqual(f.calls[0].init.method, 'GET');
  assert.strictEqual(f.calls[0].init.headers.authorization, 'Bearer ' + keys.token);
});

test('get returns rev and body; put sends body and prev and returns the new rev', async () => {
  const f = fakeFetch((u, init) => init.method === 'GET' ? { status: 200, body: '{"rev":"3","body":"abc"}' } : { status: 200, body: '{"rev":"4"}' });
  const c = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: f });
  assert.deepStrictEqual(await c.get(), { rev: '3', body: 'abc' });
  assert.deepStrictEqual(await c.put('xyz', '3'), { rev: '4' });
  assert.deepStrictEqual(JSON.parse(f.calls[1].init.body), { body: 'xyz', prev: '3' });
  await c.put('nope');
  assert.deepStrictEqual(JSON.parse(f.calls[2].init.body), { body: 'nope' });
});

test('errors are typed: conflict (with the current rev), auth, toobig, network, bad answer', async () => {
  const mk = (status, body) => createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: fakeFetch(() => ({ status, body })) });
  await assert.rejects(mk(409, '{"rev":"7"}').put('x', '6'), e => e instanceof RelayError && e.kind === 'conflict' && e.rev === '7');
  await assert.rejects(mk(401, '{"error":"Wrong key"}').get(), e => e.kind === 'auth');
  await assert.rejects(mk(413, '{"error":"big"}').put('x'), e => e.kind === 'toobig');
  await assert.rejects(mk(500, 'x').get(), e => e.kind === 'server');
  await assert.rejects(mk(200, 'not json').get(), e => e.kind === 'bad');
  await assert.rejects(mk(200, '{"rev":5,"body":1}').get(), e => e.kind === 'bad');
  const down = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.get(), e => e.kind === 'network');
});

test('health and del; the token never appears in an error message', async () => {
  const f = fakeFetch((u, init) => init.method === 'DELETE' ? { status: 204 } : { status: 200, body: '{"ok":true,"app":"study-desk-relay"}' });
  const c = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: f });
  assert.strictEqual(await c.health(), true);
  await c.del();
  assert.strictEqual(f.calls[1].init.method, 'DELETE');
  const wrong = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: fakeFetch(() => ({ status: 200, body: '{"ok":true,"app":"other"}' })) });
  assert.strictEqual(await wrong.health(), false);
  const bad = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: async () => { throw new Error('boom ' + keys.token); } });
  await assert.rejects(bad.get(), e => !String(e.message).includes(keys.token));
});

test('a request that hangs is cut off by the timeout', async () => {
  const hang = (u, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const c = createRelayClient({ baseUrl: 'https://r.example.dev', keys, fetchImpl: hang, timeoutMs: 50 });
  await assert.rejects(c.get(), e => e.kind === 'network');
});

test('constructing with a bad address throws', () => {
  assert.throws(() => createRelayClient({ baseUrl: 'http://example.com', keys }), RelayError);
});
