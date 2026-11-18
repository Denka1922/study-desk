'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function walk(dir, skip = []) {
  const out = [];
  const base = path.resolve(dir);
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (skip.some(s => rel === s || rel.startsWith(s + '/') || e.name === s)) continue;
      if (e.isDirectory()) rec(full); else if (e.isFile()) out.push(full);
    }
  })(base);
  return out;
}
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { return require('/opt/npm-tools/node_modules/playwright'); }
}
// The shipped page keeps its code inside one function, so tests cannot reach it. This copies app/index.html to a
// temp file with a few of its inner names copied onto window (only in that copy, never in the shipped file).
function pageWithExports(names, extra = '') {
  const os = require('node:os');
  const html = read('app/index.html');
  const end = html.lastIndexOf('})();\n</script>');
  if (end < 0) throw new Error('app/index.html: end of the main script not found');
  const lines = names.map(n => "try{if(typeof " + n + "!=='undefined')window." + n + "=" + n + ";}catch(e){}").join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-page-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html.slice(0, end) + extra + '\n' + lines + '\n' + html.slice(end));
  return { file, url: require('node:url').pathToFileURL(file).href, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { ROOT, read, walk, loadPlaywright, pageWithExports };
