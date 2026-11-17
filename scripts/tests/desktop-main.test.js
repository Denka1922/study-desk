'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAIN = path.resolve(__dirname, '../../desktop/main.js');

function makeFake({ lock = true, isPackaged = false, template = null } = {}) {
  const log = { windows: [], openExternal: [], menu: 'unset', quit: 0, appHandlers: {}, reqPerm: null, checkPerm: null, order: [], ipcChannels: [], serviceCreated: 0, shutdown: 0, serviceDeps: null };
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.handlers = {}; this.loaded = null; this.calls = [];
      this.webContents = {
        on: (ev, fn) => { this.handlers[ev] = fn; },
        setWindowOpenHandler: fn => { this.openHandler = fn; },
        send: (ch, payload) => { (this.sent = this.sent || []).push([ch, payload]); },
      };
      log.windows.push(this);
    }
    loadFile(p) { this.loaded = p; log.order.push('loadFile'); return Promise.resolve(); }
    isDestroyed() { return false; }
    isMinimized() { return true; }
    restore() { this.calls.push('restore'); }
    show() { this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    on() {}
  }
  const electron = {
    app: {
      isPackaged,
      requestSingleInstanceLock: () => lock,
      whenReady: () => Promise.resolve(),
      on: (ev, fn) => { log.appHandlers[ev] = fn; },
      quit: () => { log.quit++; },
      getPath: name => path.join(path.sep, 'fake-user-data', name),
      getGPUInfo: async () => ({ gpuDevice: [] }),
    },
    ipcMain: { handle: ch => { log.ipcChannels.push(ch); log.order.push('ipc'); } },
    BrowserWindow,
    Menu: { setApplicationMenu: m => { log.menu = m; }, buildFromTemplate: t => { log.template = t; return { built: true }; } },
    shell: { openExternal: u => { log.openExternal.push(u); return Promise.resolve(); } },
    session: { defaultSession: {
      setPermissionRequestHandler: fn => { log.reqPerm = fn; },
      setPermissionCheckHandler: fn => { log.checkPerm = fn; },
    } },
  };
  return { electron, log };
}

async function loadMain(opts = {}) {
  const { electron, log } = makeFake(opts);
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  // always pin the platform: these tests describe the Windows program unless a test asks for a Mac, so they must not depend on the computer running them
  Object.defineProperty(process, 'platform', { value: opts.platform || 'win32' });
  const orig = Module._load;
  const fakeService = { createAiService: deps => { log.serviceCreated++; log.serviceDeps = deps; return new Proxy({ shutdown: () => { log.shutdown++; return Promise.resolve(); } }, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve({})) }); } };
  Module._load = function (request, ...rest) { if (request === 'electron') return electron; if (request === './ai/service') return fakeService; return orig.call(this, request, ...rest); };
  delete require.cache[MAIN];
  try { require(MAIN); await new Promise(r => setImmediate(r)); }
  finally { Module._load = orig; delete require.cache[MAIN]; Object.defineProperty(process, 'platform', realPlatform); }
  return log;
}

test('window is created with the locked-down settings', async () => {
  const log = await loadMain();
  assert.strictEqual(log.windows.length, 1);
  const w = log.windows[0];
  assert.strictEqual(w.opts.width, 1200); assert.strictEqual(w.opts.height, 800);
  assert.strictEqual(w.opts.minWidth, 360); assert.strictEqual(w.opts.minHeight, 600);
  assert.strictEqual(w.opts.title, 'Study Desk');
  assert.deepStrictEqual(w.opts.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.resolve(__dirname, '../../desktop/preload.js') });
  assert.strictEqual(log.menu, null);
});

test('it loads the app page from the development location, or from resources when packaged', async () => {
  const dev = await loadMain();
  assert.strictEqual(dev.windows[0].loaded, path.resolve(__dirname, '../../app/index.html'));
  process.resourcesPath = path.join(path.sep, 'res');
  try {
    const pk = await loadMain({ isPackaged: true });
    assert.strictEqual(pk.windows[0].loaded, path.join(path.sep, 'res', 'app', 'index.html'));
  } finally { delete process.resourcesPath; }
});

test('links: https goes to the browser, everything else stays refused, nothing navigates away', async () => {
  const log = await loadMain();
  const w = log.windows[0];
  for (const ev of ['will-navigate', 'will-redirect']) {
    let prevented = 0;
    w.handlers[ev]({ preventDefault: () => { prevented++; } }, 'https://example.com/x');
    assert.strictEqual(prevented, 1, ev + ' https');
    w.handlers[ev]({ preventDefault: () => { prevented++; } }, 'javascript:alert(1)');
    assert.strictEqual(prevented, 2, ev + ' js');
  }
  assert.deepStrictEqual(log.openExternal, ['https://example.com/x', 'https://example.com/x']);
  const own = pathToFileURL(path.resolve(__dirname, '../../app/index.html')).href + '#tutor';
  let prevented = 0;
  w.handlers['will-navigate']({ preventDefault: () => { prevented++; } }, own);
  assert.strictEqual(prevented, 0, 'own page hash navigation is not blocked');
});

test('new windows are never opened; https is routed to the browser', async () => {
  const log = await loadMain();
  const w = log.windows[0];
  assert.deepStrictEqual(w.openHandler({ url: 'https://example.com/y' }), { action: 'deny' });
  assert.deepStrictEqual(w.openHandler({ url: 'http://example.com/y' }), { action: 'deny' });
  assert.deepStrictEqual(w.openHandler({ url: 'javascript:1' }), { action: 'deny' });
  assert.deepStrictEqual(log.openExternal, ['https://example.com/y']);
});

test('all permission requests are denied', async () => {
  const log = await loadMain();
  let granted = 'unset';
  log.reqPerm({}, 'media', ok => { granted = ok; });
  assert.strictEqual(granted, false);
  assert.strictEqual(log.checkPerm({}, 'geolocation'), false);
});

test('second copy: quits; first copy: restores and focuses', async () => {
  const second = await loadMain({ lock: false });
  assert.strictEqual(second.quit, 1);
  assert.strictEqual(second.windows.length, 0);
  const first = await loadMain();
  first.appHandlers['second-instance']();
  assert.deepStrictEqual(first.windows[0].calls, ['restore', 'show', 'focus']);
});

test('the browser is given the cleaned-up address, not the raw string', async () => {
  const log = await loadMain();
  const w = log.windows[0];
  w.handlers['will-navigate']({ preventDefault() {} }, 'HTTPS://EXAMPLE.com/a b');
  assert.deepStrictEqual(log.openExternal, ['https://example.com/a%20b']);
  assert.deepStrictEqual(w.openHandler({ url: 'https://Example.com/x y' }), { action: 'deny' });
  assert.strictEqual(log.openExternal[1], 'https://example.com/x%20y');
});

test('on a Mac the app keeps a minimal menu so copy, paste, quit and hide work', async () => {
  const mac = await loadMain({ platform: 'darwin' });
  assert.deepStrictEqual(mac.menu, { built: true });
  assert.deepStrictEqual(mac.template.map(m => m.role), ['appMenu', 'editMenu', 'windowMenu']);
  const win = await loadMain({ platform: 'win32' });
  assert.strictEqual(win.menu, null, 'Windows keeps no menu bar');
});

test('the AI service is created once, its IPC is registered before the page loads, and it is shut down on quit', async () => {
  const { AI_CHANNELS } = require('../../desktop/ai/ipc');
  const log = await loadMain();
  assert.strictEqual(log.serviceCreated, 1);
  assert.deepStrictEqual([...log.ipcChannels].sort(), [...AI_CHANNELS].sort());
  assert.ok(log.order.indexOf('ipc') < log.order.indexOf('loadFile'), 'IPC first, then the page');
  assert.strictEqual(log.serviceDeps.dataDir, path.join(path.sep, 'fake-user-data', 'userData', 'ai'));
  assert.ok(typeof log.serviceDeps.hardwareReader === 'function' && log.serviceDeps.catalog && log.serviceDeps.engine && log.serviceDeps.runCli && log.serviceDeps.chatLocal && log.serviceDeps.download && log.serviceDeps.engineInstaller && log.serviceDeps.detectTools);
  log.appHandlers['before-quit'](); assert.strictEqual(log.shutdown, 1);
  log.appHandlers['window-all-closed'](); assert.strictEqual(log.shutdown, 2, 'calling shutdown twice is harmless');
});

test('download progress is sent to the page window', async () => {
  const log = await loadMain();
  log.serviceDeps.onProgress({ phase: 'model', modelId: 'm', done: 1, total: 2 });
  assert.deepStrictEqual(log.windows[0].sent, [['study-desk:ai:progress', { phase: 'model', modelId: 'm', done: 1, total: 2 }]]);
});

test('a second copy of the app never creates the AI service', async () => {
  const second = await loadMain({ lock: false });
  assert.strictEqual(second.serviceCreated, 0);
});
