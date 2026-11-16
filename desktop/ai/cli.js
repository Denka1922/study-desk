'use strict';
// Runs an AI command-line tool the student already has installed, in its read-only one-shot mode.
// Tools come only from cli-tools.json; the page can name one by id but never supplies a command or a path.
// The prompt always goes through standard input; the arguments are fixed text.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { estimateTokens } = require('./usage');

class CliError extends Error {
  constructor(kind, message) { super(message); this.name = 'CliError'; this.kind = kind; }
}

function loadTools() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-tools.json'), 'utf8'));
}

// How each tool is asked for a plain answer with no file edits, no commands and no approval questions.
const BUILDERS = {
  // Codex: read-only sandbox, non-interactive exec; the last message is written to answer.txt in the scratch folder.
  codex: (prompt, scratch) => ({
    args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--ignore-user-config', '--color', 'never', '--json', '-o', 'answer.txt', '-'],
    outputFile: path.join(scratch, 'answer.txt'),
  }),
  // Gemini CLI: plan mode is read-only; -p holds a fixed instruction and the real prompt arrives on stdin.
  gemini: () => ({
    args: ['--approval-mode', 'plan', '--skip-trust', '-o', 'json', '-p', 'Follow the instructions given on standard input and reply with the answer only.'],
  }),
  // goose: chat-only mode (no tools, no file changes), no saved session, no extensions.
  goose: () => ({
    args: ['run', '-i', '-', '--no-session', '--no-profile', '--quiet'],
    env: { GOOSE_MODE: 'chat' },
  }),
};

function buildInvocation(tool, prompt, scratchDir) {
  const b = BUILDERS[tool.buildArgs];
  if (!b) throw new CliError('bad', 'Unknown tool.');
  const r = b(prompt, scratchDir);
  return { file: tool.binaries[0], args: r.args, stdin: prompt, env: r.env || {}, outputFile: r.outputFile || null };
}

// ---- finding and starting programs ------------------------------------------------------------------------------

function resolveBinary(name, pathEnv, o = {}) {
  const platform = o.platform || process.platform;
  const exists = o.exists || (f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  const win = platform === 'win32';
  const j = win ? path.win32.join : path.posix.join;
  const names = win ? [name + '.exe', name + '.cmd', name + '.bat', name + '.com'] : [name];
  for (const dir of String(pathEnv || '').split(win ? ';' : ':').map(s => s.replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const n of names) { const f = j(dir, n); if (exists(f)) return f; }
  }
  return null;
}

const SAFE_ARG = /^[A-Za-z0-9 _.,:=\/\\-]+$/;
// npm installs tools on Windows as .cmd shims, which can only run through cmd.exe. That is safe here only because
// every argument is fixed text (checked) and the prompt never appears on the command line.
function windowsCommand(file, args) {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  if (/[%"\r\n]/.test(file)) throw new CliError('bad', 'The tool is installed in a folder whose name is unsafe to start from the app (unsafe path).');
  for (const a of args) if (!SAFE_ARG.test(a)) throw new CliError('bad', 'Unsafe tool argument.');
  const line = '"' + file + '" ' + args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

function killTree(proc) {
  try {
    if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch (e) { try { proc.kill('SIGKILL'); } catch (e2) { /* already gone */ } }
}

// An app started from Finder or the Dock gets a tiny PATH (/usr/bin:/bin:...), but tools such as Codex, Gemini and goose
// are normally installed in Homebrew, npm, nvm or similar folders. Look there too (after the real PATH, never before it).
function augmentPath(pathEnv, o = {}) {
  const platform = o.platform || process.platform;
  if (platform === 'win32') return String(pathEnv || '');
  const home = o.home != null ? o.home : os.homedir();
  const readdir = o.readdir || (d => fs.readdirSync(d));
  const list = String(pathEnv || '').split(':').filter(Boolean);
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  if (home) {
    extra.push(home + '/.local/bin', home + '/.npm-global/bin', home + '/.bun/bin', home + '/.cargo/bin', home + '/.volta/bin');
    let versions = [];
    try { versions = readdir(home + '/.nvm/versions/node').filter(v => /^v\d+/.test(v)); } catch (e) { versions = []; }
    const num = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    versions.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] || 0) - (x[i] || 0); return 0; });
    for (const v of versions) extra.push(home + '/.nvm/versions/node/' + v + '/bin');
  }
  for (const d of extra) if (!list.includes(d)) list.push(d);
  return list.join(':');
}
const defaultPath = () => augmentPath(process.env.PATH || process.env.Path || '');

// the tool's PATH: the folders it was found on first, then everything the app itself has
function mergePath(first, second) {
  const out = String(first || '').split(':').filter(Boolean);
  for (const d of String(second || '').split(':').filter(Boolean)) if (!out.includes(d)) out.push(d);
  return out.join(':');
}

function startProcess(spawn, bin, args, scratch, extraEnv, pathEnv) {
  let plan = { file: bin, args, verbatim: false };
  if (process.platform === 'win32') plan = windowsCommand(bin, args);
  return spawn(plan.file, plan.args, {
    cwd: scratch, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    windowsVerbatimArguments: plan.verbatim, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, extraEnv || {}, { NO_COLOR: '1' }, pathEnv && process.platform !== 'win32' ? { PATH: mergePath(pathEnv, process.env.PATH) } : {}),
  });
}

async function detectTools(o = {}) {
  const pathEnv = o.pathEnv != null ? o.pathEnv : defaultPath();
  const versionOf = o.versionOf || (file => new Promise(resolve => {
    let proc;
    try { proc = startProcess(cp.spawn, file, ['--version'], os.tmpdir(), {}); } catch (e) { return resolve(null); }
    let out = ''; const t = setTimeout(() => killTree(proc), 8000);
    proc.stdout.on('data', d => { out += d; }); proc.on('error', () => resolve(null));
    proc.on('close', () => { clearTimeout(t); resolve(out.trim().split(/\r?\n/)[0] || null); });
    proc.stdin.on('error', () => {}); proc.stdin.end();
  }));
  return Promise.all(loadTools().map(async t => {
    const file = resolveBinary(t.binaries[0], pathEnv, o);
    return { id: t.id, name: t.name, found: !!file, version: file ? await versionOf(file) : null, dataGoes: t.dataGoes, install: t.install, login: t.login };
  }));
}

// ---- reading the answer -----------------------------------------------------------------------------------------

function jsonLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) { try { out.push(JSON.parse(line)); } catch (e) { /* not JSON */ } }
  return out;
}

function parseResult(tool, stdout, outputFile) {
  if (tool.buildArgs === 'codex') {
    let text = '';
    try { text = fs.readFileSync(outputFile, 'utf8').trim(); } catch (e) { /* no answer file */ }
    let usage = null;
    for (const ev of jsonLines(stdout)) {
      const u = ev && (ev.usage || (ev.msg && ev.msg.usage));
      if (u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)) usage = { input: u.input_tokens, output: u.output_tokens, estimated: false };
    }
    return { text, usage };
  }
  if (tool.buildArgs === 'gemini') {
    const a = stdout.indexOf('{'), b = stdout.lastIndexOf('}');
    let j = null;
    try { j = JSON.parse(stdout.slice(a, b + 1)); } catch (e) { /* not JSON */ }
    if (!j) return { text: '', usage: null };
    let usage = null;
    const models = j.stats && j.stats.models;
    if (models && typeof models === 'object') {
      let i = 0, o = 0, seen = false;
      for (const m of Object.values(models)) { const t = m && m.tokens; if (t && Number.isFinite(t.prompt) && Number.isFinite(t.candidates)) { i += t.prompt; o += t.candidates; seen = true; } }
      if (seen) usage = { input: i, output: o, estimated: false };
    }
    return { text: String(j.response == null ? '' : j.response).trim(), usage };
  }
  return { text: stdout.trim(), usage: null };
}

const AUTH = /not logged in|log ?in|sign ?in|unauthori[sz]ed|authenticat|api key|credential|401/i;
const RATE = /rate.?limit|429|quota|too many requests|usage limit/i;

function failure(tool, code, stderr, stdout) {
  const hay = stderr + '\n' + stdout.slice(0, 2000);
  if (AUTH.test(hay)) return new CliError('auth', tool.name + ' is asking for a login. ' + tool.login);
  if (RATE.test(hay)) return new CliError('rate', tool.name + ' says you reached its usage limit. Wait a little and try again.');
  const first = (stderr.split(/\r?\n/).map(s => s.trim()).find(Boolean) || stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'it stopped with code ' + code).slice(0, 300);
  return new CliError('bad', tool.name + ' did not finish: ' + first);
}

async function runCli(o) {
  const tool = typeof o.toolId === 'string' ? loadTools().find(t => t.id === o.toolId) : null;
  if (!tool) throw new CliError('bad', 'Unknown AI tool.');
  const pathEnv = o.pathEnv != null ? o.pathEnv : defaultPath();
  const bin = resolveBinary(tool.binaries[0], pathEnv);
  if (!bin) throw new CliError('nocli', tool.name + ' was not found on this computer. ' + tool.install);
  if (o.signal && o.signal.aborted) throw new CliError('cancelled', 'Cancelled.');

  const scratch = await fs.promises.mkdtemp(path.join(o.scratchRoot || os.tmpdir(), 'studydesk-cli-'));
  try {
    const inv = buildInvocation(tool, o.prompt, scratch);
    const proc = startProcess(o.spawn || cp.spawn, bin, inv.args, scratch, inv.env, pathEnv);
    const out = [], errs = []; let outBytes = 0, errBytes = 0, why = null, spawnError = null;
    const maxOut = o.maxOutputBytes || 2 * 1024 * 1024;
    const stop = reason => { if (!why) { why = reason; killTree(proc); } };
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs || 5 * 60 * 1000);
    const onAbort = () => stop('cancelled');
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', d => { outBytes += d.length; if (outBytes > maxOut) return stop('flood'); out.push(d); });
    proc.stderr.on('data', d => { errBytes += d.length; if (errBytes <= 64 * 1024) errs.push(d); });
    proc.stdin.on('error', () => { /* the program may exit before reading everything */ });
    proc.stdin.end(inv.stdin);
    const code = await new Promise(resolve => { proc.on('error', e => { spawnError = e; resolve(null); }); proc.on('close', resolve); });
    clearTimeout(timer); if (o.signal) o.signal.removeEventListener('abort', onAbort);

    if (why === 'cancelled') throw new CliError('cancelled', 'Cancelled.');
    if (why === 'timeout') throw new CliError('timeout', tool.name + ' took too long to answer, so it was stopped.');
    if (why === 'flood') throw new CliError('bad', tool.name + ' sent a reply that was too long, so it was stopped.');
    if (spawnError) throw new CliError(spawnError.code === 'ENOENT' ? 'nocli' : 'bad', tool.name + ' could not be started: ' + spawnError.message);
    const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(errs).toString('utf8');
    if (code !== 0) throw failure(tool, code, stderr, stdout);
    const r = parseResult(tool, stdout, inv.outputFile);
    if (!r.text) throw new CliError('bad', 'The AI sent an empty reply. Try again.');
    return { text: r.text, cut: false, usage: r.usage || { input: estimateTokens(o.prompt), output: estimateTokens(r.text), estimated: true } };
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

module.exports = { loadTools, detectTools, buildInvocation, runCli, windowsCommand, resolveBinary, augmentPath, CliError };
