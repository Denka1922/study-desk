'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ROOT, read, walk } = require('./helpers');

const A = 'mobile/android';
const MAN = `${A}/app/src/main/AndroidManifest.xml`;
const RES = `${A}/app/src/main/res`;

test('capacitor config is the Play Store one and cannot load remote content', () => {
  const c = JSON.parse(read('mobile/capacitor.config.json'));
  assert.strictEqual(c.appId, 'app.studydesk.planner');
  assert.strictEqual(c.appName, 'Study Desk');
  assert.strictEqual(c.webDir, '../app');
  assert.ok(!c.server, 'no server block (no live-reload url, no cleartext, no allowNavigation)');
  assert.strictEqual(c.android.allowMixedContent, false);
});

test('mobile package.json pins Capacitor 8.6.0 and Node 22', () => {
  const p = JSON.parse(read('mobile/package.json'));
  const all = { ...p.dependencies, ...p.devDependencies };
  assert.deepStrictEqual(Object.keys(all).sort(), ['@capacitor/android', '@capacitor/cli', '@capacitor/core']);
  for (const v of Object.values(all)) assert.strictEqual(v, '8.6.0');
  assert.strictEqual(p.engines.node, '>=22');
  assert.strictEqual(p.scripts.sync, 'cap sync android');
  const lock = JSON.parse(read('mobile/package-lock.json'));
  const bad = Object.entries(lock.packages).filter(([k, v]) => k && v.resolved && !v.resolved.startsWith('https://registry.npmjs.org/'));
  assert.deepStrictEqual(bad.map(b => b[0]), []);
});

test('manifest asks only for internet and the camera, with backup off', () => {
  const m = read(MAN);
  const perms = [...m.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map(x => x[1]);
  assert.deepStrictEqual(perms, ['android.permission.INTERNET', 'android.permission.CAMERA']);
  assert.ok(!/<uses-permission-sdk-23/.test(m));
  assert.deepStrictEqual([...m.matchAll(/<uses-feature[^>]*>/g)].map(x => x[0].replace(/\s+/g, ' ')), ['<uses-feature android:name="android.hardware.camera" android:required="false" />']);
  assert.match(m, /android:allowBackup="false"/);
});

test('plain HTTP is allowed only because sync needs the local network, and the page itself still cannot use it', () => {
  // Sync talks to the PC (http://192.168.x.x) through the native HTTP plugin; every body is AES-GCM sealed (SYNC.md).
  // The page's own network rules stay closed: no mixed content, and its content policy names only the three AI hosts over https.
  assert.match(read(MAN), /android:usesCleartextTraffic="true"/);
  assert.strictEqual(JSON.parse(read('mobile/capacitor.config.json')).android.allowMixedContent, false);
  const csp = read('app/index.html').match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const connect = csp.match(/connect-src ([^;]+)/)[1].split(' ');
  assert.deepStrictEqual(connect, ['https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com']);
});

test('application id, name and version match the config and version.json', () => {
  const g = read(`${A}/app/build.gradle`);
  const v = JSON.parse(read('mobile/version.json'));
  assert.match(g, /applicationId "app\.studydesk\.planner"/);
  assert.match(g, /namespace = "app\.studydesk\.planner"/);
  assert.ok(g.includes(`versionCode ${v.versionCode}\n`), 'versionCode');
  assert.ok(g.includes(`versionName "${v.versionName}"\n`), 'versionName');
  assert.match(read(`${RES}/values/strings.xml`), /<string name="app_name">Study Desk<\/string>/);
});

test('Capacitor 8 toolchain values', () => {
  const vars = read(`${A}/variables.gradle`);
  assert.match(vars, /minSdkVersion = 24/);
  assert.match(vars, /compileSdkVersion = 36/);
  assert.match(vars, /targetSdkVersion = 36/);
  assert.match(read(`${A}/gradle/wrapper/gradle-wrapper.properties`), /gradle-8\.14\.\d+-/);
});

test('launcher icons are ours, adaptive icon is wired, splash is not the Capacitor default', () => {
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      assert.ok(fs.existsSync(path.join(ROOT, RES, `mipmap-${d}`, f)), `${d}/${f}`);
    }
  }
  const xml = read(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`);
  assert.match(xml, /@color\/ic_launcher_background/);
  assert.match(xml, /@mipmap\/ic_launcher_foreground/);
  assert.match(read(`${RES}/values/ic_launcher_background.xml`), /#2540D9/i);
  const defaults = ['08cc34ad7713fe7e', '5cf98b4451bd99b2', '22f87e1e3bc89aa0', '42aa26392546fcde', '60393ce8636fd263',
    'c5015f4ba3628392', '07fa579e1c83e04b', 'b73049cb37fe76d6', '0c7f1212f25b7b90', '3db071a03b2f8ffe'];
  const splashes = walk(path.join(ROOT, RES)).filter(f => path.basename(f) === 'splash.png');
  assert.ok(splashes.length >= 11);
  for (const f of splashes) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    assert.ok(!defaults.some(d => h.startsWith(d)), 'default Capacitor splash left in ' + f);
  }
});

test('no signing material and no stale page copy in the Android project', () => {
  for (const f of walk(path.join(ROOT, 'mobile'), ['node_modules'])) {
    assert.ok(!/(\.jks|\.keystore|\.p12|keystore\.properties|local\.properties)$/i.test(f), f);
  }
  const copy = path.join(ROOT, A, 'app/src/main/assets/public/index.html');
  if (fs.existsSync(copy)) assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(path.join(ROOT, 'app/index.html'))), 'run npm run sync in mobile/');
});
