'use strict';
// Talks to the user's own relay (relay/worker.js). Everything it sends is already sealed; see SYNC.md.
class RelayError extends Error {
  constructor(kind, message, extra) { super(message); this.name = 'RelayError'; this.kind = kind; if (extra && extra.rev !== undefined) this.rev = extra.rev; }
}

function cleanRelayUrl(v) {
  if (typeof v !== 'string') return '';
  let u; try { u = new URL(v.trim()); } catch (e) { return ''; }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return '';
  if (!u.hostname || u.username || u.password || u.search || u.hash || u.href.length > 200) return '';
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

function createRelayClient({ baseUrl, keys, fetchImpl, timeoutMs }) {
  const base = cleanRelayUrl(baseUrl);
  if (!base) throw new RelayError('bad', 'The relay address must start with https://');
  const doFetch = fetchImpl || ((u, i) => fetch(u, i));
  const room = base + '/v1/room/' + keys.room;
  const auth = { authorization: 'Bearer ' + keys.token };

  async function call(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    let res, text;
    try {
      res = await doFetch(url, { ...init, signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      throw new RelayError('network', 'Cannot reach the relay.');
    } finally { clearTimeout(timer); }
    return { status: res.status, text };
  }
  const json = t => { try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };

  function failFor(r) {
    if (r.status === 401) return new RelayError('auth', 'The relay says this connection is not recognised.');
    if (r.status === 413) return new RelayError('toobig', 'Your data is too big for the relay (2 MB).');
    if (r.status === 409) { const o = json(r.text); return new RelayError('conflict', 'Another device wrote first.', { rev: o && typeof o.rev === 'string' ? o.rev : '' }); }
    return new RelayError('server', 'The relay had a problem (' + r.status + ').');
  }

  return {
    async health() {
      const r = await call(base + '/v1/health', { method: 'GET' });
      const o = r.status === 200 ? json(r.text) : null;
      return !!o && o.ok === true && o.app === 'study-desk-relay';
    },
    async get() {
      const r = await call(room, { method: 'GET', headers: auth });
      if (r.status === 404) return null;
      if (r.status !== 200) throw failFor(r);
      const o = json(r.text);
      if (!o || typeof o.rev !== 'string' || typeof o.body !== 'string') throw new RelayError('bad', 'The relay answered something unexpected.');
      return { rev: o.rev, body: o.body };
    },
    async put(body, prev) {
      const payload = prev === undefined ? { body } : { body, prev };
      const r = await call(room, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.status !== 200) throw failFor(r);
      const o = json(r.text);
      if (!o || typeof o.rev !== 'string') throw new RelayError('bad', 'The relay answered something unexpected.');
      return { rev: o.rev };
    },
    async del() {
      const r = await call(room, { method: 'DELETE', headers: auth });
      if (r.status !== 204 && r.status !== 200) throw failFor(r);
    },
  };
}

module.exports = { createRelayClient, RelayError, cleanRelayUrl };
