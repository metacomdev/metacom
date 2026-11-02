'use strict';
// Owner approvals: an agent asks for an outward action (deploy, publish, push, start an agent); only
// the hub owner can approve or decline it; the decision is recorded in the room and typed into the
// agent as the owner's own word, with the request's id.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(ownerConn, { name: 'misha', room: 'dev', kind: 'human' });
  const agent = (name) => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(auth.create({ name, role: 'agent', rooms: ['dev'] }).token), '127.0.0.1');
    hub.register(conn, { name, room: 'dev' });
    return { conn, client, typed: () => client.events.filter(([e, d]) => e === 'agents/message' && d.kind === 'command').map(([, d]) => d.text) };
  };
  const memberConn = hub.bind(fakeClient(), auth.verify(auth.create({ name: 'alen', role: 'member', rooms: ['dev'], steer: 'answer', agents: true }).token), '127.0.0.1');
  hub.register(memberConn, { name: 'alen', room: 'dev', kind: 'human' });
  const roomLog = () => hub.store.tailRoom('dev', 100);
  return { hub, ownerConn, memberConn, agent, roomLog };
};

test('approvals: an agent asks, the room sees it with its id, open', () => {
  const { hub, agent, roomLog } = setup();
  const builder = agent('builder');
  const r = hub.request(builder.conn, 'dev', 'push main to origin', '3 commits, tests green');
  assert.match(r.id, /^[0-9a-f]{8}$/);
  const msg = roomLog().find((m) => m.kind === 'request');
  assert.ok(msg, 'posted in the room');
  assert.deepStrictEqual({ ...msg.request, ts: undefined }, { id: r.id, agent: 'builder', room: 'dev', action: 'push main to origin', detail: '3 commits, tests green', risk: 'outward', status: 'open', ts: undefined });
  assert.strictEqual(msg.from.name, 'builder');
  assert.deepStrictEqual(hub.requests(builder.conn, 'dev').map((q) => q.id), [r.id]);
});

test('approvals: the owner approves; the room records it and the agent gets the owner\'s word', () => {
  const { hub, ownerConn, agent, roomLog } = setup();
  const builder = agent('builder');
  const { id } = hub.request(builder.conn, 'dev', 'restart the hub', '');
  const d = hub.decide(ownerConn, id, true);
  assert.strictEqual(d.status, 'approved');
  assert.ok(roomLog().some((m) => m.kind === 'system' && m.text === `misha approved "restart the hub" (request ${id})`));
  assert.ok(builder.typed().some((t) => t === `APPROVED ${id}: restart the hub`), builder.typed().join(' | '));
  const updated = hub.history(ownerConn, 'dev', 50).filter((m) => m.kind === 'request').at(-1);
  assert.strictEqual(updated.request.status, 'approved', 'the request line shows the decision');
  assert.strictEqual(updated.request.by, 'misha');
  assert.deepStrictEqual(hub.requests(builder.conn, 'dev'), [], 'no longer open');
});

test('approvals: a decline reaches the agent too', () => {
  const { hub, ownerConn, agent } = setup();
  const builder = agent('builder');
  const { id } = hub.request(builder.conn, 'dev', 'publish the release', 'v0.1.0');
  hub.decide(ownerConn, id, false);
  assert.ok(builder.typed().some((t) => t === `DECLINED ${id}: publish the release`));
});

test('approvals: only the hub owner decides, once', () => {
  const { hub, ownerConn, memberConn, agent } = setup();
  const builder = agent('builder');
  const other = agent('reviewer');
  const { id } = hub.request(builder.conn, 'dev', 'deploy the site', '');
  assert.throws(() => hub.decide(builder.conn, id, true), (e) => e.code === 403, 'not the asking agent');
  assert.throws(() => hub.decide(other.conn, id, true), (e) => e.code === 403, 'not another agent');
  assert.throws(() => hub.decide(memberConn, id, true), (e) => e.code === 403, 'not a member or user');
  hub.decide(ownerConn, id, true);
  assert.throws(() => hub.decide(ownerConn, id, false), (e) => e.code === 409, 'decided already');
  assert.throws(() => hub.decide(ownerConn, 'ffffffff', true), (e) => e.code === 404);
});

test('approvals: a request left for a day expires and can no longer be approved', () => {
  const { hub, ownerConn, agent } = setup();
  const builder = agent('builder');
  const { id } = hub.request(builder.conn, 'dev', 'send the outreach batch', '');
  hub.approvals.get(id).ts = new Date(Date.now() - 25 * 3600e3).toISOString();
  assert.throws(() => hub.decide(ownerConn, id, true), (e) => e.code === 410);
  assert.deepStrictEqual(hub.requests(builder.conn, 'dev'), []);
});

test('approvals: what is asked is kept short and plain', () => {
  const { hub, agent } = setup();
  const builder = agent('builder');
  assert.throws(() => hub.request(builder.conn, 'dev', '', ''), (e) => e.code === 400);
  assert.throws(() => hub.request(builder.conn, 'dev', 'x'.repeat(201), ''), (e) => e.code === 400);
  assert.throws(() => hub.request(builder.conn, 'dev', 'push', 'y'.repeat(2001)), (e) => e.code === 400);
});

test('approvals: they survive a hub restart', () => {
  const { hub, ownerConn, agent } = setup();
  const builder = agent('builder');
  const { id } = hub.request(builder.conn, 'dev', 'push main', '');
  const again = new Hub({ dataDir: hub.store.dir, auth: hub.auth, console: quiet });
  assert.strictEqual(again.approvals.get(id)?.status, 'open');
  void ownerConn;
});

test('approvals: a request carries its risk; routine ones are approved together, the others one by one', () => {
  const { hub, ownerConn, memberConn, agent } = setup();
  const builder = agent('builder');
  const a = hub.request(builder.conn, 'dev', 'restart the preview server', '', 'routine');
  const b = hub.request(builder.conn, 'dev', 'rerun the nightly build', '', 'routine');
  const c = hub.request(builder.conn, 'dev', 'push main to origin', '', 'outward');
  const d = hub.request(builder.conn, 'dev', 'drop the staging database', '', 'irreversible');
  assert.strictEqual(hub.approvals.get(c.id).risk, 'outward');
  assert.strictEqual(hub.request(builder.conn, 'dev', 'something', '').id && hub.approvals.get([...hub.approvals.keys()].at(-1)).risk, 'outward', 'outward by default');
  assert.throws(() => hub.request(builder.conn, 'dev', 'x', '', 'whatever'), (e) => e.code === 400);
  assert.throws(() => hub.decideAll(memberConn, 'dev', true), (e) => e.code === 403);
  const r = hub.decideAll(ownerConn, 'dev', true);
  assert.deepStrictEqual(r.decided.sort(), [a.id, b.id].sort(), 'only the routine ones');
  assert.ok(builder.typed().includes(`APPROVED ${a.id}: restart the preview server`) && builder.typed().includes(`APPROVED ${b.id}: rerun the nightly build`));
  const open = hub.requests(builder.conn, 'dev').map((q) => q.id);
  assert.ok(open.includes(c.id) && open.includes(d.id), 'outward and irreversible stay open');
});

test('approvals: the owner sees every open one, in every room', () => {
  const { hub, ownerConn, agent } = setup();
  const builder = agent('builder');
  hub.request(builder.conn, 'dev', 'push main', '');
  const all = hub.pendingApprovals(ownerConn);
  assert.deepStrictEqual(all.map((r) => [r.room, r.action]), [['dev', 'push main']]);
  assert.throws(() => hub.pendingApprovals(builder.conn), (e) => e.code === 403);
});

const TRUST = { text: 'Accessing workspace:\n/home/x/metasales\nQuick safety check: Is this a project you created or one you trust?', options: [{ label: 'No, exit' }, { label: 'Yes, I trust this folder' }] };
const TOOL = { text: 'Tool use\nBash: rm -rf build\nDo you want to proceed?', options: [{ label: 'Yes' }, { label: "Yes, and don't ask again" }, { label: 'No' }] };
const ask = (hub, conn, q) => hub.setStatus(conn, 'blocked', 'screen', { ...q, id: require('node:crypto').randomBytes(6).toString('hex') });

test('delegate: the owner lets a named agent answer folder-trust questions, and nothing else', async () => {
  const { hub, ownerConn, memberConn, agent } = setup();
  const ceo = agent('leader');
  const sales = agent('sales');
  const other = agent('reviewer');
  assert.throws(() => hub.delegate(memberConn, 'answers', ['leader']), (e) => e.code === 403);
  assert.throws(() => hub.delegate(ceo.conn, 'answers', ['leader']), (e) => e.code === 403, 'not the agent itself');
  assert.deepStrictEqual(hub.delegate(ownerConn, 'answers', ['leader']), { answers: ['leader'] });
  ask(hub, sales.conn, TRUST);
  await assert.rejects(hub.send(other.conn, 'sales', '2'), (e) => e.code === 403, 'an agent not named still cannot');
  const r = await hub.send(ceo.conn, 'sales', '2');
  assert.strictEqual(r.option, 2, 'the named one answers the trust question');
  ask(hub, sales.conn, TOOL);
  await assert.rejects(hub.send(ceo.conn, 'sales', '1'), (e) => e.code === 403, 'never a tool permission');
  const { id } = hub.request(sales.conn, 'dev', 'push main', '');
  assert.throws(() => hub.decide(ceo.conn, id, true), (e) => e.code === 403, 'never an owner approval');
  hub.delegate(ownerConn, 'answers', []);
  ask(hub, sales.conn, TRUST);
  await assert.rejects(hub.send(ceo.conn, 'sales', '2'), (e) => e.code === 403, 'taken back');
});
