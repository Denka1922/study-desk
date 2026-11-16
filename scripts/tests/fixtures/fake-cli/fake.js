'use strict';
// Stand-in for the real AI command-line tools. Behaviour comes from FAKE_MODE; FAKE_RECORD says where to write what it was given.
const fs = require('node:fs');
module.exports = function fake(name) {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) { console.log(name + '-cli 9.9.9\nsecond line'); return; }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { stdin += d; });
  process.stdin.on('end', () => {
    const mode = process.env.FAKE_MODE || '';
    if (process.env.FAKE_RECORD) {
      fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, cwd: process.cwd(), ls: fs.readdirSync(process.cwd()), gooseMode: process.env.GOOSE_MODE || null, stdin }));
    }
    if (mode === 'fail') { console.error('boom: it broke\nsecond line'); process.exit(3); }
    if (mode === 'auth') { console.error('Error: you are not logged in. Please log in first.'); process.exit(1); }
    if (mode === 'rate') { console.error('Error 429: rate limit exceeded'); process.exit(1); }
    if (mode === 'sleep') { setTimeout(() => {}, 30000); return; }
    if (mode === 'flood') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); setTimeout(() => {}, 30000); return; }
    if (mode === 'empty') { return; }
    if (name === 'codex') {
      const i = argv.indexOf('-o');
      if (i >= 0) fs.writeFileSync(argv[i + 1], stdin);
      console.log(JSON.stringify({ type: 'thread.started' }));
      if (process.env.FAKE_USAGE) console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, output_tokens: 4 } }));
    } else if (name === 'gemini') {
      const out = { response: stdin };
      if (process.env.FAKE_USAGE) out.stats = { models: { m1: { tokens: { prompt: 20, candidates: 3, total: 23 } }, m2: { tokens: { prompt: 1, candidates: 1, total: 2 } } } };
      console.log(JSON.stringify(out));
    } else {
      process.stdout.write(stdin + '\n');
    }
  });
};
