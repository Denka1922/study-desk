'use strict';
// The only doorway from the page to the AI service. Every call is checked: who is asking, and what exactly was sent.
const { LEVEL_ORDER } = require('./levels');

const PREFIX = 'study-desk:ai:';
const NAMES = ['getHardware', 'recommend', 'local:status', 'local:install', 'local:cancel', 'local:remove', 'local:removeAll',
  'local:start', 'local:stop', 'cli:detect', 'chat', 'cancelChat'];
const AI_CHANNELS = NAMES.map(n => PREFIX + n);
const AI_PROGRESS_CHANNEL = PREFIX + 'progress'; // main to page only (webContents.send), never handled

const ID_RE = /^[a-z0-9._-]{1,60}$/;
const KINDS = ['auth', 'quota', 'rate', 'network', 'timeout', 'cancelled', 'bad', 'disk', 'checksum', 'ram', 'engine', 'nocli'];

class BadRequest extends Error { constructor(m) { super(m || 'The request was not valid.'); this.kind = 'bad'; } }
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const need = (c, m) => { if (!c) throw new BadRequest(m); };
const id = v => { need(typeof v === 'string' && ID_RE.test(v)); return v; };
const level = v => { need(LEVEL_ORDER.includes(v)); return v; };

const none = () => undefined;
const VALIDATE = {
  getHardware: none, 'local:status': none, 'local:cancel': none, 'local:removeAll': none, 'local:stop': none, 'cli:detect': none, cancelChat: none,
  recommend: a => { need(isObj(a)); need(a.language === undefined || (typeof a.language === 'string' && a.language.length <= 40)); return { level: level(a.level), language: a.language }; },
  'local:install': a => { need(isObj(a)); return { modelId: id(a.modelId), level: level(a.level) }; },
  'local:start': a => { need(isObj(a)); return { modelId: id(a.modelId), level: level(a.level) }; },
  'local:remove': a => { need(isObj(a)); return { modelId: id(a.modelId) }; },
  chat: a => {
    need(isObj(a));
    need(a.mode === 'local' || a.mode === 'cli');
    const out = { mode: a.mode };
    if (a.mode === 'cli') out.cliId = id(a.cliId);
    need(typeof a.system === 'string' && a.system.length <= 100000);
    need(Array.isArray(a.messages) && a.messages.length <= 60);
    out.messages = a.messages.map(m => {
      need(isObj(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.length <= 200000);
      return { role: m.role, text: m.text };
    });
    need(Number.isInteger(a.maxTokens) && a.maxTokens >= 1 && a.maxTokens <= 32768);
    need(typeof a.json === 'boolean');
    out.system = a.system; out.maxTokens = a.maxTokens; out.json = a.json;
    return out;
  },
};
const METHOD = { getHardware: 'getHardware', recommend: 'recommend', 'local:status': 'localStatus', 'local:install': 'install', 'local:cancel': 'cancelInstall', 'local:remove': 'remove',
  'local:removeAll': 'removeAll', 'local:start': 'start', 'local:stop': 'stop', 'cli:detect': 'cliDetect', chat: 'chat', cancelChat: 'cancelChat' };

function plainUrl(u) { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; } catch (e) { return null; } }

function failure(e) {
  const kind = e && KINDS.includes(e.kind) ? e.kind : 'bad';
  const error = { kind, message: e && KINDS.includes(e.kind) && typeof e.message === 'string' ? e.message : 'Something went wrong with the AI. Try again.' };
  if (e && isObj(e.suggestion)) error.suggestion = e.suggestion;
  return { ok: false, error };
}

function registerAiIpc({ ipcMain, service, appFileUrl }) {
  const appHref = plainUrl(appFileUrl);
  for (const name of NAMES) {
    ipcMain.handle(PREFIX + name, async (event, arg) => {
      try {
        const from = event && event.senderFrame && plainUrl(event.senderFrame.url);
        if (!appHref || from !== appHref) throw new BadRequest('This request did not come from the app.');
        const clean = VALIDATE[name](arg);
        return { ok: true, value: await service[METHOD[name]](clean) };
      } catch (e) { return failure(e); }
    });
  }
}

// Downloads report progress for every chunk; the page only needs a few updates a second (and always the last one).
function createProgressSender(send, o = {}) {
  const interval = o.intervalMs || 250, now = o.now || Date.now, last = new Map();
  return p => {
    const key = p.phase + ':' + p.modelId, t = now();
    const done = p.total > 0 && p.done >= p.total;
    if (done || !last.has(key) || t - last.get(key) >= interval) { last.set(key, t); send(p); }
  };
}

module.exports = { registerAiIpc, AI_CHANNELS, AI_PROGRESS_CHANNEL, createProgressSender };
