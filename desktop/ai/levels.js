'use strict';
// Power levels: how much memory, how many processor cores and how long a context the local AI may use.
const GIB = 1024 ** 3;
const LEVEL_ORDER = ['light', 'medium', 'high', 'xhigh', 'max'];
const LEVELS = {
  light:  { ram: 0.25, cores: 0.25, ctx: 4096 },
  medium: { ram: 0.40, cores: 0.50, ctx: 8192 },
  high:   { ram: 0.55, cores: 0.65, ctx: 12288 },
  xhigh:  { ram: 0.70, cores: 0.80, ctx: 16384 },
  max:    { ram: 0.85, cores: 1.00, ctx: 32768 },
};

// ramBytes is the most memory the AI may use: the level's share of total memory, and never more than
// what is free minus a reserve for Windows/macOS and the other programs (max of 2 GB and 15% of total).
// macOS reports cached memory as used, so on a Mac the free reading is ignored.
function budgetFor(level, hw) {
  const l = LEVELS[level];
  if (!l) throw new Error('Unknown power level: ' + level);
  let ram = hw.totalRamBytes * l.ram;
  if (hw.platform !== 'darwin') ram = Math.min(ram, hw.freeRamBytes - Math.max(2 * GIB, 0.15 * hw.totalRamBytes));
  return {
    ramBytes: Math.max(0, Math.floor(ram)),
    threads: Math.max(1, Math.floor(hw.cores * l.cores)),
    ctx: l.ctx,
    maxAnswerTokens: Math.min(4096, l.ctx / 4),
  };
}

module.exports = { LEVEL_ORDER, LEVELS, budgetFor, GIB };
