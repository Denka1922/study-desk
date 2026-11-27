'use strict';
// Speaking the answer in the Voice tutor, run in the real page with a scripted desktop bridge and a fake microphone that plays
// a real sound file (so the real recording, level meter and 16 kHz conversion run). The listener itself is faked here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlaywright, pageWithExports } = require('./helpers');

const PG = pageWithExports(['vc', 'vm', 'VM', 'vmEndpoint', 'vmNewEnd', 'vcCfg', 'ai', 'render', 'aiSettingsSet', 'aiSettingsGet'], 'window.__setSend=function(f){ aiSend=f; };');
test.after(() => { PG.cleanup(); fs.rmSync(DIR, { recursive: true, force: true }); });

const qT = (q, a) => 'Q: ' + q + '\n' + [0, 1, 2, 3].map(k => 'ABCD'[k] + ') ' + q + '-opt' + k).join('\n') + '\nANSWER: ' + 'ABCD'[a] + '\nWHY: because';
const OUTLINE = 'TITLE: Geometry Basics\nSUMMARY: A short course.\n' + [1, 2, 3].map(i => 'LESSON: Lesson ' + i + ' | Goal ' + i).join('\n');
const LESSON = '## Right triangles\nA right triangle has one square corner.\nKEY: The long side is the hypotenuse\nEXAMPLE: A 3-4-5 triangle\n9 + 16 = 25\n' + [0, 1, 2, 3].map(j => qT('Q' + j, j)).join('\n');
const START_SCRIPT = 'Welcome to this lesson. Can you explain in your own words what the hypotenuse is?';
const REPLY_SCRIPT = 'Good explanation. Now, why is it opposite the square corner?';

// ---- fake microphone sounds (16 kHz mono WAV files) ----
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mic-'));
function wavFile(name, parts) { // parts: [seconds, amplitude]
  const rate = 16000, n = parts.reduce((a, p) => a + Math.round(p[0] * rate), 0), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let i = 0; for (const [sec, amp] of parts) for (let k = 0; k < Math.round(sec * rate); k++, i++) { const t = i / rate; b.writeInt16LE(Math.round(amp * 32767 * (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 410 * t) * Math.sin(2 * Math.PI * 3 * t)) / 1.6), 44 + i * 2); }
  const f = path.join(DIR, name + '.wav'); fs.writeFileSync(f, b); return f;
}
// 0.6 s of quiet room, 1.6 s of talking, then quiet for a long time
const TALK = wavFile('talk', [[0.6, 0.002], [1.6, 0.35], [30, 0.002]]);
const QUIET = wavFile('quiet', [[30, 0.002]]);

const BRIDGE = `
(function () {
  function wav() {
    var n = 800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    function s(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
    return new Uint8Array(b);
  }
  var LIC = { name: 'Apache-2.0', url: 'https://example.org/' };
  var fb = window.__fb = { calls: [], gate: null, hearText: 'the hypotenuse is the longest side', hearFail: null, hearGate: null, listenInstalled: ['parakeet-en'], cb: null, installGate: null, noListen: false, listenPacks: null, ready: true };
  function packs() { return [{ id: 'kokoro-en', title: 'Kokoro', blurb: 'Natural English voices.', languages: ['en'], license: LIC, sizeBytes: 132353410, installed: true, voices: [{ id: 'af_heart', name: 'Heart', note: 'US, female' }] }]; }
  function listen() {
    return { ready: fb.ready && fb.listenInstalled.length > 0, packs: fb.listenPacks || [
      { id: 'parakeet-en', title: 'English (accurate)', blurb: 'Understands English well.', languages: ['en'], license: { name: 'CC-BY-4.0', url: 'https://example.org/' }, credit: 'NVIDIA Parakeet-TDT-CTC 110M', sizeBytes: 104337827, installed: fb.listenInstalled.indexOf('parakeet-en') >= 0 },
      { id: 'moonshine-en', title: 'English (small)', blurb: 'Lighter.', languages: ['en'], license: { name: 'MIT', url: 'https://example.org/' }, credit: 'Moonshine tiny', sizeBytes: 29858559, installed: fb.listenInstalled.indexOf('moonshine-en') >= 0 } ] };
  }
  var v = { version: 1,
    status: function () { var st = { available: true, engine: { installed: true, sizeBytes: 19000000 }, packs: packs(), studio: { found: false, voices: [] }, installing: '' }; if (!fb.noListen) st.listen = listen(); return Promise.resolve(st); },
    refreshStudio: function () { return Promise.resolve({ found: false, voices: [] }); },
    install: function () { return Promise.resolve({ packs: packs() }); }, cancel: function () { fb.calls.push(['cancel']); return Promise.resolve({}); },
    remove: function () { return Promise.resolve({ packs: packs() }); }, removeAll: function () { return Promise.resolve({}); },
    speak: function () { return Promise.resolve({ wav: wav(), cached: false }); }, cancelSpeak: function () { return Promise.resolve({}); },
    onProgress: function (cb) { fb.cb = cb; return function () { fb.cb = null; }; } };
  if (!window.__noHear) {
    v.hear = function (a) {
      var peak = 0; for (var i = 0; i < a.samples.length; i += 97) peak = Math.max(peak, Math.abs(a.samples[i]));
      fb.calls.push(['hear', { packId: a.packId, lang: a.lang, n: a.samples.length, f32: a.samples instanceof Float32Array, peak: peak, keys: Object.keys(a).sort().join() }]);
      if (fb.hearFail) return Promise.reject(fb.hearFail);
      var go = function () { return { text: fb.hearText }; };
      return fb.hearGate ? fb.hearGate.then(go) : Promise.resolve(go());
    };
    v.cancelHear = function () { fb.calls.push(['cancelHear']); return Promise.resolve({}); };
    v.listenInstall = function (a) { fb.calls.push(['listenInstall', a]); var done = function () { fb.listenInstalled.push(a.packId); return { listen: listen() }; }; return fb.installGate ? fb.installGate.then(done) : Promise.resolve(done()); };
    v.listenRemove = function (a) { fb.calls.push(['listenRemove', a]); fb.listenInstalled = fb.listenInstalled.filter(function (x) { return x !== a.packId; }); return Promise.resolve({ listen: listen() }); };
  }
  window.studyDesk = { voice: v };
})();`;

// Keeps track of every microphone stream the page opens, so a test can check that the microphone is really released.
const MIC_SPY = `
(function () {
  var s = window.__streams = [], gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = function (c) { window.__gum = (window.__gum || 0) + 1; window.__constraints = JSON.stringify(c); return gum(c).then(function (st) { s.push(st); return st; }); };
})();`;
const live = page => page.evaluate(() => window.__streams.filter(s => s.getTracks().some(t => t.readyState === 'live')).length);

const browsers = {};
async function browserFor(file) {
  if (!browsers[file]) browsers[file] = Promise.resolve(loadPlaywright().chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + file + '%noloop'] }));
  return browsers[file];
}
test.after(async () => { for (const k of Object.keys(browsers)) await (await browsers[k]).close(); });

async function open(opts = {}) {
  const ctx = await (await browserFor(opts.sound || TALK)).newContext({ viewport: { width: opts.width || 1280, height: opts.height || 900 } });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(`try{sessionStorage.setItem('sd-ai-key','KEY-UI-TEST-1234567890')}catch(e){}`);
  if (opts.noHear) await page.addInitScript('window.__noHear=true;');
  await page.addInitScript(BRIDGE);
  if (opts.mic !== false) await page.addInitScript(MIC_SPY);
  if (opts.pre) await page.addInitScript(opts.pre);
  await page.goto(PG.url); await page.waitForSelector('.glance');
  await page.evaluate(([o, l, s, r]) => {
    window.__setSend(function (req) {
      var t = /speaking out loud/.test(req.system) ? (/The student just explained/.test(req.system) ? r : s) : /Write lesson (\d+) of/.test(req.system) ? l : o;
      window.__lastReq = req;
      return Promise.resolve({ text: t, usage: { input: 1, output: 1, estimated: true } });
    });
  }, [OUTLINE, LESSON, START_SCRIPT, REPLY_SCRIPT]);
  return { ctx, page, errors };
}
async function toLesson(page, language) {
  await page.locator('[data-view="tutor"]:visible').first().click(); await page.waitForSelector('#ai-new');
  await page.fill('#ai-topic', 'Geometry'); await page.selectOption('#ai-count', '3');
  if (language) await page.selectOption('#ai-lang', language);
  await page.click('#ai-create'); await page.waitForSelector('#ai-course');
  await page.click('[data-act="ai-lesson"][data-i="0"]'); await page.waitForSelector('#ai-lesson');
}
const waitPhase = (page, p) => page.waitForFunction(x => vc.phase === x, p, { timeout: 8000 });
const calls = (page, name) => page.evaluate(n => window.__fb.calls.filter(c => c[0] === n).map(c => c[1]), name);
// opens the tutor and gets to the student's turn (the script is read with the downloaded voice, which the fake answers at once)
async function toTurn(page, language) {
  await toLesson(page, language);
  await page.click('[data-act="vc-open"]'); await page.waitForSelector('#vc-main');
  await page.click('#vc-main'); await waitPhase(page, 'speaking');
  await page.click('[data-act="vc-skip"]'); await waitPhase(page, 'listening');
}
const state = page => page.evaluate(() => vm.state);
const waitState = (page, s, ms) => page.waitForFunction(x => vm.state === x, s, { timeout: ms || 8000 });
const val = page => page.inputValue('#vc-ans');

// ---- the stopping rule (pure) ----
test('the stopping rule: it learns the room noise first, stops after talking then quiet, waits for speech, and has a time limit', async () => {
  const { ctx, page } = await open({ mic: false });
  const r = await page.evaluate(() => {
    const run = (levels, dt) => { const s = vmNewEnd(); const out = []; for (const l of levels) { const x = vmEndpoint(s, l, dt); out.push(x); if (x) break; } return { out, s }; };
    const rep = (v, n) => Array(n).fill(v);
    const talk = run([...rep(0.003, 8), ...rep(0.2, 20), ...rep(0.003, 40)], 100);
    const blip = run([...rep(0.003, 8), 0.2, ...rep(0.003, 150)], 100);
    const noisy = run([...rep(0.02, 8), ...rep(0.35, 20), ...rep(0.02, 40)], 100);
    const nobody = run(rep(0.003, 400), 100);
    const eager = run([...rep(0.2, 20), ...rep(0.003, 40)], 100);
    const never = run([...rep(0.003, 8), ...rep(0.2, 2000)], 100);
    const pause = run([...rep(0.003, 8), ...rep(0.2, 10), ...rep(0.003, 10), ...rep(0.2, 10), ...rep(0.003, 40)], 100);
    return { talk: talk.out.length * 100 + ':' + talk.out.pop(), blip: blip.out.pop() || '', noisy: noisy.out.length * 100 + ':' + noisy.out.pop(), nobody: nobody.out.length * 100 + ':' + nobody.out.pop(), never: never.out.pop(), pause: pause.out.length * 100 + ':' + pause.out.pop(), eager: eager.out.length * 100 + ':' + eager.out.pop() };
  });
  assert.match(r.talk, /^[0-9]+:quiet$/); const t = parseInt(r.talk, 10); assert.ok(t >= 800 + 2000 + 1500 && t <= 800 + 2000 + 1800, 'stops about 1.6 s after the talking ends: ' + r.talk);
  assert.strictEqual(r.blip, 'waited', 'a click or a cough is not an answer, so it keeps waiting and then gives up');
  assert.match(r.noisy, /:quiet$/, 'a noisy room still works: the level of the room is learned first');
  assert.match(r.nobody, /^12[0-9]{3}:waited$/, 'nobody speaks: gives up after about 12 s');
  assert.strictEqual(r.never, 'limit', 'a very long answer is cut at the time limit');
  assert.match(r.eager, /:quiet$/, 'a student who starts talking at once is not mistaken for room noise');
  const p = parseInt(r.pause, 10); assert.ok(p > 800 + 1000 + 1000 + 1000 + 1500, 'a short pause in the middle of an answer does not end it: ' + r.pause);
  await ctx.close();
});

// ---- showing it ----
test('without a listener in the app there is no microphone button and no mode choice', async () => {
  const { ctx, page, errors } = await open({ noHear: true });
  await toTurn(page);
  assert.strictEqual(await page.locator('#vm-toggle, [name="vm-mode"], .vm').count(), 0);
  assert.ok(await page.locator('#vc-ans').isVisible());
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('the student\'s turn shows a Speak button, the Push to talk / Mic open choice (Push to talk is the start) and keeps typing', async () => {
  const { ctx, page, errors } = await open();
  await toTurn(page);
  assert.match(await page.locator('#vm-toggle').innerText(), /Speak/i);
  assert.strictEqual(await page.locator('[name="vm-mode"]').count(), 2);
  assert.strictEqual(await page.locator('[name="vm-mode"]:checked').getAttribute('value'), 'push');
  const labels = await page.locator('.vm-mode label').allInnerTexts();
  assert.match(labels[0], /Push to talk/); assert.match(labels[0], /press/i); assert.match(labels[1], /Mic open/); assert.match(labels[1], /quiet/i);
  assert.ok(await page.locator('#vc-ans').isVisible(), 'typing still works');
  assert.strictEqual(await page.evaluate(() => window.__gum || 0), 0, 'the microphone is not touched until the student asks');
  assert.strictEqual(await state(page), 'off');
  assert.ok((await page.locator('#vm-toggle').innerText()).trim().length > 0, 'the button has a name'); assert.strictEqual(await page.locator('fieldset.vm-mode legend').count(), 1);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

// ---- push to talk ----
test('push to talk: press to start, a level bar moves, press again, the words land in the box, and the microphone is released', async () => {
  const { ctx, page, errors } = await open();
  await toTurn(page);
  await page.click('#vm-toggle'); await waitState(page, 'recording');
  assert.match(await page.locator('#vm-toggle').innerText(), /Stop|Done/i);
  const c = await page.evaluate(() => JSON.parse(window.__constraints).audio); assert.strictEqual(c.echoCancellation, true); assert.strictEqual(c.noiseSuppression, true);
  await page.waitForFunction(() => { const e = document.getElementById('vm-level'); return e && parseFloat(e.style.width) > 5; }, null, { timeout: 5000 });
  assert.strictEqual(await calls(page, 'hear').then(x => x.length), 0, 'nothing is understood while the student is still talking');
  await page.waitForTimeout(1200);
  assert.strictEqual(await state(page), 'recording', 'push to talk never stops by itself');
  await page.click('#vm-toggle');
  await page.waitForFunction(() => window.__fb.calls.some(c => c[0] === 'hear'), null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('vc-ans') && document.getElementById('vc-ans').value.length > 0, null, { timeout: 5000 });
  const h = (await calls(page, 'hear'))[0];
  assert.deepStrictEqual([h.packId, h.lang, h.f32, h.keys], ['parakeet-en', 'en', true, 'lang,packId,samples']);
  assert.ok(h.n > 16000 * 1.8 && h.n < 16000 * 6, 'about 16 000 numbers per second of sound: ' + h.n);
  assert.ok(h.peak > 0.05, 'real sound, not silence: ' + h.peak);
  assert.strictEqual(await val(page), 'the hypotenuse is the longest side');
  assert.strictEqual(await state(page), 'off'); assert.strictEqual(await live(page), 0, 'the microphone is released');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'vc-ans', 'the student can fix the words at once');
  assert.match(await page.locator('#vm-note').innerText(), /check/i);
  await page.keyboard.press('Enter'); await waitPhase(page, 'speaking');
  assert.match(await page.evaluate(() => window.__lastReq.messages[0].text), /hypotenuse is the longest side/, 'the spoken words are what the tutor receives');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('new words are added after what the student already typed, and an empty result says so without touching the box', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.fill('#vc-ans', 'It has a square corner.');
  await page.evaluate(() => { window.__fb.hearText = 'and the long side'; });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(900); await page.click('#vm-toggle');
  await page.waitForFunction(() => document.getElementById('vc-ans').value.indexOf('long side') > 0, null, { timeout: 8000 });
  assert.strictEqual(await val(page), 'It has a square corner. and the long side');
  await page.evaluate(() => { window.__fb.hearText = '  '; });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(500); await page.click('#vm-toggle'); await waitState(page, 'off');
  assert.strictEqual(await val(page), 'It has a square corner. and the long side');
  assert.match(await page.locator('#vm-note').innerText(), /did not catch|didn't catch|no words/i);
  assert.strictEqual(await page.locator('#vc-err').innerText(), '', 'not catching words is a hint, not an error');
  await ctx.close();
});

test('while the words are being understood the page says so, and the student can still type', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.evaluate(() => { window.__release = null; window.__fb.hearGate = new Promise(r => { window.__release = r; }); });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(800); await page.click('#vm-toggle'); await waitState(page, 'working');
  assert.match(await page.locator('.vm').innerText(), /understanding/i);
  await page.fill('#vc-ans', 'typing meanwhile');
  await page.evaluate(() => window.__release()); await waitState(page, 'off');
  assert.match(await val(page), /^typing meanwhile.*hypotenuse/);
  await ctx.close();
});

// ---- mic open ----
test('mic open: one press, it stops by itself when the student goes quiet, and the words land in the box', async () => {
  const { ctx, page, errors } = await open();
  await toTurn(page);
  await page.check('[name="vm-mode"][value="open"]');
  assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('study-desk-voice-v1')).mic), 'open', 'the choice is remembered');
  await page.click('#vm-toggle'); await waitState(page, 'recording');
  assert.match(await page.locator('.vm').innerText(), /listening/i);
  await page.waitForFunction(() => window.__fb.calls.some(c => c[0] === 'hear'), null, { timeout: 12000 });
  await page.waitForFunction(() => document.getElementById('vc-ans').value.length > 0, null, { timeout: 5000 });
  const h = (await calls(page, 'hear'))[0]; assert.ok(h.n > 16000 * 2.5 && h.n < 16000 * 7, 'about 0.6 s + 1.6 s of talking + the quiet that ended it: ' + h.n);
  assert.strictEqual(await live(page), 0); assert.strictEqual(await val(page), 'the hypotenuse is the longest side');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('mic open: if nobody speaks it closes by itself with a hint and does not call the listener', async () => {
  const { ctx, page } = await open({ sound: QUIET });
  await toTurn(page);
  await page.evaluate(() => { VM.wait = 2000; vcCfg().mic = 'open'; });
  await page.click('#vm-toggle'); await waitState(page, 'recording');
  await waitState(page, 'off', 7000);
  assert.strictEqual((await calls(page, 'hear')).length, 0);
  assert.match(await page.locator('#vm-note').innerText(), /did not hear|didn't hear/i);
  assert.strictEqual(await live(page), 0); assert.strictEqual(await val(page), '');
  await ctx.close();
});

test('mic open starts by itself on the student\'s turn only after the student chose it and used the microphone once; push to talk never does', async () => {
  const pre = `try{localStorage.setItem('study-desk-voice-v1',JSON.stringify({voice:'',speed:1,mic:'open',micOk:true}))}catch(e){}`;
  const a = await open({ pre });
  await toTurn(a.page);
  await waitState(a.page, 'recording');
  assert.strictEqual(await a.page.evaluate(() => window.__gum), 1);
  await a.ctx.close();
  const b = await open({ pre: `try{localStorage.setItem('study-desk-voice-v1',JSON.stringify({voice:'',speed:1,mic:'push',micOk:true}))}catch(e){}` });
  await toTurn(b.page); await b.page.waitForTimeout(900);
  assert.strictEqual(await state(b.page), 'off'); assert.strictEqual(await b.page.evaluate(() => window.__gum || 0), 0);
  await b.ctx.close();
  const c = await open({ pre: `try{localStorage.setItem('study-desk-voice-v1',JSON.stringify({voice:'',speed:1,mic:'open'}))}catch(e){}` });
  await toTurn(c.page); await c.page.waitForTimeout(900);
  assert.strictEqual(await state(c.page), 'off', 'the first time the student presses the button themselves');
  await c.page.click('#vm-toggle'); await waitState(c.page, 'recording');
  assert.strictEqual(await c.page.evaluate(() => vcCfg().micOk), true, 'after one successful start the microphone is known to work');
  await c.ctx.close();
});

// ---- stopping and leaving ----
test('Send, Replay, Escape, Close and leaving the lesson all stop the recording and release the microphone without understanding it', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  const start = async () => { await page.click('#vm-toggle'); await waitState(page, 'recording'); };
  await start(); await page.fill('#vc-ans', 'typed answer'); await page.press('#vc-ans', 'Enter'); await waitPhase(page, 'speaking');
  assert.strictEqual(await live(page), 0); assert.strictEqual(await state(page), 'off', 'Send');
  await page.click('[data-act="vc-skip"]'); await waitPhase(page, 'listening');
  await start(); await page.click('[data-act="vc-replay"]'); assert.strictEqual(await state(page), 'off', 'Replay'); assert.strictEqual(await live(page), 0);
  await page.click('[data-act="vc-skip"]'); await waitPhase(page, 'listening');
  await start(); await page.keyboard.press('Escape'); await waitState(page, 'off');
  assert.ok(await page.locator('#vc').count() === 1, 'the first Escape only stops the microphone'); assert.strictEqual(await live(page), 0);
  await start(); await page.click('[data-act="vc-close"]'); assert.strictEqual(await page.locator('#vc').count(), 0); assert.strictEqual(await live(page), 0);
  await page.click('[data-act="vc-open"]'); await page.waitForSelector('#vc-main'); await page.click('#vc-main'); await waitPhase(page, 'speaking'); await page.click('[data-act="vc-skip"]'); await waitPhase(page, 'listening');
  await start(); await page.click('[data-act="ai-back-course"], [data-act="ai-courses"], [data-view="plan"]:visible').catch(() => {}); await page.evaluate(() => { ai.screen = 'course'; render(); });
  await page.waitForFunction(() => !document.getElementById('vc')); assert.strictEqual(await live(page), 0, 'leaving the lesson');
  assert.strictEqual((await calls(page, 'hear')).length, 0, 'nothing that was stopped was sent to the listener');
  await ctx.close();
});

test('stopping while the words are being understood throws the result away and tells the listener to stop', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.evaluate(() => { window.__fb.hearGate = new Promise(r => { window.__release = r; }); });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(800); await page.click('#vm-toggle'); await waitState(page, 'working');
  await page.click('[data-act="vc-close"]');
  assert.ok((await calls(page, 'cancelHear')).length >= 1);
  await page.evaluate(() => window.__release()); await page.waitForTimeout(150);
  assert.strictEqual(await page.locator('#vc').count(), 0);
  await ctx.close();
});

// ---- problems ----
test('a blocked, missing or busy microphone gives a plain message with what to do, and typing still works', async () => {
  for (const [name, re] of [['NotAllowedError', /not allowed|blocked|allow/i], ['NotFoundError', /no microphone/i], ['NotReadableError', /another program|in use|busy/i], ['SecurityError', /microphone/i]]) {
    const { ctx, page, errors } = await open({ mic: false, pre: `navigator.mediaDevices.getUserMedia=function(){ return Promise.reject(new DOMException('x','${name}')); };` });
    await toTurn(page);
    await page.click('#vm-toggle');
    await page.waitForFunction(() => document.getElementById('vc-err') && document.getElementById('vc-err').textContent.length > 0, null, { timeout: 5000 });
    const msg = await page.locator('#vc-err').innerText(); assert.match(msg, re, name);
    if (name === 'NotAllowedError') assert.match(msg, /privacy|settings/i, 'says where to switch it on');
    assert.strictEqual(await state(page), 'off'); assert.ok(await page.locator('#vc-ans').isVisible()); assert.ok(await page.locator('#vm-toggle').isEnabled());
    assert.deepStrictEqual(errors, [], name); await ctx.close();
  }
});

test('a listener error keeps the box as it was, says what happened, and the student can try again', async () => {
  const { ctx, page, errors } = await open();
  await toTurn(page);
  await page.fill('#vc-ans', 'keep me');
  await page.evaluate(() => { window.__fb.hearFail = { kind: 'engine', message: 'This listening model is not installed yet.' }; });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(800); await page.click('#vm-toggle'); await waitState(page, 'off');
  assert.match(await page.locator('#vc-err').innerText(), /not installed yet/); assert.strictEqual(await val(page), 'keep me');
  await page.evaluate(() => { window.__fb.hearFail = { kind: 'bad', message: '<img src=x onerror=window.__pwn=1>' }; });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(800); await page.click('#vm-toggle'); await waitState(page, 'off');
  assert.strictEqual(await page.evaluate(() => window.__pwn || 0), 0, 'error text is never treated as markup');
  await page.evaluate(() => { window.__fb.hearFail = null; });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(800); await page.click('#vm-toggle');
  await page.waitForFunction(() => document.getElementById('vc-ans').value.indexOf('hypotenuse') > 0, null, { timeout: 8000 });
  assert.strictEqual(await page.locator('#vc-err').innerText(), '', 'the old error is cleared');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('a recording that is far too short is not sent to the listener', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.click('#vm-toggle'); await waitState(page, 'off');
  assert.strictEqual((await calls(page, 'hear')).length, 0);
  assert.match(await page.locator('#vm-note').innerText(), /too short|hold|longer/i);
  await ctx.close();
});

// ---- the listening model ----
test('with no listening model installed the student is offered one: size, licence credit, progress, and then the microphone works', async () => {
  const { ctx, page, errors } = await open({ pre: 'window.__pre=1;' });
  await page.addInitScript(() => { }); // (the bridge is already in place)
  await page.evaluate(() => { window.__fb.listenInstalled = []; });
  await toTurn(page);
  assert.strictEqual(await page.locator('#vm-toggle').count(), 0, 'no Speak button without a model');
  const offer = await page.locator('.vm').innerText(); assert.match(offer, /100 MB/); assert.match(offer, /offline|without internet/i);
  await page.evaluate(() => { window.__fb.installGate = new Promise(r => { window.__go = r; }); });
  await page.click('#vm-get');
  assert.deepStrictEqual(await calls(page, 'listenInstall'), [{ packId: 'parakeet-en' }], 'the best model for the course language');
  await page.evaluate(() => window.__fb.cb({ phase: 'voice', modelId: 'parakeet-en', packId: 'parakeet-en', done: 50, total: 100 }));
  assert.strictEqual(await page.locator('.vm .vc-pct').innerText(), '50%');
  assert.strictEqual(await page.locator('#vm-get').count(), 0, 'no second download while one runs');
  await page.evaluate(() => window.__go()); await page.waitForSelector('#vm-toggle', { timeout: 5000 });
  assert.strictEqual(await page.locator('.vm .vc-pct').count(), 0);
  assert.deepStrictEqual(errors, []); await ctx.close();
});

test('a course in a language with no listening model says speaking is not ready for it, offers nothing to download, and typing works', async () => {
  const { ctx, page } = await open();
  await toTurn(page, 'Turkish');
  assert.strictEqual(await page.locator('#vm-toggle, #vm-get').count(), 0);
  assert.match(await page.locator('.vm').innerText(), /Turkish/); assert.match(await page.locator('.vm').innerText(), /type/i);
  assert.ok(await page.locator('#vc-ans').isVisible());
  await ctx.close();
});

test('a failed or cancelled listening download shows a plain message and keeps the offer', async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__fb.listenInstalled = []; });
  await toTurn(page);
  await page.evaluate(() => { const l = window.studyDesk.voice.listenInstall; window.studyDesk.voice.listenInstall = function () { return Promise.reject({ kind: 'checksum', message: 'x' }); }; });
  await page.click('#vm-get');
  await page.waitForFunction(() => /safety check/i.test(document.getElementById('vc-err').textContent), null, { timeout: 5000 });
  assert.ok(await page.locator('#vm-get').isEnabled()); assert.strictEqual(await page.evaluate(() => vc.prog), null);
  await ctx.close();
});

test('the More section lists the listening models with credit and licence, and a model can be removed', async () => {
  const { ctx, page } = await open();
  await toLesson(page); await page.click('[data-act="vc-open"]'); await page.waitForSelector('#vc-main');
  await page.evaluate(() => { document.querySelector('.vc-more').open = true; vc.more = true; });
  const more = await page.locator('.vc-more').innerText();
  assert.match(more, /English \(accurate\)/); assert.match(more, /CC-BY-4.0/); assert.match(more, /NVIDIA Parakeet/); assert.match(more, /English \(small\)/);
  await page.click('[data-act="vm-remove"][data-id="parakeet-en"]');
  await page.waitForFunction(() => window.__fb.calls.some(c => c[0] === 'listenRemove'), null, { timeout: 5000 });
  assert.deepStrictEqual(await calls(page, 'listenRemove'), [{ packId: 'parakeet-en' }]);
  await page.waitForSelector('[data-act="vm-install"][data-id="parakeet-en"]');
  await ctx.close();
});

// ---- settings and looks ----
test('the mode is saved and restored; a damaged saved value falls back to Push to talk', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.check('[name="vm-mode"][value="open"]'); await page.check('[name="vm-mode"][value="push"]');
  assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('study-desk-voice-v1')).mic), 'push');
  await page.check('[name="vm-mode"][value="open"]');
  await page.click('[data-act="vc-close"]'); await page.click('[data-act="vc-open"]'); await page.waitForSelector('#vc-main');
  assert.strictEqual(await page.locator('[name="vm-mode"]:checked').getAttribute('value'), 'open', 'kept for the next time');
  await ctx.close();
  const bad = await open({ pre: `try{localStorage.setItem('study-desk-voice-v1',JSON.stringify({voice:'',speed:1,mic:'<b>x</b>',micOk:'yes'}))}catch(e){}` });
  await toTurn(bad.page);
  assert.strictEqual(await bad.page.locator('[name="vm-mode"]:checked').getAttribute('value'), 'push');
  assert.strictEqual(await bad.page.evaluate(() => vcCfg().micOk), false);
  await bad.ctx.close();
});

test('the mode choice can be changed in the middle of recording: the next press uses it, and a running recording is not cut', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.click('#vm-toggle'); await waitState(page, 'recording');
  await page.check('[name="vm-mode"][value="open"]');
  assert.strictEqual(await state(page), 'recording'); await page.waitForTimeout(1000);
  await page.click('#vm-toggle'); await page.waitForFunction(() => window.__fb.calls.some(c => c[0] === 'hear'), null, { timeout: 8000 });
  await ctx.close();
});

test('phone width and dark theme: the microphone block fits, every control has a name, and nothing scrolls sideways', async () => {
  const { ctx, page, errors } = await open({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await toTurn(page);
  await page.click('#vm-toggle'); await waitState(page, 'recording');
  const r = await page.evaluate(() => { const c = document.getElementById('vc').getBoundingClientRect(); return { l: c.left, r: c.right, w: innerWidth, sw: document.documentElement.scrollWidth, card: document.getElementById('vc').scrollWidth - document.getElementById('vc').clientWidth,
    unnamed: [...document.querySelectorAll('#vc button, #vc input, #vc select, #vc textarea')].filter(e => !(e.getAttribute('aria-label') || (e.labels && e.labels.length) || e.textContent.trim())).length }; });
  assert.ok(r.l >= 0 && r.r <= r.w && r.sw <= r.w && r.card <= 0, JSON.stringify(r)); assert.strictEqual(r.unnamed, 0);
  assert.strictEqual(await page.locator('#vm-level').evaluate(e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), true, 'the level bar has a colour in the dark theme');
  assert.deepStrictEqual(errors, []); await ctx.close();
});


// ---- found by the independent review ----
test('review: a failure while setting up the recorder shows a message and leaves the Speak button usable', async () => {
  const { ctx, page } = await open({ pre: 'window.MediaRecorder = function () { throw new Error("no recorder"); }; window.MediaRecorder.isTypeSupported = function () { return false; };' });
  await toTurn(page);
  await page.click('#vm-toggle');
  await page.waitForFunction(() => document.getElementById('vc-err') && document.getElementById('vc-err').textContent.length > 0, null, { timeout: 5000 });
  assert.match(await page.locator('#vc-err').innerText(), /microphone did not start/i);
  assert.strictEqual(await state(page), 'off'); assert.ok(await page.locator('#vm-toggle').isEnabled()); assert.match(await page.locator('#vm-toggle').innerText(), /Speak/);
  assert.strictEqual(await live(page), 0, 'the microphone is released');
  await ctx.close();
});

test('review: a long spoken answer is cut to what can be sent, and the student is told, so the box matches what is sent', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.evaluate(() => { window.__fb.hearText = ('word ').repeat(500).trim(); });
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(900); await page.click('#vm-toggle'); await waitState(page, 'off');
  const v = await val(page);
  assert.ok(v.length <= 1200 && v.length > 1000 && !/\s$/.test(v), 'cut at a word: ' + v.length);
  assert.match(await page.locator('#vm-note').innerText(), /long|first part|shortened/i);
  await page.keyboard.press('Enter'); await waitPhase(page, 'speaking');
  assert.strictEqual(await page.evaluate(() => vc.hist[vc.hist.length - 2].text), v, 'what the tutor receives is what the student saw');
  await ctx.close();
});

test('review: the recording time limit follows the clock, not the number of timer ticks', async () => {
  const { ctx, page } = await open();
  await toTurn(page);
  await page.click('#vm-toggle'); await waitState(page, 'recording'); await page.waitForTimeout(900);
  await page.evaluate(() => { vm.t0 = Date.now() - VM.max - 50; }); // as if the window had been minimised and the timer slowed down
  await page.waitForFunction(() => window.__fb.calls.some(c => c[0] === 'hear'), null, { timeout: 5000 });
  await ctx.close();
});
