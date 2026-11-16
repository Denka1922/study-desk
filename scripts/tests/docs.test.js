'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers');

const has = (txt, ...needles) => { for (const n of needles) assert.ok(n instanceof RegExp ? n.test(txt) : txt.includes(n), 'missing: ' + n); };

test('FIRST-BUILD.md covers GitHub from zero to the first Release', () => {
  const t = read('FIRST-BUILD.md');
  has(t, 'git tag v1.0.0', 'git push origin v1.0.0', /Settings.*Pages/s, 'GitHub Actions', '.github/workflows/build.yml',
    /contents of the (study-desk )?folder/i, /Create new file/i, /Releases/, 'public', 'Study-Desk-Setup-', '-portable.exe', 'TEST-CHECKLIST.md',
    'git config user.name', 'git config user.email', 'Draft a new release', /Re-run/, 'Smart App Control', /before you upload/i);
  assert.ok(!/Do not use GitHub's/i.test(t), 'browser release route is allowed');
});

test('PLAY-STORE.md covers Android Studio, the signed bundle and Google Play', () => {
  const t = read('PLAY-STORE.md');
  has(t, 'app.studydesk.planner', /cannot be changed/i, 'versionCode', '.aab', 'Play App Signing', /outside the project/i, /back(ed)? ?up/i,
    'npm install', 'npm run sync', 'Android Studio Otter', '2025.2.1', 'Node 22', 'PLAY_STORE_URL', 'node scripts/check.js --stamp',
    /AI-generated content/i, /data safety/i, /Play Console/, /current requirements/i, /testing period|closed test/i, /privacy policy/i, 'TEST-CHECKLIST.md',
    'py scripts/set-android-version.py', /same numbers/i, /push (it )?to GitHub/i,
    'Build APK(s)', /Install unknown apps/i, /uninstall/i);
  assert.ok(!/push a new version tag/i.test(t), 'changing the Play link needs no new tag');
  assert.ok(!/\.apk/i.test(t), 'guide never mentions an .apk file');
});

test('TEST-CHECKLIST.md has the Windows and Android steps', () => {
  const t = read('TEST-CHECKLIST.md');
  has(t, 'A7.', 'B1.', 'C2.', 'D6.', 'E1.', 'F.', 'unknown publisher', 'Uninstall', 'npm install', 'Smart App Control');
});

test('README.md explains every folder and says no APK is produced', () => {
  const t = read('README.md');
  has(t, 'app/', 'desktop/', 'mobile/', 'site/', 'scripts/', '.github/workflows/build.yml', 'FIRST-BUILD.md', 'PLAY-STORE.md', 'TEST-CHECKLIST.md', /no APK/i, 'node scripts/check.js --ci', /Python 3/);
});

test('Mac steps: README says what GitHub builds for Mac, the checklist has the Gatekeeper steps', () => {
  const r = read('README.md'), c = read('TEST-CHECKLIST.md');
  has(r, /Mac/, /\.dmg/, /not signed by Apple/i);
  has(c, /## G\. Mac/, /Open Anyway/, /right-click/i, /Cmd\+C|Cmd\+Q/);
});

test('TEST-CHECKLIST.md has real-machine sections for Local AI and CLI AI', () => {
  const t = read('TEST-CHECKLIST.md');
  const local = t.split(/^## /m).find(s => /^H\. Local AI/.test(s)) || '', cli = t.split(/^## /m).find(s => /^I\. CLI AI/.test(s)) || '';
  assert.ok(local, 'section H. Local AI'); assert.ok(cli, 'section I. CLI AI');
  has(local, /hardware|memory.*cores|cores/i, /Light/, /Medium/, /High/, /Extra high/, /Max/, /Download/, /Delete/, /token/i, /antivirus|SmartScreen|Defender/i, /Open Anyway/,
    /Task Manager/, /Activity Monitor/, /llama-server/, /Vulkan|graphics card|GPU/i, /Cancel/, /Start/);
  has(cli, /Codex/, /Gemini/, /goose/, /Not found/, /Check again/, /cloud/i, /token/i, /login|sign in/i);
});

test('README.md explains Local and CLI, keeps the API key for Android, and says cloud tools send questions to the cloud', () => {
  const t = read('README.md');
  has(t, /Local/, /CLI/, /Android/, /API key/, /cloud/i, /llama\.cpp/, /Nemotron/, /Verify AI catalog/, /Copilot/, /opencode/i, /Crush/, /aider/i);
  assert.ok(!/still needs your own API key for now/i.test(t), 'old "API key for now" line is gone');
  assert.match(t, /Android[^.\n]*(API key|online key)[^.\n]*/i, 'Android keeps the API key');
});

test('FIRST-BUILD.md explains the one-time Verify AI catalog run', () => {
  has(read('FIRST-BUILD.md'), 'Verify AI catalog', /Actions/, /Run workflow/, /qwen3|GLM/i);
});

test('PLAY-STORE.md says the Android app has no Local or CLI AI', () => {
  const t = read('PLAY-STORE.md');
  has(t, /no Local|Local and CLI/i, /API key/);
  assert.ok(!/expected to be replaced by a local model later/i.test(t));
});

test('the download page mentions Local and CLI on Windows and Mac in one sentence', () => {
  has(read('site/index.html'), /command-line tool/i, /your own computer|on your computer/i);
});
