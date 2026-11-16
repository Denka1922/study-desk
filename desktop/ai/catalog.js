'use strict';
// Catalog of the engine build and the AI models Study Desk may download, plus the download host allowlist.
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_SUFFIXES = ['github.com', 'githubusercontent.com', 'huggingface.co', 'hf.co'];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /\/resolve\/[0-9a-f]{40}\//;
const ASSET_IDS = ['win-x64-cpu', 'win-x64-vulkan', 'mac-arm64', 'mac-x64'];

// https only, no credentials, host equals or is a subdomain of an allowlisted host.
function hostAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some(s => h === s || h.endsWith('.' + s));
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
}

// Returns a list of problems; [] means valid.
function validateCatalog(c) {
  const bad = [];
  if (!c || c.schema !== 1) bad.push('schema must be 1');
  const assets = (c && c.engine && c.engine.assets) || {};
  for (const id of ASSET_IDS) {
    const a = assets[id];
    if (!a) { bad.push('engine asset missing: ' + id); continue; }
    if (!HEX64.test(a.sha256 || '')) bad.push('engine ' + id + ': sha256 must be 64 hex characters');
    if (!(a.sizeBytes > 0)) bad.push('engine ' + id + ': sizeBytes');
    if (!hostAllowed(a.url) || !String(a.url).endsWith(a.file)) bad.push('engine ' + id + ': url must be an allowed host and end with the file name');
  }
  const seen = new Set();
  for (const m of (c && c.models) || []) {
    if (seen.has(m.id)) bad.push('duplicate model id: ' + m.id);
    seen.add(m.id);
    if (!m.license || !m.license.name) bad.push(m.id + ': license missing');
    if (!m.languages || !Array.isArray(m.languages.strong) || m.languages.strong.length === 0) bad.push(m.id + ': languages.strong missing');
    if (m.listOnly) {
      // shown to the student as "too big for this PC"; nothing about it can be downloaded
      if (m.enabled || m.url || m.file || m.sha256) bad.push(m.id + ': a list-only model must not be enabled or have a download');
      if (typeof m.needs !== 'string' || m.needs.length < 10) bad.push(m.id + ': a list-only model needs a "needs" sentence');
      continue;
    }
    if (!hostAllowed(m.url) || !String(m.url).endsWith(m.file)) bad.push(m.id + ': url must be an allowed host and end with the file name');
    if (m.enabled) {
      if (!HEX64.test(m.sha256 || '')) bad.push(m.id + ': enabled model needs a 64-hex sha256');
      if (!(m.sizeBytes > 0)) bad.push(m.id + ': enabled model needs sizeBytes');
      if (!HEX40.test(m.url || '')) bad.push(m.id + ': enabled model url must pin a 40-hex revision');
    }
  }
  return bad;
}

module.exports = { hostAllowed, loadCatalog, validateCatalog, ASSET_IDS };
