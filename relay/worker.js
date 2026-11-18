// Study Desk relay: a tiny Cloudflare Worker that keeps ONE encrypted blob per room, so a phone and a PC that are not on the same
// Wi-Fi can still hand their (already encrypted) planner data to each other. It cannot read what it stores: the key never leaves
// your two devices. See SYNC.md ("Internet relay protocol") and relay/README.md.
//
// Storage: a KV namespace bound as ROOMS. Value = JSON {h: sha256 hex of the token, rev: whole number, body: string}.

const MAX_BODY = 2 * 1024 * 1024;           // bytes
const TTL = 90 * 24 * 60 * 60;              // seconds without a write before a room disappears
const ROOM_RE = /^[0-9a-f]{32}$/;
const ROOM_PATH = /^\/v1\/room\/([^/]*)$/;
const enc = new TextEncoder();

function reply(status, obj, extra) {
  const headers = { 'cache-control': 'no-store', ...(extra || {}) };
  if (status === 204) return new Response(null, { status, headers });
  headers['content-type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(obj), { status, headers });
}
const fail = (status, message, extra) => reply(status, { error: message }, extra);

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
function sameText(a, b) {                   // constant time for equal-length strings; hashes always have the same length
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function bearer(request) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1] : '';
}

async function readLimited(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY) return { tooBig: true };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return { tooBig: true };
  return { text: new TextDecoder('utf-8').decode(buf) };
}

function parsePrev(v) {                     // returns a whole number, or null when it is not a valid prev
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string') return /^\d{1,15}$/.test(v) ? Number(v) : null;
  return null;
}

async function roomRequest(request, env, room) {
  const method = request.method;
  if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return fail(405, 'Method not allowed', { allow: 'GET, PUT, DELETE' });
  if (!env || !env.ROOMS) return fail(500, 'The ROOMS storage binding is missing. See relay/README.md.');
  const token = bearer(request);
  let rec = null;
  try {
    const raw = await env.ROOMS.get(room);
    rec = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (e) { return fail(500, 'Storage problem'); }

  if (rec) {
    const ok = token && sameText(await sha256Hex(token), rec.h);
    if (!ok) return fail(401, 'Wrong key');
  } else if (!token) {
    return fail(401, 'Missing key');
  }

  try {
    if (method === 'GET') {
      if (!rec) return fail(404, 'No data yet');
      return reply(200, { rev: String(rec.rev), body: rec.body });
    }
    if (method === 'DELETE') {
      if (rec) await env.ROOMS.delete(room);
      return reply(204);
    }
    // PUT
    const got = await readLimited(request);
    if (got.tooBig) return fail(413, 'Too much data (limit 2 MB)');
    let data;
    try { data = JSON.parse(got.text); } catch (e) { return fail(400, 'The request is not valid JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'The request must be a JSON object');
    if (typeof data.body !== 'string') return fail(400, 'body must be a string');
    const current = rec ? Number(rec.rev) : 0;
    if (data.prev !== undefined) {
      const prev = parsePrev(data.prev);
      if (prev === null) return fail(400, 'prev must be a whole number');
      if (prev !== current) return reply(409, { rev: String(current) });
    }
    const next = current + 1;
    const h = rec ? rec.h : await sha256Hex(token);
    await env.ROOMS.put(room, JSON.stringify({ h, rev: next, body: data.body }), { expirationTtl: TTL });
    return reply(200, { rev: String(next) });
  } catch (e) {
    return fail(500, 'Storage problem');
  }
}

export async function handle(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/v1/health') {
    if (request.method !== 'GET') return fail(405, 'Method not allowed', { allow: 'GET' });
    return reply(200, { ok: true, app: 'study-desk-relay' });
  }
  const m = ROOM_PATH.exec(path);
  if (!m || !ROOM_RE.test(m[1])) return fail(404, 'Not found');
  return roomRequest(request, env, m[1]);
}

export default { fetch: (request, env) => handle(request, env) };
