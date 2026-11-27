'use strict';
// Starts the voice worker (a separate process), keeps one voice model loaded, and makes audio files one request at a time.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { VoiceError } = require('./extract');

const START_TIMEOUT_MS = 120000;
const SPEAK_TIMEOUT_MS = 120000;
const IDLE_MS = 5 * 60 * 1000;

function createHost(o) {
  const forkImpl = o.fork || fork;
  // The same host runs the speech listener: it only differs in the request it sends, how messages are packed (the recording is
  // a typed array) and the words used in errors.
  const N = o.noun || 'voice', requestType = o.requestType || 'speak';
  const failedMsg = o.failed || 'The voice could not read this text.', slowMsg = o.slow || 'The voice took too long. Try a shorter text or a lighter voice.';
  const execPath = o.execPath || process.execPath;
  const workerPath = o.workerPath || path.join(__dirname, 'worker.js');
  const setTimer = o.setTimeout || setTimeout, clearTimer = o.clearTimeout || clearTimeout;
  let child = null, loaded = '', starting = null, nextId = 1, idle = null, queue = Promise.resolve(), gen = 0, startCtl = null;
  const waiting = new Map();

  function failAll(message, kind) { for (const [, w] of waiting) { clearTimer(w.timer); w.reject(new VoiceError(message, kind)); } waiting.clear(); }

  function kill() {
    const c = child; child = null; loaded = ''; starting = null; gen++;
    if (idle) { clearTimer(idle); idle = null; }
    if (startCtl) { const s = startCtl; startCtl = null; clearTimer(s.timer); s.reject(new VoiceError(`The ${N} was stopped.`, 'cancelled')); }
    if (c) { try { c.removeAllListeners(); c.kill(); } catch (e) { /* already gone */ } }
    failAll(`The ${N} was stopped.`, 'cancelled');
  }

  function spawnFor(spec) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (process.platform !== 'win32') { const k = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'; env[k] = spec.platformDir + (env[k] ? path.delimiter + env[k] : ''); }
    const forkOpts = { execPath, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true };
    if (o.serialization) forkOpts.serialization = o.serialization;
    const c = forkImpl(workerPath, [], forkOpts);
    child = c;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => { if (startCtl === ctl) startCtl = null; kill(); reject(new VoiceError(`The ${N} took too long to start. Try again.`)); }, START_TIMEOUT_MS);
      const ctl = { timer, reject };
      startCtl = ctl;
      const settle = () => { clearTimer(timer); if (startCtl === ctl) startCtl = null; };
      c.on('message', m => {
        if (m.type === 'hello') { try { c.send({ type: 'init', wrapperDir: spec.wrapperDir, kind: spec.kind, packDir: spec.packDir, threads: spec.threads, ...(spec.init || {}) }); } catch (e) { settle(); if (child === c) kill(); reject(new VoiceError(`The ${N} engine could not start.`)); } }
        else if (m.type === 'ready') { settle(); loaded = spec.key; resolve(); }
        else if (m.type === 'error' && m.id == null) { settle(); if (child === c) kill(); reject(new VoiceError(m.message || `The ${N} engine could not start.`)); }
        else if (m.type === 'done' || m.type === 'error') {
          const w = waiting.get(m.id); if (!w) return;
          waiting.delete(m.id); clearTimer(w.timer);
          if (m.type === 'done') w.resolve(m); else w.reject(new VoiceError(m.message || failedMsg));
        }
      });
      c.on('error', () => { settle(); if (child === c) kill(); reject(new VoiceError(`The ${N} engine could not start.`)); });
      c.on('exit', () => { settle(); if (child === c) { child = null; loaded = ''; starting = null; failAll(`The ${N} engine stopped.`); } reject(new VoiceError(`The ${N} engine stopped while starting.`)); });
    });
  }

  async function ensure(spec) {
    if (child && loaded === spec.key) return;
    if (child) kill();
    starting = spawnFor(spec);
    await starting;
  }

  function touch() { if (idle) clearTimer(idle); idle = setTimer(kill, IDLE_MS); if (idle && idle.unref) idle.unref(); }

  // spec: { key, wrapperDir, platformDir, kind, packDir, threads }; req: { text, sid, speed, lang, out }
  function speak(spec, req) {
    const mine = gen; // a stop() after this request was queued cancels it
    const run = async () => {
      if (mine !== gen) throw new VoiceError(`The ${N} was stopped.`, 'cancelled');
      if (idle) { clearTimer(idle); idle = null; } // never kill the worker in the middle of a request
      await ensure(spec);
      const id = nextId++;
      const c = child;
      const done = new Promise((resolve, reject) => {
        const timer = setTimer(() => { kill(); reject(new VoiceError(slowMsg)); }, SPEAK_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
      });
      try { c.send({ ...req, type: requestType, id }); }
      catch (e) { const w = waiting.get(id); if (w) { clearTimer(w.timer); waiting.delete(id); } if (child === c) kill(); throw new VoiceError(`The ${N} engine stopped.`); }
      try { return await done; } finally { if (child) touch(); }
    };
    const p = queue.then(run, run);
    queue = p.then(() => undefined, () => undefined);
    return p;
  }

  return { speak, stop: kill, running: () => !!child, loaded: () => loaded };
}

module.exports = { createHost };
