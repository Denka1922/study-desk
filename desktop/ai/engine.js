'use strict';
// Installs the llama.cpp server (llama-server) and runs it for the local AI. The server listens on 127.0.0.1 only.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { downloadVerified } = require('./download');
const { budgetFor } = require('./levels');
const { engineAssetFor } = require('./hardware');

class EngineError extends Error {
  constructor(message) { super(message); this.name = 'EngineError'; this.kind = 'engine'; }
}

function buildServerArgs(o) {
  return [
    '-m', o.modelPath,
    '--host', '127.0.0.1',
    '--port', String(o.port),
    '--api-key', o.token,
    '--ctx-size', String(o.ctx),
    '--threads', String(o.threads),
    '--gpu-layers', String(o.gpuLayers),
    '--parallel', '1',
    '--jinja',
    '--reasoning-format', 'deepseek', // thinking goes to reasoning_content, not into the answer
    '--no-webui',
  ];
}

// ---- extraction -------------------------------------------------------------------------------------------------

// Writes only inside destDir: rejects absolute names, drive letters and any ".." segment.
function safeJoin(destDir, name) {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..') || n.includes('\0')) throw new EngineError('The engine download contains an unsafe file name, so it was not installed.');
  const full = path.resolve(destDir, n);
  if (full !== path.resolve(destDir) && !full.startsWith(path.resolve(destDir) + path.sep)) throw new EngineError('The engine download contains an unsafe file name, so it was not installed.');
  return full;
}

// Small zip reader (stored and deflate entries, no zip64, no encryption): enough for the llama.cpp release zips.
async function extractZip(archive, destDir) {
  const buf = await fs.promises.readFile(archive);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new EngineError('The engine download is not a valid zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new EngineError('The engine download is not a valid zip file.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (flags & 1 || csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) throw new EngineError('The engine download uses a zip feature the app does not support.');
    entries.push({ name, method, csize, usize, off });
    p += 46 + nlen + elen + clen;
  }
  await fs.promises.mkdir(destDir, { recursive: true });
  for (const e of entries) {
    const target = safeJoin(destDir, e.name);
    if (e.name.endsWith('/')) { await fs.promises.mkdir(target, { recursive: true }); continue; }
    if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new EngineError('The engine download is not a valid zip file.');
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const raw = buf.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data || data.length !== e.usize) throw new EngineError('The engine download is damaged or uses an unsupported zip method.');
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, out, errOut) => err ? reject(new EngineError('Could not run ' + cmd + ': ' + (errOut || err.message))) : resolve(out));
  });
}

async function extractArchive(archive, destDir, format) {
  if (format === 'zip') return extractZip(archive, destDir);
  if (format === 'tar.gz') { await fs.promises.mkdir(destDir, { recursive: true }); return run('tar', ['-xzf', archive, '-C', destDir]); }
  throw new EngineError('Unknown engine archive format: ' + format);
}

// macOS only: ad-hoc sign the server and its libraries so Gatekeeper lets a locally unpacked program run.
async function defaultSign(dir, serverPath) {
  const libs = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.dylib')) libs.push(f); } };
  walk(dir);
  for (const f of [...libs, serverPath]) await run('codesign', ['--force', '-s', '-', f]);
}

// ---- install ----------------------------------------------------------------------------------------------------

async function ensureEngine(o) {
  const assetId = engineAssetFor(o.hardware);
  const asset = assetId && o.catalog.engine.assets[assetId];
  if (!asset) throw new EngineError('Local AI is not available on this computer.');
  const root = path.join(o.dataDir, 'engine', o.catalog.engine.tag);
  const dir = path.join(root, assetId);
  const serverPath = path.join(dir, asset.serverPath);
  const marker = path.join(dir, 'installed.json');
  if (fs.existsSync(marker) && fs.existsSync(serverPath)) return { serverPath, assetId };

  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const archive = path.join(root, asset.file);
  await (o.download || downloadVerified)({ url: asset.url, destPath: archive, sha256: asset.sha256, sizeBytes: asset.sizeBytes, onProgress: o.onProgress, signal: o.signal });
  const tmp = dir + '.tmp';
  await fs.promises.rm(tmp, { recursive: true, force: true });
  try {
    await (o.extract || extractArchive)(archive, tmp, asset.format);
    await fs.promises.rename(tmp, dir);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }); await fs.promises.rm(archive, { force: true });
  }
  if (!fs.existsSync(serverPath)) throw new EngineError('The engine download did not contain the expected program.');
  await fs.promises.chmod(serverPath, 0o755);
  if (o.hardware.platform === 'darwin') await (o.sign || defaultSign)(dir, serverPath);
  await fs.promises.writeFile(marker, JSON.stringify({ tag: o.catalog.engine.tag, assetId, at: new Date().toISOString() }));
  return { serverPath, assetId };
}

// ---- running ----------------------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The CPU builds and Intel Macs keep every layer on the processor; Vulkan and Apple builds let the engine choose.
function gpuLayersFor(hw) {
  const asset = engineAssetFor(hw);
  return asset === 'win-x64-cpu' || asset === 'mac-x64' ? 0 : 'auto';
}

// ---- an engine left behind by a crashed or killed app ----------------------------------------------------------------
// The running engine's process id and program name are written to a small file. If the app is killed, the next run
// finds the file and ends the leftover engine, but only if that process id still belongs to a program with the same name
// (ids get reused by other programs).
function defaultProbe(pid) {
  return new Promise(resolve => {
    const done = out => resolve(out ? path.basename(String(out).trim()) : null);
    try {
      if (process.platform === 'win32') {
        cp.execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (e, so) => {
          const m = !e && /^"([^"]+)","(\d+)"/m.exec(String(so)); done(m && Number(m[2]) === pid ? m[1] : null);
        });
      } else if (process.platform === 'linux') {
        fs.readlink('/proc/' + pid + '/exe', (e, l) => done(e ? null : l.replace(/ \(deleted\)$/, '')));
      } else {
        cp.execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 8000 }, (e, so) => done(e ? null : so));
      }
    } catch (e) { resolve(null); }
  });
}
function defaultKill(pid) {
  try {
    if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch (e) { /* already gone */ }
}
async function reapStale(o = {}) {
  const file = o.pidFile; if (!file) return;
  let rec = null;
  try { rec = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (e) { rec = null; }
  try { await fs.promises.rm(file, { force: true }); } catch (e) { /* ignore */ }
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1 || rec.pid === process.pid || typeof rec.exe !== 'string' || !rec.exe) return;
  let name = null;
  try { name = await (o.probe || defaultProbe)(rec.pid); } catch (e) { name = null; }
  if (name && String(name).toLowerCase() === rec.exe.toLowerCase()) { try { (o.kill || defaultKill)(rec.pid); } catch (e) { /* ignore */ } }
}

function createEngine(deps = {}) {
  const spawn = deps.spawn || cp.spawn;
  const fetchImpl = deps.fetchImpl || fetch;
  const pickPort = deps.pickPort || freePort;
  const pollMs = deps.pollMs || 500;
  const healthTimeoutMs = deps.healthTimeoutMs || 5 * 60 * 1000;
  let child = null, stopping = false, reaped = false;
  const pidFile = deps.pidFile || null;
  const reap = () => reapStale({ pidFile, probe: deps.probe, kill: deps.kill });
  const forgetPid = () => { if (pidFile) { try { fs.rmSync(pidFile, { force: true }); } catch (e) { /* ignore */ } } }; // synchronous: a late delete must never remove a newer engine's file
  const exitCbs = [];

  async function startOnce(o, port, token) {
    const b = budgetFor(o.level, o.hardware);
    const args = buildServerArgs({ modelPath: o.modelPath, ctx: b.ctx, threads: b.threads, gpuLayers: gpuLayersFor(o.hardware), port, token });
    const proc = spawn(o.serverPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(o.serverPath) });
    let tail = '', exited = null;
    const grab = d => { tail = (tail + d).slice(-4000); };
    proc.stdout && proc.stdout.on('data', grab); proc.stderr && proc.stderr.on('data', grab);
    proc.on('error', e => { exited = { code: null }; tail += String(e.message); });
    proc.on('exit', code => {
      exited = { code };
      if (child === proc) { child = null; forgetPid(); if (!stopping) exitCbs.forEach(cb => { try { cb(code); } catch (e) { /* ignore */ } }); }
    });
    child = proc; stopping = false;
    if (pidFile && proc.pid) { try { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, JSON.stringify({ pid: proc.pid, exe: path.basename(o.serverPath) })); } catch (e) { /* the file only helps cleanup */ } }
    const deadline = Date.now() + healthTimeoutMs;
    for (;;) {
      await sleep(Math.min(pollMs, 200)); // give a server that cannot bind its port time to exit before asking /health
      if (exited) { if (child === proc) child = null; throw Object.assign(new EngineError('The AI engine stopped while starting. ' + tail.trim().split('\n').slice(-3).join(' ')), { bind: /bind|address already in use|EADDRINUSE/i.test(tail) }); }
      try {
        const r = await fetchImpl('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
        if (r.status === 200 && !exited) return;
      } catch (e) { /* not up yet */ }
      if (Date.now() > deadline) { await stop(); throw new EngineError('The AI engine did not become ready in time. Try a smaller model or a lower power level.'); }
    }
  }

  async function start(o) {
    if (!reaped) { reaped = true; await reap(); }
    if (child) await stop();
    const token = crypto.randomBytes(24).toString('hex');
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await pickPort();
      try { await startOnce(o, port, token); return { port, token }; }
      catch (e) { last = e; if (!e.bind) throw e; }
    }
    throw last;
  }

  async function stop() {
    const proc = child;
    if (!proc) { await reap(); return; }
    stopping = true; child = null; forgetPid();
    await new Promise(resolve => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      proc.once('exit', fin);
      try { proc.kill(); } catch (e) { fin(); }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } setTimeout(fin, 500); }, 3000).unref();
      if (proc.exitCode !== null || proc.killed && proc.signalCode) fin();
    });
  }

  return { start, stop, running: () => !!child, onExit: cb => { exitCbs.push(cb); } };
}

module.exports = { buildServerArgs, ensureEngine, createEngine, reapStale, extractArchive, EngineError, freePort };
