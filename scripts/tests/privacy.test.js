'use strict';
// PRIVACY.md must name every server the app can talk to, so the policy cannot silently fall behind the code.
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');

const policy = () => read('PRIVACY.md');

function appHosts() {
  const html = read('app/index.html');
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  const hosts = new Set([...csp.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]));
  const allowed = /const ALLOWED = \[([^\]]*)\]/.exec(read('desktop/voice/catalog.js'))[1];
  for (const m of allowed.matchAll(/'([a-z0-9.-]+)'/gi)) hosts.add(m[1]);
  return [...hosts];
}

test('the privacy policy names every server the app page or the downloads can contact', () => {
  const p = policy(), hosts = appHosts();
  assert.ok(hosts.length >= 8, 'found the hosts: ' + hosts.join(', '));
  for (const h of hosts) assert.ok(p.includes(h), 'PRIVACY.md does not mention ' + h);
});

test('the privacy policy covers the things a reader needs, in plain words', () => {
  const p = policy();
  for (const [re, what] of [[/no account/i, 'no accounts'], [/analytics|tracking/i, 'no analytics'], [/microphone/i, 'microphone'], [/never (sent|leaves)|not sent|stays on/i, 'stays on the device'],
    [/AI Tutor/i, 'AI Tutor'], [/Sync/i, 'Sync'], [/Google Fonts/i, 'Google Fonts'], [/delete|remove|uninstall/i, 'how to delete'], [/issues/i, 'how to contact'], [/Last updated: \d{4}-\d{2}-\d{2}/, 'date']]) {
    assert.match(p, re, what);
  }
});

test('the privacy policy contains no key, address or personal details', () => {
  const p = policy();
  assert.ok(!/AQ\.Ab8|[\w.+-]+@[\w-]+\.[a-z]{2,}|workers\.dev/i.test(p));
});
