'use strict';
// The voice service the page talks to (through ipc.js): which voices are installed, installing and removing them,
// and turning one line of text into a WAV. Two sources: downloaded voice packs, and VoiceStudio if it is running here.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { platformKey } = require('./catalog');
const { ensureEngine, ensurePack, engineInstalled, packInstalled, packDir, enginePaths } = require('./install');
const { keyFor } = require('./cache');
const { VoiceError } = require('./extract');

const MAX_TEXT = 1000;
const err = (message, kind) => Object.assign(new Error(message), { kind });

function createVoiceService(o) {
  const { dataDir, catalog, hardware, host, studio, cache } = o;
  const onProgress = o.onProgress || (() => {});
  let installing = null; const speakCtls = new Set(); let studioState = { found: false, voices: [] };

  const packOf = id => (catalog.packs || []).find(p => p.id === id);
  const available = () => !!platformKey(hardware.platform, hardware.arch);

  function packView(p) {
    return { id: p.id, title: p.title, blurb: p.blurb, languages: p.languages, license: p.license, sizeBytes: p.sizeBytes, installed: packInstalled(dataDir, p),
      voices: p.voices.map(v => ({ id: v.id, name: v.name, note: v.note })) };
  }

  async function refreshStudio() { studioState = await studio.detect(); return studioState; }

  async function status() {
    await refreshStudio();
    const e = catalog.engine;
    const key = platformKey(hardware.platform, hardware.arch);
    return {
      available: available(),
      engine: { installed: available() && engineInstalled(dataDir, catalog, hardware), sizeBytes: key ? e.wrapper.sizeBytes + e.platforms[key].sizeBytes : 0 },
      packs: (catalog.packs || []).map(packView),
      studio: studioState,
      installing: installing ? installing.packId : '',
    };
  }

  async function install({ packId }) {
    const pack = packOf(packId);
    if (!pack) throw err('That voice is not in the list.', 'bad');
    if (!available()) throw err('Offline voices are not available on this computer. The built-in computer voice still works.', 'engine');
    if (installing) throw err('A voice is already being installed. Wait for it to finish.', 'bad');
    const ctl = new AbortController();
    installing = { packId, ctl };
    const key = platformKey(hardware.platform, hardware.arch);
    const engBytes = engineInstalled(dataDir, catalog, hardware) ? 0 : catalog.engine.wrapper.sizeBytes + catalog.engine.platforms[key].sizeBytes;
    const total = engBytes + (packInstalled(dataDir, pack) ? 0 : pack.sizeBytes);
    const base = { dataDir, catalog, hardware, signal: ctl.signal, download: o.download, extract: o.extract, sign: o.sign };
    try {
      await ensureEngine({ ...base, onProgress: (d, t) => onProgress({ packId, done: Math.round(engBytes * (t > 0 ? d / t : 0)), total }) });
      await ensurePack({ ...base, pack, onProgress: (d) => onProgress({ packId, done: engBytes + d, total }) });
      onProgress({ packId, done: total, total });
      return { packs: (catalog.packs || []).map(packView) };
    } catch (e) {
      if (e && e.code) throw err(e.message, ({ cancelled: 'cancelled', checksum: 'checksum', disk: 'disk', network: 'network', host: 'bad' })[e.code] || 'network');
      throw e;
    } finally { installing = null; }
  }

  function cancelInstall() { if (installing) installing.ctl.abort(); return {}; }

  async function remove({ packId }) {
    const pack = packOf(packId);
    if (!pack) throw err('That voice is not in the list.', 'bad');
    if (host.loaded() === pack.id) host.stop();
    await fs.promises.rm(packDir(dataDir, pack), { recursive: true, force: true });
    return { packs: (catalog.packs || []).map(packView) };
  }

  async function removeAll() {
    host.stop();
    await fs.promises.rm(path.join(dataDir, 'voice'), { recursive: true, force: true });
    return { packs: (catalog.packs || []).map(packView) };
  }

  function clean(a) {
    const text = String(a.text == null ? '' : a.text).replace(/\s+/g, ' ').trim();
    if (!text) throw err('There is nothing to say.', 'bad');
    if (text.length > MAX_TEXT) throw err('That text is too long to say in one piece.', 'bad');
    const speed = Math.min(1.6, Math.max(0.6, Number(a.speed) || 1));
    return { text, speed: Math.round(speed * 100) / 100 };
  }

  async function speak(a) {
    const { text, speed } = clean(a);
    const ctl = new AbortController();
    speakCtls.add(ctl);
    try {
      if (a.source === 'studio') {
        const voice = String(a.voiceId || '');
        if (!studioState.found || !studioState.voices.some(v => v.id === voice)) throw err('VoiceStudio is not running or does not have that voice.', 'engine');
        const key = keyFor(['studio', voice, speed, text]);
        const hit = await cache.read(key);
        if (hit) return { wav: hit, cached: true };
        const wav = await studio.speak({ text, voice, speed, signal: ctl.signal });
        try { // whole or not at all; the voice still works when the cache cannot be written
          const f = cache.file(key);
          await fs.promises.mkdir(path.dirname(f), { recursive: true });
          await fs.promises.writeFile(f + '.part', wav);
          await fs.promises.rename(f + '.part', f);
        } catch (e) { await fs.promises.rm(cache.file(key) + '.part', { force: true }).catch(() => {}); }
        return { wav, cached: false };
      }
      const pack = packOf(a.packId);
      if (!pack) throw err('That voice is not in the list.', 'bad');
      const voice = pack.voices.find(v => v.id === a.voiceId);
      if (!voice) throw err('That voice is not in the list.', 'bad');
      const lang = String(a.lang || 'en').toLowerCase();
      if (!pack.languages.includes(lang)) throw err('This voice does not speak that language. Choose another voice.', 'bad');
      if (!available() || !engineInstalled(dataDir, catalog, hardware) || !packInstalled(dataDir, pack)) throw err('This voice is not installed yet.', 'engine');
      const key = keyFor([pack.id, voice.id, lang, speed, text]);
      const hit2 = await cache.read(key);
      if (hit2) return { wav: hit2, cached: true };
      const p = enginePaths(dataDir, catalog, hardware);
      const out = cache.file(key);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const part = out + '.part';
      const threads = Math.max(2, Math.min(4, Math.floor((os.cpus().length || 2) / 2)));
      const spec = { key: pack.id, wrapperDir: p.wrapperDir, platformDir: p.platformDir, kind: pack.kind, packDir: packDir(dataDir, pack), threads };
      const work = host.speak(spec, { text, sid: voice.sid, speed, lang, out: part });
      const abort = new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(err('The voice was stopped.', 'cancelled')), { once: true }));
      // the worker may still finish a stopped line a moment later, so the half file is removed when the worker is done with it
      const tidy = () => fs.promises.rm(part, { force: true }).catch(() => {});
      work.then(() => {}, () => {}).then(() => { if (ctl.signal.aborted) tidy(); });
      try { await Promise.race([work, abort]); }
      catch (e) { await tidy(); if (e instanceof VoiceError) throw err(e.message, e.kind); throw e; }
      await fs.promises.rename(part, out);
      cache.prune().catch(() => {});
      return { wav: await fs.promises.readFile(out), cached: false };
    } finally { speakCtls.delete(ctl); }
  }

  function cancelSpeak() { for (const c of [...speakCtls]) c.abort(); host.stop(); return {}; }

  function shutdown() { cancelInstall(); host.stop(); }

  return { status, refreshStudio, install, cancelInstall, remove, removeAll, speak, cancelSpeak, shutdown };
}

module.exports = { createVoiceService, MAX_TEXT };
