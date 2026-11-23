'use strict';
// Installs the voice engine (small, per platform) and the voice packs (models) into the app's data folder.
// Everything is downloaded from a pinned address and checked against a pinned SHA-256 before it is unpacked.
const fs = require('node:fs');
const path = require('node:path');
const { downloadVerified } = require('../ai/download');
const { hostAllowed, platformKey } = require('./catalog');
const { extractTarball, run, VoiceError } = require('./extract');

async function fetchAndUnpack(o, asset, finalDir, innerDir, label) {
  const root = path.dirname(finalDir);
  await fs.promises.mkdir(root, { recursive: true });
  const archive = path.join(root, asset.file);
  await (o.download || downloadVerified)({ url: asset.url, destPath: archive, sha256: asset.sha256, sizeBytes: asset.sizeBytes, onProgress: o.onProgress, signal: o.signal, hostAllowed });
  const tmp = finalDir + '.tmp';
  await fs.promises.rm(tmp, { recursive: true, force: true });
  try {
    await (o.extract || extractTarball)(archive, tmp);
    const from = path.join(tmp, innerDir);
    if (!fs.existsSync(from)) throw new VoiceError('The ' + label + ' download did not contain the expected files.');
    await fs.promises.rm(finalDir, { recursive: true, force: true });
    await fs.promises.rename(from, finalDir);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.rm(archive, { force: true });
  }
}

// macOS only: ad-hoc sign the downloaded native files so the system lets them load.
async function defaultSign(dir) {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(dylib|node)$/.test(e.name)) files.push(f); } };
  walk(dir);
  for (const f of files) await run('codesign', ['--force', '-s', '-', f]);
}

function enginePaths(dataDir, catalog, hardware) {
  const key = platformKey(hardware.platform, hardware.arch);
  if (!key) return null;
  const root = path.join(dataDir, 'voice', 'engine', catalog.engine.version);
  const nodeModules = path.join(root, 'node_modules');
  return { key, root, nodeModules, wrapperDir: path.join(nodeModules, 'sherpa-onnx-node'), platformDir: path.join(nodeModules, 'sherpa-onnx-' + key), marker: path.join(root, 'installed.json') };
}

function engineInstalled(dataDir, catalog, hardware) {
  const p = enginePaths(dataDir, catalog, hardware);
  return !!p && fs.existsSync(p.marker) && fs.existsSync(path.join(p.platformDir, 'sherpa-onnx.node'));
}

async function ensureEngine(o) {
  const p = enginePaths(o.dataDir, o.catalog, o.hardware);
  if (!p) throw new VoiceError('Offline voices are not available on this computer. The built-in computer voice still works.');
  if (engineInstalled(o.dataDir, o.catalog, o.hardware)) return p;
  await fs.promises.rm(p.root, { recursive: true, force: true });
  const e = o.catalog.engine;
  // progress for the two small files is shared: wrapper = first 10 %, platform build = the rest
  const part = (from, span) => o.onProgress && ((d, t) => o.onProgress(from + (t > 0 ? d / t : 0) * span, 1));
  await fetchAndUnpack({ ...o, onProgress: part(0, 0.1) }, e.wrapper, p.wrapperDir, 'package', 'voice engine');
  await fetchAndUnpack({ ...o, onProgress: part(0.1, 0.9) }, e.platforms[p.key], p.platformDir, 'package', 'voice engine');
  if (!fs.existsSync(path.join(p.platformDir, 'sherpa-onnx.node'))) throw new VoiceError('The voice engine download did not contain the expected program.');
  if (o.hardware.platform === 'darwin') await (o.sign || defaultSign)(p.platformDir);
  await fs.promises.writeFile(p.marker, JSON.stringify({ version: e.version, key: p.key, at: new Date().toISOString() }));
  return p;
}

function packDir(dataDir, pack) { return path.join(dataDir, 'voice', 'packs', pack.id); }
function packInstalled(dataDir, pack) { return fs.existsSync(path.join(packDir(dataDir, pack), 'installed.json')); }

async function ensurePack(o) {
  const dir = packDir(o.dataDir, o.pack);
  if (packInstalled(o.dataDir, o.pack)) return dir;
  await fetchAndUnpack(o, o.pack, dir, o.pack.dir, 'voice');
  await fs.promises.writeFile(path.join(dir, 'installed.json'), JSON.stringify({ id: o.pack.id, at: new Date().toISOString() }));
  return dir;
}

module.exports = { ensureEngine, ensurePack, engineInstalled, packInstalled, packDir, enginePaths, defaultSign };
