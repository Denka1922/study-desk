'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadPlaywright } = require('./helpers');

const HTML = fs.readFileSync(path.join(ROOT, 'app/index.html'));

async function exercise(browser, url, setup) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  if (setup) await setup(page);
  await page.goto(url);
  await page.waitForSelector('.glance');
  await page.click('.side [data-view="todo"]');
  await page.fill('#t-title', 'Origin check task');
  await page.click('#task-form .btn.primary');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('#view .view-head');
  await page.waitForTimeout(1200);
  assert.ok(await page.evaluate(() => document.body.innerText.includes('Origin check task')), 'task persists after reload');
  await page.evaluate(() => { location.hash = 'tutor'; });
  await page.reload();
  await page.waitForSelector('#view .view-head');
  assert.ok(await page.locator('#view .view-head').first().isVisible(), 'tutor view opens');
  assert.deepStrictEqual(errs, []);
  await ctx.close();
}

test('page works from http://127.0.0.1 and from a Capacitor-like https://localhost origin', async () => {
  const { chromium } = loadPlaywright();
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(HTML); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    await exercise(browser, `http://127.0.0.1:${server.address().port}/`);
    await exercise(browser, 'https://localhost/', async page => {
      await page.route('https://localhost/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
    });
  } finally { await browser.close(); server.close(); }
});
