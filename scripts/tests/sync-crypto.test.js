'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../desktop/sync/crypto');

// Vector made with an independent implementation (Python cryptography). The page's WebCrypto code is tested against the same values.
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const IV = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
const V = {
  enc: '909442ab696566fa64107012f950b2688c9c7a8a2eade29d1d81ffa477e45091',
  room: 'b23ef471b1cce42136810fd9ab71c38c',
  token: '-IGDF-KpeNBEn89HgTbzojHCpZxJLrx-K3Ym7o8gWWI',
  i: 'oKGio6Slpqeoqaqr',
  c: 'S3Qjz2R73ctMfUUS_5mYAv3D_QW3-i6-x6qt4kCxu4vQb70Dz55t9SQXo2Y',
};

test('keys match the independent vector', () => {
  const k = C.deriveKeys(SECRET);
  assert.strictEqual(k.encKey.toString('hex'), V.enc);
  assert.strictEqual(k.room, V.room);
  assert.strictEqual(k.token, V.token);
});

test('seal with a fixed IV gives the vector, and open reads it back', () => {
  const k = C.deriveKeys(SECRET);
  const env = C.seal(k, { op: 'hello', nonce: 'abc' }, IV);
  assert.deepStrictEqual(env, { v: 1, i: V.i, c: V.c });
  assert.deepStrictEqual(C.open(k, env), { op: 'hello', nonce: 'abc' });
});

test('seal uses a fresh IV every time', () => {
  const k = C.deriveKeys(SECRET);
  const a = C.seal(k, { x: 1 }), b = C.seal(k, { x: 1 });
  assert.notStrictEqual(a.i, b.i); assert.notStrictEqual(a.c, b.c);
});

test('open rejects a wrong key, a changed byte, a changed IV, a wrong version and junk, with a typed error', () => {
  const k = C.deriveKeys(SECRET), k2 = C.deriveKeys(Buffer.alloc(32, 7));
  const env = C.seal(k, { a: 'ö' });
  const flip = s => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const bad = [
    [k2, env], [k, { ...env, c: flip(env.c) }], [k, { ...env, i: flip(env.i) }], [k, { ...env, v: 2 }],
    [k, null], [k, 'text'], [k, {}], [k, { v: 1, i: 'x', c: 'y' }], [k, { v: 1, i: env.i, c: '' }], [k, { v: 1, i: 5, c: 6 }],
  ];
  for (const [key, e] of bad) assert.throws(() => C.open(key, e), err => err instanceof C.SyncCryptoError);
});

test('base64url helpers round trip and refuse other characters', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) { const b = Buffer.alloc(n, 255); assert.deepStrictEqual(C.fromB64url(C.b64url(b)), b); }
  assert.strictEqual(C.b64url(Buffer.from([251, 255])), '-_8');
  assert.throws(() => C.fromB64url('a+b/'), C.SyncCryptoError);
  assert.throws(() => C.fromB64url('a b'), C.SyncCryptoError);
});

test('deriveKeys needs exactly 32 bytes; random helpers have the right shape', () => {
  assert.throws(() => C.deriveKeys(Buffer.alloc(31)), C.SyncCryptoError);
  assert.throws(() => C.deriveKeys('nope'), C.SyncCryptoError);
  assert.strictEqual(C.randomSecret().length, 32);
  assert.notDeepStrictEqual(C.randomSecret(), C.randomSecret());
  assert.match(C.randomId(), /^[0-9a-f]{16}$/);
  assert.match(C.b64url(C.randomSecret()), /^[A-Za-z0-9_-]{43}$/);
});
