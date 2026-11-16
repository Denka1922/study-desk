'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');
const { hostAllowed, loadCatalog, validateCatalog } = require('../../desktop/ai/catalog');

const HEX64 = /^[0-9a-f]{64}$/;

test('hostAllowed accepts only https on the allowlisted hosts and their subdomains', () => {
  for (const u of [
    'https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip',
    'https://huggingface.co/x/y',
    'https://cdn-lfs.hf.co/x',
    'https://objects.githubusercontent.com/x',
    'https://release-assets.githubusercontent.com/x',
  ]) assert.strictEqual(hostAllowed(u), true, u);
  for (const u of [
    'http://huggingface.co/x',
    'https://evil.example/x',
    'https://huggingface.co.evil.example/x',
    'https://user:pw@huggingface.co/x',
    'https://nothuggingface.co/x',
    'ftp://github.com/x',
    'not a url',
    '',
  ]) assert.strictEqual(hostAllowed(u), false, u);
});

test('the shipped catalog is valid', () => {
  const c = loadCatalog();
  assert.deepStrictEqual(validateCatalog(c), []);
  assert.strictEqual(c.engine.tag, 'b12360');
  assert.deepStrictEqual(Object.keys(c.engine.assets).sort(), ['mac-arm64', 'mac-x64', 'win-x64-cpu', 'win-x64-vulkan']);
  for (const a of Object.values(c.engine.assets)) {
    assert.match(a.sha256, HEX64);
    assert.ok(a.sizeBytes > 1e6);
    assert.ok(hostAllowed(a.url) && a.url.endsWith(a.file));
  }
  const enabled = c.models.filter(m => m.enabled);
  assert.ok(enabled.length >= 2, 'at least two enabled models');
  for (const m of enabled) {
    assert.match(m.sha256, HEX64, m.id);
    assert.ok(m.sizeBytes > 1e8, m.id);
    assert.ok(hostAllowed(m.url) && m.url.endsWith(m.file), m.id);
    assert.match(m.url, /\/resolve\/[0-9a-f]{40}\//, m.id);
  }
});

test('catalog has a strongly multilingual model and every model names its license', () => {
  const c = loadCatalog();
  const need = ['Turkish', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Russian', 'Arabic'];
  const multi = c.models.filter(m => need.every(l => m.languages.strong.includes(l)));
  assert.ok(multi.length >= 1, 'a model with all tutor languages strong');
  for (const m of c.models) { assert.ok(m.license && m.license.name, m.id); assert.ok(m.languages.strong.length > 0, m.id); }
  const ids = c.models.map(m => m.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('catalog includes the Nemotron and GLM families from the design', () => {
  const fam = new Set(loadCatalog().models.map(m => m.family));
  assert.ok(fam.has('nemotron') && fam.has('glm'));
});

test('validateCatalog reports the problems it should', () => {
  const good = loadCatalog();
  const clone = () => JSON.parse(JSON.stringify(good));
  let c = clone(); c.models[0].enabled = true; c.models[0].sha256 = null;
  assert.ok(validateCatalog(c).some(p => /sha256/.test(p)));
  c = clone(); c.models.push(JSON.parse(JSON.stringify(c.models[0])));
  assert.ok(validateCatalog(c).some(p => /duplicate/i.test(p)));
  c = clone(); c.models[0].url = 'https://evil.example/m.gguf';
  assert.ok(validateCatalog(c).some(p => /url|host/i.test(p)));
  c = clone(); delete c.models[0].license;
  assert.ok(validateCatalog(c).some(p => /license/.test(p)));
});

test('verify-catalog workflow is manual-only with read-only permissions', () => {
  const y = read('.github/workflows/verify-catalog.yml');
  assert.match(y, /workflow_dispatch/);
  assert.ok(!/\bpush:|\bpull_request|\bschedule:/.test(y), 'no automatic triggers');
  assert.match(y, /permissions:\s*\n\s*contents: read/);
  assert.match(y, /pin-catalog\.js --verify/);
});

const TOO_BIG = ['nemotron-3-super-120b-a12b', 'nemotron-3.5-super-vl-120b-a12b', 'nemotron-3-ultra-550b-a55b'];

test('the catalog lists the Nemotron 3.5 Lightning 30B model', () => {
  const m = loadCatalog().models.find(x => x.id === 'nemotron-3.5-lightning-30b-a3b');
  assert.ok(m, 'Lightning is in the catalog');
  assert.strictEqual(m.family, 'nemotron');
  assert.match(m.url, /^https:\/\/huggingface\.co\/.+\/resolve\/(main|[0-9a-f]{40})\//);
});

test('Super and Ultra are listed as too big for normal PCs and can never be downloaded', () => {
  const c = loadCatalog();
  for (const id of TOO_BIG) {
    const m = c.models.find(x => x.id === id);
    assert.ok(m, id + ' is listed');
    assert.strictEqual(m.listOnly, true, id);
    assert.strictEqual(m.enabled, false, id);
    assert.ok(typeof m.needs === 'string' && m.needs.length > 10, id + ' says what it needs');
    assert.ok(!m.url && !m.file && !m.sha256, id + ' has no download');
    assert.ok(m.license && m.license.name, id + ' has a licence');
  }
  assert.deepStrictEqual(validateCatalog(c), []);
});

test('validateCatalog rejects a list-only model that is enabled or has a download address', () => {
  const clone = () => JSON.parse(JSON.stringify(loadCatalog()));
  let c = clone(); c.models.find(m => m.id === TOO_BIG[0]).enabled = true;
  assert.ok(validateCatalog(c).some(p => /list-only/i.test(p)));
  c = clone(); c.models.find(m => m.id === TOO_BIG[0]).url = 'https://huggingface.co/x/y/resolve/main/z.gguf';
  assert.ok(validateCatalog(c).some(p => /list-only/i.test(p)));
  c = clone(); delete c.models.find(m => m.id === TOO_BIG[0]).needs;
  assert.ok(validateCatalog(c).some(p => /needs/i.test(p)));
});
