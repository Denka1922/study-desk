'use strict';
// The only doorway from the page to the voice service. Same rules as ../ai/ipc.js: only the app's own page may call,
// and every argument is checked before the service sees it.
const PREFIX = 'study-desk:voice:';
const NAMES = ['status', 'install', 'cancel', 'remove', 'removeAll', 'speak', 'cancelSpeak', 'refreshStudio'];
const VOICE_CHANNELS = NAMES.map(n => PREFIX + n);
const VOICE_PROGRESS_CHANNEL = PREFIX + 'progress'; // main to page only, never handled

const ID_RE = /^[a-z0-9._-]{1,60}$/;
const VOICE_RE = /^[\w .:@-]{1,80}$/;
const KINDS = ['cancelled', 'bad', 'disk', 'checksum', 'network', 'timeout', 'engine'];

class BadRequest extends Error { constructor(m) { super(m || 'The request was not valid.'); this.kind = 'bad'; } }
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const need = (c, m) => { if (!c) throw new BadRequest(m); };
const none = () => undefined;

const VALIDATE = {
  status: none, cancel: none, removeAll: none, cancelSpeak: none, refreshStudio: none,
  install: a => { need(isObj(a)); need(typeof a.packId === 'string' && ID_RE.test(a.packId)); return { packId: a.packId }; },
  remove: a => { need(isObj(a)); need(typeof a.packId === 'string' && ID_RE.test(a.packId)); return { packId: a.packId }; },
  speak: a => {
    need(isObj(a));
    need(a.source === 'pack' || a.source === 'studio');
    need(typeof a.voiceId === 'string' && VOICE_RE.test(a.voiceId));
    need(typeof a.text === 'string' && a.text.length >= 1 && a.text.length <= 1000);
    need(typeof a.speed === 'number' && a.speed >= 0.5 && a.speed <= 2);
    const out = { source: a.source, voiceId: a.voiceId, text: a.text, speed: a.speed };
    if (a.source === 'pack') {
      need(typeof a.packId === 'string' && ID_RE.test(a.packId));
      need(typeof a.lang === 'string' && /^[a-z]{2,3}$/.test(a.lang));
      out.packId = a.packId; out.lang = a.lang;
    }
    return out;
  },
};
const METHOD = { status: 'status', install: 'install', cancel: 'cancelInstall', remove: 'remove', removeAll: 'removeAll', speak: 'speak', cancelSpeak: 'cancelSpeak', refreshStudio: 'refreshStudio' };

function plainUrl(u) { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; } catch (e) { return null; } }

function failure(e) {
  const known = e && KINDS.includes(e.kind);
  return { ok: false, error: { kind: known ? e.kind : 'bad', message: known && typeof e.message === 'string' ? e.message : 'The voice did not work. Try again.' } };
}

function registerVoiceIpc({ ipcMain, service, appFileUrl }) {
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

module.exports = { registerVoiceIpc, VOICE_CHANNELS, VOICE_PROGRESS_CHANNEL };
