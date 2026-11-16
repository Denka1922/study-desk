#!/usr/bin/env node
'use strict';
// Stand-in for llama-server used by tests: same arguments, serves /health and /v1/chat/completions.
// FAKE_MODE: exit (dies at once), never (never healthy). FAKE_LOAD_MS: unhealthy for that long. FAKE_ARGS_FILE: where to write argv.
// Chat behaviour is picked by a word "SCENARIO:<name>" anywhere in the request body (see the switch below).
const http = require('node:http');
const fs = require('node:fs');
const a = process.argv.slice(2);
const arg = n => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(a));
const mode = process.env.FAKE_MODE || '';
if (mode === 'exit') { console.error('fatal: cannot load model'); process.exit(1); }
const key = arg('--api-key'), host = arg('--host'), port = Number(arg('--port'));
const loadMs = Number(process.env.FAKE_LOAD_MS || 0), t0 = Date.now();

const reply = (res, message, extra = {}) => {
  const body = { choices: [{ index: 0, message: Object.assign({ role: 'assistant' }, message), finish_reason: extra.finish || 'stop' }] };
  if (extra.usage !== false) body.usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (mode === 'never' || Date.now() - t0 < loadMs) { res.writeHead(503); return res.end('{"error":{"message":"Loading model"}}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}');
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end('{"error":"bad key"}'); }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const m = /SCENARIO:([a-z-]+)/.exec(raw); const s = m ? m[1] : 'default';
      switch (s) {
        case 'hang': return; // never answers
        case 'reasoning-field': return reply(res, { content: 'Final answer', reasoning_content: 'let me think about it' });
        case 'think-tag': return reply(res, { content: '<think>hmm, the user asks</think>Final answer' });
        case 'think-json': return reply(res, { content: '<think>hmm {"x":2}</think>{"a":1}' });
        case 'think-only': return reply(res, { content: '<think>I keep thinking and never close the tag' });
        case 'no-usage': return reply(res, { content: 'Final answer' }, { usage: false });
        case 'length': return reply(res, { content: 'A cut off ans' }, { finish: 'length' });
        case 'echo-request': return reply(res, { content: JSON.stringify({ auth: req.headers.authorization, body: JSON.parse(raw) }) });
        default: return reply(res, { content: 'Final answer' });
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.on('error', () => { console.error("couldn't bind HTTP server socket, hostname: " + host + ", port: " + port); process.exit(1); });
server.listen(port, host);
