'use strict';
// Which permissions the app page may get. Only one: the microphone (audio, never the camera or the screen), and only for the
// app's own page in the app's own window. Everything else is refused, as before.

function plainUrl(u) { try { const x = new URL(String(u)); x.hash = ''; x.search = ''; return x.href; } catch (e) { return null; } }

// o.appFileUrl: the app page; o.isAppContents(webContents): true for the app window only;
// o.askMicrophone (Mac): asks the system for microphone access and answers true or false.
function createPermissionHandlers(o) {
  const appHref = plainUrl(o.appFileUrl);
  const fromApp = (wc, url, isMainFrame) => !!appHref && !!wc && !!o.isAppContents(wc) && isMainFrame === true && plainUrl(url) === appHref;

  function request(wc, permission, callback, details) {
    const d = details || {};
    const audioOnly = Array.isArray(d.mediaTypes) && d.mediaTypes.length === 1 && d.mediaTypes[0] === 'audio';
    if (permission !== 'media' || !audioOnly || !fromApp(wc, d.requestingUrl, d.isMainFrame)) { callback(false); return; }
    if (!o.askMicrophone) { callback(true); return; }
    Promise.resolve().then(o.askMicrophone).then(ok => callback(ok === true), () => callback(false));
  }

  function check(wc, permission, origin, details) {
    const d = details || {};
    return permission === 'media' && d.mediaType === 'audio' && fromApp(wc, d.requestingUrl, d.isMainFrame);
  }

  return { request, check };
}

module.exports = { createPermissionHandlers };
