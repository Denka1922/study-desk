'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, read } = require('./helpers');

test('app/index.html is the Study Desk page with the AI hosts only', () => {
  const html = read('app/index.html');
  assert.match(html, /<title>Study Desk/);
  const csp = html.match(/<meta[^>]+Content-Security-Policy[^>]+>/i);
  assert.ok(csp, 'CSP meta present');
  const cs = csp[0].match(/connect-src([^;"]*)/);
  assert.ok(cs, 'connect-src present');
  const hosts = cs[1].trim().split(/\s+/).filter(x => x.startsWith('https://')).sort();
  assert.deepStrictEqual(hosts, [
    'https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com']);
});

test('app/index.html has no test export', () => {
  assert.ok(!read('app/index.html').includes('window.SDAI'));
});

test('app/index.html is byte-identical to the planner build when it is present', t => {
  const src = path.resolve(ROOT, '..', 'planner', 'study-desk-local.html');
  if (!fs.existsSync(src)) return t.skip('planner folder not present');
  assert.ok(fs.readFileSync(src).equals(fs.readFileSync(path.join(ROOT, 'app/index.html'))));
});
