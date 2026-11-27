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

// ---- speech input: the real listener (voice-activity detection + recogniser) on real English speech ----
//   also needs m/silero_vad.onnx and the listening model folders next to the voice models
const { createEarsHost } = require('../../desktop/voice/ears-host');
const EARS = { parakeet: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8', moonshine: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27' };
const haveEars = have && fs.existsSync(path.join(DIR, 'm', 'silero_vad.onnx')) && fs.existsSync(path.join(DIR, 'm', EARS.parakeet));
function pcm16k(file) { // 16-bit mono WAV at 16 kHz (the sample recordings that ship inside the models)
  const b = fs.readFileSync(file); assert.strictEqual(b.readUInt32LE(24), 16000); const n = (b.length - 44) >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768; return x;
}
const earsSpec = (key, kind, model) => ({ ...spec(key, kind, model), init: { vadModel: path.join(DIR, 'm', 'silero_vad.onnx'), tune: {} } });
const words = t => t.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);

test('the listener understands real English speech (Parakeet), and silence gives no words', { skip: !haveEars && 'real listening files not on this computer', timeout: 180000 }, async () => {
  const h = createEarsHost({}); const s = earsSpec('parakeet-en', 'nemo-ctc', EARS.parakeet);
  try {
    const dir = path.join(DIR, 'm', EARS.parakeet, 'test_wavs');
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.wav'))) {
      const x = pcm16k(path.join(dir, f)), r = await h.speak(s, { samples: x });
      assert.ok(words(r.text).length >= 3, f + ': ' + JSON.stringify(r.text)); console.log('# heard', f, JSON.stringify(r.text), r.ms + ' ms for ' + (x.length / 16000).toFixed(1) + ' s');
    }
    const quiet = await h.speak(s, { samples: new Float32Array(16000 * 3) });
    assert.strictEqual(quiet.text, '', 'three seconds of silence');
    // two sentences with a gap in the middle come back as one text, in order
    const a = pcm16k(path.join(dir, '0.wav')), b = pcm16k(path.join(dir, '1.wav')), gap = new Float32Array(16000);
    const both = new Float32Array(a.length + gap.length + b.length); both.set(a); both.set(gap, a.length); both.set(b, a.length + gap.length);
    const one = (await h.speak(s, { samples: a })).text, two = (await h.speak(s, { samples: b })).text, joined = (await h.speak(s, { samples: both })).text;
    assert.strictEqual(words(joined).join(' '), words(one + ' ' + two).join(' '));
  } finally { h.stop(); }
});

test('the small English listener (Moonshine) understands the same speech', { skip: !(haveEars && fs.existsSync(path.join(DIR, 'm', EARS.moonshine))) && 'real listening files not on this computer', timeout: 180000 }, async () => {
  const h = createEarsHost({}); const s = earsSpec('moonshine-en', 'moonshine', EARS.moonshine);
  try {
    const x = pcm16k(path.join(DIR, 'm', EARS.parakeet, 'test_wavs', '0.wav')), r = await h.speak(s, { samples: x });
    assert.ok(words(r.text).length >= 3, JSON.stringify(r.text)); console.log('# heard (moonshine)', JSON.stringify(r.text));
  } finally { h.stop(); }
});
