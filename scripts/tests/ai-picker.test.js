'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCatalog } = require('../../desktop/ai/catalog');
const { LEVEL_ORDER, budgetFor } = require('../../desktop/ai/levels');
const { readHardware, engineAssetFor } = require('../../desktop/ai/hardware');
const { languageFit, estimateNeedBytes, recommend } = require('../../desktop/ai/picker');

const GiB = 1024 ** 3;
const hw = (gib, o = {}) => Object.assign({
  platform: 'win32', arch: 'x64', totalRamBytes: gib * GiB, freeRamBytes: gib * GiB * 0.75, cores: 8,
  gpu: { present: false, vendor: 'unknown', name: '' }, appleSilicon: false,
}, o);

// the shipped catalog, with the not-yet-confirmed models switched on so the table can be exercised
function allOn() {
  const c = loadCatalog();
  for (const m of c.models) { if (m.listOnly) continue; m.enabled = true; m.sha256 = m.sha256 || 'a'.repeat(64); }
  return c;
}

test('level order is fixed', () => {
  assert.deepStrictEqual(LEVEL_ORDER, ['light', 'medium', 'high', 'xhigh', 'max']);
});

test('budgetFor follows the level table', () => {
  const h = hw(16, { freeRamBytes: 16 * GiB });
  let b = budgetFor('light', h);
  assert.strictEqual(b.ramBytes, Math.floor(16 * GiB * 0.25));
  assert.strictEqual(b.threads, 2); assert.strictEqual(b.ctx, 4096);
  b = budgetFor('medium', h); assert.strictEqual(b.threads, 4); assert.strictEqual(b.ctx, 8192);
  b = budgetFor('high', h); assert.strictEqual(b.threads, 5); assert.strictEqual(b.ctx, 12288);
  b = budgetFor('xhigh', h); assert.strictEqual(b.threads, 6); assert.strictEqual(b.ctx, 16384);
  b = budgetFor('max', h);
  assert.ok(Math.abs(b.ramBytes - 16 * GiB * 0.85) <= 2, 'max = 85% of RAM');
  assert.strictEqual(b.threads, 8); assert.strictEqual(b.ctx, 32768);
  for (const l of LEVEL_ORDER) assert.ok(budgetFor(l, h).maxAnswerTokens > 0 && budgetFor(l, h).maxAnswerTokens < budgetFor(l, h).ctx);
});

test('budgetFor never lets threads reach 0 and never exceeds free RAM minus the reserve', () => {
  assert.strictEqual(budgetFor('light', hw(8, { cores: 1 })).threads, 1);
  const low = hw(16, { freeRamBytes: 3 * GiB });
  const reserve = Math.max(2 * GiB, 0.15 * low.totalRamBytes);
  assert.ok(budgetFor('max', low).ramBytes <= low.freeRamBytes - reserve + 1);
  assert.strictEqual(budgetFor('max', hw(8, { freeRamBytes: 1 * GiB })).ramBytes, 0, 'no negative budgets');
  assert.throws(() => budgetFor('turbo', hw(16)), /level/i);
});

test('on a Mac the free-memory reading is not used (macOS reports cache as used)', () => {
  const mac = hw(16, { platform: 'darwin', arch: 'arm64', appleSilicon: true, freeRamBytes: 0.5 * GiB });
  assert.strictEqual(budgetFor('medium', mac).ramBytes, Math.floor(16 * GiB * 0.4));
});

test('engineAssetFor picks the right engine build', () => {
  assert.strictEqual(engineAssetFor(hw(16, { gpu: { present: true, vendor: 'nvidia', name: 'RTX' } })), 'win-x64-vulkan');
  assert.strictEqual(engineAssetFor(hw(16)), 'win-x64-cpu');
  assert.strictEqual(engineAssetFor(hw(16, { platform: 'darwin', arch: 'arm64', appleSilicon: true })), 'mac-arm64');
  assert.strictEqual(engineAssetFor(hw(16, { platform: 'darwin', arch: 'x64' })), 'mac-x64');
  assert.strictEqual(engineAssetFor(hw(16, { platform: 'linux' })), null);
  assert.strictEqual(engineAssetFor(hw(16, { platform: 'freebsd' })), null);
});

test('readHardware reads the machine and survives missing GPU info', async () => {
  const os = { totalmem: () => 16 * GiB, freemem: () => 9 * GiB, cpus: () => new Array(12).fill({}) };
  let h = await readHardware({ os, platform: 'win32', arch: 'x64', getGpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 3060', active: true }] }) });
  assert.deepStrictEqual([h.platform, h.arch, h.totalRamBytes, h.freeRamBytes, h.cores], ['win32', 'x64', 16 * GiB, 9 * GiB, 12]);
  assert.deepStrictEqual(h.gpu, { present: true, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' });
  assert.strictEqual(h.appleSilicon, false);
  h = await readHardware({ os, platform: 'win32', arch: 'x64', getGpuInfo: async () => { throw new Error('no gpu api'); } });
  assert.strictEqual(h.gpu.present, false);
  h = await readHardware({ os, platform: 'win32', arch: 'x64', getGpuInfo: async () => null });
  assert.strictEqual(h.gpu.present, false);
  h = await readHardware({ os, platform: 'darwin', arch: 'arm64', getGpuInfo: async () => null });
  assert.strictEqual(h.appleSilicon, true); assert.strictEqual(h.gpu.vendor, 'apple'); assert.strictEqual(h.gpu.present, true);
});

test('languageFit and estimateNeedBytes', () => {
  const c = allOn();
  const qwen = c.models.find(m => m.id === 'qwen3-4b'), nemo = c.models.find(m => m.id === 'nemotron-3-nano-4b');
  assert.strictEqual(languageFit(qwen, 'Turkish'), 'strong');
  assert.strictEqual(languageFit(nemo, 'English'), 'strong');
  assert.strictEqual(languageFit(nemo, 'Turkish'), 'weak');
  assert.strictEqual(languageFit(c.models.find(m => m.id === 'nemotron-nano-9b-v2'), 'German'), 'fair');
  assert.strictEqual(estimateNeedBytes(nemo, 8192), nemo.sizeBytes + nemo.kvBytesPerToken * 8192 + 600e6);
});

test('a 4 GB PC gets no local model and is pointed to the CLI option', () => {
  const r = recommend({ hardware: hw(4), level: 'max', language: 'English', catalog: allOn() });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.suggest, 'cli'); assert.ok(r.reason.length > 10);
});

test('8 GB: the small model from High up, never the 6.5 GB one; Medium is too low and says so', () => {
  const c = loadCatalog();
  let r = recommend({ hardware: hw(8), level: 'high', language: 'English', catalog: c });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.model.id, 'nemotron-3-nano-4b');
  assert.strictEqual(r.engineAsset, 'win-x64-cpu');
  r = recommend({ hardware: hw(8), level: 'medium', language: 'English', catalog: c });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.raiseTo, 'high'); assert.strictEqual(r.suggest, 'cli');
});

test('16 GB at High gets an 8B-9B class model; the shipped catalog never offers disabled or list-only models', () => {
  const c = loadCatalog();
  const r = recommend({ hardware: hw(16), level: 'high', language: 'English', catalog: c });
  assert.strictEqual(r.model.id, 'qwen3-8b');
  assert.ok(c.models.filter(m => !m.enabled).every(m => m.listOnly), 'everything not enabled is list-only');
  const r32 = recommend({ hardware: hw(32, { freeRamBytes: 28 * GiB }), level: 'xhigh', language: 'English', catalog: c });
  assert.ok(r32.ok && r32.model.enabled && !r32.model.listOnly);
});

test('32 GB at xhigh gets Nemotron 3.5 Lightning once it is enabled and fits', () => {
  const r = recommend({ hardware: hw(32, { freeRamBytes: 28 * GiB }), level: 'xhigh', language: 'English', catalog: allOn() });
  assert.strictEqual(r.model.id, 'nemotron-3.5-lightning-30b-a3b');
  const c = allOn(); c.models = c.models.filter(m => m.id !== 'nemotron-3.5-lightning-30b-a3b');
  // among equal tiers the smaller file wins, so without Lightning the 8B Qwen3 is chosen
  assert.strictEqual(recommend({ hardware: hw(32, { freeRamBytes: 28 * GiB }), level: 'xhigh', language: 'English', catalog: c }).model.id, 'qwen3-8b');
});

test('Turkish prefers a strong Turkish model when the tier loss is one step', () => {
  const r = recommend({ hardware: hw(16), level: 'high', language: 'Turkish', catalog: allOn() });
  assert.strictEqual(r.model.id, 'qwen3-8b'); assert.strictEqual(r.languageFit, 'strong');
});

test('when only a weak-language model fits, the answer says so in plain words', () => {
  const r = recommend({ hardware: hw(8), level: 'high', language: 'Turkish', catalog: loadCatalog() });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.languageFit, 'weak');
  assert.ok(r.reasons.some(s => /Turkish/.test(s) && /(weak|not strong|less)/i.test(s)), r.reasons.join(' | '));
});

test('upgrade is the next larger enabled model that fits one level higher, else null', () => {
  const big = hw(32, { freeRamBytes: 28 * GiB });
  const up = recommend({ hardware: big, level: 'high', language: 'English', catalog: allOn() });
  assert.strictEqual(up.model.id, 'qwen3-8b'); assert.strictEqual(up.upgrade.id, 'nemotron-3.5-lightning-30b-a3b');
  assert.strictEqual(recommend({ hardware: big, level: 'max', language: 'English', catalog: allOn() }).upgrade, null);
  assert.strictEqual(recommend({ hardware: hw(8), level: 'high', language: 'English', catalog: loadCatalog() }).upgrade, null);
});

test('Linux or an unknown platform is not supported for Local', () => {
  const r = recommend({ hardware: hw(32, { platform: 'linux' }), level: 'high', language: 'English', catalog: loadCatalog() });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.suggest, 'api');
});

test('the reasons list says how much memory the choice uses', () => {
  const r = recommend({ hardware: hw(16), level: 'high', language: 'English', catalog: loadCatalog() });
  assert.ok(r.reasons.some(s => /GB/.test(s)));
});

test('a list-only model is never recommended, even on a huge computer', () => {
  const catalog = loadCatalog();
  const hardware = { platform: 'win32', arch: 'x64', totalRamBytes: 2048 * 2 ** 30, freeRamBytes: 2000 * 2 ** 30, cpuThreads: 64, gpus: [] };
  for (const level of LEVEL_ORDER) {
    const r = recommend({ hardware, level, language: 'English', catalog });
    if (r.ok) assert.ok(!r.model.listOnly, level + ' picked ' + r.model.id);
  }
});

test('a Turkish student on a 32 GB computer still gets a strong-Turkish model, not the weak-Turkish top model', () => {
  const hardware = hw(32, { freeRamBytes: 28 * GiB });
  const r = recommend({ hardware, level: 'max', language: 'Turkish', catalog: allOn() });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.languageFit, 'strong'); assert.strictEqual(r.model.id, 'qwen3-8b');
  const en = recommend({ hardware, level: 'max', language: 'English', catalog: allOn() });
  assert.strictEqual(en.model.id, 'nemotron-3.5-lightning-30b-a3b');
});
