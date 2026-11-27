'use strict';
// Settings for the speech listener: which files each kind of model needs, how the recogniser and the silence finder are set up,
// and how one stretch of speech is cut out of a recording. Pure functions, no engine needed, so they are easy to test.
const path = require('node:path');

const RATE = 16000;
const EAR_KINDS = ['nemo-ctc', 'moonshine', 'transducer'];
const REQUIRED = {
  'nemo-ctc': ['model.int8.onnx', 'tokens.txt'],
  moonshine: ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt'],
  transducer: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
};

// The full recogniser settings for a model folder.
function recogConfig(kind, dir, threads) {
  const f = n => path.join(dir, n);
  let model;
  if (kind === 'nemo-ctc') model = { nemoCtc: { model: f('model.int8.onnx') } };
  else if (kind === 'moonshine') model = { moonshine: { encoder: f('encoder_model.ort'), mergedDecoder: f('decoder_model_merged.ort') } }; // the newer layout only
  else if (kind === 'transducer') model = { transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') }, modelType: 'nemo_transducer' };
  else throw new Error('unknown listening model kind');
  return { featConfig: { sampleRate: RATE, featureDim: 80 }, modelConfig: { ...model, tokens: f('tokens.txt'), numThreads: threads || 2, provider: 'cpu', debug: false } };
}

// Finds speech and silence. A pause of half a second ends a sentence; one stretch is never longer than 20 seconds.
function vadConfig(model) {
  return { sileroVad: { model, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 }, sampleRate: RATE, numThreads: 1, debug: false };
}

// One stretch of speech, ready for the recogniser: optionally with a little of the recording on each side (the model writes
// capitals and full stops better when words are not cut off exactly), and optionally louder (one model needs that).
function prepareSegment(all, seg, tune) {
  const t = tune || {};
  let x = seg.samples;
  const pad = Math.round((t.context || 0) * RATE);
  if (pad > 0) x = all.subarray(Math.max(0, seg.start - pad), Math.min(all.length, seg.start + seg.samples.length + pad));
  if (t.gain && t.gain !== 1) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * t.gain; return y; }
  return pad > 0 ? Float32Array.from(x) : x;
}

module.exports = { RATE, EAR_KINDS, REQUIRED, recogConfig, vadConfig, prepareSegment };
