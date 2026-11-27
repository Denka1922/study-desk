'use strict';
// Study Desk for Windows: one window that shows app/index.html and nothing else.
const { app, BrowserWindow, Menu, ipcMain, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { linkAction, resolveAppFile } = require('./security');
const { loadCatalog } = require('./ai/catalog');
const { readHardware } = require('./ai/hardware');
const { downloadVerified } = require('./ai/download');
const { createEngine, ensureEngine } = require('./ai/engine');
const { chatLocal } = require('./ai/localchat');
const { runCli, detectTools } = require('./ai/cli');
const { createAiService } = require('./ai/service');
const { registerAiIpc, createProgressSender, AI_PROGRESS_CHANNEL } = require('./ai/ipc');
const { registerSyncIpc } = require('./sync/ipc');
const { loadVoiceCatalog } = require('./voice/catalog');
const { createHost: createVoiceHost } = require('./voice/host');
const { createEarsHost } = require('./voice/ears-host');
const { createPermissionHandlers } = require('./permissions');
const { createStudio } = require('./voice/studio');
const { createCache } = require('./voice/cache');
const { createVoiceService } = require('./voice/service');
const { registerVoiceIpc, VOICE_PROGRESS_CHANNEL } = require('./voice/ipc');

let win = null;
let aiService = null;
let syncIpc = null;
let voiceService = null;

function appFile() {
  return resolveAppFile({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, baseDir: __dirname });
}

function openInBrowser(url) {
  // linkAction already checked that this parses; hand the browser the cleaned-up address
  Promise.resolve(shell.openExternal(new URL(url).href)).catch(() => {});
}

// The Local and CLI AI features: downloads, the engine, and the command-line tools all run here, never in the page.
function startAiService() {
  const sendProgress = createProgressSender(p => {
    try { if (win && !win.isDestroyed()) win.webContents.send(AI_PROGRESS_CHANNEL, p); } catch (e) { /* window is closing */ }
  });
  aiService = createAiService({
    dataDir: path.join(app.getPath('userData'), 'ai'),
    catalog: loadCatalog(),
    hardwareReader: () => readHardware({ getGpuInfo: () => app.getGPUInfo('basic') }),
    engine: createEngine({ pidFile: path.join(app.getPath('userData'), 'ai', 'engine.pid') }),
    engineInstaller: ensureEngine,
    download: downloadVerified,
    chatLocal,
    runCli,
    detectTools,
    onProgress: sendProgress,
  });
  registerAiIpc({ ipcMain, service: aiService, appFileUrl: pathToFileURL(appFile()).href });
}

// The AI Tutor's voice: voice packs are downloaded and run here (never in the page); the page only plays the sound.
function startVoice() {
  const dataDir = path.join(app.getPath('userData'), 'voice-data');
  const sendProgress = createProgressSender(p => {
    try { if (win && !win.isDestroyed()) win.webContents.send(VOICE_PROGRESS_CHANNEL, p); } catch (e) { /* window is closing */ }
  });
  const cache = createCache(path.join(dataDir, 'voice', 'cache'));
  cache.prune().catch(() => {});
  voiceService = createVoiceService({
    dataDir,
    catalog: loadVoiceCatalog(),
    hardware: { platform: process.platform, arch: process.arch },
    host: createVoiceHost({}),
    earsHost: createEarsHost({}),
    studio: createStudio(),
    cache,
    download: downloadVerified,
    onProgress: p => sendProgress({ phase: 'voice', modelId: p.packId, done: p.done, total: p.total, packId: p.packId }),
  });
  registerVoiceIpc({ ipcMain, service: voiceService, appFileUrl: pathToFileURL(appFile()).href });
}

// Sync with the phone: the door stays closed until the user pairs a device in the app.
function startSync() {
  syncIpc = registerSyncIpc({ ipcMain, getWindow: () => win, appFileUrl: pathToFileURL(appFile()).href });
}

function stopAi() {
  if (aiService) Promise.resolve(aiService.shutdown()).catch(() => {});
  if (syncIpc) Promise.resolve(syncIpc.shutdown()).catch(() => {});
  if (voiceService) Promise.resolve(voiceService.shutdown()).catch(() => {});
}

function createWindow() {
  const file = appFile();
  const fileUrl = pathToFileURL(file).href;
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 600,
    title: 'Study Desk',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  const guard = (event, url) => {
    const action = linkAction(url, fileUrl);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') openInBrowser(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (linkAction(url, fileUrl) === 'external') openInBrowser(url);
    return { action: 'deny' };
  });
  win.loadFile(file);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('before-quit', stopAi);
  app.on('window-all-closed', () => { stopAi(); app.quit(); });
  app.whenReady().then(() => {
    // Everything is refused except the microphone (audio only) for the app's own page in the app's own window.
    const permissions = createPermissionHandlers({
      appFileUrl: pathToFileURL(appFile()).href,
      isAppContents: wc => !!win && !win.isDestroyed() && wc === win.webContents,
      askMicrophone: process.platform === 'darwin' && systemPreferences ? () => systemPreferences.askForMediaAccess('microphone') : undefined,
    });
    session.defaultSession.setPermissionRequestHandler(permissions.request);
    session.defaultSession.setPermissionCheckHandler(permissions.check);
    // Windows: no menu bar. Mac: the menu bar is part of the system, and without an Edit menu
    // copy and paste do not work and Cmd+Q does nothing, so keep a minimal one.
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null);
    startAiService(); // IPC is ready before the page loads
    startSync();
    try { startVoice(); } catch (e) { console.error('The voice feature could not start:', e && e.message); } // the planner must open even without voice
    createWindow();
  });
}
