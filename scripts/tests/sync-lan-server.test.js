'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const C = require('../../desktop/sync/crypto');
const { createLanServer, isPrivateAddress } = require('../../desktop/sync/lan-server');

const keys = C.deriveKeys(Buffer.alloc(32, 9));
const other = C.deriveKeys(Buffer.alloc(32, 3));

function post(port, path, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...(data !== null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers }, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
async function start(over = {}) {
  let t = 1000000;
  const clock = { advance: ms => { t += ms; } };
  const srv = createLanServer({ getKeys: () => keys, onMessage: async m => ({ ok: true, echo: m }), now: () => t, portStart: 0, portEnd: 0, host: '127.0.0.1', ...over });
  const { port } = await srv.start();
  return { srv, port, clock };
}

test('a good request is decrypted, answered and the answer is sealed', async () => {
  const { srv, port } = await start();
  try {
    const r = await post(port, '/v1/x', C.seal(keys, { op: 'peek', from: 'a' }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(C.open(keys, JSON.parse(r.text)), { ok: true, echo: { op: 'peek', from: 'a' } });
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.ok(!r.text.includes('peek'));
  } finally { await srv.stop(); }
});

test('every other path or method is 404 with an empty body', async () => {
  const { srv, port } = await start();
  try {
    for (const [m, p] of [['GET', '/'], ['GET', '/v1/x'], ['POST', '/'], ['POST', '/v1/y'], ['PUT', '/v1/x'], ['DELETE', '/v1/x'], ['POST', '/v1/x/'], ['POST', '/v1/x?a=1x']]) {
      const r = await post(port, p, C.seal(keys, { op: 'peek' }), { method: m });
      if (m === 'POST' && p === '/v1/x?a=1x') { assert.strictEqual(r.status, 200); continue; } // a query string does not change the route
      assert.strictEqual(r.status, 404, m + ' ' + p); assert.strictEqual(r.text, '');
    }
  } finally { await srv.stop(); }
});

test('bad JSON or a malformed envelope is 400; a wrong key is 401 with an empty body', async () => {
  const { srv, port } = await start();
  try {
    assert.strictEqual((await post(port, '/v1/x', '{nope')).status, 400);
    assert.strictEqual((await post(port, '/v1/x', '[1]')).status, 400);
    assert.strictEqual((await post(port, '/v1/x', 'null')).status, 400);
    const r = await post(port, '/v1/x', C.seal(other, { op: 'peek' }));
    assert.strictEqual(r.status, 401); assert.strictEqual(r.text, '');
    assert.strictEqual((await post(port, '/v1/x', { v: 1, i: 'x', c: 'y' })).status, 401);
  } finally { await srv.stop(); }
});

test('a body over 8 MB is 413', async () => {
  const { srv, port } = await start();
  try {
    const big = '{"v":1,"i":"x","c":"' + 'A'.repeat(8 * 1024 * 1024) + '"}';
    const r = await post(port, '/v1/x', big).catch(e => ({ status: 'closed:' + e.code }));
    assert.ok(r.status === 413 || String(r.status).startsWith('closed:'), String(r.status));
    assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'peek' }))).status, 200); // still alive
  } finally { await srv.stop(); }
});

test('a remote address that is not private is 403 and never reaches onMessage', async () => {
  let called = 0;
  const { srv, port } = await start({ isPrivateAddress: () => false, onMessage: async () => { called++; return {}; } });
  try {
    assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'peek' }))).status, 403);
    assert.strictEqual(called, 0);
  } finally { await srv.stop(); }
});

test('more than 20 failed decryptions in a minute from one address is 429 for the next minute', async () => {
  const { srv, port, clock } = await start();
  try {
    const bad = C.seal(other, { op: 'peek' });
    const codes = [];
    for (let n = 0; n < 24; n++) codes.push((await post(port, '/v1/x', bad)).status);
    assert.deepStrictEqual(codes.slice(0, 20), Array(20).fill(401));
    assert.strictEqual(codes[23], 429);
    assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'peek' }))).status, 429, 'even a good request waits');
    clock.advance(61000);
    assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'peek' }))).status, 200);
  } finally { await srv.stop(); }
});

test('503 when the app window does not answer in time; 500 when onMessage fails', async () => {
  let mode = 'slow';
  const { srv, port } = await start({ requestTimeoutMs: 80, onMessage: () => mode === 'slow' ? new Promise(() => {}) : Promise.reject(new Error('boom secret')) });
  try {
    assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'sync' }))).status, 503);
    mode = 'throw';
    const r = await post(port, '/v1/x', C.seal(keys, { op: 'sync' }));
    assert.strictEqual(r.status, 500); assert.ok(!r.text.includes('secret'));
  } finally { await srv.stop(); }
});

test('no keys (not paired) means the server answers 503 instead of guessing', async () => {
  const { srv, port } = await start({ getKeys: () => null });
  try { assert.strictEqual((await post(port, '/v1/x', C.seal(keys, { op: 'peek' }))).status, 503); } finally { await srv.stop(); }
});

test('port fallback: the next free port is used, and stop() frees it', async () => {
  const blocker = http.createServer(); await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const p0 = blocker.address().port;
  const srv = createLanServer({ getKeys: () => keys, onMessage: async () => ({}), portStart: p0, portEnd: p0 + 5, host: '127.0.0.1' });
  const { port } = await srv.start();
  assert.ok(port > p0 && port <= p0 + 5);
  await srv.stop(); await new Promise(r => blocker.close(r));
  const srv2 = createLanServer({ getKeys: () => keys, onMessage: async () => ({}), portStart: port, portEnd: port, host: '127.0.0.1' });
  assert.strictEqual((await srv2.start()).port, port);
  await srv2.stop();
});

test('start fails with a clear error when every port is busy', async () => {
  const blocker = http.createServer(); await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const p0 = blocker.address().port;
  const srv = createLanServer({ getKeys: () => keys, onMessage: async () => ({}), portStart: p0, portEnd: p0, host: '127.0.0.1' });
  await assert.rejects(srv.start(), /port/i);
  await new Promise(r => blocker.close(r));
});

test('isPrivateAddress knows the private and the public ranges', () => {
  const yes = ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.254', '169.254.1.1', '127.0.0.1', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:192.168.1.5', '::ffff:10.1.2.3', '::ffff:127.0.0.1'];
  const no = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1', '11.0.0.1', '100.64.0.1', '2001:4860:4860::8888', 'fec0::1', '::ffff:8.8.8.8', '', undefined, null, 'garbage', '999.1.1.1'];
  for (const a of yes) assert.strictEqual(isPrivateAddress(a), true, String(a));
  for (const a of no) assert.strictEqual(isPrivateAddress(a), false, String(a));
});
