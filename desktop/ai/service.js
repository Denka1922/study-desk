'use strict';
// Puts the pieces together for the page: install, start/stop, chat (Local or CLI), idle stop and clean-up.
const fs = require('node:fs');
const path = require('node:path');
const { LEVEL_ORDER, budgetFor } = require('./levels');
const { engineAssetFor } = require('./hardware');
const { estimateNeedBytes, languageFit, recommend: pickModel } = require('./picker');
const { estimateTokens } = require('./usage');
const { DownloadError } = require('./download');

class AiServiceError extends Error {
  constructor(kind, message, extra) { super(message); this.name = 'AiServiceError'; this.kind = kind; if (extra) Object.assign(this, extra); }
}
const bad = m => new AiServiceError('bad', m);
const DOWNLOAD_KINDS = { host: 'bad', http: 'network', network: 'network', disk: 'disk', checksum: 'checksum', cancelled: 'cancelled' };
const ID_RE = /^[a-z0-9._-]{1,60}$/;

// Turns anything thrown by a lower layer into an error with a page kind and a plain message.
function normalize(e) {
  if (e instanceof AiServiceError) return e;
  if (e instanceof DownloadError) return new AiServiceError(DOWNLOAD_KINDS[e.code] || 'bad', e.message);
  if (e && typeof e.kind === 'string') return new AiServiceError(e.kind, e.message || 'Something went wrong.');
  return new AiServiceError('bad', 'Something went wrong: ' + (e && e.message ? e.message : String(e)));
}

function createAiService(deps) {
  const { dataDir, catalog } = deps;
  const modelsDir = path.join(dataDir, 'models');
  const engineDir = path.join(dataDir, 'engine');
  const idleMs = deps.idleMs || 10 * 60 * 1000;
  const progress = deps.onProgress || (() => {});

  let choice = null;      // {modelId, level}: what the engine should run, remembered for restarts
  let running = null;     // {modelId, level} while the engine is up
  let conn = null;        // {port, token}
  let installCtl = null, chatCtl = null, idleTimer = null, shuttingDown = false;
  let startPromise = null;

  deps.engine.onExit(() => { running = null; conn = null; });

  const modelById = id => (typeof id === 'string' && ID_RE.test(id) ? catalog.models.find(m => m.id === id) : null);
  const modelFile = m => path.join(modelsDir, m.file);
  const checkLevel = l => { if (!LEVEL_ORDER.includes(l)) throw bad('Unknown power level.'); };
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  async function suggestion(hardware, level, language) {
    const rec = pickModel({ hardware, level, language: language || 'English', catalog });
    return rec.ok ? { modelId: rec.model.id, level } : { modelId: null, raiseTo: rec.raiseTo || null, advice: rec.reason };
  }

  async function checkFits(m, level) {
    const hardware = await deps.hardwareReader();
    const b = budgetFor(level, hardware);
    if (hardware.totalRamBytes < m.minRamBytes || estimateNeedBytes(m, b.ctx) > b.ramBytes) {
      const s = await suggestion(hardware, level);
      throw new AiServiceError('ram', m.name + ' needs more memory than the ' + level + ' power level allows on this computer. ' +
        (s.modelId ? 'A smaller model fits: ' + catalog.models.find(x => x.id === s.modelId).name + '.' : 'Raise the power level or use a command-line AI tool.'), { suggestion: s });
    }
    return { hardware, budget: b };
  }

  async function getHardware() { return deps.hardwareReader(); }

  async function recommend({ level, language }) {
    checkLevel(level);
    const hardware = await deps.hardwareReader();
    const rec = pickModel({ hardware, level, language, catalog });
    const b = budgetFor(level, hardware);
    // the page lets the student choose another model, so it gets every enabled one with a plain fits flag (no internal fields)
    const models = catalog.models.filter(m => m.enabled).map(m => ({
      id: m.id, name: m.name, params: m.params, sizeBytes: m.sizeBytes, line: m.line, tier: m.tier, license: { name: m.license.name, url: m.license.url },
      fit: languageFit(m, language), fits: hardware.totalRamBytes >= m.minRamBytes && estimateNeedBytes(m, b.ctx) <= b.ramBytes,
    }));
    return Object.assign({}, rec, { models });
  }

  async function localStatus() {
    const hardware = await deps.hardwareReader();
    const installed = [];
    for (const m of catalog.models) {
      try { const st = fs.statSync(modelFile(m)); if (st.isFile()) installed.push({ modelId: m.id, sizeBytes: st.size }); } catch (e) { /* not installed */ }
    }
    const asset = engineAssetFor(hardware);
    const engineInstalled = !!asset && fs.existsSync(path.join(engineDir, catalog.engine.tag, asset, 'installed.json'));
    let diskFreeBytes = 0;
    try { fs.mkdirSync(dataDir, { recursive: true }); diskFreeBytes = await (deps.freeBytes || (async d => { const s = await fs.promises.statfs(d); return s.bavail * s.bsize; }))(dataDir); } catch (e) { diskFreeBytes = 0; }
    return { installed, engineInstalled, running, diskFreeBytes };
  }

  async function install({ modelId, level }) {
    const m = modelById(modelId);
    if (!m || !m.enabled) throw bad('That model is not available.');
    checkLevel(level);
    if (installCtl) throw bad('A download is already running.');
    const ctl = installCtl = new AbortController();
    try {
      const { hardware } = await checkFits(m, level);
      await deps.engineInstaller({ dataDir, hardware, catalog, signal: ctl.signal, onProgress: (done, total) => progress({ phase: 'engine', modelId, done, total }) });
      await deps.download({
        url: m.url, destPath: modelFile(m), sha256: m.sha256, sizeBytes: m.sizeBytes, signal: ctl.signal,
        onProgress: (done, total) => progress({ phase: 'model', modelId, done, total }),
      });
      choice = { modelId, level };
      return { modelId };
    } catch (e) { throw normalize(e); } finally { installCtl = null; }
  }

  function cancelInstall() { if (installCtl) installCtl.abort(); }

  async function stop() {
    clearIdle(); running = null; conn = null;
    await deps.engine.stop();
  }

  // one start at a time: a second call waits for the first and then finds the engine already running
  let startChain = Promise.resolve();
  function start(a) {
    const p = startChain.then(() => startNow(a));
    startChain = p.catch(() => {});
    return p;
  }

  async function startNow({ modelId, level }) {
    const m = modelById(modelId);
    if (!m || !m.enabled) throw bad('That model is not available.');
    checkLevel(level);
    if (!fs.existsSync(modelFile(m))) throw bad('That model is not installed yet.');
    if (running && running.modelId === modelId && running.level === level && deps.engine.running()) return { running };
    // another model or level: end the running engine first, so its own memory is not counted against the new one
    if (running || deps.engine.running()) await stop();
    const { hardware } = await checkFits(m, level); // free memory is read again every time
    const { serverPath } = await deps.engineInstaller({ dataDir, hardware, catalog });
    try {
      conn = await deps.engine.start({ serverPath, modelPath: modelFile(m), level, hardware });
    } catch (e) { running = null; conn = null; throw normalize(e); }
    running = { modelId, level }; choice = { modelId, level };
    return { running };
  }

  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(() => { idleTimer = null; stop().catch(() => {}); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function ensureRunning() {
    if (running && deps.engine.running()) return;
    if (!choice) throw bad('Choose and install a model first, on the Local screen.');
    if (!startPromise) startPromise = start(choice).finally(() => { startPromise = null; });
    try { await startPromise; } catch (e) {
      const n = normalize(e);
      if (n.kind === 'ram' || n.kind === 'bad') throw n;
      throw new AiServiceError('engine', 'The local AI could not be restarted. ' + n.message);
    }
  }

  function composePrompt(system, messages, json) {
    const turns = messages.map(m => (m.role === 'user' ? 'Student: ' : 'Tutor: ') + m.text).join('\n\n');
    return system + '\n\n' + turns + '\n\nTutor:' + (json ? '\n\nReply with valid JSON only, nothing else.' : '');
  }

  async function chat(req) {
    if (shuttingDown) throw bad('The app is closing.');
    if (!req || (req.mode !== 'local' && req.mode !== 'cli')) throw bad('Unknown AI source.');
    if (chatCtl) throw bad('The AI is still answering the last question.');
    const ctl = chatCtl = new AbortController();
    clearIdle();
    try {
      if (req.mode === 'cli') {
        return await deps.runCli({ toolId: req.cliId, prompt: composePrompt(req.system, req.messages, req.json), signal: ctl.signal });
      }
      await ensureRunning();
      const b = budgetFor(running.level, await deps.hardwareReader());
      const input = estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.text), 0);
      const room = b.ctx - input - 64; // the page may ask for more answer than fits; the answer allowance shrinks, the question is never cut
      if (room < 256) throw bad('This conversation is too long for the ' + running.level + ' power level. Start a new chat, or choose a higher level.');
      const maxTokens = Math.min(req.maxTokens, room);
      try {
        return await deps.chatLocal({ port: conn.port, token: conn.token, system: req.system, messages: req.messages, maxTokens, json: !!req.json, signal: ctl.signal });
      } catch (e) {
        if (!deps.engine.running() && e && e.kind !== 'cancelled') { running = null; conn = null; throw new AiServiceError('engine', 'The local AI stopped unexpectedly. Send your message again to restart it.'); }
        throw e;
      }
    } catch (e) { throw normalize(e); } finally {
      chatCtl = null;
      if (running && !shuttingDown) armIdle();
    }
  }

  function cancelChat() { if (chatCtl) chatCtl.abort(); }

  async function remove({ modelId }) {
    const m = modelById(modelId);
    if (!m) throw bad('That model is not known.');
    if (running && running.modelId === m.id) await stop();
    await fs.promises.rm(modelFile(m), { force: true });
    await fs.promises.rm(modelFile(m) + '.part', { force: true });
    return { modelId: m.id };
  }

  async function removeAll() {
    await stop();
    await fs.promises.rm(modelsDir, { recursive: true, force: true });
    await fs.promises.rm(engineDir, { recursive: true, force: true });
    choice = null;
    return {};
  }

  async function shutdown() {
    shuttingDown = true;
    cancelInstall(); cancelChat(); clearIdle();
    running = null; conn = null;
    await deps.engine.stop();
  }

  return { getHardware, recommend, localStatus, install, cancelInstall, remove, removeAll, start, stop, chat, cancelChat, cliDetect: () => deps.detectTools(), shutdown };
}

module.exports = { createAiService, AiServiceError };
