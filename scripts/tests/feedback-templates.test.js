'use strict';
// The GitHub issue forms that the download page fills in. The page sends values by field id, so the ids must exist in the forms.
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');

const ids = y => [...y.matchAll(/^\s+id:\s*([a-z_]+)\s*$/gm)].map(m => m[1]);
const bug = () => read('.github/ISSUE_TEMPLATE/bug_report.yml'), rev = () => read('.github/ISSUE_TEMPLATE/review.yml');

test('the bug report form has every field the page fills in, asks for no secrets, and labels the issue "bug"', () => {
  const y = bug();
  for (const f of ['where', 'area', 'version', 'what', 'steps']) assert.ok(ids(y).includes(f), 'field ' + f);
  assert.match(y, /^name: .+/m); assert.match(y, /^description: .+/m); assert.match(y, /labels:\s*\[\s*"?bug"?\s*\]/);
  assert.match(y, /(password|API key)/i); assert.match(y, /public/i);
  assert.match(y, /id: what[\s\S]*?required: true/);
});

test('the review form has every field the page fills in, labels the issue "review", and says it is public and needs approval', () => {
  const y = rev();
  for (const f of ['rating', 'used', 'review']) assert.ok(ids(y).includes(f), 'field ' + f);
  assert.match(y, /labels:\s*\[\s*"?review"?\s*\]/);
  assert.match(y, /public/i); assert.match(y, /approve/i);
  // the page reads these headings back from the approved issue
  assert.match(y, /label: Rating\b/); assert.match(y, /label: Used on\b/); assert.match(y, /label: Your review\b/);
});

test('the review form cannot approve itself: it never sets the "review-approved" label', () => {
  assert.ok(!/review-approved/.test(rev().split('\n').filter(l => /labels:/.test(l)).join('\n')));
});
