'use strict';
// Runs in its own process (Electron's own Node, started with ELECTRON_RUN_AS_NODE), like worker.js. It loads the downloaded
// engine, keeps one listening model in memory, finds the speech in a recording, and turns it into text. The recording never
// leaves the computer and is never written to disk.
const path = require('node:path');
const { RATE, recogConfig, vadConfig, prepareSegment } = require('./ears-config');

const CHUNK = 512;

// samples: mono 16 kHz Float32Array. Returns { text }. `sherpa` and `recognizer` are passed in so this can be tested with fakes.
function hearAll({ sherpa, recognizer, vadModel, samples, tune }) {
  const vad = new sherpa.Vad(vadConfig(vadModel), 30);
  // a second of quiet at the end, so the last words are always closed off as a finished piece of speech
  const x = new Float32Array(samples.length + RATE); x.set(samples);
  const segs = [];
  const drain = () => { while (!vad.isEmpty()) { const s = vad.front(false); vad.pop(); segs.push({ start: s.start, samples: s.samples }); } };
  for (let i = 0; i < x.length; i += CHUNK) { vad.acceptWaveform(x.subarray(i, Math.min(i + CHUNK, x.length))); drain(); }
  vad.flush(); drain();
  const parts = [];
  for (const seg of segs) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: RATE, samples: prepareSegment(samples, seg, tune) });
    recognizer.decode(stream);
    const t = String(recognizer.getResult(stream).text || '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  }
  return { text: parts.join(' ') };
}

let sherpa = null, recognizer = null, vadModel = '', tune = {};
function init(m) {
  sherpa = require(path.join(m.wrapperDir));
  recognizer = new sherpa.OfflineRecognizer(recogConfig(m.kind, m.packDir, m.threads));
  vadModel = m.vadModel; tune = m.tune || {};
}

function hear(m) {
  if (!(m.samples instanceof Float32Array) || !m.samples.length) throw new Error('There was no sound to listen to.');
  const t0 = Date.now();
  const { text } = hearAll({ sherpa, recognizer, vadModel, samples: m.samples, tune });
  return { text, ms: Date.now() - t0, seconds: m.samples.length / RATE };
}

if (require.main === module && process.send) {
  process.on('message', m => {
    try {
      if (m.type === 'init') { init(m); process.send({ type: 'ready' }); }
      else if (m.type === 'hear') process.send(Object.assign({ type: 'done', id: m.id }, hear(m)));
    } catch (e) { process.send({ type: 'error', id: m.id, message: String(e && e.message || e).slice(0, 300) }); }
  });
  process.send({ type: 'hello' });
}

module.exports = { hearAll };
