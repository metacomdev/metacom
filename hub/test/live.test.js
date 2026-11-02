'use strict';

// Live mode (docs/direct.md): the owner watches an agent's screen as frames relayed by the hub and
// types into it. Only the owner; frames only while someone watches; viewers told when it ends.

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
const got = (client, event) => client.events.filter(([e]) => e === event).map(([, d]) => d);

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerClient = fakeClient();
  const ownerConn = hub.bind(ownerClient, owner, '127.0.0.1');
  const agentClient = fakeClient();
  const agentConn = hub.bind(agentClient, auth.verify(auth.create({ name: 'a', role: 'agent' }).token), '127.0.0.1');
  hub.register(agentConn, { name: 'Alex', room: 'dev' });
  hub.setStatus(agentConn, 'waiting', 'idle');
  const peerClient = fakeClient();
  const peerConn = hub.bind(peerClient, auth.verify(auth.create({ name: 'b', role: 'agent' }).token), '127.0.0.1');
  hub.register(peerConn, { name: 'Bea', room: 'dev' });
  const room = () => hub.history(ownerConn, 'dev', 50).messages || hub.history(ownerConn, 'dev', 50);
  return { hub, ownerConn, ownerClient, agentConn, agentClient, peerConn, room };
};

test('live: the owner starts it, the wrapper is asked for frames, frames reach the viewer', () => {
  const { hub, ownerConn, ownerClient, agentConn, agentClient, room } = setup();
  assert.deepStrictEqual(hub.liveFrame(agentConn, { lines: { 0: 'x' } }), { watched: false });
  hub.live(ownerConn, 'Alex', true);
  assert.strictEqual(got(agentClient, 'agents/liveStart').length, 1);
  assert.ok(room().some((m) => m.kind === 'system' && /is in Alex's terminal \(direct\)/.test(m.text)));
  hub.liveFrame(agentConn, { cols: 80, rows: 24, cursor: [2, 3], full: true, lines: { 0: '\u001b[0;1mhi\u001b[0m', 23: '> ' } });
  assert.deepStrictEqual(got(ownerClient, 'agents/liveFrame'), [{ name: 'Alex', cols: 80, rows: 24, cursor: [2, 3], full: true, lines: { 0: '\u001b[0;1mhi\u001b[0m', 23: '> ' } }]);
});

test('live: keys go to the agent only from a watching owner; others are refused', async () => {
  const { hub, ownerConn, agentClient, peerConn } = setup();
  assert.throws(() => hub.liveKeys(ownerConn, 'Alex', 'x'), (e) => e.code === 409);
  hub.live(ownerConn, 'Alex', true);
  hub.liveKeys(ownerConn, 'Alex', '\u001b[B\r');
  assert.deepStrictEqual(got(agentClient, 'agents/liveKeys'), [{ data: '\u001b[B\r' }]);
  assert.throws(() => hub.live(peerConn, 'Alex', true), (e) => e.code === 403);
  assert.throws(() => hub.liveKeys(peerConn, 'Alex', 'x'), (e) => e.code === 403);
});

test('live: leaving stops the frames; a viewer that disconnects counts as leaving', () => {
  const { hub, ownerConn, ownerClient, agentConn, agentClient, room } = setup();
  hub.live(ownerConn, 'Alex', true);
  hub.live(ownerConn, 'Alex', false);
  assert.strictEqual(got(agentClient, 'agents/liveStop').length, 1);
  assert.ok(room().some((m) => /left Alex's terminal \(direct\)/.test(m.text)));
  assert.deepStrictEqual(hub.liveFrame(agentConn, { lines: {} }), { watched: false });
  hub.live(ownerConn, 'Alex', true);
  hub.unbind(ownerClient);
  assert.strictEqual(got(agentClient, 'agents/liveStop').length, 2);
});

test('live: when the agent goes, its viewers are told; an offline agent cannot be watched', () => {
  const { hub, ownerConn, ownerClient, agentClient } = setup();
  hub.live(ownerConn, 'Alex', true);
  hub.unbind(agentClient);
  assert.deepStrictEqual(got(ownerClient, 'agents/liveEnd'), [{ name: 'Alex', reason: 'disconnected' }]);
  assert.throws(() => hub.live(ownerConn, 'Alex', true), (e) => e.code === 409);
});

test('live: scrolling back asks the wrapper for a screenful from its scrollback and answers the viewer alone; nothing to the agent', async () => {
  const { hub, ownerConn, agentConn, agentClient, peerConn } = setup();
  await assert.rejects(hub.liveScroll(ownerConn, 'Alex', 10), /Not watching Alex/);
  hub.live(ownerConn, 'Alex', true);
  const asked = hub.liveScroll(ownerConn, 'Alex', 10);
  const [req] = got(agentClient, 'agents/liveScroll');
  assert.strictEqual(req.offset, 10);
  assert.deepStrictEqual(hub.liveHistory(peerConn, req.req, { lines: ['not mine'] }), { taken: false }, 'only that agent answers');
  hub.liveHistory(agentConn, req.req, { cols: 80, rows: 2, offset: 10, max: 120, lines: ['line 98', 'line 99'] });
  assert.deepStrictEqual(await asked, { name: 'Alex', cols: 80, rows: 2, offset: 10, max: 120, lines: ['line 98', 'line 99'] });
  assert.strictEqual(got(agentClient, 'agents/liveKeys').length, 0, 'not a key for the agent');
  assert.throws(() => hub.owner(agentConn), /Owners only/);
  await assert.rejects(hub.liveScroll(agentConn, 'Alex', 1), /Owners only/);
});
