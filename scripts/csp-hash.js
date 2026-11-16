'use strict';
// CSP hashes for the download page's one inline script and one inline style.
// Browsers hash the text after turning CRLF/CR into LF, so we do the same here.
const crypto = require('node:crypto');

const norm = s => s.replace(/\r\n?/g, '\n');
const hashOf = s => 'sha256-' + crypto.createHash('sha256').update(norm(s), 'utf8').digest('base64');

function stampHtml(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!script || !style) throw new Error('site/index.html needs one inline <script> and one inline <style>');
  return html
    .replace(/(script-src\s+')sha256-[^']*(')/, `$1${hashOf(script[1])}$2`)
    .replace(/(style-src\s+')sha256-[^']*(')/, `$1${hashOf(style[1])}$2`);
}

module.exports = { hashOf, stampHtml, norm };
