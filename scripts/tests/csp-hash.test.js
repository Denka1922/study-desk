'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');
const { hashOf, stampHtml } = require('../csp-hash');

const metaHashes = h => {
  const c = h.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  return [c.match(/script-src '([^']+)'/)[1], c.match(/style-src '([^']+)'/)[1]];
};

test('hash ignores line-ending style, like the browser does', () => {
  assert.strictEqual(hashOf('a\r\nb\rc\nd'), hashOf('a\nb\nc\nd'));
});

test('stamping a CRLF copy of the page gives the same hashes as the LF page', () => {
  const lf = stampHtml(read('site/index.html'));
  const crlf = stampHtml(read('site/index.html').replace(/\r?\n/g, '\r\n'));
  assert.deepStrictEqual(metaHashes(crlf), metaHashes(lf));
});
