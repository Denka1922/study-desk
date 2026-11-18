'use strict';
// Runs one sync pairing on the PC: the "Same Wi-Fi" door, the optional relay, and the hand-over to the app window (which owns the data).
const C = require('./crypto');
const { cleanRelayUrl, RelayError } = require('./relay-client');
const { isPrivateAddress } = require('./lan-server');

const MODES = ['wifi', 'net', 'both'];
const CYCLE_MS = 20000, QUICK_MS = 600;

function listAddresses(os) {
  const out = [];
  const all = os.networkInterfaces() || {};
  for (const name of Object.keys(all)) for (const a of all[name] || []) {
    const v4 = a.family === 'IPv4' || a.family === 4;
    if (!v4 || a.internal || !a.address || a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
    if (isPrivateAddress(a.address) && !out.includes(a.address)) out.push(a.address);
  }
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.map((ip, i) => ({ ip, i })).sort((x, y) => rank(x.ip) - rank(y.ip) || x.i - y.i).map(x => x.ip);
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function hhmm(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

function createSyncService(o) {
  const now = o.now || Date.now;
  const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || (t => clearTimeout(t));
  const emit = o.emitStatus || (() => {});
  let cfg = null;      // {keys, mode, name, relayUrl}
  let lan = null, relay = null;
  let latest = null;   // {rev, doc} as last published by the page
  let cycleTimer = null, quickTimer = null, running = false, again = false, lastSync = 0;

  const status = (state, text) => emit({ state, text, lastSync, mode: cfg ? cfg.mode : 'off' });
  const synced = () => { lastSync = now(); status('connected', 'Synced ' + hhmm(lastSync)); };

  async function pageMerge(rev, doc) {
    const r = await o.askPage({ op: 'sync', rev, doc }, 15000);
    if (!isObj(r) || typeof r.rev !== 'string' || !isObj(r.doc)) throw new Error('The app window gave an unexpected answer.');
    latest = { rev: r.rev, doc: r.doc };
    return latest;
  }

  async function onMessage(msg) {
    if (!isObj(msg)) throw new Error('bad message');
    if (msg.op === 'hello') return { ok: true, nonce: String(msg.nonce || '').slice(0, 100), name: cfg.name, rev: latest ? latest.rev : '' };
    if (msg.op === 'peek') return { ok: true, rev: latest ? latest.rev : '' };
    if (msg.op === 'sync') {
      if (!isObj(msg.doc) || typeof msg.rev !== 'string') throw new Error('bad sync');
      const r = await pageMerge(msg.rev, msg.doc);
      synced();
      if (relay) scheduleQuick();
      return { ok: true, rev: r.rev, doc: r.doc };
    }
    throw new Error('unknown op');
  }

  function relayStatus(e) {
    if (e instanceof C.SyncCryptoError) return status('error', 'The relay holds data this connection cannot read. Pair again.');
    const k = e && e.kind;
    if (k === 'network') return status('error', 'Cannot reach the relay. Check the internet connection.');
    if (k === 'auth') return status('error', 'The relay does not recognise this connection. Pair again.');
    if (k === 'toobig') return status('error', 'Your data is too big for the relay (2 MB).');
    return status('error', 'The relay had a problem. Will try again.');
  }

  async function oneCycle() {
    const remote = await relay.get();
    if (!remote) {
      if (!latest) return;
      await relay.put(JSON.stringify(C.seal(cfg.keys, { rev: latest.rev, doc: latest.doc })), '0');
      return synced();
    }
    let plain;
    try { plain = C.open(cfg.keys, JSON.parse(remote.body)); } catch (e) { throw e instanceof C.SyncCryptoError ? e : new C.SyncCryptoError(); }
    if (!isObj(plain) || typeof plain.rev !== 'string' || !isObj(plain.doc)) throw new C.SyncCryptoError();
    if (latest && plain.rev === latest.rev) return synced();
    const merged = await pageMerge(plain.rev, plain.doc);
    if (merged.rev !== plain.rev) await relay.put(JSON.stringify(C.seal(cfg.keys, { rev: merged.rev, doc: merged.doc })), remote.rev);
    synced();
  }

  async function runCycle() {
    if (!relay) return;
    if (running) { again = true; return; }
    running = true;
    try {
      for (let n = 0; n < 3; n++) {
        try { await oneCycle(); break; }
        catch (e) { if (e instanceof RelayError && e.kind === 'conflict' && n < 2) continue; relayStatus(e); break; }
      }
    } catch (e) { status('error', 'Something went wrong while syncing.'); }
    finally { running = false; }
    if (again && relay) { again = false; scheduleQuick(); }
  }
  function scheduleQuick() {
    if (!relay) return;
    clearTimer(quickTimer);
    quickTimer = setTimer(() => { quickTimer = null; runCycle(); }, QUICK_MS);
  }

  async function stop() {
    clearTimer(cycleTimer); clearTimer(quickTimer); cycleTimer = quickTimer = null;
    const l = lan; lan = null; relay = null;
    if (l) await l.stop();
    cfg = null; lastSync = 0; again = false;
    emit({ state: 'off', text: 'Sync is off', lastSync: 0, mode: 'off' });
  }

  async function start(a) {
    await stop();
    if (!isObj(a) || !MODES.includes(a.mode)) throw new Error('Choose how the devices connect.');
    let secret;
    try { secret = C.fromB64url(a.secretB64); } catch (e) { secret = null; }
    if (!secret || secret.length !== 32) throw new Error('The pairing secret is not valid.');
    const keys = C.deriveKeys(secret);
    let relayUrl = '';
    if (a.mode !== 'wifi') { relayUrl = cleanRelayUrl(a.relayUrl); if (!relayUrl) throw new Error('The relay address must start with https://'); }
    cfg = { keys, mode: a.mode, name: String(a.name || 'This PC').slice(0, 40), relayUrl };
    latest = latest || null;
    let port;
    try {
      if (a.mode !== 'net') { lan = o.makeLan({ getKeys: () => (cfg ? cfg.keys : null), onMessage }); port = (await lan.start()).port; }
    } catch (e) { const l = lan; lan = null; cfg = null; if (l) await l.stop().catch(() => {}); throw e; }
    if (a.mode !== 'wifi') {
      relay = o.makeRelay({ baseUrl: relayUrl, keys });
      const tick = () => { cycleTimer = setTimer(async () => { await runCycle(); if (relay) tick(); }, CYCLE_MS); };
      tick(); scheduleQuick();
    }
    status('waiting', a.mode === 'net' ? 'Connecting through the relay' : 'Waiting for your phone');
    const out = { ok: true, addresses: a.mode === 'net' ? [] : listAddresses(o.os) };
    if (port !== undefined) out.port = port;
    return out;
  }

  function publish(p) {
    if (!isObj(p) || typeof p.rev !== 'string' || !isObj(p.doc)) throw new Error('bad publish');
    latest = { rev: p.rev, doc: p.doc };
    if (relay) scheduleQuick();
  }

  async function forget() {
    const r = relay;
    try { if (r) await r.del(); } catch (e) { /* the room expires by itself; the local pairing is removed anyway */ }
    await stop();
  }

  return { start, stop, publish, forget, runCycle, listAddresses: () => listAddresses(o.os), isRunning: () => !!cfg };
}

module.exports = { createSyncService, listAddresses, MODES };
