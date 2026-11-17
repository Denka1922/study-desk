'use strict';
// The page turns the AI's tagged lines into data. These cases come from real small models (see the real-model runs).
const test = require('node:test');
const assert = require('node:assert');
const { loadPlaywright, pageWithExports } = require('./helpers');

const PG = pageWithExports(['aiParseTagged', 'aiValidate']);
let browser;
async function page() {
  if (!browser) browser = await loadPlaywright().chromium.launch();
  const p = await browser.newPage(); await p.goto(PG.url); await p.waitForSelector('.glance'); return p;
}
test.after(async () => { if (browser) await browser.close(); PG.cleanup(); });

const NINE = 'TITLE: **How Photosynthesis Works**  \nSUMMARY: A short course.  \n'
  + Array.from({ length: 9 }, (_, i) => 'LESSON: **Lesson ' + (i + 1) + '** | Goal ' + (i + 1) + '.  ').join('\n');

test('an outline with more lessons than asked keeps the first ones (a real 4B model wrote 9 for 3)', async () => {
  const p = await page();
  const r = await p.evaluate(t => { const o = aiParseTagged('outline', t, { lessonCount: 3 }); return { n: o.lessons.length, titles: o.lessons.map(l => l.title), ok: !!aiValidate('outline', o, { lessonCount: 3 }) }; }, NINE);
  assert.deepStrictEqual(r, { n: 3, titles: ['Lesson 1', 'Lesson 2', 'Lesson 3'], ok: true });
  await p.close();
});

test('too few lessons is still a failure, and without a count nothing is cut', async () => {
  const p = await page();
  const r = await p.evaluate(t => {
    const few = aiParseTagged('outline', 'TITLE: T\nLESSON: A | a\nLESSON: B | b', { lessonCount: 3 });
    return { fewOk: !!aiValidate('outline', few, { lessonCount: 3 }), all: aiParseTagged('outline', t).lessons.length };
  }, NINE);
  assert.deepStrictEqual(r, { fewOk: false, all: 9 });
  await p.close();
});

test('bold marks around a title, goal or course name are removed', async () => {
  const p = await page();
  const o = await p.evaluate(t => aiParseTagged('outline', t, { lessonCount: 1 }), 'TITLE: **Big Title**\nSUMMARY: **S**\nLESSON: **What Is It?** | **Know it.**');
  assert.deepStrictEqual([o.title, o.lessons[0].title, o.lessons[0].goal], ['Big Title', 'What Is It?', 'Know it.']);
  await p.close();
});
