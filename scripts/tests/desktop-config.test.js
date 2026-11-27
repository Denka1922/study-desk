'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, read } = require('./helpers');

const pkg = () => JSON.parse(read('desktop/package.json'));

test('versions are exact', () => {
  const p = pkg();
  for (const [n, v] of Object.entries({ ...p.dependencies, ...p.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, n);
  assert.strictEqual(p.devDependencies.electron, '45.3.0');
  assert.strictEqual(p.devDependencies['electron-builder'], '26.18.0');
});

test('product name and app id are fixed so the data folder never moves', () => {
  const p = pkg();
  assert.strictEqual(p.name, 'study-desk');
  assert.strictEqual(p.productName, 'Study Desk');
  assert.strictEqual(p.build.appId, 'app.studydesk.planner');
  assert.ok(!/setPath|\btemp\b|tmpdir/i.test(read('desktop/main.js')), 'main.js never redirects the profile');
});

test('installer and portable targets, names and shortcuts', () => {
  const b = pkg().build;
  const targets = b.win.target.map(t => `${t.target}:${t.arch.join()}`).sort();
  assert.deepStrictEqual(targets, ['nsis:x64', 'portable:x64']);
  assert.strictEqual(b.nsis.oneClick, true);
  assert.strictEqual(b.nsis.perMachine, false);
  assert.strictEqual(b.nsis.createDesktopShortcut, true);
  assert.strictEqual(b.nsis.createStartMenuShortcut, true);
  assert.strictEqual(b.nsis.artifactName, 'Study-Desk-Setup-${version}.exe');
  assert.strictEqual(b.portable.artifactName, 'Study-Desk-${version}-portable.exe');
  assert.strictEqual(b.win.icon, 'icon.ico');
  assert.strictEqual(b.publish, null);
});

test('the page is shipped as a resource and only the shell files are packed', () => {
  const b = pkg().build;
  assert.deepStrictEqual(b.extraResources, [{ from: '../app/index.html', to: 'app/index.html' }]);
  assert.deepStrictEqual([...b.files].sort(), ['!ai/tools/**', 'ai/**/*', 'main.js', 'package.json', 'permissions.js', 'preload.js', 'security.js', 'sync/**/*', 'voice/**/*']);
  assert.strictEqual(pkg().main, 'main.js');
});

test('every file the app loads at start is in the packed file list (a missing one would crash the installed app)', () => {
  const files = pkg().build.files.filter(f => !f.startsWith('!'));
  const packed = rel => files.some(f => f === rel || (f.endsWith('/**/*') && rel.startsWith(f.slice(0, -4))) || (f.endsWith('/**') && rel.startsWith(f.slice(0, -2))));
  const seen = [], walk = (file, dir) => {
    const src = read('desktop/' + path.posix.join(dir, file));
    for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
      let rel = path.posix.normalize(path.posix.join(dir, m[1])); if (!/\.(js|json)$/.test(rel)) rel += fs.existsSync(path.join(ROOT, 'desktop', rel + '.js')) ? '.js' : '/index.js';
      if (seen.includes(rel)) continue; seen.push(rel); assert.ok(packed(rel), rel + ' is required by ' + path.posix.join(dir, file) + ' but is not in build.files');
      if (rel.endsWith('.js')) walk(path.posix.basename(rel), path.posix.dirname(rel));
    }
  };
  walk('main.js', '.'); walk('preload.js', '.');
  assert.ok(seen.includes('permissions.js') && seen.includes('voice/service.js') && seen.length > 10, seen.join());
});

test('lock file exists and every package comes from the npm registry', () => {
  const lock = JSON.parse(read('desktop/package-lock.json'));
  const bad = Object.entries(lock.packages).filter(([k, v]) => k && v.resolved && !v.resolved.startsWith('https://registry.npmjs.org/'));
  assert.deepStrictEqual(bad.map(b => b[0]), []);
  assert.ok(Object.keys(lock.packages).length > 50);
});

test('Mac build: dmg and zip for both chips, unsigned-but-ad-hoc-signed, same stable names', () => {
  const b = pkg().build;
  const targets = b.mac.target.map(t => `${t.target}:${t.arch.slice().sort().join()}`).sort();
  assert.deepStrictEqual(targets, ['dmg:arm64,x64', 'zip:arm64,x64']);
  assert.strictEqual(b.mac.identity, '-', 'ad-hoc signature: Apple Silicon refuses completely unsigned apps');
  assert.strictEqual(b.mac.hardenedRuntime, false);
  assert.strictEqual(b.mac.icon, 'icon.png');
  assert.strictEqual(b.mac.artifactName, 'Study-Desk-${version}-mac-${arch}.${ext}');
  assert.strictEqual(b.mac.category, 'public.app-category.education');
  assert.match(b.mac.extendInfo.NSMicrophoneUsageDescription, /answer|speak|talk/i, 'the Mac asks for the microphone with a plain reason');
  assert.ok(!/only when you press/i.test(b.mac.extendInfo.NSMicrophoneUsageDescription), 'Mic open also listens on later turns, so the text must not promise a press every time');
  assert.match(b.mac.extendInfo.NSMicrophoneUsageDescription, /Mic open|turn/i);
  assert.ok(!('NSCameraUsageDescription' in b.mac.extendInfo), 'the camera is never asked for');
  assert.strictEqual(b.appId, 'app.studydesk.planner');
  assert.strictEqual(pkg().scripts['dist:mac'], 'electron-builder --mac --publish never');
});
