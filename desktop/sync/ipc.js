'use strict';
// The doorway between the page and the sync service. Same rules as desktop/ai/ipc.js: only the app's own page may call, every argument is checked.
const os = require('node:os');
const { MODES, createSyncService } = require('./service');
const { createLanServer } = require('./lan-server');
const { createRelayClient } = require('./relay-client');

const PREFIX = 'study-desk:sync:';
const NAMES = ['start', 'stop', 'forget', 'publish', 'status', 'reply'];
const SYNC_CHANNELS = NAMES.map(n => PREFIX + n);
const SYNC_REQUEST_CHANNEL = PREFIX + 'request';   // main to page only
const SYNC_STATUS_CHANNEL = PREFIX + 'status:event'; // main to page only
const MAX_DOC = 8 * 1024 * 1024;

class BadRequest extends Error {}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const need = (c, m) => { if (!c) throw new BadRequest(m || 'The request was not valid.'); };
function plainUrl(u) { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; } catch (e) { return null; } }

function checkDoc(doc) {
  need(isObj(doc), 'The data is not valid.');
  let size = 0; try { size = JSON.stringify(doc).length; } catch (e) { need(false); }
  need(size <= MAX_DOC, 'The data is too big to sync.');
  return doc;
}

const VALIDATE = {
  start: a => {
    need(isObj(a)); need(MODES.includes(a.mode));
    need(typeof a.secretB64 === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a.secretB64));
    need(typeof a.deviceId === 'string' && /^[0-9a-f]{16}$/.test(a.deviceId));
    need(a.name === undefined || (typeof a.name === 'string' && a.name.length <= 40));
    need(a.relayUrl === undefined || (typeof a.relayUrl === 'string' && a.relayUrl.length <= 200));
    return { secretB64: a.secretB64, mode: a.mode, deviceId: a.deviceId, name: a.name || 'This PC', relayUrl: a.relayUrl || '' };
  },
  stop: () => undefined, forget: () => undefined, status: () => undefined,
  publish: a => { need(isObj(a)); need(typeof a.rev === 'string' && a.rev.length <= 128); return { rev: a.rev, doc: checkDoc(a.doc) }; },
  reply: a => {
    need(isObj(a)); need(Number.isInteger(a.id) && a.id > 0); need(typeof a.ok === 'boolean');
    if (a.ok) { need(isObj(a.value) && typeof a.value.rev === 'string' && a.value.rev.length <= 128); return { id: a.id, ok: true, value: { rev: a.value.rev, doc: checkDoc(a.value.doc) } }; }
    return { id: a.id, ok: false };
  },
};

function registerSyncIpc(o) {
  const { ipcMain, getWindow, appFileUrl } = o;
  const appHref = plainUrl(appFileUrl);
  const pending = new Map(); let nextId = 1;
  let lastStatus = { state: 'off', text: 'Sync is off', lastSync: 0, mode: 'off' };
  const sendToPage = (channel, payload) => { try { const w = getWindow(); if (!w || w.isDestroyed()) return false; w.webContents.send(channel, payload); return true; } catch (e) { return false; } };

  function askPage(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The app window did not answer.')); }, timeoutMs || 15000);
      pending.set(id, { resolve, reject, timer });
      if (!sendToPage(SYNC_REQUEST_CHANNEL, { id, msg })) { clearTimeout(timer); pending.delete(id); reject(new Error('The app window is not available.')); }
    });
  }
  const service = (o.createService || (() => createSyncService({
    os, askPage,
    emitStatus: s => { lastStatus = s; sendToPage(SYNC_STATUS_CHANNEL, s); },
    makeLan: ({ getKeys, onMessage }) => createLanServer({ getKeys, onMessage }),
    makeRelay: ({ baseUrl, keys }) => createRelayClient({ baseUrl, keys }),
  })))({ askPage, emitStatus: s => { lastStatus = s; sendToPage(SYNC_STATUS_CHANNEL, s); } });

  const HANDLER = {
    start: a => service.start(a), stop: () => service.stop().then(() => ({})), forget: () => service.forget().then(() => ({})),
    publish: a => { service.publish(a); return {}; }, status: () => lastStatus,
    reply: a => {
      const p = pending.get(a.id); if (!p) return {};
      pending.delete(a.id); clearTimeout(p.timer);
      if (a.ok) p.resolve(a.value); else p.reject(new Error('The app could not merge the data.'));
      return {};
    },
  };
  for (const name of NAMES) {
    ipcMain.handle(PREFIX + name, async (event, arg) => {
      try {
        const from = event && event.senderFrame && plainUrl(event.senderFrame.url);
        if (!appHref || from !== appHref) throw new BadRequest('This request did not come from the app.');
        return { ok: true, value: await HANDLER[name](VALIDATE[name](arg)) };
      } catch (e) { return { ok: false, error: { message: e instanceof BadRequest || (e && e.message) ? String(e.message).slice(0, 200) : 'Sync did not work.' } }; }
    });
  }
  return { service, shutdown: () => { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); return service.stop(); } };
}

module.exports = { registerSyncIpc, SYNC_CHANNELS, SYNC_REQUEST_CHANNEL, SYNC_STATUS_CHANNEL };
