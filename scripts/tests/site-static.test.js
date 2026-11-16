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
  assert.ok(!/<img\b|<iframe\b|<form\b|@import|url\(\s*["']?https?:/i.test(h));
  const meta = h.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, 'CSP meta');
  const dirs = Object.fromEntries(meta[1].split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')]; }));
  const script = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  const style = h.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.strictEqual(dirs['default-src'], "'none'");
  assert.strictEqual(dirs['script-src'], `'${hashOf(script)}'`);
  assert.strictEqual(dirs['style-src'], `'${hashOf(style)}'`);
  assert.strictEqual(dirs['connect-src'], 'https://api.github.com');
  assert.strictEqual(dirs['base-uri'], "'none'");
  assert.strictEqual(dirs['form-action'], "'none'");
  assert.deepStrictEqual(Object.keys(dirs).sort(), ['base-uri', 'connect-src', 'default-src', 'form-action', 'script-src', 'style-src']);
  assert.ok(!/apk/i.test(h));
  const code = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(code));
  // empty when shipped; after publishing, the user pastes this app's Play Store address
  assert.match(code, /const PLAY_STORE_URL = "(|https:\/\/play\.google\.com\/store\/apps\/details\?id=app\.studydesk\.planner)";/);
  assert.match(code, /const REPO_OVERRIDE = "";/);
}

test('the shipped page follows the static rules', () => staticRules(html()));
test('the rules still hold after the user sets the Play Store address and re-stamps', () => staticRules(withPlay(html(), PLAY)));
test('the page tells people about Smart App Control', () => assert.match(html(), /Smart App Control/));
