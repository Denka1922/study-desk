'use strict';
// Unpacks .tar.gz / .tar.bz2 with the tar program every supported system has (Windows 10+ ships bsdtar as tar.exe).
// The list of names is checked first, so an archive can never write outside its target folder.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

class VoiceError extends Error { constructor(m, kind) { super(m); this.name = 'VoiceError'; this.kind = kind || 'engine'; } }

function tarProgram(platform = process.platform, env = process.env) {
  return platform === 'win32' ? path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(String(stdout));
    });
  });
}

function unsafeName(raw) {
  const n = String(raw).replace(/\\/g, '/');
  return !n || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..');
}

async function extractTarball(archive, destDir, o = {}) {
  const exec = o.run || run, tar = o.tar || tarProgram();
  let listing;
  try { listing = await exec(tar, ['-tf', archive]); }
  catch (e) { throw new VoiceError('The voice download could not be opened. Try again, or remove it and download it again.'); }
  const names = listing.split(/\r?\n/).filter(Boolean);
  if (!names.length) throw new VoiceError('The voice download was empty.');
  if (names.some(unsafeName)) throw new VoiceError('The voice download contains an unsafe file name, so it was not installed.');
  await fs.promises.mkdir(destDir, { recursive: true });
  try { await exec(tar, ['-xf', archive, '-C', destDir]); }
  catch (e) { throw new VoiceError('The voice download could not be unpacked. Check the free disk space and try again.', 'disk'); }
}

module.exports = { extractTarball, tarProgram, run, unsafeName, VoiceError };
