'use strict';
// Runs the REAL voice engine and models, only when they are on this computer (otherwise skipped, so CI stays offline).
//   SD_VOICE_REAL_DIR=<folder with npm/node_modules/sherpa-onnx-node, npm/node_modules/sherpa-onnx-<platform>, m/<model folders>>
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../../desktop/voice/host');

const DIR = process.env.SD_VOICE_REAL_DIR;
const have = !!DIR && fs.existsSync(path.join(DIR, 'npm', 'node_modules', 'sherpa-onnx-node'));
const plat = 'sherpa-onnx-' + (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch;
const spec = (key, kind, model) => ({ key, kind, wrapperDir: path.join(DIR, 'npm', 'node_modules', 'sherpa-onnx-node'), platformDir: path.join(DIR, 'npm', 'node_modules', plat), packDir: path.join(DIR, 'm', model), threads: 2 });
function wavInfo(f) { const b = fs.readFileSync(f); return { riff: b.toString('latin1', 0, 4), rate: b.readUInt32LE(24), seconds: (b.length - 44) / (b.readUInt32LE(28)) }; }

test('Kokoro says an English sentence', { skip: !have && 'real voice files not on this computer', timeout: 180000 }, async () => {
  const h = createHost({}), out = path.join(os.tmpdir(), 'sd-real-kokoro.wav');
  try {
    await h.speak(spec('kokoro-en', 'kokoro', 'kokoro-int8-multi-lang-v1_0'), { text: 'Can you explain photosynthesis in your own words?', sid: 3, speed: 1, lang: 'en', out });
    const w = wavInfo(out); assert.strictEqual(w.riff, 'RIFF'); assert.strictEqual(w.rate, 24000); assert.ok(w.seconds > 1.5 && w.seconds < 8, 'about the length of the sentence: ' + w.seconds);
  } finally { h.stop(); }
});

test('Supertonic says Turkish with its special letters, and a different speed makes a different length', { skip: !have && 'real voice files not on this computer', timeout: 180000 }, async () => {
  const h = createHost({}), a = path.join(os.tmpdir(), 'sd-real-tr1.wav'), b = path.join(os.tmpdir(), 'sd-real-tr2.wav');
  const text = 'Fotosentezi kendi cümlelerinle anlatabilir misin? Işık, su ve karbondioksit nasıl bir araya gelir?';
  try {
    const s = spec('supertonic-3', 'supertonic', 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11');
    await h.speak(s, { text, sid: 0, speed: 1, lang: 'tr', out: a }); await h.speak(s, { text, sid: 0, speed: 1.4, lang: 'tr', out: b });
    const x = wavInfo(a), y = wavInfo(b); assert.strictEqual(x.rate, 44100); assert.ok(x.seconds > 4, 'a full Turkish sentence: ' + x.seconds); assert.ok(y.seconds < x.seconds * 0.9, 'faster speed is shorter: ' + y.seconds + ' vs ' + x.seconds);
  } finally { h.stop(); }
});
