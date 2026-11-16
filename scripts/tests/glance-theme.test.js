'use strict';
// The summary tiles (Overview: Pending, Grades: Overall average) must follow the theme like every
// other tile. They used to be drawn with swapped colors (light box in dark theme, dark box in light).
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');

test('no summary tile is painted with the text color as its background', () => {
  const html = read('app/index.html');
  const rules = [...html.matchAll(/(\.glance[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 0, 'glance rules found');
  for (const [, sel, body] of rules) {
    assert.ok(!/background\s*:\s*var\(--ink\)/.test(body), `${sel.trim()} must not use --ink as its background`);
    assert.ok(!/color\s*:\s*var\(--surface\)/.test(body), `${sel.trim()} must not use --surface as its text color`);
  }
});
