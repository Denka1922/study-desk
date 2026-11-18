'use strict';
// The PC side of "Same Wi-Fi" sync: one small HTTP door, POST /v1/x, whose bodies are sealed messages (see SYNC.md).
// Anything that is not a correctly sealed message from a private address gets nothing useful back.
const http = require('node:http');
const C = require('./crypto');

const MAX_BODY = 8 * 1024 * 1024;
const FAIL_LIMIT = 20, WINDOW_MS = 60000;

function isPrivateAddress(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  let a = addr.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [p, q, r, s] = v4.slice(1).map(Number);
    if ([p, q, r, s].some(n => n > 255)) return false;
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  if (!/^[0-9a-f:]+$/.test(a) || a.indexOf(':') < 0) return false;
  if (a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 and fe80::/10
}

function createLanServer(o) {
  const getKeys = o.getKeys, onMessage = o.onMessage;
  const now = o.now || Date.now;
  const isPrivate = o.isPrivateAddress || isPrivateAddress;
  const host = o.host || '0.0.0.0';
  const portStart = o.portStart === undefined ? 47821 : o.portStart;
  const portEnd = o.portEnd === undefined ? portStart + 9 : o.portEnd;
  const timeoutMs = o.requestTimeoutMs || 15000;
  const fails = new Map();   // address -> {times:[ms], until:ms}
  const sockets = new Set();
  let server = null;

  const send = (res, status, body, extra) => {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body || ''), ...(body ? { 'content-type': 'application/json' } : {}), connection: 'close', ...(extra || {}) });
    res.end(body || '');
  };
  const blocked = ip => { const f = fails.get(ip); return !!f && f.until > now(); };
  function noteFailure(ip) {
    const f = fails.get(ip) || { times: [], until: 0 };
    const t = now();
    f.times = f.times.filter(x => t - x < WINDOW_MS); f.times.push(t);
    if (f.times.length > FAIL_LIMIT) { f.until = t + WINDOW_MS; f.times = []; }
    fails.set(ip, f);
    return f.until > t;
  }

  function handle(req, res) {
    const ip = req.socket.remoteAddress;
    if (!isPrivate(ip)) return send(res, 403, '');
    if (blocked(ip)) return send(res, 429, '');
    const path = (req.url || '').split('?')[0];
    if (req.method !== 'POST' || path !== '/v1/x') return send(res, 404, '');
    const chunks = []; let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; send(res, 413, ''); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', async () => {
      if (done) return; done = true;
      let env;
      try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, ''); }
      if (!env || typeof env !== 'object' || Array.isArray(env)) return send(res, 400, '');
      const keys = getKeys();
      if (!keys) return send(res, 503, '');
      let msg;
      try { msg = C.open(keys, env); } catch (e) { return send(res, noteFailure(ip) ? 429 : 401, ''); }
      let timer;
      try {
        const reply = await Promise.race([
          Promise.resolve().then(() => onMessage(msg)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs); }),
        ]);
        send(res, 200, JSON.stringify(C.seal(keys, reply === undefined ? { ok: true } : reply)));
      } catch (e) {
        send(res, e && e.code === 'TIMEOUT' ? 503 : 500, '');
      } finally { clearTimeout(timer); }
    });
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handle);
      s.requestTimeout = 30000; s.headersTimeout = 10000;
      s.on('connection', sock => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
      s.once('error', reject);
      s.listen(port, host, () => { s.removeListener('error', reject); s.on('error', () => {}); resolve(s); });
    });
  }

  return {
    async start() {
      if (server) return { port: server.address().port };
      let last;
      for (let p = portStart; p <= portEnd; p++) {
        try { server = await listen(p); return { port: server.address().port }; } catch (e) { last = e; if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break; }
      }
      const err = new Error('No free port for sync on this computer (tried ' + portStart + '-' + portEnd + ').');
      err.code = last && last.code; throw err;
    },
    stop() {
      return new Promise(resolve => {
        if (!server) return resolve();
        const s = server; server = null;
        for (const sock of sockets) sock.destroy();
        s.close(() => resolve());
      });
    },
  };
}

module.exports = { createLanServer, isPrivateAddress, MAX_BODY };
