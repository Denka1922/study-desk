'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadVerified, DownloadError } = require('../../desktop/ai/download');

const BODY = crypto.randomBytes(300000);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');
const localOnly = u => new URL(u).hostname === '127.0.0.1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-dl-'));

// a small server: /file (supports Range), /redir -> /file, /slow (sends half, then stalls), /404, /reset, /norange (ignores Range)
function server() {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range });
    if (req.url === '/redir') { res.writeHead(302, { location: '/file' }); return res.end(); }
    if (req.url === '/404') { res.writeHead(404); return res.end('no'); }
    if (req.url === '/reset') return req.socket.destroy();
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-length': BODY.length });
      res.write(BODY.subarray(0, 100000));
      return; // never finishes
    }
    if (req.url === '/norange') { res.writeHead(200, { 'content-length': BODY.length }); return res.end(BODY); }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) start = Number(m[1]);
    if (start > 0) {
      res.writeHead(206, { 'content-length': BODY.length - start, 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
      return res.end(BODY.subarray(start));
    }
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, seen, base: `http://127.0.0.1:${s.address().port}` })));
}
const opts = (base, p, dir, extra = {}) => Object.assign({ url: base + p, destPath: path.join(dir, 'm.gguf'), sha256: SHA, sizeBytes: BODY.length, hostAllowed: localOnly, freeBytes: async () => 1e12 }, extra);
async function code(p) { try { await p; } catch (e) { assert.ok(e instanceof DownloadError, 'DownloadError, got ' + e); assert.ok(e.message.length > 10); return e.code; } assert.fail('should have rejected'); }

test('downloads, verifies the checksum and renames the .part file; progress reaches the size', async () => {
  const { s, base } = await server(); const dir = tmp(); const marks = [];
  const r = await downloadVerified(opts(base, '/file', dir, { onProgress: (d, t) => marks.push([d, t]) }));
  s.close();
  assert.strictEqual(r.path, path.join(dir, 'm.gguf'));
  assert.ok(fs.readFileSync(r.path).equals(BODY)); assert.ok(!fs.existsSync(r.path + '.part'));
  assert.deepStrictEqual(marks[marks.length - 1], [BODY.length, BODY.length]);
});

test('resumes from an existing .part with a Range request', async () => {
  const { s, base, seen } = await server(); const dir = tmp();
  fs.writeFileSync(path.join(dir, 'm.gguf.part'), BODY.subarray(0, 120000));
  await downloadVerified(opts(base, '/file', dir));
  s.close();
  assert.strictEqual(seen[0].range, 'bytes=120000-');
  assert.ok(fs.readFileSync(path.join(dir, 'm.gguf')).equals(BODY));
});

test('a server that ignores Range restarts the file from the beginning', async () => {
  const { s, base } = await server(); const dir = tmp();
  fs.writeFileSync(path.join(dir, 'm.gguf.part'), BODY.subarray(0, 50000));
  await downloadVerified(opts(base, '/norange', dir));
  s.close();
  assert.ok(fs.readFileSync(path.join(dir, 'm.gguf')).equals(BODY));
});

test('a wrong checksum deletes everything and leaves nothing that could be run', async () => {
  const { s, base } = await server(); const dir = tmp();
  assert.strictEqual(await code(downloadVerified(opts(base, '/file', dir, { sha256: '0'.repeat(64) }))), 'checksum');
  s.close();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a redirect to another allowed address works', async () => {
  const { s, base } = await server(); const dir = tmp();
  await downloadVerified(opts(base, '/redir', dir));
  s.close();
  assert.ok(fs.readFileSync(path.join(dir, 'm.gguf')).equals(BODY));
});

test('a redirect to a host that is not allowed is refused (real allowlist)', async () => {
  const dir = tmp(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }); };
  const o = { url: 'https://huggingface.co/a/b', destPath: path.join(dir, 'm.gguf'), sha256: SHA, sizeBytes: 1000, fetchImpl, freeBytes: async () => 1e12 };
  assert.strictEqual(await code(downloadVerified(o)), 'host');
  assert.strictEqual(calls, 1, 'the evil host is never contacted');
});

test('a redirect to an allowed CDN host is followed (real allowlist)', async () => {
  const dir = tmp(); const urls = [];
  const fetchImpl = async (u) => {
    urls.push(String(u));
    if (urls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/blob' } });
    return new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } });
  };
  await downloadVerified({ url: 'https://huggingface.co/a/b', destPath: path.join(dir, 'm.gguf'), sha256: SHA, sizeBytes: BODY.length, fetchImpl, freeBytes: async () => 1e12 });
  assert.deepStrictEqual(urls, ['https://huggingface.co/a/b', 'https://cdn-lfs.hf.co/blob']);
});

test('more than 5 redirects is refused', async () => {
  const dir = tmp(); let n = 0;
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://huggingface.co/loop' + (++n) } });
  assert.strictEqual(await code(downloadVerified({ url: 'https://huggingface.co/a', destPath: path.join(dir, 'm'), sha256: SHA, sizeBytes: 1, fetchImpl, freeBytes: async () => 1e12 })), 'host');
});

test('too little free disk space stops before any request', async () => {
  const dir = tmp(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('x'); };
  const o = { url: 'https://huggingface.co/a', destPath: path.join(dir, 'm'), sha256: SHA, sizeBytes: 1000, fetchImpl, freeBytes: async () => 1050 };
  assert.strictEqual(await code(downloadVerified(o)), 'disk');
  assert.strictEqual(calls, 0);
});

test('cancelling keeps the .part file so the download can continue later', async () => {
  const { s, base } = await server(); const dir = tmp(); const ac = new AbortController();
  const p = downloadVerified(opts(base, '/slow', dir, { signal: ac.signal, onProgress: () => ac.abort() }));
  assert.strictEqual(await code(p), 'cancelled');
  s.closeAllConnections(); s.close();
  assert.ok(fs.existsSync(path.join(dir, 'm.gguf.part')));
  assert.ok(!fs.existsSync(path.join(dir, 'm.gguf')));
});

test('a folder with spaces and Turkish letters works', async () => {
  const { s, base } = await server(); const dir = path.join(tmp(), 'Öğrenci Çalışma ı ş');
  await downloadVerified(opts(base, '/file', dir));
  s.close();
  assert.ok(fs.readFileSync(path.join(dir, 'm.gguf')).equals(BODY));
});

test('HTTP errors and broken connections give plain codes', async () => {
  const { s, base } = await server(); const dir = tmp();
  assert.strictEqual(await code(downloadVerified(opts(base, '/404', dir))), 'http');
  assert.strictEqual(await code(downloadVerified(opts(base, '/reset', dir))), 'network');
  s.close();
});

test('a destination whose name has no allowed host in the URL (page-supplied) never gets contacted', async () => {
  const dir = tmp(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('x'); };
  assert.strictEqual(await code(downloadVerified({ url: 'http://huggingface.co/a', destPath: path.join(dir, 'm'), sha256: SHA, sizeBytes: 10, fetchImpl, freeBytes: async () => 1e12 })), 'host');
  assert.strictEqual(calls, 0);
});
