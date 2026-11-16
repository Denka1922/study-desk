#!/usr/bin/env node
'use strict';
// Maintainer tool, not shipped in the app. Run from GitHub Actions ("Verify AI catalog") or by hand.
//   node desktop/ai/tools/pin-catalog.js --verify   checks every catalog entry against the live source; exit 1 on any mismatch
//   node desktop/ai/tools/pin-catalog.js --fill     prints the sha256 / size / commit it found for models with sha256 null (does not edit the file)
const crypto = require('node:crypto');
const { loadCatalog, hostAllowed } = require('../catalog');

// Hugging Face answers a HEAD on /resolve/<rev>/<file> with the LFS sha256 (x-linked-etag), size and commit.
async function hfFacts(url) {
  if (!hostAllowed(url)) throw new Error('host not allowed: ' + url);
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  const h = n => r.headers.get(n);
  const sha = String(h('x-linked-etag') || '').replace(/"/g, '');
  return { sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null, sizeBytes: Number(h('x-linked-size')) || null, commit: h('x-repo-commit') || null, status: r.status };
}

async function sha256Of(url) {
  if (!hostAllowed(url)) throw new Error('host not allowed: ' + url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  const h = crypto.createHash('sha256'); let n = 0;
  for await (const chunk of r.body) { h.update(chunk); n += chunk.length; }
  return { sha256: h.digest('hex'), sizeBytes: n };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--verify' && mode !== '--fill') { console.error('usage: pin-catalog.js --verify | --fill'); process.exit(2); }
  const c = loadCatalog();
  let bad = 0;
  const say = (ok, msg) => { if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

  for (const m of c.models) {
    if (m.listOnly) { console.log('skip ' + m.id + ' (list-only: too big for normal PCs)'); continue; }
    if (mode === '--verify' && !m.enabled) { console.log('skip ' + m.id + ' (not enabled)'); continue; }
    try {
      const f = await hfFacts(m.url);
      if (mode === '--fill') { console.log(m.id + ': ' + JSON.stringify(f)); continue; }
      say(f.sha256 === m.sha256, m.id + ' sha256 ' + (f.sha256 || 'not found'));
      if (f.sizeBytes && m.sizeBytes) say(Math.abs(f.sizeBytes - m.sizeBytes) / f.sizeBytes < 0.02, m.id + ' size ' + f.sizeBytes + ' (catalog ' + m.sizeBytes + ')');
    } catch (e) { say(false, m.id + ': ' + e.message); }
  }

  if (mode === '--verify') {
    for (const [id, a] of Object.entries(c.engine.assets)) {
      try {
        const f = await sha256Of(a.url);
        say(f.sha256 === a.sha256 && f.sizeBytes === a.sizeBytes, 'engine ' + id + ' ' + f.sha256);
      } catch (e) { say(false, 'engine ' + id + ': ' + e.message); }
    }
  }
  if (mode === '--verify') { console.log(bad ? bad + ' problem(s)' : 'catalog verified'); process.exit(bad ? 1 : 0); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { hfFacts, sha256Of };
