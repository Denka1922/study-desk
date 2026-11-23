'use strict';
// Remembers spoken lines on disk so a lesson read twice is not made twice. Small, and cleaned by age when it grows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 150 * 1024 * 1024;
const PART_MAX_AGE_MS = 10 * 60 * 1000;

function keyFor(parts) { return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40); }

function createCache(dir, o = {}) {
  const max = o.maxBytes || MAX_BYTES;
  const file = key => path.join(dir, key + '.wav');
  return {
    file,
    has: key => fs.existsSync(file(key)),
    // The sound for a key, or null when it is not there (for example pruned a moment ago). Reading counts as use, so it stays.
    async read(key) {
      try { const b = await fs.promises.readFile(file(key)); const now = new Date(); fs.promises.utimes(file(key), now, now).catch(() => {}); return b; }
      catch (e) { return null; }
    },
    async prune() {
      let names;
      try { names = await fs.promises.readdir(dir); } catch (e) { return; }
      const list = [];
      for (const n of names) {
        if (n.endsWith('.part')) { // an unfinished file nobody is writing any more
          try { const s = await fs.promises.stat(path.join(dir, n)); if (Date.now() - s.mtimeMs > PART_MAX_AGE_MS) await fs.promises.rm(path.join(dir, n), { force: true }); } catch (e) { /* gone */ }
          continue;
        }
        if (!n.endsWith('.wav')) continue;
        try { const s = await fs.promises.stat(path.join(dir, n)); list.push({ n, size: s.size, t: s.mtimeMs }); } catch (e) { /* gone */ }
      }
      let total = list.reduce((a, b) => a + b.size, 0);
      list.sort((a, b) => a.t - b.t);
      for (const f of list) { if (total <= max) break; await fs.promises.rm(path.join(dir, f.n), { force: true }); total -= f.size; }
    },
    async clear() { await fs.promises.rm(dir, { recursive: true, force: true }); },
  };
}

module.exports = { createCache, keyFor, MAX_BYTES };
