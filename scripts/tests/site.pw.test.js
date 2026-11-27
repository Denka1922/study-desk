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
      { name: 'Study-Desk-1.2.0-mac-arm64.dmg', size: 95000000, browser_download_url: DL + 'Study-Desk-1.2.0-mac-arm64.dmg' },
      { name: 'Study-Desk-1.2.0-mac-arm64.zip', size: 91000000, browser_download_url: DL + 'Study-Desk-1.2.0-mac-arm64.zip' },
      { name: 'Study-Desk-1.2.0-mac-x64.dmg', size: 99000000, browser_download_url: DL + 'Study-Desk-1.2.0-mac-x64.dmg' },
      { name: 'Study-Desk-1.2.0-mac-x64.zip', size: 96000000, browser_download_url: DL + 'Study-Desk-1.2.0-mac-x64.zip' },
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

async function open(browser, { api = { status: 200, body: release() }, issues = { status: 200, body: [] }, url = PAGE, play, width = 1280, scheme = 'light', wait = true, ua } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, ...(ua ? { userAgent: ua } : {}) });
  const page = await ctx.newPage();
  const errs = []; const hosts = new Set();
  page.on('pageerror', e => errs.push(e.message));
  // A fake 4xx/5xx makes the browser log "Failed to load resource"; CSP problems say "Refused to ..." and are kept.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on('request', r => hosts.add(new URL(r.url()).host));
  await page.route('**/*', async route => {
    const u = route.request().url();
    if (u.startsWith('https://api.github.com/repos/alice/study-desk/issues')) { // the approved reviews
      if (issues.abort) return route.abort();
      return route.fulfill({ status: issues.status, contentType: 'application/json', body: typeof issues.body === 'string' ? issues.body : JSON.stringify(issues.body) });
    }
    if (u.startsWith('https://api.github.com/')) {
      if (api.abort) return route.abort();
      if (api.delay) await new Promise(r => setTimeout(r, api.delay));
      return route.fulfill({ status: api.status, contentType: 'application/json',
        body: typeof api.body === 'string' ? api.body : JSON.stringify(api.body) });
    }
    const asset = /^https:\/\/alice\.github\.io\/study-desk\/((?:shots\/[a-z0-9-]+\.webp)|favicon\.svg)$/.exec(u);
    if (asset) {
      return route.fulfill({ status: 200, contentType: asset[1].endsWith('.svg') ? 'image/svg+xml' : 'image/webp',
        body: require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'site', asset[1])) });
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
  // the page has its own pictures now; what must never appear is an image made from the hostile file name
  assert.strictEqual(await page.locator('img[src="x"], img[onerror]').count(), 0);
  assert.strictEqual(await page.locator('#file-list img, #btns img').count(), 0);
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

const APK = { name: 'Study-Desk-1.2.0-android.apk', size: 3381493, browser_download_url: DL + 'Study-Desk-1.2.0-android.apk' };
const withApk = (extra = []) => release({ assets: [...release().assets, APK, ...extra] });

test('Android APK: a download button appears only when the release has one, from this repository only', () => withBrowser(async b => {
  const none = await open(b);
  assert.strictEqual(await none.page.locator('#btn-apk').count(), 0);
  assert.match(await none.page.locator('#android-card').innerText(), /Android: coming soon on Google Play/);
  const yes = await open(b, { api: { status: 200, body: withApk() } });
  assert.strictEqual(await href(yes.page, '#btn-apk'), DL + 'Study-Desk-1.2.0-android.apk');
  assert.match(await yes.page.locator('#btn-apk').innerText(), /Download the Android app \(APK\)/);
  const card = await yes.page.locator('#android-card').innerText();
  assert.match(card, /Study-Desk-1\.2\.0-android\.apk · 3\.2 MB/);
  assert.match(card, /Install unknown apps|install unknown apps/i);
  assert.match(card, /does not update itself|doesn't update itself|not update by itself/i);
  assert.ok(!/coming soon/i.test(card), 'the page does not say "coming soon" when the file is there');
  assert.deepStrictEqual(yes.errs, []);
  // a file from somewhere else, a wrong name, or a checksum file never becomes the button
  for (const bad of [{ name: 'Study-Desk-1.2.0-android.apk', size: 1, browser_download_url: 'https://evil.example/alice/study-desk/releases/download/v1.2.0/Study-Desk-1.2.0-android.apk' },
    { name: 'other.apk', size: 1, browser_download_url: DL + 'other.apk' }, { name: 'Study-Desk-1.2.0-android.apk.sha256', size: 1, browser_download_url: DL + 'x.sha256' }]) {
    const x = await open(b, { api: { status: 200, body: release({ assets: [...release().assets, bad] }) } });
    assert.strictEqual(await x.page.locator('#btn-apk').count(), 0, bad.name + ' ' + bad.browser_download_url);
  }
}));

test('Android APK: Android visitors get it from the big button, and Google Play wins once an address is set', () => withBrowser(async b => {
  const and = await open(b, { ua: ANDROID_UA, api: { status: 200, body: withApk() } });
  assert.strictEqual(await href(and.page, '#hero-dl'), DL + 'Study-Desk-1.2.0-android.apk');
  assert.strictEqual((await and.page.locator('#hero-dl').innerText()).trim(), 'Get the Android app');
  const win = await open(b, { api: { status: 200, body: withApk() } });
  assert.strictEqual(await href(win.page, '#hero-dl'), DL + 'Study-Desk-Setup-1.2.0.exe', 'the Windows button is untouched');
  const good = 'https://play.google.com/store/apps/details?id=app.studydesk.planner';
  const both = await open(b, { ua: ANDROID_UA, play: good, api: { status: 200, body: withApk() } });
  assert.strictEqual(await href(both.page, '#hero-dl'), good);
  assert.strictEqual(await href(both.page, '#android-link'), good);
  assert.strictEqual(await href(both.page, '#btn-apk'), DL + 'Study-Desk-1.2.0-android.apk');
  assert.match(await both.page.locator('#android-card').innerText(), /Get it on Google Play/);
  assert.deepStrictEqual(both.errs, []);
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

test('keyboard: Tab goes through the top links and big button, then the selected tab, the installer button and the portable one', () => withBrowser(async b => {
  const { page } = await open(b);
  const seen = [];
  for (let i = 0; i < 30 && !seen.includes('tab-windows'); i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim().slice(0, 20)));
  }
  assert.ok(seen.includes('hero-dl'), 'the big download button can be reached: ' + seen.join(' > '));
  assert.ok(seen.indexOf('hero-dl') < seen.indexOf('tab-windows'));
  assert.strictEqual(seen[seen.length - 1], 'tab-windows');
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

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const visible = (p, sel) => p.locator(sel).isVisible();
const selected = async p => p.evaluate(() => [...document.querySelectorAll('[role=tab]')].filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.id));

test('three tabs: Windows, Mac and Android, one panel visible at a time', () => withBrowser(async b => {
  const { page, errs } = await open(b);
  assert.deepStrictEqual(await page.locator('[role=tab]').allInnerTexts(), ['Windows', 'Mac', 'Android']);
  assert.deepStrictEqual(await selected(page), ['tab-windows']);
  assert.ok(await visible(page, '#windows')); assert.ok(!(await visible(page, '#mac'))); assert.ok(!(await visible(page, '#android-card')));
  await page.click('#tab-mac');
  assert.deepStrictEqual(await selected(page), ['tab-mac']);
  assert.ok(!(await visible(page, '#windows'))); assert.ok(await visible(page, '#mac'));
  await page.click('#tab-android');
  assert.ok(await visible(page, '#android-card')); assert.ok(!(await visible(page, '#mac')));
  await page.focus('#tab-android'); await page.keyboard.press('ArrowLeft');
  assert.deepStrictEqual(await selected(page), ['tab-mac']);
  await page.keyboard.press('Home');
  assert.deepStrictEqual(await selected(page), ['tab-windows']);
  await page.keyboard.press('End');
  assert.deepStrictEqual(await selected(page), ['tab-android']);
  assert.deepStrictEqual(errs, []);
}));

test('the first tab matches the visitor\'s system', () => withBrowser(async b => {
  assert.deepStrictEqual(await selected((await open(b, { ua: MAC_UA })).page), ['tab-mac']);
  assert.deepStrictEqual(await selected((await open(b, { ua: ANDROID_UA })).page), ['tab-android']);
  assert.deepStrictEqual(await selected((await open(b)).page), ['tab-windows']);
}));

test('Mac tab: four downloads with safe links, sizes, which-one help and the Open Anyway steps', () => withBrowser(async b => {
  const { page, errs, hosts } = await open(b);
  await page.click('#tab-mac');
  assert.strictEqual(await href(page, '#btn-mac-arm64'), DL + 'Study-Desk-1.2.0-mac-arm64.dmg');
  assert.strictEqual(await href(page, '#btn-mac-x64'), DL + 'Study-Desk-1.2.0-mac-x64.dmg');
  assert.strictEqual(await href(page, '#btn-mac-arm64-zip'), DL + 'Study-Desk-1.2.0-mac-arm64.zip');
  assert.strictEqual(await href(page, '#btn-mac-x64-zip'), DL + 'Study-Desk-1.2.0-mac-x64.zip');
  assert.match(await page.locator('#btn-mac-arm64').innerText(), /Apple Silicon/);
  assert.match(await page.locator('#btn-mac-x64').innerText(), /Intel/);
  const items = await page.locator('#mac-list li').allInnerTexts();
  assert.strictEqual(items.length, 4);
  assert.match(items[0], /mac-arm64\.dmg/); assert.match(items[0], /90\.6 MB/);
  const t = await page.locator('#mac').innerText();
  assert.match(t, /About This Mac/); assert.match(t, /Open Anyway/); assert.match(t, /not signed by Apple/i);
  assert.deepStrictEqual([...hosts].sort(), ['alice.github.io', 'api.github.com']);
  assert.deepStrictEqual(errs, []);
}));

test('Mac tab: missing files say so, and links outside this repository are dropped', () => withBrowser(async b => {
  const none = release(); none.assets = none.assets.slice(0, 2);
  const a = await open(b, { api: { status: 200, body: none } });
  await a.page.click('#tab-mac');
  assert.strictEqual(await a.page.locator('#btn-mac-arm64, #btn-mac-x64, #btn-mac-arm64-zip, #btn-mac-x64-zip').count(), 0);
  assert.match(await a.page.locator('#mac').innerText(), /No Mac files in this version yet/);
  assert.doesNotMatch(await a.page.locator('#state').innerText(), /still being built/i);
  const evil = release({ assets: [{ name: 'Study-Desk-1.2.0-mac-arm64.dmg', size: 1, browser_download_url: 'https://evil.com/alice/study-desk/releases/download/v1/x.dmg' }] });
  const e = await open(b, { api: { status: 200, body: evil } });
  assert.strictEqual(await e.page.locator('#btn-mac-arm64').count(), 0);
}));

test('Mac only release: not "still being built"', () => withBrowser(async b => {
  const r = release(); r.assets = r.assets.slice(4);
  const { page } = await open(b, { api: { status: 200, body: r } });
  assert.strictEqual(await state(page), 'loaded');
  assert.doesNotMatch(await page.locator('#state').innerText(), /still being built/i);
  await page.click('#tab-windows');
  assert.match(await page.locator('#windows').innerText(), /No Windows files in this version yet/);
}));

test('the big button at the top matches the visitor and links to a safe file', () => withBrowser(async b => {
  const win = await open(b);
  assert.strictEqual((await win.page.locator('#hero-dl').innerText()).trim(), 'Download for Windows');
  assert.strictEqual(await href(win.page, '#hero-dl'), DL + 'Study-Desk-Setup-1.2.0.exe');
  assert.match(await win.page.locator('#hero-meta').innerText(), /Version 1\.2\.0 · November 10, 2026/);
  const failed = await open(b, { api: { status: 500, body: {} } });
  assert.strictEqual(await href(failed.page, '#hero-dl'), '#download');
  assert.strictEqual((await failed.page.locator('#hero-dl').innerText()).trim(), 'Download for Windows');
  const mac = await open(b, { ua: MAC_UA });
  assert.strictEqual((await mac.page.locator('#hero-dl').innerText()).trim(), 'Download for Mac');
  assert.strictEqual(await href(mac.page, '#hero-dl'), '#download');
  const and = await open(b, { ua: ANDROID_UA });
  assert.strictEqual((await and.page.locator('#hero-dl').innerText()).trim(), 'Get the Android app');
  assert.strictEqual(await href(and.page, '#hero-dl'), '#download');
  const good = 'https://play.google.com/store/apps/details?id=app.studydesk.planner';
  const play = await open(b, { ua: ANDROID_UA, play: good });
  assert.strictEqual(await href(play.page, '#hero-dl'), good);
  // a hostile asset name or address must never reach the big button
  const evil = release({ assets: [{ name: 'Study-Desk-Setup-9.exe', size: 1, browser_download_url: 'https://evil.example/Study-Desk-Setup-9.exe' }] });
  const bad = await open(b, { api: { status: 200, body: evil } });
  assert.strictEqual(await href(bad.page, '#hero-dl'), '#download');
}));

test('the app pictures load in light and dark, and project links point at this repository', () => withBrowser(async b => {
  for (const scheme of ['light', 'dark']) {
    const { page, errs } = await open(b, { scheme });
    await page.evaluate(() => { for (const i of document.images) i.loading = 'eager'; });
    await page.waitForFunction(() => [...document.images].every(i => i.complete));
    const bad = await page.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.currentSrc || i.src));
    assert.deepStrictEqual(bad, [], scheme);
    assert.ok(await page.evaluate(() => document.images.length >= 5));
    assert.ok(await page.evaluate(() => [...document.images].every(i => i.alt.length > 10)), 'alt text');
    assert.deepStrictEqual(errs, [], scheme);
  }
  const { page } = await open(b);
  const links = await page.locator('a[data-repo]').evaluateAll(a => a.map(x => [x.href, x.hidden]));
  assert.deepStrictEqual(links.map(l => l[1]), [false, false, false, false]);
  for (const [h] of links) assert.match(h, /^https:\/\/github\.com\/alice\/study-desk(\/|$)/, h);
  const root = await open(b, { url: 'https://alice.github.io/' });
  assert.deepStrictEqual(await root.page.locator('a[data-repo]').evaluateAll(a => a.map(x => x.hidden)), [true, true, true, true]);
}));

test('the page has one main heading, labelled sections and no sideways scrolling at 320 px', () => withBrowser(async b => {
  const { page } = await open(b, { width: 320 });
  assert.strictEqual(await page.locator('h1').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const unlabelled = await page.locator('main section[aria-labelledby]').evaluateAll(s => s.filter(x => !document.getElementById(x.getAttribute('aria-labelledby'))).length);
  assert.strictEqual(unlabelled, 0);
  // the questions open and close with the keyboard
  await page.locator('#faq summary').first().focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.locator('#faq details').first().evaluate(d => d.open));
}));

// ---------------------------------------------------------------- feedback: bug reports and reviews
const issue = (rating, used, text, over = {}) => ({ number: 7, state: 'open', created_at: '2026-11-20T10:00:00Z', user: { login: 'secret-student' },
  body: '### Rating\n\n' + rating + '\n\n### Used on\n\n' + used + '\n\n### Your review\n\n' + text, ...over });

test('Feedback: the bug form opens a GitHub issue form with the answers, from this repository only', () => withBrowser(async b => {
  const { page, ctx, errs } = await open(b);
  assert.strictEqual(await page.locator('#feedback').isVisible(), true);
  await page.selectOption('#bug-where', 'Android app'); await page.selectOption('#bug-area', 'Voice tutor');
  const what = 'The tutor stops after the first line & says "ı ğ ü ş İ" #1 100% \nSecond line', steps = 'Open a lesson\nPress Voice tutor';
  await page.fill('#bug-what', what); await page.fill('#bug-steps', steps);
  const u = new URL(await href(page, '#bug-go'));
  assert.strictEqual(u.origin + u.pathname, 'https://github.com/alice/study-desk/issues/new');
  const q = u.searchParams;
  assert.strictEqual(q.get('template'), 'bug_report.yml');
  assert.match(q.get('title'), /^\[Bug\] .*Voice tutor/);
  assert.strictEqual(q.get('where'), 'Android app'); assert.strictEqual(q.get('area'), 'Voice tutor');
  assert.strictEqual(q.get('what'), what); assert.strictEqual(q.get('steps'), steps); assert.strictEqual(q.get('version'), '1.2.0');
  assert.deepStrictEqual([...q.keys()].sort(), ['area', 'steps', 'template', 'title', 'version', 'what', 'where']);
  const popup = ctx.waitForEvent('page'); await page.click('#bug-go'); const pg = await popup;
  assert.match(pg.url(), /^https:\/\/github\.com\/alice\/study-desk\/issues\/new\?/);
  assert.deepStrictEqual(errs, []);
}));

test('Feedback: a bug report needs a few words, and very long text is cut so the address stays usable', () => withBrowser(async b => {
  const { page, ctx } = await open(b);
  let opened = 0; ctx.on('page', () => opened++);
  await page.fill('#bug-what', 'broken');
  await page.click('#bug-go', { force: true }); await page.waitForTimeout(300); // a person can still press it: it explains what is missing
  assert.strictEqual(opened, 0, 'nothing opens for a too-short report');
  assert.match(await page.locator('#bug-msg').innerText(), /Tell us what went wrong/i);
  assert.strictEqual(await page.locator('#bug-go').getAttribute('aria-disabled'), 'true');
  await page.fill('#bug-what', 'x'.repeat(5000)); await page.fill('#bug-steps', 'y'.repeat(5000));
  const href1 = await href(page, '#bug-go'), q = new URL(href1).searchParams;
  assert.ok(q.get('what').length <= 1500 && q.get('steps').length <= 1500); assert.ok(href1.length < 7000, 'address length ' + href1.length);
  assert.strictEqual(await page.locator('#bug-go').getAttribute('aria-disabled'), null);
}));

test('Feedback: reviews come only from approved GitHub issues of this repository, are shown as plain text without names, and are averaged', () => withBrowser(async b => {
  const bad = [issue(5, 'Windows program', 'This pull request is not a review at all', { pull_request: { url: 'x' } }), issue(9, 'Mac program', 'Rating out of range, must be ignored'),
    issue('', 'Mac program', 'No rating at all, must be ignored'), issue(3, 'Mac program', 'ok')];
  const good = [issue(5, 'Android app', 'Great for exams <img src=x onerror=alert(1)> <b>bold</b> https://evil.example/'), issue(4, 'Windows program', 'Clean and fast, the calendar is what I use every day.')];
  const { page, errs, hosts } = await open(b, { issues: { status: 200, body: [...good, ...bad] } });
  await page.waitForSelector('#rv-list li');
  assert.strictEqual(await page.locator('#rv-list li').count(), 2);
  const t = await page.locator('#rv-list').innerText();
  assert.ok(t.includes('<img src=x onerror=alert(1)> <b>bold</b>'), 'shown as plain text');
  assert.strictEqual(await page.locator('#rv-list img, #rv-list b, #rv-list a').count(), 0);
  assert.match(t, /Android app/); assert.match(t, /Windows program/); assert.ok(!/pull request is not|out of range|No rating at all/.test(t));
  assert.ok(!(await page.locator('body').innerText()).includes('secret-student'), 'no GitHub names');
  assert.strictEqual(await page.locator('#rv-list li').first().locator('[role="img"]').getAttribute('aria-label'), '5 out of 5');
  assert.match(await page.locator('#rv-summary').innerText(), /4\.5 out of 5/); assert.match(await page.locator('#rv-summary').innerText(), /2 reviews/);
  assert.deepStrictEqual(errs, []);
  for (const h of hosts) assert.ok(['alice.github.io', 'api.github.com'].includes(h), 'unexpected host ' + h);
}));

test('Feedback: the reviews request asks for the approved label only, from this repository', () => withBrowser(async b => {
  const urls = [];
  const { page } = await open(b, { wait: false });
  page.on('request', r => { if (r.url().includes('/issues?')) urls.push(r.url()); });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#state').dataset.state !== 'loading');
  await page.waitForTimeout(300);
  assert.strictEqual(urls.length, 1); const u = new URL(urls[0]);
  assert.strictEqual(u.pathname, '/repos/alice/study-desk/issues'); assert.strictEqual(u.searchParams.get('labels'), 'review-approved'); assert.strictEqual(u.searchParams.get('state'), 'open');
}));

test('Feedback: no reviews gives an honest empty message, and a failed request a plain message; writing still works', () => withBrowser(async b => {
  const a = await open(b);
  await a.page.waitForFunction(() => document.querySelector('#rv-status').textContent.length > 0);
  assert.match(await a.page.locator('#rv-status').innerText(), /No reviews yet/);
  assert.strictEqual(await a.page.locator('#rv-list li').count(), 0); assert.strictEqual(await a.page.locator('#rv-summary').isVisible(), false);
  for (const issues of [{ status: 403, body: { message: 'rate limit' } }, { status: 200, body: '{not json' }, { status: 200, body: { not: 'a list' } }, { abort: true }]) {
    const x = await open(b, { issues });
    await x.page.waitForFunction(() => document.querySelector('#rv-status').textContent.length > 0);
    assert.match(await x.page.locator('#rv-status').innerText(), /could not be loaded/i, JSON.stringify(issues).slice(0, 40));
    assert.strictEqual(await x.page.locator('#rv-go').isVisible(), true); assert.deepStrictEqual(x.errs, []);
  }
}));

test('Feedback: writing a review opens the review form with rating, place and text; the rating is 1 to 5 and the text needs a few words', () => withBrowser(async b => {
  const { page, ctx } = await open(b);
  let opened = 0; ctx.on('page', () => opened++);
  await page.selectOption('#rv-rating', '4'); await page.selectOption('#rv-where', 'Windows program'); await page.fill('#rv-text', 'short');
  await page.click('#rv-go', { force: true }); await page.waitForTimeout(300); assert.strictEqual(opened, 0);
  assert.match(await page.locator('#rv-msg').innerText(), /few words/i);
  const text = 'It keeps my exams and deadlines in one place, ı ğ ü.';
  await page.fill('#rv-text', text);
  const u = new URL(await href(page, '#rv-go')), q = u.searchParams;
  assert.strictEqual(u.origin + u.pathname, 'https://github.com/alice/study-desk/issues/new');
  assert.strictEqual(q.get('template'), 'review.yml'); assert.strictEqual(q.get('rating'), '4'); assert.strictEqual(q.get('used'), 'Windows program'); assert.strictEqual(q.get('review'), text);
  assert.match(q.get('title'), /^\[Review\] 4 out of 5/); assert.deepStrictEqual([...q.keys()].sort(), ['rating', 'review', 'template', 'title', 'used']);
  assert.deepStrictEqual(await page.locator('#rv-rating option').evaluateAll(o => o.map(x => x.value)), ['5', '4', '3', '2', '1']);
  const popup = ctx.waitForEvent('page'); await page.click('#rv-go'); assert.match((await popup).url(), /^https:\/\/github\.com\/alice\/study-desk\/issues\/new\?/);
}));

test('Feedback: the section is hidden when the project address is not known (no wrong links)', () => withBrowser(async b => {
  const { page } = await open(b, { url: 'https://example.com/' });
  assert.strictEqual(await page.locator('#feedback').isVisible(), false);
  assert.strictEqual(await page.locator('#bug-go').getAttribute('href'), null);
}));

test('Feedback: the page says what is public, and the top menu links to it', () => withBrowser(async b => {
  const { page } = await open(b);
  const t = await page.locator('#feedback').innerText();
  assert.match(t, /GitHub account/i); assert.match(t, /public/i); assert.match(t, /approve/i); assert.match(t, /(password|key)/i);
  assert.strictEqual(await page.locator('.bar nav a[href="#feedback"]').count(), 1);
}));
