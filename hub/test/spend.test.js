'use strict';
// The spend guard: each agent's wrapper reports what its agent cost today (from `metacom usage`'s
// reading of its logs); the hub holds a daily budget per agent ($30 unless the owner sets one), says
// so in the room at 80%, and at 100% pauses the agent: new commands wait (control ones still act),
// loop fires are skipped, until the owner resumes it or raises its budget, or the day turns.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(ownerConn, { name: 'misha', room: 'mstudio', kind: 'human' });
  const client = fakeClient();
  const conn = hub.bind(client, auth.verify(auth.create({ name: 'director', role: 'agent', rooms: ['mstudio'] }).token), '127.0.0.1');
  hub.register(conn, { name: 'director', room: 'mstudio' });
  const memberConn = hub.bind(fakeClient(), auth.verify(auth.create({ name: 'alen', role: 'member', rooms: ['mstudio'], steer: 'answer', agents: true }).token), '127.0.0.1');
  hub.register(memberConn, { name: 'alen', room: 'mstudio', kind: 'human' });
  const typed = () => client.events.filter(([e, d]) => e === 'agents/message' && d.kind === 'command').map(([, d]) => d.text);
  const said = () => hub.store.tailRoom('mstudio', 200).filter((m) => m.kind === 'system').map((m) => m.text);
  const member = () => [...hub.members.values()].find((m) => m.name === 'director');
  return { hub, ownerConn, conn, memberConn, typed, said, member };
};

test('spend: $30 a day unless set; the room hears at 80%, once a day', () => {
  const { hub, conn, said, member } = setup();
  hub.spend(conn, { day: '2026-10-31', cost: 10 });
  assert.deepStrictEqual(said().filter((t) => /budget|of \$/.test(t)), []);
  hub.spend(conn, { day: '2026-10-31', cost: 24.5 });
  hub.spend(conn, { day: '2026-10-31', cost: 26 });
  assert.deepStrictEqual(said().filter((t) => /of its \$30/.test(t)), ['director has spent $24.50 of its $30 today (80%)']);
  assert.strictEqual(hub.publicMember(member()).spend.cost, 26);
  assert.strictEqual(hub.publicMember(member()).spend.budget, 30);
});

test('spend: at 100% the agent is paused; commands wait, control ones act, and resume delivers', async () => {
  const { hub, ownerConn, conn, typed, said, member } = setup();
  hub.spend(conn, { day: '2026-10-31', cost: 31 });
  assert.ok(said().includes('director reached its $30 budget for today ($31.00): paused. /resume director, or /budget director $<more>'), said().join(' | '));
  assert.strictEqual(hub.publicMember(member()).paused, 'budget');
  const r = await hub.send(ownerConn, 'director', 'write the next post', 'command');
  assert.ok(r.paused && r.queued, 'held, not lost');
  assert.ok(!typed().includes('write the next post'), 'not typed while paused');
  assert.ok(hub.inboxFor(conn).every((m) => m.text !== 'write the next post'), 'not in the inbox a reconnect would read');
  await hub.send(ownerConn, 'director', '!stop', 'command');
  hub.resume(ownerConn, 'director');
  assert.ok(typed().includes('write the next post'), 'delivered on resume');
  assert.strictEqual(hub.publicMember(member()).paused, undefined);
  assert.ok(said().some((t) => /misha resumed director/.test(t)));
  hub.spend(conn, { day: '2026-10-31', cost: 35 });
  assert.strictEqual(hub.publicMember(member()).paused, undefined, 'resumed for the rest of the day');
});

test('spend: a higher budget lifts the pause; only the owner sets budgets or resumes', () => {
  const { hub, ownerConn, conn, memberConn, member } = setup();
  hub.spend(conn, { day: '2026-10-31', cost: 31 });
  assert.throws(() => hub.setBudget(memberConn, 'director', 100), (e) => e.code === 403);
  assert.throws(() => hub.setBudget(conn, 'director', 100), (e) => e.code === 403, 'not the agent itself');
  assert.throws(() => hub.resume(memberConn, 'director'), (e) => e.code === 403);
  hub.setBudget(ownerConn, 'director', 95);
  assert.strictEqual(hub.publicMember(member()).paused, undefined);
  assert.strictEqual(hub.publicMember(member()).spend.budget, 95);
  assert.throws(() => hub.setBudget(ownerConn, 'director', -1), (e) => e.code === 400);
  assert.deepStrictEqual(hub.budgets(ownerConn).find((b) => b.name === 'director'), { name: 'director', room: 'mstudio', budget: 95, cost: 31, day: '2026-10-31', paused: false });
});

test('spend: a new day starts unpaused, with the alerts again', () => {
  const { hub, conn, said, member } = setup();
  hub.spend(conn, { day: '2026-10-31', cost: 25 });
  hub.spend(conn, { day: '2026-10-31', cost: 40 });
  assert.strictEqual(hub.publicMember(member()).paused, 'budget');
  hub.spend(conn, { day: '2026-11-01', cost: 1 });
  assert.strictEqual(hub.publicMember(member()).paused, undefined);
  hub.spend(conn, { day: '2026-11-01', cost: 25 });
  assert.strictEqual(said().filter((t) => /80%/.test(t)).length, 2);
});

test('spend: only an agent reports its own spend', () => {
  const { hub, ownerConn } = setup();
  assert.throws(() => hub.spend(ownerConn, { day: '2026-10-31', cost: 1 }), (e) => e.code === 403);
});
