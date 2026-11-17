'use strict';
// Talks to the local llama-server (OpenAI-style chat endpoint on 127.0.0.1).
const http = require('node:http');
const { estimateTokens } = require('./usage');

class ChatError extends Error {
  constructor(kind, message) { super(message); this.name = 'ChatError'; this.kind = kind; }
}

// Reasoning models (Nemotron, GLM) think before they answer; only the answer may reach the tutor.
function stripThinking(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = s.search(/<\/think>/i);
  if (close >= 0) s = s.slice(close + '</think>'.length); // chat template opened the tag in the prompt: all before it is thinking
  const open = s.search(/<think>/i);
  if (open >= 0) s = s.slice(0, open); // never closed: the rest is thinking
  return s.trim();
}

function unfence(s) {
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s.trim());
  return m ? m[1].trim() : s;
}

// Plain http request to the engine on this computer. The built-in fetch gives up after 5 minutes without a first byte,
// but the engine sends nothing until the whole answer is ready, and a slow processor can need longer than that.
// Only the app's own limit (timeoutMs) applies. Returns the small part of a fetch Response that chatLocal uses.
function localFetch(url, init) {
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
    const headers = Object.assign({}, init.headers);
    if (init.body != null) headers['content-length'] = Buffer.byteLength(init.body); // a plain length, never chunked
    const req = http.request(url, { method: init.method || 'GET', headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; req.destroy(e); reject(e); }, { once: true });
    req.on('error', reject);
    req.end(init.body);
  });
}

async function chatLocal(o) {
  const fetchImpl = o.fetchImpl || localFetch;
  const messages = [{ role: 'system', content: o.system }].concat(o.messages.map(m => ({ role: m.role, content: m.text })));
  const body = { model: 'local', messages, max_tokens: o.maxTokens, stream: false };
  body.chat_template_kwargs = { enable_thinking: false }; // answer at once: thinking first can eat the whole answer budget and uses far more tokens
  if (o.json) body.response_format = { type: 'json_object' };

  const ac = new AbortController();
  let why = null;
  const onAbort = () => { why = why || 'cancelled'; ac.abort(); };
  if (o.signal) { if (o.signal.aborted) throw new ChatError('cancelled', 'Cancelled.'); o.signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => { why = why || 'timeout'; ac.abort(); }, o.timeoutMs || 15 * 60 * 1000);

  let data;
  try {
    let res;
    try {
      res = await fetchImpl('http://127.0.0.1:' + o.port + '/v1/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ChatError('bad', 'The local AI answered with an error (' + res.status + '). Try again, or restart the AI from the setup screen.');
      data = await res.json();
    } catch (e) {
      if (e instanceof ChatError) throw e;
      if (why === 'cancelled') throw new ChatError('cancelled', 'Cancelled.');
      if (why === 'timeout') throw new ChatError('timeout', 'The local AI took too long to answer. A smaller model or a higher power level may help.');
      if (e && e.name === 'SyntaxError') throw new ChatError('bad', 'The local AI sent a reply the app could not read.');
      throw new ChatError('network', 'Could not reach the local AI. It may have stopped; restart it from the setup screen.');
    }
  } finally { clearTimeout(timer); if (o.signal) o.signal.removeEventListener('abort', onAbort); }

  const choice = data && data.choices && data.choices[0];
  let text = stripThinking(choice && choice.message && choice.message.content);
  if (o.json) text = unfence(text);
  if (!text) throw new ChatError('bad', 'The AI sent an empty reply. Try again, or choose a higher power level so it has room to answer.');
  const u = data.usage;
  const usage = u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)
    ? { input: u.prompt_tokens, output: u.completion_tokens, estimated: false }
    : { input: estimateTokens(o.system) + o.messages.reduce((n, m) => n + estimateTokens(m.text), 0), output: estimateTokens(text), estimated: true };
  return { text, cut: choice.finish_reason === 'length', usage };
}

module.exports = { chatLocal, stripThinking, ChatError };
