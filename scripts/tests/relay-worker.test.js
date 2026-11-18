'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKER = pathToFileURL(path.resolve(__dirname, '..', '..', 'relay', 'worker.js')).href;
const load = () => import(WORKER);

const MAX = 2 * 1024 * 1024;
const NINETY_DAYS = 90 * 24 * 60 * 60;
const ROOM = 'a'.repeat(32);
const ROOM2 = '0123456789abcdef0123456789abcdef';
const TOKEN = 'dG9rZW4tZm9yLXRlc3RzLW9ubHktbm90LXJlYWw';
const OTHER = 'b3RoZXItdG9rZW4tZm9yLXRlc3RzLW9ubHk';

// Small in-memory stand-in for a Cloudflare KV namespace. It records every put (with its options).
function fakeKV() {
  const data = new Map();
  const puts = [];
  return {
    data, puts,
    async get(key, type) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) { puts.push({ key, value, opts }); data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

async function setup() {
  const mod = await load();
  const kv = fakeKV();
  const env = { ROOMS: kv };
  const call = (method, p, { token, body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (token !== undefined) h.authorization = 'Bearer ' + token;
    const init = { method, headers: h };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    return mod.default.fetch(new Request('https://relay.test' + p, init), env);
  };
  return { mod, kv, env, call };
}
const json = async (res) => JSON.parse(await res.text());

test('health answers without any token', async () => {
  const { call } = await setup();
  const res = await call('GET', '/v1/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await json(res), { ok: true, app: 'study-desk-relay' });
});

test('GET on a room that has no data yet is 404', async () => {
  const { call } = await setup();
  const res = await call('GET', '/v1/room/' + ROOM, { token: TOKEN });
  assert.strictEqual(res.status, 404);
  assert.ok(typeof (await json(res)).error === 'string');
});

test('first PUT creates the room and returns rev "1"', async () => {
  const { call } = await setup();
  const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'hello' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await json(res), { rev: '1' });
});

test('GET returns the stored body and rev', async () => {
  const { call } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: '{"v":1,"i":"x","c":"y"}' } });
  const res = await call('GET', '/v1/room/' + ROOM, { token: TOKEN });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await json(res), { rev: '1', body: '{"v":1,"i":"x","c":"y"}' });
});

test('Turkish letters and an empty string survive the round trip', async () => {
  const { call } = await setup();
  const txt = 'Öğrenci Çalışma ğüşiı İŞ 😀';
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: txt } });
  assert.strictEqual((await json(await call('GET', '/v1/room/' + ROOM, { token: TOKEN }))).body, txt);
  const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: '' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await json(await call('GET', '/v1/room/' + ROOM, { token: TOKEN })), { rev: '2', body: '' });
});

test('a wrong or missing token is 401 on GET, PUT and DELETE, and changes nothing', async () => {
  const { call, kv } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'secret-ish' } });
  const before = kv.data.get(ROOM);
  for (const t of [OTHER, '', 'x']) {
    assert.strictEqual((await call('GET', '/v1/room/' + ROOM, { token: t })).status, 401);
    assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: t, body: { body: 'evil' } })).status, 401);
    assert.strictEqual((await call('DELETE', '/v1/room/' + ROOM, { token: t })).status, 401);
  }
  // no Authorization header at all, and a header that is not Bearer
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM)).status, 401);
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { body: { body: 'evil' } })).status, 401);
  assert.strictEqual((await call('DELETE', '/v1/room/' + ROOM)).status, 401);
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM, { headers: { authorization: 'Basic ' + TOKEN } })).status, 401);
  assert.strictEqual(kv.data.get(ROOM), before);
  assert.strictEqual(kv.puts.length, 1);
  const res = await call('GET', '/v1/room/' + ROOM, { token: OTHER });
  assert.ok(!(await res.clone().text()).includes('secret-ish'), '401 never leaks data');
});

test('the right token increments rev on every PUT', async () => {
  const { call } = await setup();
  for (let n = 1; n <= 4; n++) {
    const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'v' + n } });
    assert.deepStrictEqual(await json(res), { rev: String(n) });
  }
  assert.deepStrictEqual(await json(await call('GET', '/v1/room/' + ROOM, { token: TOKEN })), { rev: '4', body: 'v4' });
});

test('stale prev is 409 with the current rev and does not overwrite; matching prev works', async () => {
  const { call } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'one' } });
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'two', prev: '1' } }); // matches -> rev 2
  const stale = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'late', prev: '1' } });
  assert.strictEqual(stale.status, 409);
  assert.deepStrictEqual(await json(stale), { rev: '2' });
  assert.deepStrictEqual(await json(await call('GET', '/v1/room/' + ROOM, { token: TOKEN })), { rev: '2', body: 'two' });
  const ok = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'three', prev: '2' } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await json(ok), { rev: '3' });
  // a number is accepted as well as a string, and a future prev is also a mismatch
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'four', prev: 3 } })).status, 200);
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'x', prev: '99' } })).status, 409);
});

test('prev on a room that does not exist: "0" is fine, anything else is 409 with rev "0"', async () => {
  const { call } = await setup();
  const stale = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a', prev: '5' } });
  assert.strictEqual(stale.status, 409);
  assert.deepStrictEqual(await json(stale), { rev: '0' });
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM, { token: TOKEN })).status, 404);
  const ok = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a', prev: '0' } });
  assert.deepStrictEqual(await json(ok), { rev: '1' });
});

test('a prev that is not a non-negative whole number is 400', async () => {
  const { call } = await setup();
  for (const prev of ['abc', '-1', '1.5', -1, 1.5, {}, [], true, '']) {
    const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a', prev } });
    assert.strictEqual(res.status, 400, JSON.stringify(prev));
  }
});

test('a request body over 2 MB is 413: by Content-Length, and by the real size', async () => {
  const { call, kv } = await setup();
  // 1. the header alone is enough (the small body is never read)
  const h = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'x' }, headers: { 'content-length': String(MAX + 1) } });
  assert.strictEqual(h.status, 413);
  // 2. no header (or a lying one), the real body is too big
  const big = JSON.stringify({ body: 'x'.repeat(MAX) });
  assert.ok(Buffer.byteLength(big) > MAX);
  const b = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: big });
  assert.strictEqual(b.status, 413);
  const lie = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: big, headers: { 'content-length': '10' } });
  assert.strictEqual(lie.status, 413);
  // 3. multi-byte text counts in bytes, not characters
  const wide = JSON.stringify({ body: 'ç'.repeat(MAX / 2) });
  assert.ok(wide.length < MAX + 20 && Buffer.byteLength(wide) > MAX);
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: wide })).status, 413);
  assert.strictEqual(kv.puts.length, 0, 'nothing stored');
  assert.ok(typeof (await json(h)).error === 'string');
});

test('a request of exactly 2 MB is accepted, one byte more is not', async () => {
  const { call } = await setup();
  const frame = JSON.stringify({ body: '' });
  const exact = JSON.stringify({ body: 'x'.repeat(MAX - Buffer.byteLength(frame)) });
  assert.strictEqual(Buffer.byteLength(exact), MAX);
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: exact })).status, 200);
  const over = JSON.stringify({ body: 'x'.repeat(MAX - Buffer.byteLength(frame) + 1) });
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM2, { token: TOKEN, raw: over })).status, 413);
});

test('a malformed room id is 404 (never touches storage), on every method', async () => {
  const { call, kv } = await setup();
  const bad = ['abc', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '../' + 'a'.repeat(29), 'a'.repeat(32) + '/x', '%61'.repeat(32), ''];
  for (const r of bad) {
    for (const m of ['GET', 'PUT', 'DELETE']) {
      const res = await call(m, '/v1/room/' + r, { token: TOKEN, body: m === 'PUT' ? { body: 'x' } : undefined });
      assert.strictEqual(res.status, 404, m + ' ' + r);
    }
  }
  assert.strictEqual(kv.puts.length, 0);
});

test('malformed JSON is 400', async () => {
  const { call, kv } = await setup();
  for (const raw of ['{nope', '', '{"body":', 'null', '[]', '"text"', '12']) {
    const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw });
    assert.strictEqual(res.status, 400, JSON.stringify(raw));
    assert.ok(typeof (await json(res)).error === 'string');
  }
  assert.strictEqual(kv.puts.length, 0);
});

test('a body that is not a string (or is missing) is 400', async () => {
  const { call, kv } = await setup();
  for (const b of [{}, { body: 5 }, { body: null }, { body: { a: 1 } }, { body: ['x'] }, { body: true }, { prev: '1' }]) {
    const res = await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: b });
    assert.strictEqual(res.status, 400, JSON.stringify(b));
  }
  assert.strictEqual(kv.puts.length, 0);
});

test('a wrong token on an existing room is 401 even when the JSON is bad (auth is checked first)', async () => {
  const { call } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a' } });
  assert.strictEqual((await call('PUT', '/v1/room/' + ROOM, { token: OTHER, raw: '{nope' })).status, 401);
});

test('DELETE removes the room: 204, then GET is 404, and the room can be used again from rev 1', async () => {
  const { call, kv } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a' } });
  const del = await call('DELETE', '/v1/room/' + ROOM, { token: TOKEN });
  assert.strictEqual(del.status, 204);
  assert.strictEqual(await del.text(), '');
  assert.strictEqual(kv.data.size, 0);
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM, { token: TOKEN })).status, 404);
  // a different token can now claim the empty room (the secret is new after "Forget this connection")
  const again = await call('PUT', '/v1/room/' + ROOM, { token: OTHER, body: { body: 'b' } });
  assert.deepStrictEqual(await json(again), { rev: '1' });
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM, { token: TOKEN })).status, 401);
});

test('DELETE on a room that does not exist is 204 (nothing to forget)', async () => {
  const { call } = await setup();
  assert.strictEqual((await call('DELETE', '/v1/room/' + ROOM, { token: TOKEN })).status, 204);
});

test('every put to KV has a 90-day expirationTtl', async () => {
  const { call, kv } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a' } });
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'b', prev: '1' } });
  await call('PUT', '/v1/room/' + ROOM2, { token: OTHER, body: { body: 'c' } });
  assert.strictEqual(kv.puts.length, 3);
  for (const p of kv.puts) assert.strictEqual(p.opts && p.opts.expirationTtl, NINETY_DAYS);
});

test('the token is never stored in plain form: only its SHA-256 hex', async () => {
  const { call, kv } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'payload' } });
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'payload2', prev: '1' } });
  const everything = JSON.stringify([...kv.data.entries()]) + JSON.stringify(kv.puts);
  assert.ok(!everything.includes(TOKEN), 'plain token must not appear in KV');
  assert.ok(!everything.includes(Buffer.from(TOKEN).toString('hex')));
  assert.ok(!everything.includes(Buffer.from(TOKEN).toString('base64')));
  const rec = JSON.parse(kv.data.get(ROOM));
  assert.deepStrictEqual(Object.keys(rec).sort(), ['body', 'h', 'rev']);
  assert.strictEqual(rec.h, crypto.createHash('sha256').update(TOKEN).digest('hex'));
  assert.strictEqual(rec.rev, 2);
  assert.strictEqual(rec.body, 'payload2');
});

test('rooms are independent of each other', async () => {
  const { call } = await setup();
  await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'one' } });
  await call('PUT', '/v1/room/' + ROOM2, { token: OTHER, body: { body: 'two' } });
  assert.strictEqual((await json(await call('GET', '/v1/room/' + ROOM, { token: TOKEN }))).body, 'one');
  assert.strictEqual((await json(await call('GET', '/v1/room/' + ROOM2, { token: OTHER }))).body, 'two');
  assert.strictEqual((await call('GET', '/v1/room/' + ROOM2, { token: TOKEN })).status, 401);
});

test('unknown paths are 404, known paths with the wrong method are 405', async () => {
  const { call } = await setup();
  for (const p of ['/', '/v1', '/v1/', '/v2/health', '/health', '/v1/healthz', '/v1/health/', '/v1/room', '/v1/room/', '/admin', '/v1/rooms/' + ROOM, '//v1/health']) {
    const res = await call('GET', p, { token: TOKEN });
    assert.strictEqual(res.status, 404, p);
    assert.ok(typeof (await json(res)).error === 'string');
  }
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.strictEqual((await call(m, '/v1/health', { raw: m === 'GET' ? undefined : '{}' })).status, 405, m);
  for (const m of ['POST', 'PATCH', 'HEAD', 'OPTIONS']) {
    const res = await call(m, '/v1/room/' + ROOM, { token: TOKEN });
    assert.strictEqual(res.status, 405, m);
    assert.ok(/GET/.test(res.headers.get('allow') || ''), 'Allow header lists the allowed methods');
  }
});

test('CORS is not enabled: no access-control headers, and a preflight is not answered', async () => {
  const { call } = await setup();
  const all = [
    await call('GET', '/v1/health', { headers: { origin: 'https://evil.example' } }),
    await call('GET', '/v1/room/' + ROOM, { token: TOKEN, headers: { origin: 'https://evil.example' } }),
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a' }, headers: { origin: 'https://evil.example' } }),
    await call('OPTIONS', '/v1/room/' + ROOM, { headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } }),
    await call('GET', '/nothing'),
  ];
  for (const res of all) {
    for (const [k] of res.headers) assert.ok(!/^access-control-/i.test(k), 'unexpected header ' + k);
  }
  assert.strictEqual(all[3].status, 405);
});

test('every response says cache-control: no-store, sets no cookies, and errors are JSON', async () => {
  const { call } = await setup();
  const responses = [
    await call('GET', '/v1/health'),
    await call('GET', '/nope'),
    await call('POST', '/v1/health'),
    await call('GET', '/v1/room/' + ROOM, { token: TOKEN }),                                  // 404
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'a' } }),            // 200
    await call('GET', '/v1/room/' + ROOM, { token: TOKEN }),                                  // 200
    await call('GET', '/v1/room/' + ROOM, { token: OTHER }),                                  // 401
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'b', prev: '9' } }), // 409
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: '{bad' }),                    // 400
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'x' }, headers: { 'content-length': String(MAX + 1) } }), // 413
    await call('GET', '/v1/room/xyz', { token: TOKEN }),                                      // 404
    await call('DELETE', '/v1/room/' + ROOM, { token: OTHER }),                               // 401
    await call('DELETE', '/v1/room/' + ROOM, { token: TOKEN }),                               // 204
  ];
  assert.deepStrictEqual(responses.map(r => r.status), [200, 404, 405, 404, 200, 200, 401, 409, 400, 413, 404, 401, 204]);
  for (const res of responses) {
    assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'status ' + res.status);
    assert.strictEqual(res.headers.get('set-cookie'), null);
    if (res.status >= 400) {
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const o = JSON.parse(await res.text());
      if (res.status === 409) assert.strictEqual(typeof o.rev, 'string'); // a conflict answers with the current rev (SYNC.md)
      else assert.ok(typeof o.error === 'string');
    }
  }
});

test('storage problems give a JSON 500 that does not echo the request or the token', async () => {
  const mod = await load();
  const broken = { ROOMS: { get: async () => { throw new Error('kv down ' + TOKEN); }, put: async () => { throw new Error('x'); }, delete: async () => { throw new Error('x'); } } };
  const req = (m) => new Request('https://relay.test/v1/room/' + ROOM, { method: m, headers: { authorization: 'Bearer ' + TOKEN }, body: m === 'PUT' ? JSON.stringify({ body: 'SECRETBODY' }) : undefined });
  for (const m of ['GET', 'PUT', 'DELETE']) {
    const res = await mod.default.fetch(req(m), broken);
    const txt = await res.text();
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.ok(typeof JSON.parse(txt).error === 'string');
    assert.ok(!txt.includes(TOKEN) && !txt.includes('SECRETBODY'));
  }
  // a missing ROOMS binding is explained, not a crash
  const res = await mod.default.fetch(req('GET'), {});
  assert.strictEqual(res.status, 500);
  assert.match((await json(res)).error, /ROOMS/);
  // ... but health still works
  assert.strictEqual((await mod.default.fetch(new Request('https://relay.test/v1/health'), {})).status, 200);
});

test('the worker never logs (no request data can reach the console)', async () => {
  const seen = [];
  const keep = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { keep[k] = console[k]; console[k] = (...a) => seen.push(a); }
  try {
    const { call } = await setup();
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, body: { body: 'SECRETBODY' } });
    await call('GET', '/v1/room/' + ROOM, { token: OTHER });
    await call('PUT', '/v1/room/' + ROOM, { token: TOKEN, raw: '{bad' });
  } finally { for (const k in keep) console[k] = keep[k]; }
  assert.deepStrictEqual(seen, []);
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '..', '..', 'relay', 'worker.js'), 'utf8');
  assert.ok(!/console\./.test(src), 'worker.js has no console calls');
});

test('exports: handle() is the same as default.fetch', async () => {
  const mod = await load();
  assert.strictEqual(typeof mod.handle, 'function');
  const res = await mod.handle(new Request('https://relay.test/v1/health'), { ROOMS: fakeKV() });
  assert.strictEqual(res.status, 200);
});
