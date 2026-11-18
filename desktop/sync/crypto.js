'use strict';
// Keys and sealed messages for sync. The format is written down in SYNC.md and the page (WebCrypto) must produce and read exactly the same bytes.
const nodeCrypto = require('node:crypto');

const SALT = Buffer.from('study-desk-sync-v1', 'utf8');
const AAD = SALT;

class SyncCryptoError extends Error { constructor(m) { super(m || 'Could not read the sync message.'); this.name = 'SyncCryptoError'; } }

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new SyncCryptoError('Bad encoding.');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
const hkdf = (secret, info, n) => Buffer.from(nodeCrypto.hkdfSync('sha256', secret, SALT, Buffer.from(info, 'utf8'), n));

function deriveKeys(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new SyncCryptoError('The secret must be 32 bytes.');
  return { encKey: hkdf(secret, 'enc', 32), room: hkdf(secret, 'room', 16).toString('hex'), token: b64url(hkdf(secret, 'relay-token', 32)) };
}

function seal(keys, obj, iv) {
  const useIv = iv || nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', keys.encKey, useIv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, i: b64url(useIv), c: b64url(ct) };
}

function open(keys, env) {
  try {
    if (!env || typeof env !== 'object' || env.v !== 1 || typeof env.i !== 'string' || typeof env.c !== 'string') throw new SyncCryptoError();
    const iv = fromB64url(env.i), all = fromB64url(env.c);
    if (iv.length !== 12 || all.length < 16) throw new SyncCryptoError();
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', keys.encKey, iv);
    d.setAAD(AAD); d.setAuthTag(all.subarray(all.length - 16));
    const pt = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch (e) {
    throw e instanceof SyncCryptoError ? e : new SyncCryptoError();
  }
}

module.exports = { SyncCryptoError, b64url, fromB64url, deriveKeys, seal, open, randomSecret: () => nodeCrypto.randomBytes(32), randomId: () => nodeCrypto.randomBytes(8).toString('hex') };
