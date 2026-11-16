#!/usr/bin/env node
'use strict';
// Runs every test that can run without Electron or Android.
//   node scripts/check.js          all tests (needs Playwright)
//   node scripts/check.js --ci     skips *.pw.test.js (GitHub runner)
//   node scripts/check.js --stamp  writes the page's CSP hashes (see site/index.html)
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(__dirname, 'tests');
const args = process.argv.slice(2);
const ci = args.includes('--ci');

function stamp() {
  const { stampHtml } = require('./csp-hash');
  const file = path.join(ROOT, 'site', 'index.html');
  fs.writeFileSync(file, stampHtml(fs.readFileSync(file, 'utf8')));
  console.log('stamped site/index.html');
}

if (args.includes('--stamp')) { stamp(); process.exit(0); }

let status = 0;
const nodeTests = fs.existsSync(TESTS)
  ? fs.readdirSync(TESTS).filter(f => f.endsWith('.test.js') && !(ci && f.endsWith('.pw.test.js'))).map(f => path.join(TESTS, f))
  : [];
if (nodeTests.length) {
  const r = cp.spawnSync(process.execPath, ['--test', ...nodeTests], { stdio: 'inherit' });
  if (r.status !== 0) status = 1;
}
const pyTests = fs.existsSync(TESTS) && fs.readdirSync(TESTS).some(f => /^test_.*\.py$/.test(f));
if (pyTests) {
  const r = cp.spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', TESTS, '-p', 'test_*.py'], { stdio: 'inherit' });
  if (r.status !== 0) status = 1;
}
process.exit(status);
