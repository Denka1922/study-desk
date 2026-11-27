'use strict';
// Runs in the page's isolated preload context. Gives the page one small object, window.studyDesk.ai, and nothing else.
// (A sandboxed preload cannot load other files, so the channel names are written out here; a test keeps them in step.)
const { contextBridge, ipcRenderer } = require('electron');

const P = 'study-desk:ai:';
const call = (name, arg) => ipcRenderer.invoke(P + name, arg).then(r => {
  if (r && r.ok) return r.value;
  const e = (r && r.error) || {};
  const out = { kind: typeof e.kind === 'string' ? e.kind : 'bad', message: typeof e.message === 'string' ? e.message : 'Something went wrong with the AI.' };
  if (e.suggestion && typeof e.suggestion === 'object') out.suggestion = e.suggestion;
  return Promise.reject(out);
});

const ai = {
  version: 1,
  getHardware: () => call('getHardware'),
  recommend: a => call('recommend', a),
  local: {
    status: () => call('local:status'),
    install: a => call('local:install', a),
    cancel: () => call('local:cancel'),
    remove: a => call('local:remove', a),
    removeAll: () => call('local:removeAll'),
    start: a => call('local:start', a),
    stop: () => call('local:stop'),
    onProgress: cb => {
      if (typeof cb !== 'function') throw new TypeError('onProgress needs a function');
      const handler = (event, payload) => cb(payload);
      ipcRenderer.on(P + 'progress', handler);
      return () => ipcRenderer.removeListener(P + 'progress', handler);
    },
  },
  cli: { detect: () => call('cli:detect') },
  chat: a => call('chat', a),
  cancelChat: () => call('cancelChat'),
};

// Sync with the phone. The page keeps the data and does the merging; this side only carries sealed messages (see SYNC.md).
const SP = 'study-desk:sync:';
const scall = (name, arg) => ipcRenderer.invoke(SP + name, arg).then(r => {
  if (r && r.ok) return r.value;
  return Promise.reject({ message: (r && r.error && typeof r.error.message === 'string') ? r.error.message : 'Sync did not work.' });
});
const sync = {
  version: 1,
  start: a => scall('start', a),
  stop: () => scall('stop'),
  forget: () => scall('forget'),
  publish: a => scall('publish', a),
  status: () => scall('status'),
  // cb(msg) must return a promise of {rev, doc}; the answer is sent back to the main process.
  onRequest: cb => {
    if (typeof cb !== 'function') throw new TypeError('onRequest needs a function');
    const handler = (event, p) => {
      if (!p || !Number.isInteger(p.id)) return;
      Promise.resolve().then(() => cb(p.msg)).then(
        v => ipcRenderer.invoke(SP + 'reply', { id: p.id, ok: true, value: v }).catch(() => {}),
        () => ipcRenderer.invoke(SP + 'reply', { id: p.id, ok: false }).catch(() => {}));
    };
    ipcRenderer.on(SP + 'request', handler);
    return () => ipcRenderer.removeListener(SP + 'request', handler);
  },
  onStatus: cb => {
    if (typeof cb !== 'function') throw new TypeError('onStatus needs a function');
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on(SP + 'status:event', handler);
    return () => ipcRenderer.removeListener(SP + 'status:event', handler);
  },
};

// Voice for the AI Tutor: the page asks for a line of text to be spoken and plays the WAV it gets back.
const VP = 'study-desk:voice:';
const vcall = (name, arg) => ipcRenderer.invoke(VP + name, arg).then(r => {
  if (r && r.ok) return r.value;
  const e = (r && r.error) || {};
  return Promise.reject({ kind: typeof e.kind === 'string' ? e.kind : 'bad', message: typeof e.message === 'string' ? e.message : 'The voice did not work.' });
});
const voice = {
  version: 1,
  status: () => vcall('status'),
  refreshStudio: () => vcall('refreshStudio'),
  install: a => vcall('install', a),
  cancel: () => vcall('cancel'),
  remove: a => vcall('remove', a),
  removeAll: () => vcall('removeAll'),
  speak: a => vcall('speak', a),
  cancelSpeak: () => vcall('cancelSpeak'),
  // Speech input: the page sends a recording (mono, 16 kHz, Float32Array) and gets the words back.
  listenInstall: a => vcall('listenInstall', a),
  listenRemove: a => vcall('listenRemove', a),
  hear: a => vcall('hear', a),
  cancelHear: () => vcall('cancelHear'),
  onProgress: cb => {
    if (typeof cb !== 'function') throw new TypeError('onProgress needs a function');
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on(VP + 'progress', handler);
    return () => ipcRenderer.removeListener(VP + 'progress', handler);
  },
};

contextBridge.exposeInMainWorld('studyDesk', { ai, sync, voice });
