'use strict';
// The page's sync rules: keys and sealed messages, merging, pairing code. No network: two pages swap documents by hand.
const test = require('node:test');
const assert = require('node:assert');
const { loadPlaywright, pageWithExports } = require('./helpers');

const NAMES = ['syncKeys', 'syncSeal', 'syncOpen', 'syncMerge', 'syncDoc', 'syncRev', 'syncReceive', 'syncCleanDoc', 'syncMakeCode', 'syncParseCode', 'sCanon', 'sB64', 'sUnb64', 'changed', 'normalize', 'lsWrite', 'aiCoursesSave', 'aiCoursesLoad'];
const EXTRA = 'window.__st=function(){return state;};window.__set=function(s){state=normalize(s);lsWrite();};';
const PG = pageWithExports(NAMES, EXTRA);
let browser;
async function open() {
  if (!browser) browser = await loadPlaywright().chromium.launch();
  const ctx = await browser.newContext();            // each device gets its own storage
  const p = await ctx.newPage(); await p.goto(PG.url); await p.waitForSelector('.glance'); return p;
}
test.after(async () => { if (browser) await browser.close(); PG.cleanup(); });

const ev = (id, title, extra) => Object.assign({ id, type: 'exam', title, course: 'Math', date: '2026-12-01', endDate: '', time: '', score: null, max: 100, note: '' }, extra || {});
const tk = (id, title) => ({ id, title, course: 'Math', due: '2026-12-02', done: false, note: '' });

// The same vector the PC side checks in scripts/tests/sync-crypto.test.js (made with an independent implementation).
const V = { room: 'b23ef471b1cce42136810fd9ab71c38c', token: '-IGDF-KpeNBEn89HgTbzojHCpZxJLrx-K3Ym7o8gWWI', i: 'oKGio6Slpqeoqaqr', c: 'S3Qjz2R73ctMfUUS_5mYAv3D_QW3-i6-x6qt4kCxu4vQb70Dz55t9SQXo2Y' };

test('keys and a sealed message match the PC side byte for byte', async () => {
  const p = await open();
  const r = await p.evaluate(async () => {
    const S = new Uint8Array(32).map((_, i) => i), IV = new Uint8Array(12).map((_, i) => 0xa0 + i);
    const k = await syncKeys(sB64(S));
    const env = await syncSeal(k, { op: 'hello', nonce: 'abc' }, IV);
    const back = await syncOpen(k, env);
    let tamper = 'no'; try { await syncOpen(k, { v: 1, i: env.i, c: env.c.slice(0, -2) + (env.c.endsWith('AA') ? 'BB' : 'AA') }); } catch (e) { tamper = 'rejected'; }
    const other = await syncKeys(sB64(new Uint8Array(32).fill(7)));
    let wrong = 'no'; try { await syncOpen(other, env); } catch (e) { wrong = 'rejected'; }
    return { room: k.room, token: k.token, env, back, tamper, wrong };
  });
  assert.deepStrictEqual(r, { room: V.room, token: V.token, env: { v: 1, i: V.i, c: V.c }, back: { op: 'hello', nonce: 'abc' }, tamper: 'rejected', wrong: 'rejected' });
  await p.close();
});

const D = (items, gone) => ({ v: 1, items: items || {}, gone: gone || {} });
const I = (k, u, d) => ({ k, u, d });

test('merge: newest item wins, a newer deletion wins, a newer edit beats an older deletion, a tie goes to the deletion', async () => {
  const p = await open();
  const r = await p.evaluate(() => {
    const now = Date.now(), D = (items, gone) => ({ v: 1, items: items || {}, gone: gone || {} }), I = (u, title) => ({ k: 'event', u, d: { id: 'e1', title } });
    const keep = m => Object.keys(m.items).sort().join(',') + '|' + Object.keys(m.gone).sort().join(',');
    return {
      newest: syncMerge(D({ e1: I(now - 2000, 'old') }), D({ e1: I(now - 1000, 'new') })).items.e1.d.title,
      deleted: keep(syncMerge(D({ e1: I(now - 2000, 'x') }), D({}, { e1: now - 1000 }))),
      resurrect: keep(syncMerge(D({ e1: I(now - 500, 'edited') }), D({}, { e1: now - 1000 }))),
      tie: keep(syncMerge(D({ e1: I(now - 1000, 'a') }), D({}, { e1: now - 1000 }))),
    };
  });
  assert.deepStrictEqual(r, { newest: 'new', deleted: '|e1', resurrect: 'e1|', tie: '|e1' });
  await p.close();
});

test('merge gives the same result in either order, twice over, and drops deletions older than 90 days', async () => {
  const p = await open();
  const r = await p.evaluate(() => {
    const now = Date.now(), old = now - 91 * 86400000;
    const a = { v: 1, items: { a1: { k: 'task', u: 10, d: { id: 'a1', title: 'A', due: '2026-12-02' } }, c1: { k: 'event', u: 50, d: { id: 'c1', title: 'same' } } }, gone: { z9: now - 1000, z8: old } };
    const b = { v: 1, items: { b1: { k: 'link', u: 20, d: { id: 'b1' } }, c1: { k: 'event', u: 50, d: { id: 'c1', title: 'same2' } } }, gone: { a1: 5 } };
    const ab = syncMerge(a, b), ba = syncMerge(b, a);
    return { sym: sCanon(ab) === sCanon(ba), idem: sCanon(syncMerge(ab, ab)) === sCanon(ab), assoc: sCanon(syncMerge(ab, a)) === sCanon(ab), gone: Object.keys(ab.gone).join(','), items: Object.keys(ab.items).sort().join(',') };
  });
  assert.deepStrictEqual(r, { sym: true, idem: true, assoc: true, gone: 'z9', items: 'a1,b1,c1' });
  await p.close();
});

test('a document from another device is checked before it is used', async () => {
  const p = await open();
  const r = await p.evaluate(() => {
    const ok = { v: 1, items: { e1: { k: 'event', u: 1, d: { id: 'e1' } } }, gone: { g1: 2 } };
    const bad = [null, [], { v: 2, items: {} }, { v: 1 }, { v: 1, items: { '<b>': { k: 'event', u: 1, d: {} } } }, { v: 1, items: { e1: { k: 'virus', u: 1, d: {} } } },
      { v: 1, items: { e1: { k: 'event', u: -1, d: {} } } }, { v: 1, items: { e1: { k: 'event', u: 'x', d: {} } } }, { v: 1, items: { e1: { k: 'event', u: 1, d: 5 } } },
      { v: 1, items: {}, gone: { 'a b': 1 } }];
    const many = { v: 1, items: {}, gone: {} }; for (let i = 0; i < 5001; i++) many.items['i' + i] = { k: 'link', u: 1, d: {} };
    return { ok: !!syncCleanDoc(ok), bad: bad.map(b => !!syncCleanDoc(b)), many: !!syncCleanDoc(many) };
  });
  assert.deepStrictEqual(r, { ok: true, bad: new Array(10).fill(false), many: false });
  await p.close();
});

test('the pairing code survives a round trip and refuses anything that is not a private address or an https relay', async () => {
  const p = await open();
  const r = await p.evaluate(() => {
    const s = sB64(new Uint8Array(32).map((_, i) => i + 1));
    const good = { s, m: 'both', p: 47821, a: ['192.168.1.20', '10.0.0.5'], r: 'https://sd-relay.example.workers.dev', n: 'My PC' };
    const code = syncMakeCode(good), back = syncParseCode(code);
    const mk = o => syncMakeCode(Object.assign({}, good, o));
    return {
      prefix: code.indexOf('SDSYNC1.') === 0, back, wifi: syncParseCode(mk({ m: 'wifi', r: undefined })).r === undefined, net: syncParseCode(mk({ m: 'net' })).a === undefined,
      pub: syncParseCode(mk({ a: ['8.8.8.8'] })), http: syncParseCode(mk({ r: 'http://relay.example.com' })), port: syncParseCode(mk({ p: 80 })),
      junk: [syncParseCode('hello'), syncParseCode('SDSYNC1.!!!'), syncParseCode(''), syncParseCode(null)], shortKey: syncParseCode(mk({ s: sB64(new Uint8Array(5)) })),
    };
  });
  assert.strictEqual(r.prefix, true);
  assert.deepStrictEqual(r.back, { s: r.back.s, m: 'both', n: 'My PC', p: 47821, a: ['192.168.1.20', '10.0.0.5'], r: 'https://sd-relay.example.workers.dev' });
  assert.deepStrictEqual([r.wifi, r.net, r.pub, r.http, r.port, r.shortKey], [true, true, null, null, null, null]);
  assert.deepStrictEqual(r.junk, [null, null, null, null]);
  await p.close();
});

async function put(p, state) { await p.evaluate(s => { __set(s); }, state); }
async function exchange(from, to) {          // what the Wi-Fi or relay carry: one device's document into the other
  const doc = await from.evaluate(() => syncDoc());
  const back = await to.evaluate(d => syncReceive(d), doc);
  const fromAfter = await from.evaluate(d => syncReceive(d), back.doc);
  return { back, fromAfter };
}
const titles = p => p.evaluate(() => __st().events.map(e => e.title).sort().join('|') + '#' + __st().tasks.map(t => t.title).sort().join('|'));
const rev = p => p.evaluate(async () => syncRev(syncDoc()));

test('two devices end up with the same data, deletions travel, the newer edit wins, and a second exchange changes nothing', async () => {
  const A = await open(), B = await open();
  await put(A, { events: [ev('e1', 'Exam A'), ev('e2', 'Gone soon')], tasks: [], links: [] });
  await put(B, { events: [], tasks: [tk('t1', 'Essay B')], links: [] });
  await A.waitForTimeout(5);
  await exchange(A, B);
  assert.strictEqual(await titles(A), 'Exam A|Gone soon#Essay B');
  assert.strictEqual(await titles(B), 'Exam A|Gone soon#Essay B');
  assert.strictEqual(await rev(A), await rev(B), 'same data, same rev');

  const again = await exchange(A, B);                      // nothing changed since
  assert.strictEqual(again.back.changed, false); assert.strictEqual(again.fromAfter.changed, false);

  await A.waitForTimeout(5);
  await A.evaluate(() => { const s = __st(); s.events = s.events.filter(e => e.id !== 'e2'); changed(); });      // delete on A
  await B.waitForTimeout(5);
  await B.evaluate(() => { const s = __st(); s.tasks[0].title = 'Essay B (edited)'; changed(); });               // newer edit on B
  await exchange(A, B);
  assert.strictEqual(await titles(A), 'Exam A#Essay B (edited)');
  assert.strictEqual(await titles(B), 'Exam A#Essay B (edited)');
  assert.strictEqual(await rev(A), await rev(B));
  const third = await exchange(B, A);
  assert.strictEqual(third.back.changed, false);
  await A.context().close(); await B.context().close();
});

test('sample entries are not sent and give way to real data from the other device', async () => {
  const A = await open(), B = await open();                // both start with the example entries
  const sampleCount = await A.evaluate(() => __st().events.filter(e => e.sample).length);
  assert.ok(sampleCount > 0);
  assert.strictEqual(await A.evaluate(() => Object.keys(syncDoc().items).length), 0);
  await put(B, { events: [ev('r1', 'Real exam')], tasks: [], links: [] });
  await exchange(B, A);
  assert.strictEqual(await titles(A), 'Real exam#');
  assert.strictEqual(await A.evaluate(() => __st().events.some(e => e.sample)), false);
  await A.context().close(); await B.context().close();
});

test('a damaged document from the other device is refused and changes nothing', async () => {
  const A = await open();
  await put(A, { events: [ev('e1', 'Keep me')], tasks: [], links: [] });
  const r = await A.evaluate(async () => { try { await syncReceive({ v: 1, items: { '<x>': { k: 'event', u: 1, d: {} } } }); return 'accepted'; } catch (e) { return 'refused'; } });
  assert.strictEqual(r, 'refused');
  assert.strictEqual(await titles(A), 'Keep me#');
  await A.context().close();
});

test('AI Tutor courses sync too, come out identical on the other device, and the AI key and settings stay put', async () => {
  const A = await open(), B = await open();
  await A.evaluate(() => {
    aiCoursesSave([{ id: 'c1', topic: 'Photosynthesis', createdAt: '2026-11-01', outline: { title: 'Photosynthesis', summary: 'How plants make food.', lessons: [{ title: 'Light', goal: 'Know the light reactions.' }] }, lessons: [null], exam: null }]);
    sessionStorage.setItem('sd-ai-key', 'not-a-real-key'); changed();
  });
  assert.strictEqual(await A.evaluate(() => aiCoursesLoad().length), 1, 'the course is valid for the app');
  await exchange(A, B);
  assert.strictEqual(await B.evaluate(() => aiCoursesLoad().map(c => c.topic).join()), 'Photosynthesis');
  assert.strictEqual(await rev(A), await rev(B), 'same rev after the exchange, so the devices stop talking');
  assert.strictEqual(await B.evaluate(() => sessionStorage.getItem('sd-ai-key') || localStorage.getItem('sd-ai-key')), null);
  assert.ok(!JSON.stringify(await A.evaluate(() => syncDoc())).includes('not-a-real-key'));
  await A.context().close(); await B.context().close();
});

test('on a phone-sized screen the Sync button is fully visible at the top, not pushed off the edge', async () => {
  if (!browser) browser = await loadPlaywright().chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true });
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request: async () => { throw new Error('offline'); } } } }; });
  await p.goto(PG.url); await p.waitForSelector('.glance');
  const r = await p.evaluate(() => {
    const b = [...document.querySelectorAll('[data-sync-open]')].find(x => x.getBoundingClientRect().width > 0).getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, vw: innerWidth, vh: innerHeight };
  });
  assert.ok(r.left >= 0 && r.right <= r.vw && r.top >= 0 && r.bottom <= r.vh / 3, JSON.stringify(r));
  await ctx.close();
});
