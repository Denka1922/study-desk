'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { chatLocal, stripThinking } = require('../../desktop/ai/localchat');
const { estimateTokens } = require('../../desktop/ai/usage');
const { freePort } = require('../../desktop/ai/engine');

const FAKE = path.join(__dirname, 'fixtures', 'fake-llama-server.js');
const TOKEN = 'k'.repeat(40);

async function withServer(fn) {
  const port = await freePort();
  const p = cp.spawn(process.execPath, [FAKE, '--host', '127.0.0.1', '--port', String(port), '--api-key', TOKEN], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch (e) { /* wait */ } await new Promise(r => setTimeout(r, 30)); }
    return await fn(port);
  } finally { p.kill(); }
}
const ask = (port, text, extra = {}) => chatLocal(Object.assign({ port, token: TOKEN, system: 'SYS', messages: [{ role: 'user', text }], maxTokens: 321, json: false }, extra));
async function err(p) { try { await p; } catch (e) { return e; } assert.fail('should have rejected'); }

test('estimateTokens is chars/4 rounded up, 0 for empty', () => {
  assert.strictEqual(estimateTokens(''), 0); assert.strictEqual(estimateTokens(null), 0);
  assert.strictEqual(estimateTokens('abcd'), 1); assert.strictEqual(estimateTokens('abcde'), 2);
});

test('stripThinking removes think blocks, an orphan closing tag and an unclosed opening tag', () => {
  assert.strictEqual(stripThinking('<think>a</think>Hello'), 'Hello');
  assert.strictEqual(stripThinking('<think>a</think>One <think>b</think>Two'), 'One Two');
  assert.strictEqual(stripThinking('reasoning that started in the prompt</think>\nThe answer'), 'The answer');
  assert.strictEqual(stripThinking('<think>never closed'), '');
  assert.strictEqual(stripThinking('Plain'), 'Plain');
  assert.strictEqual(stripThinking(undefined), '');
});

test('the request has the right address, key, message order, max_tokens and JSON mode', async () => {
  await withServer(async port => {
    const r = await chatLocal({ port, token: TOKEN, system: 'SYS TEXT', messages: [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'SCENARIO:echo-request three' }], maxTokens: 321, json: true });
    const seen = JSON.parse(r.text);
    assert.strictEqual(seen.auth, 'Bearer ' + TOKEN);
    assert.deepStrictEqual(seen.body.messages.map(m => [m.role, m.content]), [['system', 'SYS TEXT'], ['user', 'one'], ['assistant', 'two'], ['user', 'SCENARIO:echo-request three']]);
    assert.strictEqual(seen.body.max_tokens, 321);
    assert.deepStrictEqual(seen.body.response_format, { type: 'json_object' });
    const plain = JSON.parse((await ask(port, 'SCENARIO:echo-request x')).text);
    assert.strictEqual(plain.body.response_format, undefined);
    // a lesson does not need the model to think first; with thinking on, a 4B model used its whole answer budget thinking in Turkish and sent nothing
    assert.deepStrictEqual(seen.body.chat_template_kwargs, { enable_thinking: false });
    assert.deepStrictEqual(plain.body.chat_template_kwargs, { enable_thinking: false });
  });
});

test('usage comes from the server, or is estimated from the text when missing', async () => {
  await withServer(async port => {
    let r = await ask(port, 'hello');
    assert.deepStrictEqual(r.usage, { input: 11, output: 7, estimated: false });
    r = await ask(port, 'SCENARIO:no-usage hello');
    assert.strictEqual(r.usage.estimated, true);
    assert.strictEqual(r.usage.input, estimateTokens('SYS') + estimateTokens('SCENARIO:no-usage hello'));
    assert.strictEqual(r.usage.output, estimateTokens('Final answer'));
  });
});

test('finish_reason length sets cut', async () => {
  await withServer(async port => {
    assert.strictEqual((await ask(port, 'SCENARIO:length')).cut, true);
    assert.strictEqual((await ask(port, 'hi')).cut, false);
  });
});

test('thinking never reaches the answer, in plain or JSON mode', async () => {
  await withServer(async port => {
    assert.strictEqual((await ask(port, 'SCENARIO:reasoning-field')).text, 'Final answer');
    assert.strictEqual((await ask(port, 'SCENARIO:think-tag')).text, 'Final answer');
    const j = await ask(port, 'SCENARIO:think-json', { json: true });
    assert.deepStrictEqual(JSON.parse(j.text), { a: 1 });
    const e = await err(ask(port, 'SCENARIO:think-only'));
    assert.strictEqual(e.kind, 'bad'); assert.match(e.message, /empty reply/);
  });
});

test('cancel, timeout and a dead server are told apart', async () => {
  await withServer(async port => {
    const ac = new AbortController(); const p = ask(port, 'SCENARIO:hang', { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    assert.strictEqual((await err(p)).kind, 'cancelled');
    assert.strictEqual((await err(ask(port, 'SCENARIO:hang', { timeoutMs: 300 }))).kind, 'timeout');
    assert.strictEqual((await err(ask(port, 'x', { signal: AbortSignal.abort() }))).kind, 'cancelled');
  });
  const dead = await freePort();
  assert.strictEqual((await err(ask(dead, 'x'))).kind, 'network');
});

test('a wrong key or server error is a plain bad-reply error, not a crash', async () => {
  await withServer(async port => {
    const e = await err(chatLocal({ port, token: 'wrong', system: 's', messages: [{ role: 'user', text: 'x' }], maxTokens: 5, json: false }));
    assert.strictEqual(e.kind, 'bad'); assert.ok(e.message.length > 5);
  });
});

test('JSON mode accepts a reply wrapped in a code fence', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"a":2}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  const r = await chatLocal({ port: 1, token: 'x', system: 's', messages: [{ role: 'user', text: 'x' }], maxTokens: 5, json: true, fetchImpl });
  assert.deepStrictEqual(JSON.parse(r.text), { a: 2 });
});

test('a 50,000 character prompt with quotes and newlines arrives unchanged', async () => {
  await withServer(async port => {
    const nasty = 'SCENARIO:echo-request "q" \n %PATH% $(x) `y` & ' + 'ş'.repeat(50000);
    const seen = JSON.parse((await ask(port, nasty)).text);
    assert.strictEqual(seen.body.messages[1].content, nasty);
  });
});

test('the real request does not use the built-in fetch, which gives up after 5 minutes of silence (a slow PC can need longer)', async () => {
  // Found in a real run: Qwen3 8B on a slow processor needed more than 5 minutes for a Turkish lesson and the app said
  // "Could not reach the local AI" although the model was still working. The app's own 15 minute limit must be the only one.
  await withServer(async port => {
    const real = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('global fetch must not be used for the local AI'); };
    try {
      const r = await ask(port, 'hello');
      assert.ok(r.text.length > 0 && r.usage.output > 0);
      const ac = new AbortController(); const p = ask(port, 'SCENARIO:hang', { signal: ac.signal });
      setTimeout(() => ac.abort(), 100);
      assert.strictEqual((await err(p)).kind, 'cancelled');
      assert.strictEqual((await err(ask(port, 'SCENARIO:hang', { timeoutMs: 300 }))).kind, 'timeout');
      assert.strictEqual((await err(chatLocal({ port, token: 'wrong', system: 's', messages: [{ role: 'user', text: 'x' }], maxTokens: 5, json: false }))).kind, 'bad');
    } finally { globalThis.fetch = real; }
  });
  const dead = await freePort();
  assert.strictEqual((await err(ask(dead, 'x'))).kind, 'network');
});
