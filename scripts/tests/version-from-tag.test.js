'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');
const { versionFromRef } = require('../version-from-tag');

const CLI = path.resolve(__dirname, '../version-from-tag.js');

test('release tags give their version', () => {
  assert.strictEqual(versionFromRef('v1.2.0'), '1.2.0');
  assert.strictEqual(versionFromRef('refs/tags/v10.20.30'), '10.20.30');
  assert.strictEqual(versionFromRef('refs/tags/v0.1.0'), '0.1.0');
});

test('manual runs get a clearly marked version', () => {
  assert.strictEqual(versionFromRef('refs/heads/main', '12'), '0.0.0-manual.12');
  assert.strictEqual(versionFromRef('refs/heads/feature/x', '3'), '0.0.0-manual.3');
});

test('anything else is rejected, including text meant for a shell (Review Focus 4)', () => {
  const bad = ['v1', 'v1.2', 'v01.2.3', 'v1.02.3', 'vX', 'v1.0.0;echo hi', 'v1.0.0-rc.1', 'v1.0.0 ', 'v1.0.0\n',
    '$(id)', '`id`', 'v1.0.0 && id', 'refs/tags/v1.0.0/extra', 'refs/tags/', 'refs/heads', 'main', '', 'x'.repeat(300),
    'v1.2.3.4', 'V1.2.3', 'v1.2.99999999999999999999'];
  for (const r of bad) assert.throws(() => versionFromRef(r, '1'), undefined, JSON.stringify(r));
  for (const n of ['1; rm -rf', '', undefined, '-1', '1.5', 'x', '1'.repeat(30)]) {
    assert.throws(() => versionFromRef('refs/heads/main', n), undefined, String(n));
  }
  for (const v of [null, undefined, 42, {}, []]) assert.throws(() => versionFromRef(v, '1'));
});

test('command line prints the version, or fails with a message', () => {
  const ok = cp.spawnSync(process.execPath, [CLI, 'refs/tags/v2.0.1', '5'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout, '2.0.1\n');
  const bad = cp.spawnSync(process.execPath, [CLI, 'v1.0.0;echo hi', '5'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stdout, '');
  assert.match(bad.stderr, /not a release version/i);
});
