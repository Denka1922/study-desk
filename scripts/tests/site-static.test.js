'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { read } = require('./helpers');

const { hashOf, stampHtml } = require('../csp-hash');
const html = () => read('site/index.html');
const PLAY = 'https://play.google.com/store/apps/details?id=app.studydesk.planner';
const withPlay = (h, url) => {
  const body = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  return stampHtml(h.replace(body, () => body.replace('const PLAY_STORE_URL = "";', `const PLAY_STORE_URL = ${JSON.stringify(url)};`)));
};

function staticRules(h) {
  assert.strictEqual((h.match(/<script\b/g) || []).length, 1);
  assert.strictEqual((h.match(/<style\b/g) || []).length, 1);
  assert.ok(!/<script[^>]+src=/i.test(h));
  assert.ok(!/<link\b[^>]+href=["']https?:/i.test(h));
  assert.ok(!/<iframe\b|<form\b|@import|url\(\s*["']?https?:/i.test(h));
  // pictures come only from this site's own shots/ folder: no address with a scheme or host, no data: images, no inline style attributes
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    const src = (m[0].match(/\ssrc="([^"]*)"/) || [])[1];
    assert.match(src || '', /^shots\/[a-z0-9-]+\.webp$/, m[0]);
    assert.match(m[0], /\salt="[^"]+"/, 'every picture has a description: ' + m[0]);
  }
  for (const m of h.matchAll(/\ssrcset="([^"]*)"/gi)) assert.match(m[1], /^shots\/[a-z0-9-]+\.webp$/, m[1]);
  assert.ok(!/\sstyle=/i.test(h.replace(/<style>[\s\S]*?<\/style>/, '')), 'inline style attributes are blocked by the CSP');
  const meta = h.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, 'CSP meta');
  const dirs = Object.fromEntries(meta[1].split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')]; }));
  const script = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  const style = h.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.strictEqual(dirs['default-src'], "'none'");
  assert.strictEqual(dirs['script-src'], `'${hashOf(script)}'`);
  assert.strictEqual(dirs['style-src'], `'${hashOf(style)}'`);
  assert.strictEqual(dirs['img-src'], "'self'");
  assert.strictEqual(dirs['connect-src'], 'https://api.github.com');
  assert.strictEqual(dirs['base-uri'], "'none'");
  assert.strictEqual(dirs['form-action'], "'none'");
  assert.deepStrictEqual(Object.keys(dirs).sort(), ['base-uri', 'connect-src', 'default-src', 'form-action', 'img-src', 'script-src', 'style-src']);
  // The page may offer an APK only if the release has one (found through the GitHub reply). No address of an APK file is written into the page.
  assert.ok(!/https?:\/\/[^\s"']*\.apk/i.test(h), 'no hard-coded APK address');
  assert.ok(!/href="[^"]*\.apk/i.test(h), 'no APK link in the markup');
  const code = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(code));
  // empty when shipped; after publishing, the user pastes this app's Play Store address
  assert.match(code, /const PLAY_STORE_URL = "(|https:\/\/play\.google\.com\/store\/apps\/details\?id=app\.studydesk\.planner)";/);
  assert.match(code, /const REPO_OVERRIDE = "";/);
}

test('the shipped page follows the static rules', () => staticRules(html()));
test('the rules still hold after the user sets the Play Store address and re-stamps', () => staticRules(withPlay(html(), PLAY)));
test('the page tells people about Smart App Control', () => assert.match(html(), /Smart App Control/));
test('the page tells Mac people about Open Anyway and covers Windows, Mac and Android', () => {
  const h = html();
  assert.match(h, /Open Anyway/);
  assert.match(h, /<meta name="description" content="[^"]*Windows, Mac and Android/);
  for (const id of ['tab-windows', 'tab-mac', 'tab-android']) assert.ok(h.includes('id="' + id + '"'), id);
});

test('every picture the page names exists in site/shots and stays small', () => {
  const fs = require('node:fs'), path = require('node:path');
  const h = html();
  const names = new Set([...h.matchAll(/(?:\ssrc|\ssrcset)="(shots\/[^"]+)"/g)].map(m => m[1]));
  assert.ok(names.size >= 5, 'the page shows the app');
  for (const n of names) {
    const f = path.join(__dirname, '..', '..', 'site', n);
    assert.ok(fs.existsSync(f), n);
    assert.ok(fs.statSync(f).size < 150 * 1024, n + ' is under 150 KB');
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'site', 'favicon.svg')));
});
test('the page shows no personal details or secrets', () => {
  const h = html();
  assert.ok(!/AQ\.Ab8RN6/.test(h));
  assert.ok(!/@(gmail|outlook|hotmail|yahoo)\./i.test(h));
  assert.ok(!/workers\.dev/.test(h), 'no relay address on the page');
});

test('the page has an honest "Code signing policy": not signed yet, applied to SignPath Foundation, roles, privacy link; and it is linked from the footer', () => {
  const h = read('site/index.html');
  const m = /<(?:div|section)[^>]*id="signing"[\s\S]*?<\/(?:div|section)>\s*(?=<div class="wrap|<\/main>)/.exec(h);
  assert.ok(m, 'a section with id="signing"');
  const t = m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /Code signing policy/);
  assert.match(t, /not signed yet/i);
  assert.match(t, /applied to the SignPath Foundation/i);
  assert.match(t, /Free code signing provided by SignPath\.io/);
  assert.match(t, /certificate by SignPath Foundation/i);
  assert.match(t, /Authors?, reviewers? and approvers?/i);
  assert.match(t, /Privacy policy/);
  assert.ok(!/(are|is) signed by SignPath/i.test(t) && !/two-factor/i.test(t), 'no claim that is not true yet');
  assert.match(h, /<footer>[\s\S]*href="#signing"[\s\S]*<\/footer>/);
});
