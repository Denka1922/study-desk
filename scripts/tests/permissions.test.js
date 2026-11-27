'use strict';
// The microphone is the only permission the app page may get: audio only, for the app's own page, in the app's own window.
const test = require('node:test');
const assert = require('node:assert');
const { createPermissionHandlers } = require('../../desktop/permissions');

const APP = 'file:///C:/Program%20Files/Study%20Desk/resources/app/index.html';
const WC = { id: 1 }, OTHER = { id: 2 };
const rig = (o = {}) => createPermissionHandlers({ appFileUrl: APP, isAppContents: wc => wc === WC, ...o });
const ask = (h, wc, permission, details) => new Promise(res => h.request(wc, permission, res, details));
const MIC = { mediaTypes: ['audio'], requestingUrl: APP, isMainFrame: true };

test('the app page may use the microphone', async () => {
  const h = rig();
  assert.strictEqual(await ask(h, WC, 'media', MIC), true);
  assert.strictEqual(await ask(h, WC, 'media', { ...MIC, requestingUrl: APP + '#tutor' }), true, 'the address after # is ignored');
  assert.strictEqual(h.check(WC, 'media', 'file:///', { mediaType: 'audio', requestingUrl: APP, isMainFrame: true }), true);
});

test('the camera, the screen, other windows, other pages and every other permission are refused', async () => {
  const h = rig();
  for (const d of [{ ...MIC, mediaTypes: ['video'] }, { ...MIC, mediaTypes: ['audio', 'video'] }, { ...MIC, mediaTypes: [] }, { ...MIC, mediaTypes: undefined }, { ...MIC, mediaTypes: 'audio' },
    { ...MIC, requestingUrl: 'https://evil.example/' }, { ...MIC, requestingUrl: 'file:///C:/other/index.html' }, { ...MIC, requestingUrl: undefined }, { ...MIC, isMainFrame: false }]) {
    assert.strictEqual(await ask(h, WC, 'media', d), false, JSON.stringify(d));
  }
  assert.strictEqual(await ask(h, OTHER, 'media', MIC), false, 'only the app window');
  assert.strictEqual(await ask(h, null, 'media', MIC), false);
  assert.strictEqual(await ask(h, WC, 'media'), false, 'no details at all');
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'display-capture', 'midi', 'openExternal', 'fullscreen', 'camera', 'microphone']) assert.strictEqual(await ask(h, WC, p, MIC), false, p);
  const c = (wc, p, d) => h.check(wc, p, 'file:///', d);
  assert.strictEqual(c(WC, 'media', { mediaType: 'video', requestingUrl: APP, isMainFrame: true }), false);
  assert.strictEqual(c(WC, 'media', { mediaType: 'unknown', requestingUrl: APP, isMainFrame: true }), false);
  assert.strictEqual(c(WC, 'media', { mediaType: 'audio', requestingUrl: 'https://evil.example/', isMainFrame: true }), false);
  assert.strictEqual(c(OTHER, 'media', { mediaType: 'audio', requestingUrl: APP, isMainFrame: true }), false);
  assert.strictEqual(c(WC, 'geolocation', { requestingUrl: APP, isMainFrame: true }), false);
  assert.strictEqual(c(WC, 'media'), false);
});

test('without an app address nothing is ever allowed', async () => {
  const h = createPermissionHandlers({ appFileUrl: '', isAppContents: () => true });
  assert.strictEqual(await ask(h, WC, 'media', MIC), false);
  assert.strictEqual(h.check(WC, 'media', '', { mediaType: 'audio', requestingUrl: '', isMainFrame: true }), false);
});

test('on a Mac the system is asked first, and a "no" from the system is a no', async () => {
  const asked = []; const yes = rig({ askMicrophone: async () => { asked.push(1); return true; } }), no = rig({ askMicrophone: async () => false }), boom = rig({ askMicrophone: async () => { throw new Error('x'); } });
  assert.strictEqual(await ask(yes, WC, 'media', MIC), true); assert.strictEqual(asked.length, 1);
  assert.strictEqual(await ask(no, WC, 'media', MIC), false);
  assert.strictEqual(await ask(boom, WC, 'media', MIC), false);
  assert.strictEqual(await ask(yes, WC, 'media', { ...MIC, mediaTypes: ['video'] }), false); assert.strictEqual(asked.length, 1, 'the system is not asked for requests that are refused anyway');
});
