'use strict';
// Verified, resumable download: allowlisted hosts only (every redirect hop checked), disk space checked first,
// SHA-256 checked before the file is given its final name.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hostAllowed: defaultAllowed } = require('./catalog');

const MAX_REDIRECTS = 5;
const MSG = {
  host: 'The download was sent to a website the app does not trust, so it was stopped.',
  disk: 'There is not enough free disk space for this download. Free up some space and try again.',
  checksum: 'The downloaded file did not match its expected checksum, so it was deleted. Try again later.',
  cancelled: 'The download was cancelled. You can continue it later where it stopped.',
  network: 'The connection broke. Check your internet and try again; the download continues where it stopped.',
};

class DownloadError extends Error {
  constructor(code, message) { super(message || MSG[code]); this.name = 'DownloadError'; this.code = code; }
}

async function defaultFreeBytes(dir) {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

const isAbort = e => e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');

// Follows redirects by hand so each hop is checked against the allowlist.
async function open(o, allowed, fetchImpl, headers) {
  let url = o.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(url)) throw new DownloadError('host');
    let res;
    try { res = await fetchImpl(url, { headers, redirect: 'manual', signal: o.signal }); }
    catch (e) { throw isAbort(e) ? new DownloadError('cancelled') : new DownloadError('network'); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError('http', 'The download site sent a redirect without an address.');
      url = new URL(loc, url).href;
      continue;
    }
    return res;
  }
  throw new DownloadError('host', 'The download site redirected too many times, so it was stopped.');
}

async function hashFile(file, hash) {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
}

async function downloadVerified(o) {
  const allowed = o.hostAllowed || defaultAllowed;
  const fetchImpl = o.fetchImpl || fetch;
  if (!allowed(o.url)) throw new DownloadError('host');
  const dest = o.destPath, part = dest + '.part';
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  let have = 0;
  try { have = (await fs.promises.stat(part)).size; } catch (e) { have = 0; }
  const freeBytes = o.freeBytes || (() => defaultFreeBytes(path.dirname(dest)));
  if ((await freeBytes()) < Math.max(0, o.sizeBytes - have) * 1.1) throw new DownloadError('disk');

  let res = await open(o, allowed, fetchImpl, have ? { range: 'bytes=' + have + '-' } : {});
  if (res.status === 416 && have) { // the partial file does not fit the server's file: start over
    have = 0; await fs.promises.rm(part, { force: true });
    res = await open(o, allowed, fetchImpl, {});
  }
  if (res.status !== 200 && res.status !== 206) throw new DownloadError('http', 'The download site answered with an error (' + res.status + ').');
  if (res.status === 200) { have = 0; await fs.promises.rm(part, { force: true }); } // Range ignored

  const hash = crypto.createHash('sha256');
  if (have) await hashFile(part, hash);
  const total = have + (Number(res.headers.get('content-length')) || Math.max(0, o.sizeBytes - have));
  const fh = await fs.promises.open(part, have ? 'a' : 'w');
  let done = have;
  try {
    for await (const chunk of res.body) {
      if (o.signal && o.signal.aborted) throw new DownloadError('cancelled');
      hash.update(chunk); await fh.write(chunk); done += chunk.length;
      if (o.onProgress) o.onProgress(done, total);
    }
  } catch (e) {
    if (e instanceof DownloadError) throw e;
    if (isAbort(e) || (o.signal && o.signal.aborted)) throw new DownloadError('cancelled');
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT' || e.code === 'EFBIG')) throw new DownloadError('disk');
    throw new DownloadError('network');
  } finally { await fh.close(); }

  if (hash.digest('hex') !== String(o.sha256).toLowerCase()) {
    await fs.promises.rm(part, { force: true }); await fs.promises.rm(dest, { force: true });
    throw new DownloadError('checksum');
  }
  await fs.promises.rename(part, dest);
  return { path: dest };
}

module.exports = { downloadVerified, DownloadError };
