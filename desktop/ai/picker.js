'use strict';
// Chooses which downloadable model suits this computer, power level and tutor language.
const { LEVEL_ORDER, budgetFor, GIB } = require('./levels');
const { engineAssetFor } = require('./hardware');

const OVERHEAD_BYTES = 600e6; // engine buffers and the program around the model

function languageFit(model, language) {
  const l = String(language || 'English').toLowerCase();
  const has = a => (a || []).some(x => String(x).toLowerCase() === l);
  if (has(model.languages && model.languages.strong)) return 'strong';
  if (has(model.languages && model.languages.fair)) return 'fair';
  return 'weak';
}

// model file + memory for the conversation (kvBytesPerToken is a deliberately generous estimate) + overhead
function estimateNeedBytes(model, ctx) {
  return model.sizeBytes + model.kvBytesPerToken * ctx + OVERHEAD_BYTES;
}

const gb = n => (n / GIB).toFixed(1) + ' GB';
const fits = (m, hw, b) => m.enabled && hw.totalRamBytes >= m.minRamBytes && estimateNeedBytes(m, b.ctx) <= b.ramBytes;

function pick(models, hw, budget, language) {
  const ok = models.filter(m => fits(m, hw, budget));
  if (!ok.length) return null;
  const best = Math.max(...ok.map(m => m.tier));
  const byLang = (a, b) => (languageFit(b, language) === 'strong') - (languageFit(a, language) === 'strong') || a.sizeBytes - b.sizeBytes;
  const top = ok.filter(m => m.tier === best).sort(byLang)[0];
  if (languageFit(top, language) === 'strong') return top;
  const near = ok.filter(m => m.tier >= best - 1 && languageFit(m, language) === 'strong').sort((a, b) => b.tier - a.tier || a.sizeBytes - b.sizeBytes)[0];
  return near || top;
}

function recommend({ hardware, level, language, catalog }) {
  const engineAsset = engineAssetFor(hardware);
  if (!engineAsset) return { ok: false, suggest: 'api', reason: 'Local AI works on Windows and Mac computers only. Use your own API key instead.' };
  const budget = budgetFor(level, hardware);
  const models = catalog.models;
  const model = pick(models, hardware, budget, language);
  if (!model) {
    const idx = LEVEL_ORDER.indexOf(level);
    const raiseTo = LEVEL_ORDER.slice(idx + 1).find(l => pick(models, hardware, budgetFor(l, hardware), language));
    const reason = raiseTo
      ? 'The ' + level + ' power level leaves too little memory for an AI model on this computer. Choose ' + raiseTo + ' or a higher level, or use a command-line AI tool.'
      : 'This computer has too little free memory (' + gb(hardware.totalRamBytes) + ' in total) to run an AI model well. Use a command-line AI tool or your own API key instead.';
    const r = { ok: false, reason, suggest: 'cli' };
    if (raiseTo) r.raiseTo = raiseTo;
    return r;
  }
  const fit = languageFit(model, language);
  const reasons = ['Uses about ' + gb(estimateNeedBytes(model, budget.ctx)) + ' of your ' + gb(hardware.totalRamBytes) + ' memory at the ' + level + ' level.'];
  if (fit !== 'strong') {
    const lang = language || 'English';
    reasons.push(model.name + ' is ' + (fit === 'fair' ? 'only fair' : 'weak') + ' in ' + lang + ', so explanations may be less clear. Switch the tutor language to English or pick another model.');
  }
  const next = LEVEL_ORDER[LEVEL_ORDER.indexOf(level) + 1];
  let upgrade = null;
  if (next) {
    const nb = budgetFor(next, hardware);
    upgrade = models.filter(m => m.tier > model.tier && fits(m, hardware, nb)).sort((a, b) => a.tier - b.tier || a.sizeBytes - b.sizeBytes)[0] || null;
  }
  return { ok: true, model, engineAsset, budget, languageFit: fit, reasons, upgrade };
}

module.exports = { languageFit, estimateNeedBytes, recommend, OVERHEAD_BYTES };
