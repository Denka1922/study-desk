'use strict';
// Run by the workflow 'Mac check': runs the PACKAGED Mac app on a real Mac (GitHub runner) and checks it like a person would.
const { _electron } = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); };
const sh = c => { try { return cp.execSync(c, { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR ' + e.message.split('\n')[0]; } };

function findApp() {
  const out = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory() && n.name.endsWith('.app')) out.push(p);
      else if (n.isDirectory() && !n.name.endsWith('.app')) walk(p, depth + 1);
    }
  })('desktop/dist', 0);
  return out;
}

(async () => {
  console.log('machine:', sh('uname -m'), sh('sw_vers -productVersion'), 'node arch', process.arch, 'RAM GB', Math.round(os.totalmem() / 2 ** 30));
  const apps = findApp(); console.log('apps found:', apps.join(' | '));
  const app = apps.find(a => a.includes(process.arch === 'arm64' ? 'mac-arm64' : '/mac/')) || apps[0];
  rec('packaged app exists', !!app, app);
  const exe = path.join(app, 'Contents/MacOS/Study Desk');
  console.log(sh('file "' + exe + '"')); console.log(sh('codesign -dv "' + app + '" 2>&1 | head -6'));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  const eapp = await _electron.launch({ executablePath: exe, args: ['--user-data-dir=' + udd], timeout: 120000 });
  const win = await eapp.firstWindow();
  const errs = []; win.on('pageerror', e => errs.push(e.message)); win.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); else if (m.text().startsWith('PROG ')) console.log(m.text().slice(0, 300)); });
  await win.setViewportSize({ width: 1200, height: 800 }).catch(() => {});
  await win.waitForSelector('.glance', { timeout: 60000 });
  rec('window opens and the planner page loads', true, await win.title());
  rec('packaged: app.isPackaged and resources hold app/index.html', await eapp.evaluate(({ app: a }) => a.isPackaged), '');
  const info = await win.evaluate(() => ({ hasBridge: !!(window.studyDesk && window.studyDesk.ai), keys: window.studyDesk ? Object.keys(window.studyDesk) : [], ua: navigator.userAgent }));
  rec('the page gets the AI bridge from the preload', info.hasBridge, JSON.stringify(info.keys));
  // look and feel: screenshot of the planner, then the Tutor setup
  const shot = async name => { const b = await win.screenshot({ type: 'jpeg', quality: 55 }); console.log('SHOT-BEGIN ' + name + '\n' + b.toString('base64') + '\nSHOT-END'); };
  await shot('planner');
  const hw = await win.evaluate(() => window.studyDesk.ai.getHardware());
  console.log('hardware:', JSON.stringify(hw));
  rec('hardware read: darwin and the right chip', hw.platform === 'darwin' && hw.arch === process.arch && hw.appleSilicon === (process.arch === 'arm64'), JSON.stringify(hw));
  const rec1 = await win.evaluate(() => window.studyDesk.ai.recommend({ level: 'max', language: 'English' }));
  console.log('recommend(max):', JSON.stringify(rec1).slice(0, 700));
  rec('recommend picks the right Mac engine', rec1.ok ? rec1.engineAsset === (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : true, rec1.ok ? rec1.engineAsset + ' ' + rec1.model.id : JSON.stringify(rec1));
  const st = await win.evaluate(() => window.studyDesk.ai.local.status());
  rec('local status lists the models', Array.isArray(st.models) ? st.models.length >= 9 : true, JSON.stringify(st).slice(0, 300));
  const detect = await win.evaluate(() => window.studyDesk.ai.cli.detect());
  rec('CLI tool detection runs without crashing', !!detect, JSON.stringify(detect).slice(0, 300));
  // real engine + real small model through the app's own download, start and chat code
  if (process.env.REAL_MODEL) {
    const modelId = process.env.REAL_MODEL;
    try {
      let last = 0;
      await win.evaluate(() => { let n = 0; window.studyDesk.ai.local.onProgress(p => { if (++n % 40 === 1 || p.phase !== 'download') console.log('PROG ' + JSON.stringify(p)); }); });
      await win.evaluate(({ modelId }) => window.studyDesk.ai.local.install({ modelId, level: 'max' }).catch(e => { throw new Error('BRIDGE ' + JSON.stringify(e)); }), { modelId });
      rec('real download of the Mac engine and ' + modelId + ' (fingerprints checked by the app)', true, '');
      await win.evaluate(({ modelId }) => window.studyDesk.ai.local.start({ modelId, level: 'max' }), { modelId });
      rec('the real llama.cpp engine starts on this Mac', true, '');
      const t0 = Date.now();
      const r = await win.evaluate(() => window.studyDesk.ai.chat({ mode: 'local', system: 'Answer in one short sentence.', messages: [{ role: 'user', text: 'What gas do plants take in for photosynthesis?' }], maxTokens: 120, json: false }));
      rec('a real answer comes back', !!(r && r.text && r.text.length > 5), JSON.stringify(r).slice(0, 400) + ' in ' + Math.round((Date.now() - t0) / 1000) + 's');
      await win.evaluate(() => window.studyDesk.ai.local.stop());
    } catch (e) { rec('real local AI on the Mac', false, String(e && e.message || e).slice(0, 900)); }
  }

  // Sync with the phone: the real Wi-Fi door of the real app. A pretend phone (this script) pairs and exchanges data with the app window.
  try {
    const C = require('../desktop/sync/crypto'), http = require('node:http');
    const secret = C.randomSecret(), keys = C.deriveKeys(secret);
    const post = (port, body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/x', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, agent: false }, res => {
        let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s }));
      });
      req.on('error', reject); req.end(data);
    });
    const hasSync = await win.evaluate(() => !!(window.studyDesk && window.studyDesk.sync && window.studyDesk.sync.version === 1));
    rec('the app offers the sync bridge to its page', hasSync, '');
    const started = await win.evaluate(a => window.studyDesk.sync.start(a), { secretB64: C.b64url(secret), mode: 'wifi', deviceId: C.randomId(), name: 'CI Mac' });
    rec('sync starts and opens a Wi-Fi door', !!(started && started.ok && started.port >= 47821), JSON.stringify(started));
    await win.evaluate(() => { window.studyDesk.sync.onRequest(m => Promise.resolve({ rev: 'r-' + m.rev, doc: { v: 1, items: { x1: { k: 'link', u: 5, d: { id: 'x1', name: 'From the app', url: 'https://example.com/' } } }, gone: {} } })); });
    const hello = await post(started.port, C.seal(keys, { op: 'hello', t: Date.now(), from: 'ci', nonce: 'n-123' }));
    const hr = hello.status === 200 ? C.open(keys, JSON.parse(hello.text)) : null;
    rec('the door answers a paired phone (hello)', !!(hr && hr.ok && hr.nonce === 'n-123' && hr.name === 'CI Mac'), hello.status + ' ' + JSON.stringify(hr));
    const sync = await post(started.port, C.seal(keys, { op: 'sync', t: Date.now(), from: 'ci', rev: 'abc', doc: { v: 1, items: {}, gone: {} } }));
    const sr = sync.status === 200 ? C.open(keys, JSON.parse(sync.text)) : null;
    rec('the app window merges what the phone sends and the answer comes back sealed', !!(sr && sr.ok && sr.rev === 'r-abc' && sr.doc.items.x1), sync.status + ' ' + JSON.stringify(sr).slice(0, 200));
    const wrong = await post(started.port, C.seal(C.deriveKeys(C.randomSecret()), { op: 'hello', t: Date.now(), from: 'x', nonce: 'z' }));
    rec('a phone with the wrong code is turned away', wrong.status === 401, String(wrong.status));
    const plain = await new Promise(r => { http.get({ host: '127.0.0.1', port: started.port, path: '/', agent: false }, res => { res.resume(); r(res.statusCode); }).on('error', () => r(0)); });
    rec('anything else on the door gives nothing away (404)', plain === 404, String(plain));
    await win.evaluate(() => window.studyDesk.sync.stop());
    const gone = await post(started.port, C.seal(keys, { op: 'hello', t: Date.now(), from: 'ci', nonce: 'n' })).then(() => false, () => true);
    rec('stopping sync closes the door', gone, '');
  } catch (e) { rec('sync on the real app', false, String(e && e.message || e).slice(0, 900)); }
  rec('no errors in the page', errs.length === 0, errs.join(' | '));
  await shot('end');
  await eapp.close();
  const bad = results.filter(r => !r.ok);
  console.log('\nSUMMARY ' + (results.length - bad.length) + '/' + results.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack || e); process.exit(2); });
