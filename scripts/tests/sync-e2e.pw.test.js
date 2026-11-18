'use strict';
// A whole pairing without real devices: the real PC code (Wi-Fi server, relay client, service) and the real relay Worker, with the real page
// on both sides. Only the phone's network plugin and the PC's window bridge are stand-ins (they call the real code).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { loadPlaywright, pageWithExports } = require('./helpers');
const { createSyncService } = require('../../desktop/sync/service');
const { createLanServer } = require('../../desktop/sync/lan-server');
const { createRelayClient } = require('../../desktop/sync/relay-client');

const PG = pageWithExports(['changed', 'normalize', 'lsWrite', 'syncDoc', 'syncRev', 'syncPhoneTick'], 'window.__st=function(){return state;};window.__set=function(s){state=normalize(s);lsWrite();};window.__conn=function(){return syncRt.conn;};');
let browser, worker; const opened = [];
test.before(async () => { worker = await import('../../relay/worker.js'); browser = await loadPlaywright().chromium.launch(); });
test.after(async () => { for (const c of opened) await c.close().catch(() => {}); if (browser) await browser.close(); PG.cleanup(); });

const FAKE_IP = '192.168.1.20';
const fakeOs = { networkInterfaces: () => ({ wlan0: [{ family: 'IPv4', address: FAKE_IP, internal: false }] }) };
function fakeKV() { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; }
const ev = (id, title) => ({ id, type: 'exam', title, course: 'Math', date: '2026-12-01', endDate: '', time: '', score: null, max: 100, note: '' });
const tk = (id, title) => ({ id, title, course: 'Math', due: '2026-12-02', done: false, note: '' });

// The network between the two devices. `lan` maps the pretend home address onto the test server.
function makeNet(kv, lanPort) {
  const log = { lan: [], relay: [] };
  const relayFetch = (u, init) => worker.handle(new Request(u, init), { ROOMS: kv });
  async function request(o) {
    const url = new URL(o.url);
    if (url.hostname === 'relay.test') {
      const r = await worker.handle(new Request(o.url, { method: o.method, headers: o.headers, body: o.data === undefined ? undefined : (typeof o.data === 'string' ? o.data : JSON.stringify(o.data)) }), { ROOMS: kv });
      log.relay.push(o.method + ' ' + r.status);
      const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch (e) { /* plain text */ }
      return { status: r.status, data, headers: {} };
    }
    if (url.hostname !== FAKE_IP || lanPort() === 0) { log.lan.push('miss ' + url.hostname); throw new Error('no route to host'); }
    return new Promise((resolve, reject) => {
      const body = o.data === undefined ? null : JSON.stringify(o.data);
      const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: url.pathname, method: o.method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body || '') }, agent: false, timeout: o.readTimeout || 5000 }, res => {
        let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let d = t; try { d = JSON.parse(t); } catch (e) { /* not json */ } log.lan.push(o.method + ' ' + res.statusCode); resolve({ status: res.statusCode, data: d, headers: {} }); });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
      if (body) req.write(body); req.end();
    });
  }
  return { request, relayFetch, log };
}

async function makePair(opts = {}) {
  const phoneBrowser = opts.phoneBrowser || browser;
  const kv = fakeKV(); let port = 0;
  const net = makeNet(kv, () => port);
  const pcCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const phCtx = await phoneBrowser.newContext({ viewport: { width: 420, height: 800 }, permissions: ['camera'] });
  const pcPage = await pcCtx.newPage(), phPage = await phCtx.newPage();
  const svc = createSyncService({
    os: fakeOs,
    askPage: msg => pcPage.evaluate(m => window.__onReq(m), msg),
    emitStatus: s => { pcPage.evaluate(x => window.__onStatus && window.__onStatus(x), s).catch(() => {}); },
    makeLan: ({ getKeys, onMessage }) => createLanServer({ getKeys, onMessage, portStart: opts.port || 0, portEnd: opts.port || 0 }),
    makeRelay: ({ baseUrl, keys }) => createRelayClient({ baseUrl, keys, fetchImpl: net.relayFetch }),
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 400)),
  });
  await pcPage.exposeFunction('__svc', async (name, arg) => {
    if (name === 'start') { const r = await svc.start(arg); port = r.port || 0; return r; }
    if (name === 'publish') { svc.publish(arg); return {}; }
    if (name === 'forget') { await svc.forget(); return {}; }
    if (name === 'stop') { await svc.stop(); return {}; }
    return {};
  });
  await pcPage.addInitScript(() => {
    window.studyDesk = { sync: { version: 1, start: a => window.__svc('start', a), stop: () => window.__svc('stop'), forget: () => window.__svc('forget'), publish: a => window.__svc('publish', a), status: () => Promise.resolve({}),
      onRequest: cb => { window.__onReq = cb; return () => {}; }, onStatus: cb => { window.__onStatus = cb; return () => {}; } } };
  });
  await phPage.exposeFunction('__http', o => net.request(o));
  await phPage.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request: o => window.__http(o) } } }; });
  if (opts.pcConn) await pcPage.addInitScript(c => { try { if (!localStorage.getItem('sd-sync-conn')) localStorage.setItem('sd-sync-conn', JSON.stringify(c)); } catch (e) { /* none */ } }, opts.pcConn);
  for (const p of [pcPage, phPage]) { await p.goto(PG.url); await p.waitForSelector('.glance'); }
  const pair = { kv, net, svc, pcPage, phPage, setPort: v => { port = v; }, async close() { await svc.stop(); await pcCtx.close(); await phCtx.close(); } };
  opened.push(pair); return pair;
}
const open = p => p.evaluate(() => document.querySelector('[data-sync-open]').click());
async function pcShowQr(pc, mode, relay) {
  await open(pc.pcPage);
  if (mode !== 'wifi') {
    await pc.pcPage.click('input[name="sy-mode"][value="' + mode + '"]');
    await pc.pcPage.fill('#sy-relay', relay || 'https://relay.test');
  }
  await pc.pcPage.click('[data-sy="show"]');
  await pc.pcPage.waitForSelector('#sy-code', { state: 'attached' });
  return pc.pcPage.evaluate(() => document.querySelector('#sy-code').textContent);
}
async function phonePaste(pc, code) {
  await open(pc.phPage);
  await pc.phPage.evaluate(c => { document.querySelector('#sy-paste').value = c; document.querySelector('[data-sy="paste"]').click(); }, code);
}
const titles = p => p.evaluate(() => __st().events.map(e => e.title).sort().join('|') + '#' + __st().tasks.map(t => t.title).sort().join('|'));
const synced = (p, ms = 15000) => p.waitForFunction(() => /^Synced/.test((document.querySelector('#sy-status') || {}).textContent || ''), null, { timeout: ms });
const sameRevs = async pc => (await pc.pcPage.evaluate(async () => syncRev(syncDoc()))) === (await pc.phPage.evaluate(async () => syncRev(syncDoc())));

test('Same Wi-Fi: scan once, then changes on either device reach the other and deletions travel', async () => {
  const pc = await makePair();
  await pc.pcPage.evaluate(() => { __set({ events: [{ id: 'e1', type: 'exam', title: 'Physics exam', course: 'Phys', date: '2026-12-01', endDate: '', time: '', score: null, max: 100, note: '' }], tasks: [], links: [] }); });
  const code = await pcShowQr(pc, 'wifi');
  assert.match(code, /^SDSYNC1\./);
  await phonePaste(pc, code);
  await synced(pc.phPage);
  assert.strictEqual(await titles(pc.phPage), 'Physics exam#', 'the phone received the PC data');

  await pc.pcPage.evaluate(() => { const s = __st(); s.tasks.push({ id: 't1', title: 'Essay from PC', course: 'Eng', due: '2026-12-05', done: false, note: '' }); changed(); });
  await pc.phPage.waitForFunction(() => __st().tasks.some(t => t.title === 'Essay from PC'), null, { timeout: 15000 });     // PC change reaches the phone by itself

  await pc.phPage.evaluate(() => { const s = __st(); s.events.push({ id: 'e2', type: 'exam', title: 'Phone exam', course: 'Bio', date: '2026-12-09', endDate: '', time: '', score: null, max: 100, note: '' }); changed(); });
  await pc.pcPage.waitForFunction(() => __st().events.some(e => e.title === 'Phone exam'), null, { timeout: 15000 });         // phone change reaches the PC
  assert.strictEqual(await titles(pc.pcPage), 'Phone exam|Physics exam#Essay from PC');

  await pc.pcPage.evaluate(() => { const s = __st(); s.events = s.events.filter(e => e.id !== 'e1'); changed(); });
  await pc.phPage.waitForFunction(() => !__st().events.some(e => e.id === 'e1'), null, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(await sameRevs(pc), true);
  assert.strictEqual(await titles(pc.phPage), 'Phone exam#Essay from PC');
  await pc.close();
});

test('Same Wi-Fi: when the PC gets a new address the phone finds it again by itself', async () => {
  const pc = await makePair();
  await pc.pcPage.evaluate(() => { __set({ events: [], tasks: [{ id: 't1', title: 'Before', course: '', due: '2026-12-05', done: false, note: '' }], links: [] }); });
  const code = await pcShowQr(pc, 'wifi');
  await phonePaste(pc, code); await synced(pc.phPage);
  // The saved addresses go stale (as after a router restart): only the last two numbers of the real address are still right.
  await pc.phPage.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('sd-sync-conn')); const port = c.p;
    c.a = ['192.168.1.77']; c.last = '192.168.1.55:' + port; localStorage.setItem('sd-sync-conn', JSON.stringify(c)); window.__conn().a = c.a; window.__conn().last = c.last;
  });
  await pc.pcPage.evaluate(() => { const s = __st(); s.tasks.push({ id: 't2', title: 'After the move', course: '', due: '2026-12-06', done: false, note: '' }); changed(); });
  await pc.phPage.waitForFunction(() => __st().tasks.some(t => t.title === 'After the move'), null, { timeout: 25000 });
  await pc.close();
});

test('Over the internet: both devices go through the relay, which only ever holds encrypted data', async () => {
  const pc = await makePair();
  await pc.pcPage.evaluate(() => { __set({ events: [{ id: 'e1', type: 'exam', title: 'Chem exam', course: 'Chem', date: '2026-12-03', endDate: '', time: '', score: null, max: 100, note: '' }], tasks: [], links: [] }); });
  const code = await pcShowQr(pc, 'net');
  await phonePaste(pc, code); await synced(pc.phPage, 30000);
  await pc.phPage.waitForFunction(() => __st().events.some(e => e.title === 'Chem exam'), null, { timeout: 45000 });   // the PC adds its data on its next relay visit
  assert.strictEqual(await titles(pc.phPage), 'Chem exam#');
  assert.deepStrictEqual(pc.net.log.lan, [], 'no Wi-Fi traffic in this mode');
  await pc.phPage.evaluate(() => { const s = __st(); s.tasks.push({ id: 't9', title: 'From the phone', course: '', due: '2026-12-06', done: false, note: '' }); changed(); });
  await pc.pcPage.waitForFunction(() => __st().tasks.some(t => t.title === 'From the phone'), null, { timeout: 30000 });
  const stored = [...pc.kv.m.values()].join('');
  assert.ok(!/Chem exam|From the phone/.test(stored), 'the relay must not see the planner text');
  assert.ok(pc.kv.m.size === 1);
  await pc.close();
});

test('Both: works on Wi-Fi, and keeps working through the relay when the PC cannot be reached on Wi-Fi', async () => {
  const pc = await makePair();
  const code = await pcShowQr(pc, 'both');
  await phonePaste(pc, code); await synced(pc.phPage, 30000);
  pc.setPort(0);                                                                   // the home network is gone: only the relay is left
  await pc.pcPage.evaluate(() => { const s = __st(); s.tasks.push({ id: 't5', title: 'Over the relay', course: '', due: '2026-12-06', done: false, note: '' }); changed(); });
  await pc.phPage.waitForFunction(() => __st().tasks.some(t => t.title === 'Over the relay'), null, { timeout: 40000 });
  await pc.close();
});

test('a phone with the wrong code never gets the data', async () => {
  const pc = await makePair();
  await pc.pcPage.evaluate(() => { __set({ events: [{ id: 'e1', type: 'exam', title: 'Secret exam', course: '', date: '2026-12-03', endDate: '', time: '', score: null, max: 100, note: '' }], tasks: [], links: [] }); });
  const code = await pcShowQr(pc, 'wifi');
  const j = JSON.parse(Buffer.from(code.slice(8), 'base64url').toString()); j.s = Buffer.alloc(32, 9).toString('base64url');
  const other = 'SDSYNC1.' + Buffer.from(JSON.stringify(j)).toString('base64url');
  await phonePaste(pc, other);
  await pc.phPage.waitForFunction(() => /Cannot find your PC/.test((document.querySelector('#sy-status') || {}).textContent || ''), null, { timeout: 30000 });
  assert.ok(!(await titles(pc.phPage)).includes('Secret exam'));
  await pc.close();
});

// A camera that shows the QR code from the PC window: a video file the browser plays as if it were the phone camera.
function y4mOf(rgba, w, h, frames) {
  const Y = Buffer.alloc(w * h), U = Buffer.alloc((w / 2) * (h / 2)), V = Buffer.alloc((w / 2) * (h / 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Y[y * w + x] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    if (y % 2 === 0 && x % 2 === 0) { const j = (y / 2) * (w / 2) + x / 2; U[j] = Math.max(0, Math.min(255, Math.round(128 - 0.1687 * r - 0.3313 * g + 0.5 * b))); V[j] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.4187 * g - 0.0813 * b))); }
  }
  const head = Buffer.from('YUV4MPEG2 W' + w + ' H' + h + ' F10:1 Ip A1:1 C420jpeg\n'), fr = Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
  return Buffer.concat([head].concat(Array.from({ length: frames }, () => fr)));
}

test('the phone camera reads the QR code from the PC window and pairs by itself', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const port = await new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const secret = Buffer.alloc(32, 3).toString('base64url');
  const code = 'SDSYNC1.' + Buffer.from(JSON.stringify({ s: secret, m: 'wifi', n: 'Study Desk PC', p: port, a: [FAKE_IP] })).toString('base64url');
  // draw the code with the page's own QR library, put it on a camera "video" file
  const probe = await browser.newPage(); await probe.goto(PG.url); await probe.waitForSelector('.glance');
  const rgba = await probe.evaluate(async c => {
    const q = qrcode(0, 'M'); q.addData(c); q.make();
    const n = q.getModuleCount(), m = 2, size = n + 2 * m, k = Math.floor(400 / size), cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#000';
    const ox = Math.floor((640 - size * k) / 2), oy = Math.floor((480 - size * k) / 2);
    for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (q.isDark(r, cc)) x.fillRect(ox + (cc + m) * k, oy + (r + m) * k, k, k);
    return Array.from(x.getImageData(0, 0, 640, 480).data);
  }, code);
  await probe.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cam-')), file = path.join(dir, 'qr.y4m');
  fs.writeFileSync(file, y4mOf(rgba, 640, 480, 20));
  const camBrowser = await loadPlaywright().chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + file] });
  try {
    const pc = await makePair({ phoneBrowser: camBrowser, port, pcConn: { role: 'pc', s: secret, m: 'wifi', n: 'Study Desk PC', dev: '0123456789abcdef', p: port, a: [FAKE_IP] } });
    await pc.pcPage.evaluate(() => { __set({ events: [], tasks: [{ id: 't1', title: 'Seen through the camera', course: '', due: '2026-12-05', done: false, note: '' }], links: [] }); changed(); });
    await open(pc.phPage);
    await pc.phPage.click('[data-sy="scan"]');
    await pc.phPage.waitForFunction(() => __st().tasks.some(t => t.title === 'Seen through the camera'), null, { timeout: 30000 });
    assert.strictEqual(await pc.phPage.evaluate(() => __conn().m), 'wifi');
  } finally { await camBrowser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
