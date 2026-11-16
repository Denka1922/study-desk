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

contextBridge.exposeInMainWorld('studyDesk', { ai });
