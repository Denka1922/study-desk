'use strict';
// The speech listener: the same kind of background process as the voice worker, running ears-worker.js. Recordings travel as
// real typed arrays (advanced messages) and are never written to disk.
const path = require('node:path');
const { createHost } = require('./host');

function createEarsHost(o = {}) {
  return createHost({
    ...o,
    workerPath: o.workerPath || path.join(__dirname, 'ears-worker.js'),
    requestType: 'hear',
    serialization: 'advanced',
    noun: 'listener',
    failed: 'The listener could not understand this recording.',
    slow: 'Listening took too long. Try a shorter answer.',
  });
}

module.exports = { createEarsHost };
