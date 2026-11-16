'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, loadPlaywright } = require('./helpers');

const VIEWS = [['overview', 'Pending'], ['grades', 'Overall average']];

test('first summary tile matches the other tiles in light and dark theme', async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.addInitScript(t => { try { localStorage.setItem('sd-theme', t); } catch (e) {} }, theme);
      await page.goto(pathToFileURL(path.join(ROOT, 'app/index.html')).href);
      await page.waitForSelector('.glance');
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      for (const [view, label] of VIEWS) {
        if (view !== 'overview') await page.click(`.side [data-view="${view}"]`);
        await page.waitForSelector('.glance');
        await page.waitForTimeout(1500);
        const got = await page.evaluate(() => {
          const t = [...document.querySelectorAll('.glance > div')].map(d => ({
            label: d.querySelector('.k').textContent,
            bg: getComputedStyle(d).backgroundColor,
            fg: getComputedStyle(d.querySelector('.v')).color,
          }));
          return t;
        });
        assert.strictEqual(got[0].label, label);
        assert.strictEqual(got[0].bg, got[1].bg, `${theme}/${view}: first tile background equals the next tile`);
        assert.strictEqual(got[0].fg, got[1].fg, `${theme}/${view}: first tile number color equals the next tile`);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
});
