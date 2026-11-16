'use strict';
// Pure rules for the Windows shell. No Electron here so they can be unit tested.
const nodePath = require('node:path');

const MAX_URL = 2048;

function parse(u) {
  try { return new URL(u); } catch (e) { return null; }
}

// 'allow'    -> the app's own page (hash and query may change)
// 'external' -> an https link to open in the user's browser
// 'deny'     -> anything else
function linkAction(url, appFileUrl) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) return 'deny';
  const u = parse(url);
  if (!u) return 'deny';
  if (u.protocol === 'file:') {
    const app = parse(appFileUrl);
    return app && app.protocol === 'file:' && u.host === app.host && u.pathname === app.pathname ? 'allow' : 'deny';
  }
  if (u.protocol === 'https:') {
    if (u.username || u.password || !u.hostname) return 'deny';
    return 'external';
  }
  return 'deny';
}

// Where the page lives: next to the program's resources when installed, in ../app while developing.
function resolveAppFile({ isPackaged, resourcesPath, baseDir }, pathMod = nodePath) {
  return isPackaged
    ? pathMod.join(resourcesPath, 'app', 'index.html')
    : pathMod.join(baseDir, '..', 'app', 'index.html');
}

module.exports = { linkAction, resolveAppFile, MAX_URL };
