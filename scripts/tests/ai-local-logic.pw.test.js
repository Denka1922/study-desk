'use strict';
// Page logic for the Local and CLI sources, run in the real page with a fake desktop bridge.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlaywright, pageWithExports } = require('./helpers');

const NAMES = ['ai', 'render', 'aiBridge', 'aiSource', 'aiReady', 'aiScreen', 'aiRun', 'aiCancel', 'aiKeyGet', 'aiSettingsGet', 'aiSettingsSet', 'aiCleanSettings',
  'aiSendBridge', 'aiUsageAdd', 'aiUsageReset', 'aiUsageText', 'aiErrorText', 'aiKeySet'];
const PG = pageWithExports(NAMES);
test.after(() => PG.cleanup());
const PAGE = PG.url;
const BRIDGE = `
  window.__calls = []; window.__chatImpl = null;
  window.studyDesk = { ai: { version: 1,
    chat: function (req) { window.__calls.push(['chat', req]); if (window.__chatImpl) return window.__chatImpl(req); return Promise.resolve({ text: 'Tutor answer', cut: false, usage: { input: 10, output: 5, estimated: false } }); },
    cancelChat: function () { window.__calls.push(['cancelChat']); return Promise.resolve({}); },
    getHardware: function () { return Promise.resolve({}); }, recommend: function () { return Promise.resolve({ ok: false }); },
    local: { status: function () { return Promise.resolve({ installed: [], engineInstalled: false, running: null, diskFreeBytes: 1e12 }); }, install: function () { return Promise.resolve({}); }, cancel: function () { return Promise.resolve({}); }, remove: function () { return Promise.resolve({}); }, removeAll: function () { return Promise.resolve({}); }, start: function (a) { (window.__starts = window.__starts || []).push(a); return window.__startImpl ? window.__startImpl(a) : Promise.resolve({ running: a }); }, stop: function () { return Promise.resolve({}); }, onProgress: function () { return function () {}; } },
    cli: { detect: function () { return Promise.resolve([]); } } } };`;

async function open(browser, withBridge) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (withBridge) await page.addInitScript(BRIDGE);
  await page.goto(PAGE); await page.waitForSelector('.glance');
  return { ctx, page, errors };
}
const settings = (page, s) => page.evaluate(x => aiSettingsSet(Object.assign({ provider: 'gemini', model: 'gemini-3.8-flash', language: 'auto' }, x)), s);
const run = (page, kind, params) => page.evaluate(([k, p]) => aiRun(k, p).then(v => ({ ok: v }), e => ({ err: e })), [kind, params]);
const CHAT = { topic: 'Fractions', language: 'English', lesson: 'Some lesson text', history: [], question: 'Why?' };

test('without the bridge nothing changes: API source, key needed', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, false);
    assert.strictEqual(await page.evaluate(() => aiBridge()), null);
    assert.strictEqual(await page.evaluate(() => aiSettingsGet().source), 'api');
    assert.strictEqual(await page.evaluate(() => aiSettingsGet().level), 'medium');
    assert.strictEqual(await page.evaluate(() => aiScreen()), 'setup');
    const r = await run(page, 'chat', CHAT);
    assert.strictEqual(r.err.kind, 'auth');
    // a stored "local" source is ignored when there is no bridge
    await settings(page, { source: 'local', localModel: 'm' });
    assert.strictEqual(await page.evaluate(() => aiSource()), 'api');
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});

test('aiCleanSettings keeps only valid source, level, localModel and cliId', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const bad = await page.evaluate(() => aiCleanSettings({ source: 'weird', level: 'turbo', localModel: '../x', cliId: 'A b', provider: 'gemini' }));
    assert.deepStrictEqual([bad.source, bad.level, bad.localModel, bad.cliId], ['local', 'medium', '', ''], 'with the bridge the default source is local');
    const good = await page.evaluate(() => aiCleanSettings({ source: 'cli', level: 'xhigh', localModel: 'nemotron-3-nano-4b', cliId: 'codex' }));
    assert.deepStrictEqual([good.source, good.level, good.localModel, good.cliId], ['cli', 'xhigh', 'nemotron-3-nano-4b', 'codex']);
    for (const l of ['light', 'medium', 'high', 'xhigh', 'max']) assert.strictEqual(await page.evaluate(x => aiCleanSettings({ level: x }).level, l), l);
    assert.strictEqual(await page.evaluate(() => aiCleanSettings({ localModel: 'x'.repeat(61) }).localModel), '');
    assert.strictEqual(await page.evaluate(() => aiCleanSettings(null).level), 'medium');
    await page.evaluate(() => aiSettingsSet({ provider: 'openai', model: 'gpt-6.1-terra', language: 'Turkish', source: 'cli', level: 'high', cliId: 'goose' }));
    const back = await page.evaluate(() => aiSettingsGet());
    assert.deepStrictEqual([back.provider, back.language, back.source, back.level, back.cliId], ['openai', 'Turkish', 'cli', 'high', 'goose']);
  } finally { await browser.close(); }
});

test('local source: aiRun sends mode local through the bridge and needs no API key', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, true);
    await settings(page, { source: 'local', level: 'high', localModel: 'nemotron-3-nano-4b' });
    assert.strictEqual(await page.evaluate(() => aiKeyGet()), '');
    assert.strictEqual(await page.evaluate(() => aiScreen()), 'new', 'a chosen model is enough to leave the setup screen');
    const r = await run(page, 'chat', CHAT);
    assert.strictEqual(r.ok.text, 'Tutor answer');
    const calls = await page.evaluate(() => window.__calls);
    assert.strictEqual(calls.length, 1); const req = calls[0][1];
    assert.strictEqual(req.mode, 'local'); assert.ok(req.system.length > 100); assert.strictEqual(req.json, false);
    assert.strictEqual(req.messages[0].role, 'user'); assert.match(req.messages[0].text, /Fractions/);
    assert.ok(Number.isInteger(req.maxTokens) && req.maxTokens >= 1 && req.maxTokens <= 32768);
    assert.strictEqual(req.cliId, undefined);
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});

test('cli source passes mode cli and the tool id', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'cli', cliId: 'codex' });
    assert.strictEqual(await page.evaluate(() => aiScreen()), 'new');
    await run(page, 'chat', CHAT);
    const req = (await page.evaluate(() => window.__calls))[0][1];
    assert.strictEqual(req.mode, 'cli'); assert.strictEqual(req.cliId, 'codex');
  } finally { await browser.close(); }
});

test('with the bridge present but the API source chosen, the bridge is not used and a key is still needed', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'api' });
    const r = await run(page, 'chat', CHAT);
    assert.strictEqual(r.err.kind, 'auth');
    assert.strictEqual((await page.evaluate(() => window.__calls)).length, 0);
  } finally { await browser.close(); }
});

test('aborting calls cancelChat once and rejects with kind cancelled', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const out = await page.evaluate(async () => {
      window.__chatImpl = () => new Promise(() => {});
      const ac = new AbortController();
      const p = aiSendBridge({ mode: 'local', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 50, json: false, signal: ac.signal })
        .then(v => ({ ok: v }), e => ({ err: e }));
      setTimeout(() => ac.abort(), 50);
      const r = await p;
      const pre = new AbortController(); pre.abort();
      const r2 = await aiSendBridge({ mode: 'local', system: 's', messages: [], maxTokens: 5, json: false, signal: pre.signal }).then(v => ({ ok: v }), e => ({ err: e }));
      return { r, r2, calls: window.__calls.map(c => c[0]) };
    });
    assert.strictEqual(out.r.err.kind, 'cancelled'); assert.strictEqual(out.r2.err.kind, 'cancelled');
    assert.deepStrictEqual(out.calls, ['chat', 'cancelChat'], 'an already-aborted request never reaches the bridge');
  } finally { await browser.close(); }
});

test('aiRun cancelled by aiCancel tells the bridge to stop', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'local', localModel: 'm' });
    const out = await page.evaluate(async () => {
      window.__chatImpl = () => new Promise(() => {});
      const p = aiRun('chat', { topic: 't', language: 'English', lesson: 'l', history: [], question: 'q' }).then(v => ({ ok: v }), e => ({ err: e }));
      await new Promise(r => setTimeout(r, 50)); aiCancel();
      return { r: await p, calls: window.__calls.map(c => c[0]), busy: ai.busy };
    });
    assert.strictEqual(out.r.err.kind, 'stale'); assert.deepStrictEqual(out.calls, ['chat', 'cancelChat']); assert.strictEqual(out.busy, false);
  } finally { await browser.close(); }
});

test('bridge errors keep their kind and message; unknown kinds become bad; a cut JSON answer is an error', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const out = await page.evaluate(async () => {
      const go = (impl, json) => { window.__chatImpl = impl; return aiSendBridge({ mode: 'local', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 50, json: !!json }).then(v => ({ ok: v }), e => ({ err: e })); };
      return [
        await go(() => Promise.reject({ kind: 'ram', message: 'No room.', suggestion: { modelId: 'x' } })),
        await go(() => Promise.reject({ kind: 'weird', message: 'x' })),
        await go(() => Promise.reject('just a string')),
        await go(() => Promise.resolve({ text: '{"a":', cut: true, usage: { input: 1, output: 1 } }), true),
        await go(() => Promise.resolve({ text: 'partial but fine', cut: true, usage: { input: 1, output: 1 } }), false),
        await go(() => Promise.resolve({})),
      ];
    });
    assert.deepStrictEqual([out[0].err.kind, out[0].err.message, out[0].err.suggestion.modelId], ['ram', 'No room.', 'x']);
    assert.strictEqual(out[1].err.kind, 'bad'); assert.strictEqual(out[2].err.kind, 'bad');
    assert.strictEqual(out[3].err.kind, 'bad'); assert.match(out[3].err.message, /cut off/i);
    assert.strictEqual(out[4].ok.text, 'partial but fine');
    assert.strictEqual(out[5].err.kind, 'bad');
  } finally { await browser.close(); }
});

test('usage counter: running total, "about" for estimates, reset, never throws', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const t = await page.evaluate(() => {
      const out = [];
      aiUsageReset(); out.push(aiUsageText());
      aiUsageAdd({ input: 640, output: 172, estimated: false }); out.push(aiUsageText());
      aiUsageAdd({ input: 200, output: 50, estimated: false }); out.push(aiUsageText());
      aiUsageAdd({ input: 10, output: 10, estimated: true }); out.push(aiUsageText());
      aiUsageAdd(null); aiUsageAdd({}); aiUsageAdd({ input: 'x', output: -5 }); aiUsageAdd('junk'); out.push(aiUsageText());
      aiUsageReset(); out.push(aiUsageText());
      return out;
    });
    assert.strictEqual(t[0], t[5]); assert.match(t[0], /none yet|no answers/i);
    assert.strictEqual(t[1], 'Last answer: 812 tokens (in 640, out 172) · This session: 812 tokens');
    assert.strictEqual(t[2], 'Last answer: 250 tokens (in 200, out 50) · This session: 1,062 tokens');
    assert.strictEqual(t[3], 'Last answer: about 20 tokens (in 10, out 10) · This session: about 1,082 tokens');
    assert.ok(t[4].includes('This session: about 1,082 tokens'), 'junk adds nothing: ' + t[4]);
    // a bridge answer is recorded without any extra call
    await page.evaluate(() => aiUsageReset());
    await settings(page, { source: 'local', localModel: 'm' });
    await run(page, 'chat', CHAT); await run(page, 'chat', CHAT);
    assert.strictEqual(await page.evaluate(() => aiUsageText()), 'Last answer: 15 tokens (in 10, out 5) · This session: 30 tokens');
  } finally { await browser.close(); }
});

test('error texts: every new kind is a plain sentence with a next step; unknown kinds use the old generic text; API texts are unchanged', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const t = await page.evaluate(() => {
      const o = {}; ['disk', 'checksum', 'ram', 'engine', 'nocli'].forEach(k => { o[k] = aiErrorText({ kind: k }, 'gemini'); });
      o.unknown = aiErrorText({ kind: 'martian', status: 0 }, 'gemini');
      o.auth = aiErrorText({ kind: 'auth' }, 'gemini'); o.timeout = aiErrorText({ kind: 'timeout' }, 'gemini'); o.cancelled = aiErrorText({ kind: 'cancelled' }, 'gemini');
      o.ramMsg = aiErrorText({ kind: 'ram', message: 'Nemotron needs more memory than High allows.', bridge: true }, 'gemini');
      o.cliAuth = aiErrorText({ kind: 'auth', message: 'Codex is asking for a login. Run "codex login".', bridge: true }, 'gemini');
      o.nullErr = aiErrorText(null, 'gemini');
      return o;
    });
    for (const k of ['disk', 'checksum', 'ram', 'engine', 'nocli']) { assert.ok(t[k].length > 25 && /[.!]$/.test(t[k]), k); assert.match(t[k], /try|open|choose|close|free|install|press|pick|use/i, k); }
    assert.match(t.unknown, /sent an answer the site could not use/); assert.match(t.nullErr, /sent an answer the site could not use/);
    assert.match(t.auth, /rejected this key/); assert.match(t.timeout, /too long/); assert.strictEqual(t.cancelled, 'Stopped.');
    assert.ok(t.ramMsg.includes('Nemotron needs more memory')); assert.ok(t.cliAuth.includes('codex login'));
  } finally { await browser.close(); }
});

test('saving the API setup keeps the chosen source and level', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'api', level: 'xhigh', localModel: 'm', cliId: 'codex' });
    await page.click('.side [data-view="tutor"]');
    await page.evaluate(() => { ai.screen = 'setup'; render(); });
    await page.waitForSelector('#ai-setup-form');
    await page.fill('#ai-key', 'KEY-LOGIC-TEST-1234567890');
    await page.click('#ai-setup-form button[type="submit"]'); await page.waitForSelector('#ai-new');
    const s = await page.evaluate(() => aiSettingsGet());
    assert.deepStrictEqual([s.source, s.level, s.localModel, s.cliId], ['api', 'xhigh', 'm', 'codex']);
  } finally { await browser.close(); }
});

test('local source starts the chosen model at the chosen level before chatting; a start refusal reaches the page with its kind', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'local', level: 'xhigh', localModel: 'nemotron-nano-9b-v2' });
    await run(page, 'chat', CHAT);
    assert.deepStrictEqual(await page.evaluate(() => window.__starts), [{ modelId: 'nemotron-nano-9b-v2', level: 'xhigh' }]);
    await page.evaluate(() => { window.__calls = []; window.__startImpl = () => Promise.reject({ kind: 'ram', message: 'Too big for High.' }); });
    const r = await run(page, 'chat', CHAT);
    assert.strictEqual(r.err.kind, 'ram'); assert.strictEqual(r.err.message, 'Too big for High.');
    assert.strictEqual((await page.evaluate(() => window.__calls)).length, 0, 'no chat is sent when the model cannot start');
    // CLI never starts the local engine
    await page.evaluate(() => { window.__starts = []; }); await settings(page, { source: 'cli', cliId: 'codex' }); await run(page, 'chat', CHAT);
    assert.deepStrictEqual(await page.evaluate(() => window.__starts), []);
  } finally { await browser.close(); }
});

test('regression: a course built through the Local source keeps its own level (beginner/intermediate/advanced) and language', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, true);
    await settings(page, { source: 'local', level: 'high', localModel: 'nemotron-3-nano-4b' });
    await page.evaluate(() => {
      window.__chatImpl = req => { window.__sys = req.system; return Promise.resolve({ text: JSON.stringify({ title: 'Geometry', summary: 'Short.', lessons: [1, 2, 3].map(i => ({ title: 'L' + i, goal: 'G' + i })) }), cut: false, usage: { input: 5, output: 5 } }); };
    });
    await page.click('.side [data-view="tutor"]'); await page.waitForSelector('#ai-new');
    await page.fill('#ai-topic', 'Explain triangles'); await page.selectOption('#ai-level', 'advanced'); await page.selectOption('#ai-count', '3'); await page.selectOption('#ai-lang', 'Turkish');
    await page.click('#ai-create'); await page.waitForSelector('#ai-course');
    const sys = await page.evaluate(() => window.__sys);
    assert.match(sys, /exactly 3 lessons/); assert.match(sys, /Turkish/);
    const saved = await page.evaluate(() => { const k = Object.keys(localStorage).find(x => x.endsWith(':ai')); return JSON.parse(localStorage.getItem(k)); });
    assert.strictEqual(saved.courses[0].level, 'advanced'); assert.strictEqual(saved.courses[0].language, 'Turkish');
    assert.strictEqual(saved.settings.level, 'high', 'the power level is a separate setting and is untouched');
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});

test('review: settings saved by the old app (an API key, no source) keep the API source after the update', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    assert.strictEqual(await page.evaluate(() => aiSettingsGet().source), 'local', 'a fresh install starts on Local');
    await page.evaluate(() => { aiKeySet('OLD-USER-KEY-1234567890', false); });
    assert.strictEqual(await page.evaluate(() => aiSettingsGet().source), 'api', 'a user with a saved key stays on the API');
    assert.strictEqual(await page.evaluate(() => aiScreen()), 'new', 'and still lands on their courses, not on the download screen');
    await page.evaluate(() => { aiSettingsSet({ provider: 'gemini', model: 'gemini-3.8-flash', language: 'auto', source: 'local', localModel: 'm' }); });
    assert.strictEqual(await page.evaluate(() => aiSettingsGet().source), 'local', 'an explicit choice always wins');
  } finally { await browser.close(); }
});

test('review: messages from the app are shown as written, whatever their kind', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    const t = await page.evaluate(() => [
      aiErrorText({ kind: 'bad', message: 'The download was sent to a website the app does not trust, so it was stopped.', bridge: true }, 'gemini'),
      aiErrorText({ kind: 'bad', message: 'This conversation is too long for the model. Start a new chat.', bridge: true }, 'gemini'),
      aiErrorText({ kind: 'bad', status: 200, message: 'The AI reply did not match the expected format.' }, 'gemini'),
    ]);
    assert.strictEqual(t[0], 'The download was sent to a website the app does not trust, so it was stopped.');
    assert.strictEqual(t[1], 'This conversation is too long for the model. Start a new chat.');
    assert.match(t[2], /sent an answer the site could not use/, 'a reply that did not fit the format keeps the old text');
  } finally { await browser.close(); }
});

test('review: only a reply the page could not use is retried; a refusal from the app is not repeated', async () => {
  const { chromium } = loadPlaywright(); const browser = await chromium.launch();
  try {
    const { page } = await open(browser, true);
    await settings(page, { source: 'cli', cliId: 'codex' });
    const OUT = { topic: 't', level: 'beginner', language: 'English', lessonCount: 3 };
    await page.evaluate(() => { window.__chatImpl = () => Promise.reject({ kind: 'bad', message: 'Codex exited with an error.' }); });
    const r1 = await run(page, 'outline', OUT);
    assert.strictEqual(r1.err.kind, 'bad'); assert.strictEqual((await page.evaluate(() => window.__calls)).length, 1, 'the tool ran once');
    await page.evaluate(() => { window.__calls = []; window.__chatImpl = () => Promise.resolve({ text: 'sorry, no JSON here', cut: false, usage: { input: 1, output: 1 } }); });
    const r2 = await run(page, 'outline', OUT);
    assert.strictEqual(r2.err.kind, 'bad'); assert.strictEqual((await page.evaluate(() => window.__calls)).length, 2, 'an unusable reply is retried once');
  } finally { await browser.close(); }
});
