'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, walk } = require('./helpers');

// Patterns are built from pieces so this file never matches itself.
const P = (a, b) => new RegExp(a + b);
const PATTERNS = [
  ['google-style key', P('AQ\\.', '[A-Za-z0-9_-]{30,}')],
  ['google api key', P('AI' + 'za', '[0-9A-Za-z_-]{30,}')],
  ['anthropic key', P('sk-' + 'ant-', '[A-Za-z0-9_-]{20,}')],
  ['openai key', P('sk' + '-', '[A-Za-z0-9]{32,}')],
  ['private key block', P('-----BEGIN ', '[A-Z ]*PRIVATE KEY-----')],
  ['github token', P('gh' + '[pous]_', '[A-Za-z0-9]{30,}')],
  ['github pat', P('github' + '_pat_', '[A-Za-z0-9_]{10,}')],
];
const BAD_NAMES = /(\.jks|\.keystore|\.p12|\.pfx|\.apk|\.aab)$|^keystore\.properties$/i;
const SKIP = ['node_modules', '.sdd', 'dist', 'mobile/android/.gradle'];
const BIN = /\.(png|ico|jar|zip|webp|jpg)$/i;

test('no key-shaped strings or signing files anywhere in the project', () => {
  const bad = [];
  for (const f of walk(ROOT, SKIP)) {
    const rel = path.relative(ROOT, f);
    if (BAD_NAMES.test(path.basename(f))) bad.push('file: ' + rel);
    if (BIN.test(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    for (const [name, re] of PATTERNS) if (re.test(txt)) bad.push(name + ' in ' + rel);
  }
  assert.deepStrictEqual(bad, []);
});
