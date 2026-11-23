'use strict';
// Catalog of the voice engine and the voice packs Study Desk may download, plus the download host allowlist for voices.
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED = ['github.com', 'githubusercontent.com', 'huggingface.co', 'hf.co', 'registry.npmjs.org'];
const HEX64 = /^[0-9a-f]{64}$/;
const PLATFORMS = ['win-x64', 'darwin-arm64', 'darwin-x64'];
const KINDS = ['kokoro', 'supertonic'];
const ID_RE = /^[a-z0-9._-]{1,60}$/;

function hostAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED.some(s => h === s || h.endsWith('.' + s));
}

function loadVoiceCatalog() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8')); }

// 'win-x64' | 'darwin-arm64' | 'darwin-x64', or null when the engine has no build for this computer.
function platformKey(platform, arch) {
  const k = (platform === 'win32' ? 'win' : platform) + '-' + arch;
  return PLATFORMS.includes(k) ? k : null;
}

function checkAsset(bad, label, a) {
  if (!a) { bad.push(label + ': missing'); return; }
  if (!HEX64.test(a.sha256 || '')) bad.push(label + ': sha256 must be 64 hex characters');
  if (!(a.sizeBytes > 0)) bad.push(label + ': sizeBytes');
  if (!hostAllowed(a.url) || !String(a.url).endsWith('/' + a.file)) bad.push(label + ': url must be an allowed host and end with the file name');
  if (!/^[A-Za-z0-9._-]+$/.test(a.file || '')) bad.push(label + ': file name');
}

// Returns a list of problems; [] means valid.
function validateVoiceCatalog(c) {
  const bad = [];
  if (!c || c.schema !== 1) { bad.push('schema must be 1'); return bad; }
  const e = c.engine || {};
  if (!e.version || !e.license || !e.license.name) bad.push('engine: version and license');
  checkAsset(bad, 'engine wrapper', e.wrapper);
  for (const p of PLATFORMS) checkAsset(bad, 'engine ' + p, (e.platforms || {})[p]);
  const seen = new Set();
  for (const p of c.packs || []) {
    const L = 'pack ' + p.id;
    if (!ID_RE.test(p.id || '') || seen.has(p.id)) bad.push(L + ': id');
    seen.add(p.id);
    if (!KINDS.includes(p.kind)) bad.push(L + ': kind');
    if (!p.license || !p.license.name) bad.push(L + ': license missing');
    if (!Array.isArray(p.languages) || !p.languages.length) bad.push(L + ': languages');
    if (!/^[A-Za-z0-9._-]+$/.test(p.dir || '')) bad.push(L + ': dir');
    checkAsset(bad, L, p);
    if (!Array.isArray(p.voices) || !p.voices.length) bad.push(L + ': voices');
    const vs = new Set();
    for (const v of p.voices || []) {
      if (!ID_RE.test(v.id || '') || vs.has(v.id)) bad.push(L + ': voice id ' + v.id);
      vs.add(v.id);
      if (!Number.isInteger(v.sid) || v.sid < 0) bad.push(L + ': voice sid ' + v.id);
      if (!v.name) bad.push(L + ': voice name ' + v.id);
    }
  }
  return bad;
}

module.exports = { hostAllowed, loadVoiceCatalog, validateVoiceCatalog, platformKey, PLATFORMS, KINDS, ID_RE };
