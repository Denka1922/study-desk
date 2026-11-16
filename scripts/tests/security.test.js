'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { linkAction, resolveAppFile } = require('../../desktop/security');

const APP = 'file:///C:/Users/%C3%96%C4%9Frenci%20%C3%87al%C4%B1%C5%9Fma/AppData/Local/Programs/Study%20Desk/resources/app/index.html';

test('own page (even with a hash or query, spaces and Turkish letters in the path) is allowed', () => {
  assert.strictEqual(linkAction(APP, APP), 'allow');
  assert.strictEqual(linkAction(APP + '#tutor', APP), 'allow');
  assert.strictEqual(linkAction(APP + '?x=1#todo', APP), 'allow');
});

test('any other file, path trick or scheme is denied', () => {
  const bad = [
    'file:///C:/Users/%C3%96%C4%9Frenci%20%C3%87al%C4%B1%C5%9Fma/AppData/Local/Programs/Study%20Desk/resources/app/index.html/../secret.html',
    'file:///C:/Users/%C3%96%C4%9Frenci%20%C3%87al%C4%B1%C5%9Fma/AppData/Local/Programs/Study%20Desk/resources/app/other.html',
    'file:///etc/passwd',
    'javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'ftp://example.com/x',
    'mailto:a@b.c', 'ms-msdt:x', 'about:blank', 'blob:https://example.com/abc',
    'https://user:pass@example.com', 'https://user@example.com',
    'https://', 'not a url', '//example.com',
  ];
  for (const u of bad) assert.strictEqual(linkAction(u, APP), 'deny', u);
});

test('non-string and oversized input is denied without throwing', () => {
  for (const v of ['', null, undefined, 42, {}, [], true, () => 1, Symbol('x')]) {
    assert.strictEqual(linkAction(v, APP), 'deny');
  }
  assert.strictEqual(linkAction('https://example.com/' + 'a'.repeat(10000), APP), 'deny');
  assert.strictEqual(linkAction('https://example.com/' + 'a'.repeat(2029), APP), 'deny'); // 2049 chars
  assert.strictEqual(linkAction('https://example.com/' + 'a'.repeat(2028), APP), 'external'); // exactly 2048
});

test('normal https links go to the browser', () => {
  assert.strictEqual(linkAction('https://example.com/a?b=1#c', APP), 'external');
  assert.strictEqual(linkAction('https://xn--80ak6aa92e.com', APP), 'external');
  assert.strictEqual(linkAction('HTTPS://EXAMPLE.com', APP), 'external');
});

test('resolveAppFile: packaged and development layouts, Windows path with spaces and Turkish letters', () => {
  const w = path.win32;
  assert.strictEqual(
    resolveAppFile({ isPackaged: true, resourcesPath: 'C:\\Users\\Öğrenci Çalışma\\AppData\\Local\\Programs\\Study Desk\\resources', baseDir: 'X' }, w),
    'C:\\Users\\Öğrenci Çalışma\\AppData\\Local\\Programs\\Study Desk\\resources\\app\\index.html');
  assert.strictEqual(
    resolveAppFile({ isPackaged: false, resourcesPath: '', baseDir: 'D:\\proj\\study-desk\\desktop' }, w),
    'D:\\proj\\study-desk\\app\\index.html');
});
