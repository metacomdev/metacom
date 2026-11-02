'use strict';

// web/sw.js, the service worker, run with a stand-in `self`: a push shows the alert with the options
// as buttons; tapping a button answers through /push/answer; tapping the alert opens its room.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const load = ({ maxActions = 2, clients = [] } = {}) => {
  const handlers = {};
  const shown = [];
  const fetched = [];
  const opened = [];
  const self = {
    location: { origin: 'https://hub.example.test' },
    addEventListener: (name, fn) => (handlers[name] = fn),
    skipWaiting() {},
    registration: { showNotification: async (title, options) => shown.push({ title, ...options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async (url) => opened.push(url),
    },
  };
  const sandbox = { self, Notification: { maxActions }, URL, JSON, Number, String, fetch: async (url, init) => (fetched.push({ url, init }), { json: async () => ({ ok: true, text: 'builder: 2. Yes' }) }) };
  sandbox.self.Notification = sandbox.Notification;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'sw.js'), 'utf8'), sandbox);
  const fire = async (name, event) => {
    let waited = null;
    handlers[name]({ ...event, waitUntil: (p) => (waited = p) });
    await waited;
  };
  return { fire, shown, fetched, opened };
};

const ALERT = { kind: 'blocked', title: 'builder needs you', body: 'trust this folder?\n1. No\n2. Yes\n3. Later', where: 'builder · dev', url: 'https://hub.example.test/dev', tag: 'q-builder@dev', options: ['1. No', '2. Yes', '3. Later'], cap: 'cap123' };

test('a push shows the alert, its options as buttons up to what the platform has', async () => {
  const sw = load({ maxActions: 2 });
  await sw.fire('push', { data: { json: () => ALERT } });
  const n = sw.shown[0];
  assert.strictEqual(n.title, 'builder needs you');
  assert.match(n.body, /— builder · dev$/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(n.actions)), [{ action: '1', title: '1. No' }, { action: '2', title: '2. Yes' }]); // objects from the vm realm
  assert.strictEqual(n.requireInteraction, true);
  const done = load();
  await done.fire('push', { data: { json: () => ({ kind: 'done', title: 'builder is done', body: 'built', url: '/dev', tag: 'd', options: [], cap: null }) } });
  assert.strictEqual(done.shown[0].actions.length, 0);
});

test('a button answers through /push/answer with the capability, and says how it went', async () => {
  const sw = load();
  const notification = { data: ALERT, close() {} };
  await sw.fire('notificationclick', { action: '2', notification });
  assert.strictEqual(sw.fetched[0].url, '/push/answer');
  assert.deepStrictEqual(JSON.parse(sw.fetched[0].init.body), { c: 'cap123', n: 2 });
  assert.deepStrictEqual([sw.shown[0].title, sw.shown[0].body], ['Answered', 'builder: 2. Yes']);
});

test('a tap on the alert opens its room, in the open window when there is one', async () => {
  const notification = { data: ALERT, close() {} };
  const fresh = load();
  await fresh.fire('notificationclick', { action: '', notification });
  assert.deepStrictEqual(fresh.opened, ['/dev']);
  const went = [];
  const win = { url: 'https://hub.example.test/opn', navigate: async (p) => (went.push(p), win), focus: async () => went.push('focus') };
  const open = load({ clients: [win] });
  await open.fire('notificationclick', { action: '', notification });
  assert.deepStrictEqual(went, ['/dev', 'focus']);
});
