'use strict';
// Runs in its own process (Electron's own Node, started with ELECTRON_RUN_AS_NODE). It loads the downloaded voice engine,
// keeps one voice model in memory, and turns a line of text into a WAV file. Talks to the app only through process messages.
const fs = require('node:fs');
const path = require('node:path');

function wavBytes(samples, rate) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2); }
  return buf;
}

function modelConfig(kind, dir) {
  const f = n => path.join(dir, n);
  if (kind === 'kokoro') {
    return { kokoro: { model: f('model.int8.onnx'), voices: f('voices.bin'), tokens: f('tokens.txt'), lexicon: [f('lexicon-us-en.txt'), f('lexicon-zh.txt')].join(',') } };
  }
  if (kind === 'supertonic') {
    return { supertonic: { durationPredictor: f('duration_predictor.int8.onnx'), textEncoder: f('text_encoder.int8.onnx'), vectorEstimator: f('vector_estimator.int8.onnx'), vocoder: f('vocoder.int8.onnx'), ttsJson: f('tts.json'), unicodeIndexer: f('unicode_indexer.bin'), voiceStyle: f('voice.bin') } };
  }
  throw new Error('unknown voice kind');
}

let tts = null, kind = '';
function init(m) {
  const sherpa = require(path.join(m.wrapperDir));
  tts = new sherpa.OfflineTts({ model: { ...modelConfig(m.kind, m.packDir), debug: false, numThreads: m.threads || 2, provider: 'cpu' }, maxNumSentences: 1 });
  kind = m.kind;
}

function speak(m) {
  const req = { text: m.text, sid: m.sid, speed: m.speed };
  if (kind === 'supertonic') req.generationConfig = { sid: m.sid, speed: m.speed, numSteps: 8, extra: { lang: m.lang || 'en' } };
  const t0 = Date.now(), audio = tts.generate(req);
  if (!audio || !audio.samples || !audio.samples.length) throw new Error('The voice made no sound for this text.');
  fs.writeFileSync(m.out, wavBytes(audio.samples, audio.sampleRate));
  return { ms: Date.now() - t0, seconds: audio.samples.length / audio.sampleRate };
}

if (require.main === module && process.send) {
  process.on('message', m => {
    try {
      if (m.type === 'init') { init(m); process.send({ type: 'ready' }); }
      else if (m.type === 'speak') process.send(Object.assign({ type: 'done', id: m.id }, speak(m)));
    } catch (e) { process.send({ type: 'error', id: m.id, message: String(e && e.message || e).slice(0, 300) }); }
  });
  process.send({ type: 'hello' });
}

module.exports = { wavBytes, modelConfig };
