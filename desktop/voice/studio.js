'use strict';
// Optional link to VoiceStudio (https://github.com/debpalash/VoiceStudio), a separate program the student installs themselves.
// Study Desk never bundles or downloads it (it has its own licence); it only talks to it on this computer, over localhost.
const BASE = 'http://127.0.0.1:3900';
const FIND_TIMEOUT_MS = 1500;
const SPEAK_TIMEOUT_MS = 5 * 60 * 1000; // heavy voices can be slow without a graphics card
const MAX_WAV = 60 * 1024 * 1024;

function timeoutSignal(ms, outer) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (outer) { if (outer.aborted) c.abort(); else outer.addEventListener('abort', () => c.abort(), { once: true }); }
  return { signal: c.signal, done: () => clearTimeout(t) };
}

function readVoices(json) {
  const list = Array.isArray(json) ? json : (json && (json.voices || json.data)) || [];
  const out = [];
  for (const v of list) {
    const id = typeof v === 'string' ? v : v && (v.id || v.name || v.voice_id);
    if (typeof id !== 'string' || !/^[\w .:@-]{1,80}$/.test(id)) continue;
    out.push({ id, name: String((v && v.name) || id).slice(0, 60) });
    if (out.length >= 60) break;
  }
  return out;
}

function createStudio(o = {}) {
  const fetchImpl = o.fetchImpl || fetch, base = o.base || BASE;
  async function getJson(p, ms) {
    const t = timeoutSignal(ms);
    try { const r = await fetchImpl(base + p, { signal: t.signal, redirect: 'error' }); if (!r.ok) return null; return await r.json(); }
    catch (e) { return null; } finally { t.done(); }
  }
  return {
    // { found, voices }. Not found is normal: most computers do not have it.
    async detect() {
      const health = await getJson('/health', FIND_TIMEOUT_MS);
      if (!health) return { found: false, voices: [] };
      const voices = readVoices(await getJson('/v1/audio/voices', FIND_TIMEOUT_MS));
      return { found: true, voices: voices.length ? voices : [{ id: 'default', name: 'Default voice' }] };
    },
    async speak({ text, voice, speed, signal }) {
      const t = timeoutSignal(SPEAK_TIMEOUT_MS, signal);
      try {
        const r = await fetchImpl(base + '/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: t.signal,
          body: JSON.stringify({ input: text, voice, speed, response_format: 'wav' }) });
        if (!r.ok) throw Object.assign(new Error('VoiceStudio could not read this text (it answered ' + r.status + ').'), { kind: 'engine' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_WAV) throw Object.assign(new Error('VoiceStudio sent too much audio.'), { kind: 'engine' });
        if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw Object.assign(new Error('VoiceStudio did not send a WAV file.'), { kind: 'engine' });
        return buf;
      } catch (e) {
        if (e && e.kind) throw e;
        if (signal && signal.aborted) throw Object.assign(new Error('The voice was stopped.'), { kind: 'cancelled' });
        if (e && e.name === 'AbortError') throw Object.assign(new Error('VoiceStudio took too long. A lighter voice may be faster.'), { kind: 'timeout' });
        throw Object.assign(new Error('Could not reach VoiceStudio on this computer. Is it still running?'), { kind: 'network' });
      } finally { t.done(); }
    },
  };
}

module.exports = { createStudio, readVoices, BASE };
