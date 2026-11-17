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

// Nemotron 3 Nano 4B wrote every question on ONE line (found in a real run).
const ONE_LINE_EXAM = Array.from({ length: 12 }, (_, i) =>
  'Q: Question number ' + i + ' about plants? A) first ' + i + ' B) second ' + i + ' C) third ' + i + ' D) fourth ' + i + '. ANSWER: ' + 'ABCD'[i % 4] + ' WHY: because ' + i + '. LESSON: ' + (1 + i % 3)).join('\n');

test('a question written on one line is split into its question, four options, answer, reason and lesson', async () => {
  const p = await page();
  const r = await p.evaluate(t => {
    const o = aiParseTagged('exam', t, {});
    return { n: o.questions.length, q0: o.questions[0], q5: o.questions[5], ok: !!aiValidate('exam', o, { outline: { lessons: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] } }) };
  }, ONE_LINE_EXAM);
  assert.strictEqual(r.n, 12);
  assert.deepStrictEqual([r.q0.q, r.q0.options, r.q0.answer, r.q0.explanation, r.q0.lesson], ['Question number 0 about plants?', ['first 0', 'second 0', 'third 0', 'fourth 0.'], 0, 'because 0.', 0]);
  assert.strictEqual(r.q5.answer, 1); assert.strictEqual(r.q5.lesson, 2);
  assert.strictEqual(r.ok, true);
  await p.close();
});

test('a lesson quiz on one line works too, and a normal multi-line quiz is not changed', async () => {
  const p = await page();
  const r = await p.evaluate(() => {
    const one = '## H\nbody\nKEY: k\nEXAMPLE: e\nQ: Which is right? A) one B) two C) three D) four ANSWER: C WHY: three.';
    const multi = '## H\nbody\nKEY: k\nEXAMPLE: e\nQ: Which is right?\nA) one\nB) two\nC) three\nD) four\nANSWER: C\nWHY: three.';
    const a = aiParseTagged('lesson', one, {}).quiz[0], b = aiParseTagged('lesson', multi, {}).quiz[0];
    return { a: [a.q, a.options, a.answer], b: [b.q, b.options, b.answer] };
  });
  assert.deepStrictEqual(r.a, ['Which is right?', ['one', 'two', 'three', 'four'], 2]);
  assert.deepStrictEqual(r.b, ['Which is right?', ['one', 'two', 'three', 'four'], 2]);
  await p.close();
});
