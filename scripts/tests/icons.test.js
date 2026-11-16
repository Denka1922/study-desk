'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

function pngSize(rel) {
  const b = fs.readFileSync(path.join(ROOT, rel));
  assert.strictEqual(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', rel + ' is a PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('desktop icon.png is 512x512', () => assert.deepStrictEqual(pngSize('desktop/icon.png'), [512, 512]));
test('mobile icon-only.png is 1024x1024', () => assert.deepStrictEqual(pngSize('mobile/assets/icon-only.png'), [1024, 1024]));

test('icon.ico has all sizes and a real 256 image', () => {
  const b = fs.readFileSync(path.join(ROOT, 'desktop/icon.ico'));
  assert.strictEqual(b.subarray(0, 4).toString('hex'), '00000100');
  const n = b.readUInt16LE(4);
  const sizes = {};
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    sizes[b[o] || 256] = b.readUInt32LE(o + 8);
  }
  for (const s of [16, 32, 48, 64, 128, 256]) assert.ok(s in sizes, 'has ' + s);
  assert.ok(sizes[256] > 1024, '256 entry is not blank');
});
