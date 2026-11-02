'use strict';
// A room's managers (/manage <agent>, the owner's call): an agent the owner names may set, toggle and
// delete loops for any agent of the room it manages, not elsewhere; plain agents keep loops to
// themselves; caps count per target agent; the owner still sees and stops every loop.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(ownerConn, { name: 'misha', room: 'dev', kind: 'human' });
  const agent = (name, room = 'dev') => {
    const conn = hub.bind(fakeClient(), auth.verify(auth.create({ name: `${name}-${room}`, role: 'agent', rooms: [room] }).token), '127.0.0.1');
    hub.register(conn, { name, room });
    return conn;
  };
  return { hub, ownerConn, ceo: agent('leader'), dev: agent('metadev'), cmo: agent('marketer'), other: agent('opendev', 'opn') };
};
const loop = (hub, conn, target, room = 'dev') => hub.loops.create(conn, { room, every: '2h', target, prompt: 'check launch blockers, open bugs and tests' });

test('manage: the manager of dev sets a loop on metadev; a plain agent cannot', () => {
  const { hub, ownerConn, ceo, cmo } = setup();
  assert.throws(() => loop(hub, ceo, 'metadev'), (e) => e.code === 403, 'not before the owner says so');
  hub.manage(ownerConn, 'dev', ['leader']);
  const l = loop(hub, ceo, 'metadev');
  assert.strictEqual(l.target, 'metadev');
  assert.strictEqual(l.by.name, 'leader', 'its creator shows');
  assert.throws(() => loop(hub, cmo, 'metadev'), (e) => e.code === 403, 'marketer manages nothing');
  hub.loops.toggle(ceo, l.id, false);
  hub.loops.remove(ceo, l.id);
});

test('manage: a manager of dev has no say in another room', () => {
  const { hub, ownerConn, ceo } = setup();
  hub.manage(ownerConn, 'dev', ['leader']);
  assert.throws(() => loop(hub, ceo, 'opendev', 'opn'), (e) => e.code === 403);
});

test('manage: caps count per target; the owner still stops what a manager made', () => {
  const { hub, ownerConn, ceo, dev } = setup();
  hub.manage(ownerConn, 'dev', ['leader']);
  for (let i = 0; i < 3; i++) loop(hub, ceo, 'metadev');
  assert.throws(() => loop(hub, ceo, 'metadev'), (e) => e.code === 429, '3 for metadev');
  for (let i = 0; i < 3; i++) loop(hub, ceo, 'leader');
  assert.throws(() => loop(hub, ceo, 'leader'), (e) => e.code === 429, 'its own 3 count apart');
  const theirs = hub.loops.list(ownerConn, 'dev')[0];
  hub.loops.remove(ownerConn, theirs.id);
  assert.throws(() => hub.loops.remove(dev, hub.loops.list(ownerConn, 'dev')[0].id), (e) => e.code === 403, 'metadev cannot delete the manager\'s loop');
});

test('manage: only the owner names managers; off takes it back', () => {
  const { hub, ownerConn, ceo } = setup();
  assert.throws(() => hub.manage(ceo, 'dev', ['leader']), (e) => e.code === 403);
  hub.manage(ownerConn, 'dev', ['leader']);
  hub.manage(ownerConn, 'dev', []);
  assert.throws(() => loop(hub, ceo, 'metadev'), (e) => e.code === 403);
});
