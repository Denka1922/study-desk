'use strict';
// The Local and CLI screens, run in the real page with a scripted fake desktop bridge.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlaywright, pageWithExports } = require('./helpers');

const PG = pageWithExports(['ai', 'render', 'aiSettingsGet', 'aiSettingsSet', 'aiUsageAdd', 'aiUsageReset']);
test.after(() => PG.cleanup());

const BRIDGE = `
(function () {
  var G = 1e9;
  var LIC = function (n) { return { name: n + ' License', url: 'https://example.org/' + n }; };
  var M4 = { id: 'nemotron-3-nano-4b', name: 'NVIDIA Nemotron 3 Nano 4B', params: '4B', sizeBytes: 2.8 * G, line: 'Fast and small.', tier: 2, license: LIC('nemo4') };
  var M9 = { id: 'nemotron-nano-9b-v2', name: 'NVIDIA Nemotron Nano 9B v2', params: '9B', sizeBytes: 6.5 * G, line: 'Stronger, needs more memory.', tier: 3, license: LIC('nemo9') };
  var BIG = { high: 1, xhigh: 1, max: 1 };
  var fb = window.__fb = { calls: [], installed: [], running: null, cb: null, installImpl: null, startImpl: null, detectImpl: null, recImpl: null,
    hw: { platform: 'win32', arch: 'x64', totalRamBytes: 16 * 1073741824, freeRamBytes: 12 * 1073741824, cores: 8, gpu: { present: true, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' }, appleSilicon: false },
    tools: [
      { id: 'codex', name: 'OpenAI Codex CLI', found: true, version: 'codex-cli 0.9.1', dataGoes: 'cloud', install: 'Install Node.js, then run: npm install -g @openai/codex', login: 'Run "codex login" once in a terminal and sign in.' },
      { id: 'gemini', name: 'Gemini CLI', found: false, version: null, dataGoes: 'cloud', install: 'Install Node.js, then run: npm install -g @google/gemini-cli', login: 'Run "gemini" once in a terminal and sign in.' },
      { id: 'goose', name: 'goose', found: true, version: 'goose 1.2', dataGoes: 'depends', install: 'Install goose from https://block.github.io/goose', login: 'Run "goose configure" once.' } ] };
  function models(level, lang) {
    return [M4, M9].map(function (m) { return Object.assign({}, m, { fit: (lang === 'Turkish' && m === M4) ? 'weak' : 'strong', fits: m === M4 ? true : !!BIG[level] }); });
  }
  function rec(a) {
    var ms = models(a.level, a.language), m = BIG[a.level] ? M9 : M4, fit = (a.language === 'Turkish' && m === M4) ? 'weak' : 'strong';
    var r = { ok: true, model: m, engineAsset: 'win-x64-vulkan', languageFit: fit, budget: { ramBytes: (a.level === 'light' ? 4 : a.level === 'medium' ? 6.4 : 8.8) * G, threads: 4, ctx: 8192 },
      reasons: ['Uses about 3.7 GB of your 16.0 GB memory at the ' + a.level + ' level.'], upgrade: a.level === 'medium' ? M9 : null, models: ms };
    if (fit !== 'strong') r.reasons.push(m.name + ' is weak in ' + a.language + ', so explanations may be less clear. Switch the tutor language to English or pick another model.');
    return r;
  }
  function rec2(a) { fb.calls.push(['recommend', a]); return fb.recImpl ? fb.recImpl(a) : Promise.resolve(rec(a)); }
  window.studyDesk = { ai: { version: 1,
    chat: function (req) { fb.calls.push(['chat', req]); return Promise.resolve({ text: window.__chatText ? window.__chatText(req) : 'ok', cut: false, usage: { input: 100, output: 20, estimated: false } }); },
    cancelChat: function () { return Promise.resolve({}); },
    getHardware: function () { fb.calls.push(['getHardware']); return Promise.resolve(fb.hw); },
    recommend: rec2,
    local: {
      status: function () { fb.calls.push(['status']); return Promise.resolve({ installed: fb.installed.map(function (id) { return { modelId: id, sizeBytes: 1 }; }), engineInstalled: fb.installed.length > 0, running: fb.running, diskFreeBytes: 500 * G }); },
      install: function (a) { fb.calls.push(['install', a]); return fb.installImpl ? fb.installImpl(a) : Promise.resolve({}); },
      cancel: function () { fb.calls.push(['cancel']); return Promise.resolve({}); },
      remove: function (a) { fb.calls.push(['remove', a]); fb.installed = fb.installed.filter(function (i) { return i !== a.modelId; }); return Promise.resolve({}); },
      removeAll: function () { return Promise.resolve({}); },
      start: function (a) { fb.calls.push(['start', a]); if (fb.startImpl) return fb.startImpl(a); fb.running = a; return Promise.resolve({ running: a }); },
      stop: function () { fb.calls.push(['stop']); fb.running = null; return Promise.resolve({}); },
      onProgress: function (cb) { fb.cb = cb; return function () { fb.cb = null; }; } },
    cli: { detect: function () { fb.calls.push(['detect']); return fb.detectImpl ? fb.detectImpl() : Promise.resolve(fb.tools); } } } };
})();`;

const outline = n => JSON.stringify({ title: 'Geometry Basics', summary: 'A short course.', lessons: Array.from({ length: n }, (_, i) => ({ title: 'Lesson ' + (i + 1), goal: 'Goal ' + (i + 1) })) });
const lessonJson = i => JSON.stringify({ sections: [{ heading: 'Part A', body: 'Body ' + i }], keyPoints: ['Key ' + i], example: 'Example ' + i, quiz: [0, 1, 2, 3].map(j => ({ q: 'Q' + j + ' of lesson ' + i + '?', options: [0, 1, 2, 3].map(k => 'q' + j + '-o' + k), answer: j, explanation: 'Because ' + j })) });
const examJson = n => JSON.stringify({ questions: Array.from({ length: n }, (_, i) => ({ q: 'EQ' + i + '?', options: [0, 1, 2, 3].map(k => 'e' + i + '-o' + k), answer: i % 4, explanation: 'Exp ' + i, lesson: i % 3 })) });

let browserP = null;
async function browser() { if (!browserP) browserP = Promise.resolve(loadPlaywright().chromium.launch()); return browserP; }
test.after(async () => { if (browserP) await (await browserP).close(); });

async function open(opts = {}) {
  const ctx = await (await browser()).newContext({ viewport: { width: opts.width || 1280, height: opts.height || 900 } });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (opts.theme) await page.addInitScript(t => { try { localStorage.setItem('sd-theme', t); } catch (e) {} }, opts.theme);
  if (opts.bridge !== false) await page.addInitScript(BRIDGE);
  if (opts.pre) await page.addInitScript(opts.pre);
  await page.goto(PG.url); await page.waitForSelector('.glance');
  if (opts.theme) await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), opts.theme);
  return { ctx, page, errors };
}
const goTutor = async page => { await page.click('.side [data-view="tutor"]'); };
const calls = (page, name) => page.evaluate(n => window.__fb.calls.filter(c => c[0] === n), name);
const text = (page, sel) => page.locator(sel).innerText();
const setSettings = (page, s) => page.evaluate(x => aiSettingsSet(Object.assign(aiSettingsGet(), x)), s);

test('without the bridge the setup screen is exactly the API form', async () => {
  const { ctx, page, errors } = await open({ bridge: false });
  await goTutor(page); await page.waitForSelector('#ai-setup-form');
  assert.strictEqual(await page.locator('.ai-source, #ai-local, #ai-cli, [data-act="ai-source"]').count(), 0);
  assert.strictEqual(await page.locator('#ai-provider').count(), 1);
  assert.strictEqual(await page.locator('#ai-usage').count(), 0);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('with the bridge: Local and CLI tabs, and the online-key link switches to the API form and back', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.waitForSelector('#ai-local');
  const tabs = page.locator('.ai-source [role="tab"]');
  assert.deepStrictEqual(await tabs.allInnerTexts(), ['Local', 'CLI']);
  assert.strictEqual(await page.locator('.ai-source [role="tab"][aria-selected="true"]').innerText(), 'Local');
  assert.strictEqual(await page.locator('#ai-setup-form').count(), 0);
  await page.click('.ai-source [data-act="ai-source"][data-src="cli"]'); await page.waitForSelector('#ai-cli');
  assert.strictEqual(await page.locator('.ai-source [role="tab"][aria-selected="true"]').innerText(), 'CLI');
  await page.click('.ai-source .ai-linkbtn'); await page.waitForSelector('#ai-setup-form');
  assert.strictEqual(await page.locator('.ai-source [role="tab"][aria-selected="true"]').count(), 0, 'no tab is selected on the online-key form');
  assert.match(await text(page, '.ai-source .ai-linkbtn'), /Use Local or CLI instead/);
  assert.strictEqual(await page.locator('#ai-local, #ai-cli').count(), 0);
  await page.click('.ai-source .ai-linkbtn'); await page.waitForSelector('#ai-cli');
  assert.strictEqual(await page.locator('.ai-source [role="tab"][aria-selected="true"]').innerText(), 'CLI', 'back goes to the tab that was open before');
  assert.match(await text(page, '.ai-source .ai-linkbtn'), /Use an online key instead/);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: hardware, recommendation, levels, language warning, upgrade offer, license', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.waitForSelector('#ai-local-model');
  const hw = await text(page, '#ai-local-hw');
  assert.match(hw, /16(\.0)? GB/); assert.match(hw, /8 cores/); assert.match(hw, /NVIDIA GeForce RTX 3060/);
  const m = await text(page, '#ai-local-model');
  assert.match(m, /Nemotron 3 Nano 4B/); assert.match(m, /2\.8 GB/); assert.match(m, /Fast and small/);
  assert.match(await text(page, '#ai-local-why'), /Uses about 3\.7 GB/);
  assert.deepStrictEqual(await page.locator('.ai-levels [data-act="ai-level"]').allInnerTexts(), ['Light', 'Medium', 'High', 'Extra high', 'Max']);
  assert.strictEqual(await page.locator('.ai-levels [aria-pressed="true"]').innerText(), 'Medium');
  assert.strictEqual(await page.locator('#ai-local-langwarn').count(), 0, 'no warning for English');
  assert.match(await text(page, '#ai-local-upgrade'), /Nemotron Nano 9B v2/);
  const lic = page.locator('#ai-local-license a'); assert.match(await lic.innerText(), /NVIDIA|nemo4/i);
  assert.strictEqual(await lic.getAttribute('href'), 'https://example.org/nemo4'); assert.match(await lic.getAttribute('rel'), /noopener/);
  // level change asks again and updates the model line
  await page.click('[data-act="ai-level"][data-level="high"]');
  await page.waitForFunction(() => /Nano 9B/.test(document.querySelector('#ai-local-model').innerText));
  const rc = await calls(page, 'recommend'); assert.strictEqual(rc[rc.length - 1][1].level, 'high'); assert.strictEqual(typeof rc[rc.length - 1][1].language, 'string');
  assert.strictEqual(await page.locator('.ai-levels [aria-pressed="true"]').innerText(), 'High');
  assert.strictEqual((await page.evaluate(() => aiSettingsGet())).level, 'medium', 'looking at a level does not change the saved one; Start does');
  assert.strictEqual(await page.locator('#ai-local-upgrade').count(), 0, 'no upgrade offer when nothing bigger fits');
  // language warning appears for a weak language
  await page.click('[data-act="ai-level"][data-level="light"]');
  await page.selectOption('#ai-local-lang', 'Turkish');
  await page.waitForSelector('#ai-local-langwarn');
  assert.match(await text(page, '#ai-local-langwarn'), /weak in Turkish/);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: another model can be chosen; one that is too big is refused with the reason', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.waitForSelector('#ai-local-models');
  const rows = await page.locator('#ai-local-models [data-act="ai-local-model"]').allInnerTexts();
  assert.strictEqual(rows.length, 2); assert.ok(/fits/i.test(rows[0]) && /too big/i.test(rows[1]), JSON.stringify(rows));
  await page.click('#ai-local-models [data-id="nemotron-nano-9b-v2"]');
  assert.match(await text(page, '#ai-local-err'), /needs more memory/i);
  assert.match(await text(page, '#ai-local-model'), /Nemotron 3 Nano 4B/, 'the choice did not change');
  await page.click('[data-act="ai-level"][data-level="max"]');
  await page.waitForFunction(() => /Nano 9B/.test(document.querySelector('#ai-local-model').innerText));
  await page.click('#ai-local-models [data-id="nemotron-3-nano-4b"]');
  assert.match(await text(page, '#ai-local-model'), /Nemotron 3 Nano 4B/);
  assert.strictEqual(await page.locator('#ai-local-err').innerText(), '');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: models that no normal computer can run are listed apart, cannot be clicked, and say what they need', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.waitForSelector('#ai-local-models');
  // the scripted bridge answers with two normal models plus two list-only ones
  await page.evaluate(() => {
    var big = function (id, name, params, needs) { return { id: id, name: name, params: params, sizeBytes: null, line: 'A huge model.', tier: 6, fit: 'strong', fits: false, tooBig: true, needs: needs }; };
    var old = window.studyDesk.ai.recommend;
    window.studyDesk.ai.recommend = function (a) { return old(a).then(function (r) { r.models = r.models.concat([
      big('nemotron-3-super-120b-a12b', 'NVIDIA Nemotron 3 Super 120B', '120B', 'A workstation with about 96 GB of memory.'),
      big('nemotron-3-ultra-550b-a55b', 'NVIDIA Nemotron 3 Ultra 550B', '550B', 'A server with several hundred GB of memory.')]); return r; }); };
  });
  await page.click('[data-act="ai-level"][data-level="max"]');
  await page.waitForSelector('#ai-local-toobig');
  const clickable = await page.locator('#ai-local-models [data-act="ai-local-model"]').count();
  assert.strictEqual(clickable, 2, 'only the two normal models can be clicked');
  const box = await text(page, '#ai-local-toobig');
  assert.match(box, /Too big for normal computers/i);
  assert.match(box, /Nemotron 3 Ultra 550B/); assert.match(box, /several hundred GB/);
  assert.match(box, /Nemotron 3 Super 120B/); assert.match(box, /96 GB/);
  assert.ok(!/0 GB|NaN|null/.test(box), 'no made-up download size: ' + box);
  assert.strictEqual(await page.locator('#ai-local-toobig button, #ai-local-toobig [data-act]').count(), 0, 'nothing in the too-big list can be pressed');
  assert.match(await text(page, '#ai-local-model'), /Nano 9B/, 'the recommended model is unchanged');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: a chosen model that no longer fits offers the recommended smaller one', async () => {
  const { ctx, page } = await open({ pre: "try{localStorage.setItem('sd-test-seed','1')}catch(e){}" });
  await page.evaluate(() => { window.__fb.installed = ['nemotron-nano-9b-v2']; aiSettingsSet({ source: 'local', level: 'medium', localModel: 'nemotron-nano-9b-v2' }); });
  await goTutor(page); await page.evaluate(() => { ai.screen = 'setup'; render(); }); await page.waitForSelector('#ai-local-smaller');
  assert.match(await text(page, '#ai-local-smaller'), /Nano 9B v2.*(needs more memory|too big)/is);
  await page.click('#ai-local-smaller [data-act="ai-local-model"]');
  assert.match(await text(page, '#ai-local-model'), /Nemotron 3 Nano 4B/); assert.strictEqual(await page.locator('#ai-local-smaller').count(), 0);
  await ctx.close();
});

test('Local screen: download with progress and Cancel, then Start and Delete', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { window.__fb.installImpl = () => new Promise(r => { window.__fb.finish = r; }); });
  await goTutor(page); await page.waitForSelector('#ai-local-model');
  assert.strictEqual(await page.locator('[data-act="ai-local-start"]').isDisabled(), true, 'Start is disabled until the model is installed');
  assert.strictEqual(await page.locator('[data-act="ai-local-remove"]').count(), 0);
  await page.click('[data-act="ai-local-install"]');
  const inst = await calls(page, 'install'); assert.deepStrictEqual(inst[0][1], { modelId: 'nemotron-3-nano-4b', level: 'medium' });
  await page.waitForSelector('#ai-local-progress');
  await page.evaluate(() => window.__fb.cb({ phase: 'model', modelId: 'nemotron-3-nano-4b', done: 1.4e9, total: 2.8e9 }));
  await page.waitForFunction(() => document.querySelector('#ai-local-progress').getAttribute('aria-valuenow') === '50');
  assert.match(await text(page, '#ai-local-progress'), /1\.4 GB of 2\.8 GB/);
  assert.strictEqual(await page.locator('[data-act="ai-local-install"]').count(), 0, 'no second download while one runs');
  await page.click('[data-act="ai-local-cancel"]'); assert.strictEqual((await calls(page, 'cancel')).length, 1);
  await page.evaluate(() => { window.__fb.installed = ['nemotron-3-nano-4b']; window.__fb.finish({}); });
  await page.waitForSelector('[data-act="ai-local-remove"]');
  assert.strictEqual(await page.locator('[data-act="ai-local-start"]').isDisabled(), false);
  assert.strictEqual(await page.locator('#ai-local-license').count(), 0, 'the license is shown before the first download only');
  await page.click('[data-act="ai-local-remove"]'); await page.waitForFunction(() => !document.querySelector('[data-act="ai-local-remove"]'));
  assert.deepStrictEqual((await calls(page, 'remove'))[0][1], { modelId: 'nemotron-3-nano-4b' });
  assert.strictEqual(await page.locator('[data-act="ai-local-start"]').isDisabled(), true);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: Start runs the model, saves the choice and opens the Tutor', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { window.__fb.installed = ['nemotron-3-nano-4b']; });
  await goTutor(page); await page.waitForSelector('[data-act="ai-local-start"]:not([disabled])');
  await page.click('[data-act="ai-level"][data-level="high"]'); await page.waitForFunction(() => /Nano 9B/.test(document.querySelector('#ai-local-model').innerText));
  await page.click('#ai-local-models [data-id="nemotron-3-nano-4b"]');
  await page.click('[data-act="ai-local-start"]'); await page.waitForSelector('#ai-new');
  assert.deepStrictEqual((await calls(page, 'start'))[0][1], { modelId: 'nemotron-3-nano-4b', level: 'high' });
  const s = await page.evaluate(() => aiSettingsGet()); assert.deepStrictEqual([s.source, s.localModel, s.level], ['local', 'nemotron-3-nano-4b', 'high']);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: a computer that is too small says so and points to CLI or an online key', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { window.__fb.recImpl = () => Promise.resolve({ ok: false, reason: 'This computer has too little free memory (3.0 GB in total) to run an AI model well.', suggest: 'cli', models: [] }); });
  await goTutor(page); await page.waitForSelector('#ai-local-small');
  const t = await text(page, '#ai-local-small'); assert.match(t, /too little free memory/); assert.match(t, /CLI/); assert.match(t, /online key/i);
  assert.strictEqual(await page.locator('[data-act="ai-local-install"], [data-act="ai-local-start"]').count(), 0);
  await page.click('#ai-local-small [data-act="ai-source"][data-src="cli"]'); await page.waitForSelector('#ai-cli');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('Local screen: bridge errors show their message and leave the screen usable', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { window.__fb.installImpl = () => Promise.reject({ kind: 'disk', message: 'Not enough free space: 3.2 GB needed.' }); });
  await goTutor(page); await page.waitForSelector('[data-act="ai-local-install"]');
  await page.click('[data-act="ai-local-install"]'); await page.waitForFunction(() => /Not enough free space/.test(document.querySelector('#ai-local-err').innerText));
  assert.strictEqual(await page.locator('[data-act="ai-local-install"]').isEnabled(), true, 'the student can try again');
  await page.evaluate(() => { window.__fb.installed = ['nemotron-3-nano-4b']; window.__fb.startImpl = () => Promise.reject({ kind: 'ram', message: 'Too big for Medium.' }); });
  await page.click('[data-act="ai-level"][data-level="light"]'); await page.waitForSelector('[data-act="ai-local-start"]:not([disabled])');
  await page.click('[data-act="ai-local-start"]'); await page.waitForFunction(() => /Too big for Medium/.test(document.querySelector('#ai-local-err').innerText));
  assert.strictEqual(await page.locator('#ai-new').count(), 0);
  await page.evaluate(() => { window.__fb.installImpl = () => Promise.reject({ kind: 'cancelled', message: 'Stopped.' }); window.__fb.installed = []; });
  await page.click('[data-act="ai-level"][data-level="medium"]'); await page.waitForSelector('[data-act="ai-local-install"]');
  await page.click('[data-act="ai-local-install"]'); await page.waitForFunction(() => /continue where it stopped/i.test(document.querySelector('#ai-local-err').innerText));
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('CLI screen: lists the tools, disables missing ones, says where the data goes, refreshes and picks', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.click('.ai-source [data-src="cli"]'); await page.waitForSelector('.ai-tool[data-id="codex"]');
  assert.strictEqual(await page.locator('.ai-tool').count(), 3);
  const codex = await text(page, '.ai-tool[data-id="codex"]'); assert.match(codex, /Found/); assert.match(codex, /codex-cli 0\.9\.1/); assert.match(codex, /sends your questions to the cloud/i); assert.match(codex, /codex login/);
  const gem = page.locator('.ai-tool[data-id="gemini"]'); assert.match(await gem.innerText(), /Not found/); assert.match(await gem.innerText(), /npm install -g @google\/gemini-cli/);
  assert.strictEqual(await gem.locator('[data-act="ai-cli-pick"]').isDisabled(), true);
  assert.match(await text(page, '.ai-tool[data-id="goose"]'), /depends/i);
  assert.match(await text(page, '#ai-cli'), /runs? on your (PC|computer)|stay on your (PC|computer)/i);
  await page.evaluate(() => { window.__fb.tools[1].found = true; window.__fb.tools[1].version = 'gemini 0.5'; });
  await page.click('[data-act="ai-cli-refresh"]'); await page.waitForFunction(() => !document.querySelector('.ai-tool[data-id="gemini"] [data-act="ai-cli-pick"]').disabled);
  assert.strictEqual((await calls(page, 'detect')).length, 2);
  await page.click('.ai-tool[data-id="codex"] [data-act="ai-cli-pick"]'); await page.waitForSelector('#ai-new');
  const s = await page.evaluate(() => aiSettingsGet()); assert.deepStrictEqual([s.source, s.cliId], ['cli', 'codex']);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('CLI screen: a failing detection shows its message', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { window.__fb.detectImpl = () => Promise.reject({ kind: 'bad', message: 'Could not look for tools.' }); });
  await goTutor(page); await page.click('.ai-source [data-src="cli"]'); await page.waitForSelector('#ai-cli-err');
  await page.waitForFunction(() => /Could not look for tools/.test(document.querySelector('#ai-cli-err').innerText));
  assert.strictEqual(await page.locator('[data-act="ai-cli-refresh"]').count(), 1);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('keyboard focus lands on the first interactive element of each new screen; every control has a name', async () => {
  const { ctx, page } = await open();
  await goTutor(page); await page.waitForSelector('[data-act="ai-level"]');
  await page.click('.ai-source [data-src="cli"]'); await page.waitForSelector('.ai-tool');
  const first = sel => page.evaluate(s => { const p = document.querySelector(s); const f = [...p.querySelectorAll('button:not([disabled]),a[href],input,select,textarea')][0]; return f === document.activeElement; }, sel);
  assert.strictEqual(await first('#ai-cli'), true, 'CLI');
  await page.click('.ai-source [data-src="local"]'); await page.waitForSelector('#ai-local-model');
  await page.waitForFunction(() => { const p = document.querySelector('#ai-local'); const f = p && p.querySelector('button:not([disabled]),a[href],input,select,textarea'); return f === document.activeElement; });
  await page.click('.ai-source .ai-linkbtn'); await page.waitForSelector('#ai-setup-form');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'ai-provider');
  await page.click('.ai-source .ai-linkbtn'); await page.waitForSelector('#ai-local-model');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('#ai-local button, #ai-local a, #ai-local select, #ai-local input, .ai-source button')].filter(e => {
    const n = (e.getAttribute('aria-label') || e.innerText || e.value || '').trim(); const l = e.id && document.querySelector('label[for="' + e.id + '"]'); const w = e.closest('label');
    return !(n || (l && l.innerText.trim()) || (w && w.innerText.trim())); }).map(e => e.outerHTML.slice(0, 80)));
  assert.deepStrictEqual(unnamed, []);
  await page.click('.ai-source [data-src="cli"]'); await page.waitForSelector('.ai-tool');
  const unnamed2 = await page.evaluate(() => [...document.querySelectorAll('#ai-cli button, #ai-cli a')].filter(e => !(e.getAttribute('aria-label') || e.innerText || '').trim()).map(e => e.outerHTML.slice(0, 80)));
  assert.deepStrictEqual(unnamed2, []); await ctx.close();
});

test('the token counter shows on lesson, chat and exam screens in Local and CLI, never in API mode', async () => {
  for (const mode of ['local', 'cli', 'api']) {
    const { ctx, page, errors } = await open({ pre: `try{sessionStorage.setItem('sd-ai-key','KEY-UI-TEST-1234567890')}catch(e){}` });
    // simple scripted answers for every kind of request
    await page.evaluate(([o, l, e]) => { window.__chatText = req => { const s = req.system;
      if (/Answer the student/.test(s)) return 'The answer is 42.';
      if (/Write a final exam/.test(s)) return e;
      const m = /Write lesson (\d+) of/.exec(s); if (m) return l.replace(/__I__/g, m[1]);
      return o; }; }, [outline(3), lessonJson('__I__'), examJson(12)]);
    await setSettings(page, mode === 'api' ? { source: 'api' } : mode === 'local' ? { source: 'local', localModel: 'nemotron-3-nano-4b' } : { source: 'cli', cliId: 'codex' });
    await goTutor(page); await page.waitForSelector('#ai-new');
    if (mode === 'api') {
      await page.evaluate(() => { ai.screen = 'new'; render(); });
      assert.strictEqual(await page.locator('#ai-usage').count(), 0);
      assert.strictEqual(await page.locator('.ai-source').count(), 0); await ctx.close(); continue;
    }
    await page.fill('#ai-topic', 'Geometry'); await page.selectOption('#ai-count', '3'); await page.click('#ai-create'); await page.waitForSelector('#ai-course');
    assert.strictEqual(await page.locator('#ai-usage').count(), 0, 'not on the course list screen');
    for (let i = 0; i < 3; i++) {
      await page.click('[data-act="ai-lesson"][data-i="' + i + '"]'); await page.waitForSelector('#ai-lesson');
      assert.match(await text(page, '#ai-lesson #ai-usage'), /Last answer: .*This session:/, 'lesson ' + i);
      for (let j = 0; j < 4; j++) await page.check('#ai-quiz-form input[name="q' + j + '"][value="' + j + '"]');
      await page.click('#ai-quiz-submit'); await page.waitForSelector('#ai-quiz-result'); await page.click('[data-act="ai-course"]'); await page.waitForSelector('#ai-course');
    }
    await page.click('[data-act="ai-lesson"][data-i="0"]'); await page.waitForSelector('#ai-lesson');
    const before = await text(page, '#ai-usage');
    await page.fill('#ai-ask', 'Why?'); await page.click('#ai-ask-send'); await page.waitForSelector('#ai-chat .ai-msg.tutor');
    const after = await text(page, '#ai-chat #ai-usage'); assert.notStrictEqual(after, before, 'the counter moves after a chat answer');
    assert.match(after, /Last answer: 120 tokens \(in 100, out 20\)/);
    await page.click('[data-act="ai-course"]'); await page.waitForSelector('#ai-course');
    await page.click('[data-act="ai-exam"]'); await page.waitForSelector('#ai-exam');
    assert.match(await text(page, '#ai-exam #ai-usage'), /This session: .*tokens/);
    assert.deepStrictEqual(errors, []); await ctx.close();
  }
});

test('new elements use theme colors only: panels match the existing panels in light and dark', async () => {
  for (const theme of ['light', 'dark']) {
    const { ctx, page, errors } = await open({ theme });
    await page.waitForTimeout(1500);
    const ref = await page.evaluate(() => { const p = document.querySelector('.panel'); const c = getComputedStyle(p); return { bg: c.backgroundColor, border: c.borderTopColor, fg: c.color }; });
    await goTutor(page); await page.waitForSelector('#ai-local-model'); await page.waitForTimeout(1500);
    const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const tab of ['local', 'cli']) {
      if (tab === 'cli') { await page.click('.ai-source [data-src="cli"]'); await page.waitForSelector('.ai-tool'); await page.waitForTimeout(1500); }
      const got = await page.evaluate(sel => { const p = document.querySelector(sel), c = getComputedStyle(p);
        const bad = []; const bg = c.backgroundColor;
        const under = e => { for (let n = e; n; n = n.parentElement) { const b = getComputedStyle(n).backgroundColor; if (!/rgba\(.*,\s*0\)$/.test(b) && b !== 'transparent') return b; } return bg; };
        p.querySelectorAll('*').forEach(e => { if (!e.childNodes.length || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return; const cs = getComputedStyle(e); bad.push([e.tagName + '.' + e.className, cs.color, under(e)]); });
        return { bg, border: c.borderTopColor, fg: c.color, texts: bad }; }, tab === 'local' ? '#ai-local' : '#ai-cli');
      assert.strictEqual(got.bg, ref.bg, theme + ' ' + tab + ' background'); assert.strictEqual(got.border, ref.border, theme + ' ' + tab + ' border'); assert.strictEqual(got.fg, ref.fg, theme + ' ' + tab + ' text');
      const low = got.texts.filter(t => ratio(rgb(t[1]), rgb(t[2])) < 4.5).map(t => t[0] + ' ' + t[1]);
      assert.deepStrictEqual(low, [], theme + ' ' + tab + ' text contrast >= 4.5:1');
    }
    assert.deepStrictEqual(errors, []); await ctx.close();
  }
});

test('review: a level clicked on the Local screen is saved only when the model is started, and leaving the screen drops it', async () => {
  const { ctx, page, errors } = await open();
  await goTutor(page); await page.waitForSelector('[data-act="ai-level"]');
  await page.evaluate(() => aiSettingsSet(Object.assign(aiSettingsGet(), { source: 'local', localModel: 'nemotron-3-nano-4b', level: 'medium' })));
  await page.evaluate(() => { ai.screen = 'setup'; render(); }); await page.waitForSelector('.ai-levels');
  await page.click('[data-act="ai-level"][data-level="light"]');
  await page.waitForFunction(() => (document.querySelector('.ai-levels [aria-pressed="true"]') || {}).innerText === 'Light');
  assert.strictEqual((await page.evaluate(() => aiSettingsGet())).level, 'medium');
  await page.evaluate(() => { ai.screen = 'new'; render(); });
  await page.click('[data-act="ai-settings"]'); await page.waitForSelector('.ai-levels');
  assert.strictEqual(await page.locator('.ai-levels [aria-pressed="true"]').innerText(), 'Medium', 'the screen shows the saved level again');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('review: the CLI screen does not claim the tool cannot see your files', async () => {
  const { ctx, page } = await open();
  await goTutor(page); await page.click('[data-act="ai-source"][data-src="cli"]'); await page.waitForSelector('#ai-cli');
  const t = await text(page, '#ai-cli');
  assert.doesNotMatch(t, /cannot see or change your files/i);
  assert.match(t, /read-only/i); assert.match(t, /(can still|may still) read/i); assert.match(t, /password|secret/i);
  await ctx.close();
});

// ---- the AI writes tagged lines; the page builds the layout ----
const qT = (q, a, w, lesson) => 'Q: ' + q + '\n' + [0, 1, 2, 3].map(k => 'ABCD'[k] + ') ' + q + '-opt' + k).join('\n') + '\nANSWER: ' + 'ABCD'[a] + '\nWHY: ' + w + (lesson ? '\nLESSON: ' + lesson : '');
const outlineT = n => 'TITLE: Geometry Basics\nSUMMARY: A short course.\n' + Array.from({ length: n }, (_, i) => 'LESSON: Lesson ' + (i + 1) + ' | Goal ' + (i + 1)).join('\n');
const lessonT = i => '## Right triangles ' + i + '\nA right triangle has one square corner.\nTIP: Draw it first.\nWARN: It only works for right triangles.\nFORMULA: a² + b² = c²\nSTEP: Square the short sides\nSTEP: Add them\nSTEP: Take the root\nKEY: The long side is the hypotenuse\nEXAMPLE: A 3-4-5 triangle\n9 + 16 = 25\nSTEP: Root of 25 is 5\n' + [0, 1, 2, 3].map(j => qT('Q' + j, j, 'Because ' + j)).join('\n');
const examT = n => Array.from({ length: n }, (_, i) => qT('EQ' + i, i % 4, 'Exp ' + i, 1 + i % 3)).join('\n');

test('tagged replies: the page draws boxes, formula, steps and the quiz from plain lines, and asks for lines, not JSON', async () => {
  const { ctx, page, errors } = await open({ pre: `try{sessionStorage.setItem('sd-ai-key','KEY-UI-TEST-1234567890')}catch(e){}` });
  await page.evaluate(([o, l, e]) => { window.__reqs = []; window.__chatText = req => { window.__reqs.push({ json: req.json, system: req.system }); const s = req.system;
    if (/Answer the student/.test(s)) return 'The answer is 42.';
    if (/Write a final exam/.test(s)) return e;
    const m = /Write lesson (\d+) of/.exec(s); if (m) return l.replace(/__I__/g, m[1]);
    return o; }; }, [outlineT(3), lessonT('__I__'), examT(12)]);
  await setSettings(page, { source: 'local', localModel: 'nemotron-3-nano-4b' });
  await goTutor(page); await page.waitForSelector('#ai-new');
  await page.fill('#ai-topic', 'Geometry'); await page.selectOption('#ai-count', '3'); await page.click('#ai-create'); await page.waitForSelector('#ai-course');
  assert.match(await text(page, '#ai-course'), /Geometry Basics/); assert.match(await text(page, '#ai-course'), /Lesson 3/);
  await page.click('[data-act="ai-lesson"][data-i="0"]'); await page.waitForSelector('#ai-lesson');
  assert.strictEqual(await page.locator('#ai-lesson .ai-b-tip').count(), 1, 'tip box');
  assert.strictEqual(await page.locator('#ai-lesson .ai-b-warn').count(), 1, 'warning box');
  assert.strictEqual((await text(page, '#ai-lesson .ai-formula')).trim(), 'a² + b² = c²');
  assert.deepStrictEqual(await page.locator('#ai-lesson ol.ai-steps').first().locator('li').allInnerTexts(), ['Square the short sides', 'Add them', 'Take the root']);
  assert.match(await text(page, '#ai-lesson .ai-example'), /3-4-5 triangle/); assert.strictEqual(await page.locator('#ai-lesson .ai-example ol.ai-steps li').count(), 1, 'a step inside the worked example');
  assert.match(await text(page, '#ai-lesson'), /hypotenuse/);
  assert.strictEqual(await page.locator('#ai-quiz-form input[type="radio"]').count(), 16, '4 questions with 4 options');
  for (let j = 0; j < 4; j++) await page.check('#ai-quiz-form input[name="q' + j + '"][value="' + j + '"]');
  await page.click('#ai-quiz-submit'); await page.waitForSelector('#ai-quiz-result');
  assert.match(await text(page, '#ai-quiz-result'), /4\s*\/\s*4/, 'the letters in ANSWER lines were graded as the right options');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(overflow <= 0, 'no sideways scrolling: ' + overflow);
  const reqs = await page.evaluate(() => window.__reqs.filter(r => !/Answer the student/.test(r.system)));
  assert.ok(reqs.length >= 2 && reqs.every(r => r.json === false && /plain lines only/i.test(r.system)), 'the page asks for tagged lines (json:false): ' + JSON.stringify(reqs.map(r => r.json)));
  const lessonReq = reqs.find(r => /KEY:/.test(r.system) && /FORMULA:/.test(r.system));
  assert.ok(lessonReq && /at most (three|3)/i.test(lessonReq.system) && /never one in every section/i.test(lessonReq.system), 'the lesson prompt keeps tip, note and warning boxes rare (real models put one in every section)');
  assert.strictEqual(reqs.length, 2, 'outline and lesson were each asked for once (no retry needed)');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('tagged replies: a reply with the wrong shape is retried once, then reported; a JSON reply still works', async () => {
  const { ctx, page, errors } = await open({ pre: `try{sessionStorage.setItem('sd-ai-key','KEY-UI-TEST-1234567890')}catch(e){}` });
  // 1) outline answered in JSON (the older habit of some models): accepted without a retry
  await page.evaluate(o => { window.__n = 0; window.__chatText = req => { window.__n++; return o; }; }, outline(3));
  await setSettings(page, { source: 'local', localModel: 'nemotron-3-nano-4b' });
  await goTutor(page); await page.waitForSelector('#ai-new');
  await page.fill('#ai-topic', 'Geometry'); await page.selectOption('#ai-count', '3'); await page.click('#ai-create'); await page.waitForSelector('#ai-course');
  assert.strictEqual(await page.evaluate(() => window.__n), 1, 'JSON accepted at the first try');
  // 2) a lesson that is cut off (only 2 quiz blocks): asked twice, then an error and the screen stays usable
  await page.evaluate(() => { window.__n = 0; window.__chatText = req => { window.__n++; return '## Part\nBody\nKEY: k\nEXAMPLE: e\nQ: a?\nA) 1\nB) 2\nC) 3\nD) 4\nANSWER: A\nWHY: w\nQ: b?\nA) 1\nB) 2\nC) 3\nD) 4\nANSWER: B\nWHY: w'; }; });
  await page.click('[data-act="ai-lesson"][data-i="0"]');
  await page.waitForFunction(() => window.__n >= 2);
  await page.waitForFunction(() => /could not use/i.test(document.body.innerText));
  assert.strictEqual(await page.evaluate(() => window.__n), 2, 'one retry, no more');
  assert.strictEqual(await page.locator('#ai-lesson').count(), 0, 'no half-built lesson is shown');
  assert.deepStrictEqual(errors, []); await ctx.close();
});
