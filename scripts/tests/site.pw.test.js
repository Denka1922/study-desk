'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { read, loadPlaywright } = require('./helpers');

const SRC = read('site/index.html');
const PAGE = 'https://alice.github.io/study-desk/';
const API = 'https://api.github.com/repos/alice/study-desk/releases/latest';
const DL = 'https://github.com/alice/study-desk/releases/download/v1.2.0/';

function release(over = {}) {
  return {
    tag_name: 'v1.2.0', published_at: '2026-11-10T12:00:00Z', draft: false, prerelease: false,
    assets: [
      { name: 'Study-Desk-Setup-1.2.0.exe', size: 82000000, browser_download_url: DL + 'Study-Desk-Setup-1.2.0.exe' },
      { name: 'Study-Desk-1.2.0-portable.exe', size: 81000000, browser_download_url: DL + 'Study-Desk-1.2.0-portable.exe' },
      { name: 'Study-Desk-Setup-1.2.0.exe.blockmap', size: 90000, browser_download_url: DL + 'Study-Desk-Setup-1.2.0.exe.blockmap' },
      { name: 'latest.yml', size: 400, browser_download_url: DL + 'latest.yml' },
    ],
    ...over,
  };
}

// Serve the page from the fake Pages address; optionally change the Play constant (re-hashing the CSP).
function pageSource(playUrl) {
  if (!playUrl) return SRC;
  const script = SRC.match(/<script>([\s\S]*?)<\/script>/)[1];
  const changed = script.replace('const PLAY_STORE_URL = "";', `const PLAY_STORE_URL = ${JSON.stringify(playUrl)};`);
  const h = 'sha256-' + crypto.createHash('sha256').update(changed, 'utf8').digest('base64');
  const old = 'sha256-' + crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  return SRC.replace(script, () => changed).replace(old, h);
}

async function open(browser, { api = { status: 200, body: release() }, url = PAGE, play, width = 1280, scheme = 'light', wait = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = []; const hosts = new Set();
  page.on('pageerror', e => errs.push(e.message));
  // A fake 4xx/5xx makes the browser log "Failed to load resource"; CSP problems say "Refused to ..." and are kept.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on('request', r => hosts.add(new URL(r.url()).host));
  await page.route('**/*', async route => {
    const u = route.request().url();
    if (u.startsWith('https://api.github.com/')) {
      if (api.abort) return route.abort();
      if (api.delay) await new Promise(r => setTimeout(r, api.delay));
      return route.fulfill({ status: api.status, contentType: 'application/json',
        body: typeof api.body === 'string' ? api.body : JSON.stringify(api.body) });
    }
    if (u.startsWith('https://alice.github.io/') || u.startsWith('https://example.com/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: pageSource(play) });
    }
    return route.abort();
  });
  await page.goto(url);
  if (wait) await page.waitForFunction(() => document.querySelector('#state').dataset.state !== 'loading');
  return { page, ctx, errs, hosts };
}

async function withBrowser(fn) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try { await fn(browser); } finally { await browser.close(); }
}
const state = p => p.locator('#state').getAttribute('data-state');
const href = (p, sel) => p.locator(sel).getAttribute('href');

test('normal release: both buttons, version, date, sizes, safe links', () => withBrowser(async b => {
  const { page, errs, hosts } = await open(b);
  assert.strictEqual(await state(page), 'loaded');
  assert.strictEqual((await page.locator('#version').innerText()).trim(), '1.2.0');
  assert.match(await page.locator('#date').innerText(), /November\s+10,?\s+2026|10\s+November\s+2026/);
  assert.strictEqual(await href(page, '#btn-installer'), DL + 'Study-Desk-Setup-1.2.0.exe');
  assert.strictEqual(await href(page, '#btn-portable'), DL + 'Study-Desk-1.2.0-portable.exe');
  const items = await page.locator('#file-list li').allInnerTexts();
  assert.strictEqual(items.length, 2);
  assert.match(items[0], /Study-Desk-Setup-1\.2\.0\.exe/); assert.match(items[0], /78\.2 MB/);
  assert.ok(!(await page.locator('body').innerText()).includes('latest.yml'));
  assert.deepStrictEqual([...hosts].sort(), ['alice.github.io', 'api.github.com']);
  assert.deepStrictEqual(errs, []);
}));

test('only some files exist: only those buttons appear', () => withBrowser(async b => {
  const r = release(); r.assets = r.assets.slice(0, 1);
  const { page } = await open(b, { api: { status: 200, body: r } });
  assert.strictEqual(await page.locator('#btn-installer').count(), 1);
  assert.strictEqual(await page.locator('#btn-portable').count(), 0);
  const noExe = release(); noExe.assets = noExe.assets.slice(2);
  const two = await open(b, { api: { status: 200, body: noExe } });
  assert.strictEqual(await two.page.locator('#btn-installer, #btn-portable').count(), 0);
  assert.strictEqual(await two.page.locator('#file-list li').count(), 0);
}));

test('no release, server error, rate limit, network failure, junk body', () => withBrowser(async b => {
  const none = await open(b, { api: { status: 404, body: { message: 'Not Found' } } });
  assert.strictEqual(await state(none.page), 'none');
  assert.match(await none.page.locator('#state').innerText(), /No version has been published yet/);
  for (const api of [{ status: 500, body: {} }, { status: 403, body: { message: 'rate limit' } }, { abort: true },
    { status: 200, body: 'not json' }, { status: 200, body: '[]' }, { status: 200, body: 'null' }, { status: 200, body: { assets: 5 } }]) {
    const e = await open(b, { api });
    assert.strictEqual(await state(e.page), 'error', JSON.stringify(api));
    assert.strictEqual(await href(e.page, '#releases-link'), 'https://github.com/alice/study-desk/releases/latest');
    assert.strictEqual(await e.page.locator('#btn-installer, #btn-portable').count(), 0);
  }
}));

test('slow response shows loading first', () => withBrowser(async b => {
  const { page } = await open(b, { api: { status: 200, body: release(), delay: 1200 }, wait: false });
  assert.strictEqual(await state(page), 'loading');
  await page.waitForFunction(() => document.querySelector('#state').dataset.state === 'loaded');
}));

test('draft and prerelease are treated as no release', () => withBrowser(async b => {
  for (const o of [{ draft: true }, { prerelease: true }]) {
    const { page } = await open(b, { api: { status: 200, body: release(o) } });
    assert.strictEqual(await state(page), 'none');
  }
}));

test('hostile and odd asset data (Review Focus 5)', () => withBrowser(async b => {
  const evil = 'Study-Desk-Setup-<img src=x onerror=window.__x=1>.exe';
  const long = 'Study-Desk-Setup-' + 'a'.repeat(300) + '.exe';
  const r = release({ assets: [
    { name: evil, size: 5, browser_download_url: DL + 'x.exe' },
    { name: long, size: null, browser_download_url: DL + 'y.exe' },
    { name: null, size: 1, browser_download_url: DL + 'z.exe' },
    { name: 'Study-Desk-1.2.0-portable.exe', browser_download_url: DL + 'p.exe' },
  ] });
  const { page, errs } = await open(b, { api: { status: 200, body: r }, width: 360 });
  assert.strictEqual(await page.locator('img').count(), 0);
  assert.strictEqual(await page.evaluate(() => window.__x), undefined);
  assert.ok((await page.locator('#file-list').innerText()).includes('<img src=x'));
  assert.strictEqual(await href(page, '#btn-installer'), DL + 'x.exe', 'first matching asset wins');
  assert.strictEqual(await href(page, '#btn-portable'), DL + 'p.exe');
  assert.deepStrictEqual(errs, []);
}));

test('download links must stay inside this repository\'s releases on github.com', () => withBrowser(async b => {
  const bad = [
    'http://github.com/alice/study-desk/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://github.com/mallory/study-desk/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://github.com/alice/other/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://github.com.evil.com/alice/study-desk/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://github.com@evil.com/alice/study-desk/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://evil.com/alice/study-desk/releases/download/v1/Study-Desk-Setup-1.exe',
    'https://github.com/alice/study-desk/releases/download/../../../evil/x/Study-Desk-Setup-1.exe',
    'https://github.com/alice/study-desk/archive/main.zip',
    'javascript:alert(1)', '', 'github.com/alice/study-desk/releases/download/v1/x.exe', null, 42,
  ];
  for (const u of bad) {
    const r = release({ assets: [{ name: 'Study-Desk-Setup-1.exe', size: 1, browser_download_url: u }] });
    const { page } = await open(b, { api: { status: 200, body: r } });
    assert.strictEqual(await page.locator('#btn-installer').count(), 0, String(u));
  }
  const ok = release({ assets: [{ name: 'Study-Desk-Setup-1.exe', size: 1, browser_download_url: 'https://github.com/Alice/Study-Desk/releases/download/v1/Study-Desk-Setup-1.exe' }] });
  const { page } = await open(b, { api: { status: 200, body: ok } });
  assert.strictEqual(await page.locator('#btn-installer').count(), 1, 'case differences in owner and repo are fine');
}));

test('repository comes from the page address', () => withBrowser(async b => {
  const deep = await open(b, { url: 'https://alice.github.io/study-desk/some/deeper/path/?x=1#y' });
  assert.strictEqual(await state(deep.page), 'loaded');
  const root = await open(b, { url: 'https://alice.github.io/' });
  assert.strictEqual(await state(root.page), 'error');
  assert.ok(![...root.hosts].includes('api.github.com'));
  assert.strictEqual(await root.page.locator('#releases-link').count(), 0);
  const custom = await open(b, { url: 'https://example.com/x/' });
  assert.strictEqual(await state(custom.page), 'error');
  assert.ok(![...custom.hosts].includes('api.github.com'));
}));

test('Android card: coming soon until a valid Play Store address is set', () => withBrowser(async b => {
  const soon = await open(b);
  assert.match(await soon.page.locator('#android-card').innerText(), /Android: coming soon on Google Play/);
  assert.strictEqual(await soon.page.locator('#android-link').count(), 0);
  const good = 'https://play.google.com/store/apps/details?id=app.studydesk.planner';
  const set = await open(b, { play: good });
  assert.strictEqual(await href(set.page, '#android-link'), good);
  assert.match(await set.page.locator('#android-link').innerText(), /Get it on Google Play/);
  assert.deepStrictEqual(set.errs, []);
  for (const u of ['https://play.google.com/store/apps/details?id=other.app', 'https://play.google.com/store/apps/details?id=app.studydesk.planner.evil',
    'javascript:alert(1)', 'http://play.google.com/store/apps/details?id=app.studydesk.planner',
    'https://play.google.com.evil.com/store/apps/details?id=app.studydesk.planner', 'https://evil.com/?https://play.google.com/store/apps/details?id=app.studydesk.planner']) {
    const x = await open(b, { play: u });
    assert.strictEqual(await x.page.locator('#android-link').count(), 0, u);
  }
}));

test('layout at phone, tablet and desktop widths, light and dark', () => withBrowser(async b => {
  const long = release({ assets: [{ name: 'Study-Desk-Setup-' + 'a'.repeat(300) + '.exe', size: 1, browser_download_url: DL + 'a.exe' }] });
  for (const width of [360, 400, 820, 1280]) {
    for (const [api, label] of [[{ status: 200, body: release() }, 'normal'], [{ status: 200, body: long }, 'long'], [{ status: 500, body: {} }, 'error']]) {
      const { page, errs } = await open(b, { width, api });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${label} overflow`);
      assert.deepStrictEqual(errs, []);
    }
  }
  const dark = await open(b, { scheme: 'dark' });
  const lum = c => { const [r, g, bl] = c.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255; };
  const colors = await dark.page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
  assert.ok(lum(colors[0]) < 0.2 && lum(colors[1]) > 0.6, JSON.stringify(colors));
}));

test('keyboard: Tab reaches the installer button first, then the portable one', () => withBrowser(async b => {
  const { page } = await open(b);
  await page.keyboard.press('Tab');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'btn-installer');
  await page.keyboard.press('Tab');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'btn-portable');
}));

test('null date shows no date; a release without usable files says they are still being built', () => withBrowser(async b => {
  const nd = await open(b, { api: { status: 200, body: release({ published_at: null }) } });
  assert.strictEqual((await nd.page.locator('#date').innerText()).trim(), '');
  for (const assets of [[], [{ name: 'latest.yml', size: 1, browser_download_url: DL + 'latest.yml' }]]) {
    const { page } = await open(b, { api: { status: 200, body: release({ assets }) } });
    assert.strictEqual(await state(page), 'loaded');
    assert.match(await page.locator('#state').innerText(), /still being built/i);
    assert.strictEqual(await page.locator('#btn-installer, #btn-portable').count(), 0);
  }
  const ok = await open(b);
  assert.doesNotMatch(await ok.page.locator('#state').innerText(), /still being built/i);
}));
