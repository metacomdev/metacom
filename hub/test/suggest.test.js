'use strict';

// Suggested replies: a message can carry the reply its sender recommends. Only the people it is
// to (sent to them, or @named) see it; agents and everyone else get the message without it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { Push } = require('../lib/push.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => ({ events: [], source: '127.0.0.1', on() {}, emit(name, data) { this.events.push([name, data]); }, close() {} });
const SUGGEST = 'Yes, ship it after the tests pass';

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-suggest-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const ownerRecord = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const person = (name, record = ownerRecord) => {
    const client = fakeClient();
    const conn = hub.bind(client, record, '127.0.0.1');
    hub.register(conn, { name, room: 'dev', kind: 'human' });
    return { conn, client, seen: () => client.events.filter(([e]) => e === 'room/message').map(([, m]) => m) };
  };
  const misha = person('misha');
  const ana = person('ana', auth.verify(auth.create({ name: 'ana', role: 'member', rooms: ['dev'] }).token));
  const agentToken = auth.create({ name: 'machine', role: 'agent' }).token;
  const agent = (name) => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(agentToken), '127.0.0.1');
    hub.register(conn, { name, room: 'dev' });
    hub.setStatus(conn, 'waiting', 'idle');
    return { conn, client, got: () => client.events.filter(([e]) => e === 'agents/message' || e === 'room/message').map(([, m]) => m) };
  };
  return { hub, dir, misha, ana, agent };
};

test('sent to a person: only that person sees the suggestion', async () => {
  const { hub, misha, ana, agent } = setup();
  const builder = agent('builder');
  const other = agent('other');
  const r = await hub.send(builder.conn, 'misha', 'Tests are green. Ship 0.2 now?', 'info', null, null, { suggest: `  ${SUGGEST}\n` });
  assert.strictEqual(misha.seen().at(-1).suggest, SUGGEST, 'trimmed to one line');
  assert.strictEqual(ana.seen().at(-1).suggest, undefined);
  assert.strictEqual(other.got().at(-1).suggest, undefined, 'never an agent');
  assert.strictEqual(hub.history(misha.conn, 'dev').find((m) => m.id === r.id).suggest, SUGGEST);
  assert.strictEqual(hub.history(ana.conn, 'dev').find((m) => m.id === r.id).suggest, undefined);
  assert.strictEqual(hub.history(builder.conn, 'dev').find((m) => m.id === r.id).suggest, undefined);
  assert.throws(() => hub.say(builder.conn, 'dev', 'x', null, { suggest: 'y'.repeat(501) }), /at most 500/);
});

test('@named in a room message: those people see it; an agent sent one never does', async () => {
  const { hub, misha, ana, agent } = setup();
  const builder = agent('builder');
  hub.say(builder.conn, 'dev', '@ana the copy is ready, approve?', null, { suggest: 'Approved' });
  assert.strictEqual(ana.seen().at(-1).suggest, 'Approved');
  assert.strictEqual(misha.seen().at(-1).suggest, undefined, 'the owner is not named here');
  // a person suggests to an agent: the agent's input never carries it
  await hub.send(misha.conn, 'builder', 'Ship it?', 'command', null, null, { suggest: 'yes' });
  const toBuilder = builder.client.events.filter(([e]) => e === 'agents/message').map(([, m]) => m).at(-1);
  assert.strictEqual(toBuilder.suggest, undefined);
  assert.strictEqual(hub.inboxFor(builder.conn).at(-1).suggest, undefined);
});

test('an edit can change it, the latest wins; a reply carries what it answers', async () => {
  const { hub, misha, agent } = setup();
  const builder = agent('builder');
  const sent = await hub.send(builder.conn, 'misha', 'Which plan?', 'info', null, null, { suggest: 'Plan A' });
  hub.edit(builder.conn, sent.id, 'Which plan? (A is cheaper)', 'Plan A, the cheaper one');
  const edit = misha.client.events.filter(([e]) => e === 'room/edit').at(-1)[1];
  assert.strictEqual(edit.message.suggest, 'Plan A, the cheaper one');
  hub.edit(builder.conn, sent.id, 'Which plan? (A is cheaper, B faster)');
  assert.strictEqual(hub.history(misha.conn, 'dev').find((m) => m.id === sent.id).suggest, 'Plan A, the cheaper one', 'an edit without one keeps it');
  const reply = await hub.send(misha.conn, 'builder', 'Plan A', 'command', null, null, { replyTo: sent.id });
  assert.strictEqual(hub.history(misha.conn, 'dev').find((m) => m.id === reply.id).replyTo, sent.id);
  await assert.rejects(hub.send(misha.conn, 'builder', 'x', 'command', null, null, { replyTo: 'nope' }), /replyTo/);
});

test('the done alert knows a message to a person is waiting (never what it says)', async () => {
  const { hub, misha, agent } = setup();
  hub.push = new Push({ store: hub.store, console: quiet, env: {} });
  const bodies = [];
  hub.push.alert = async (kind, member, unread) => bodies.push([kind, unread]);
  const builder = agent('builder');
  await hub.send(misha.conn, 'builder', 'make the page', 'command');
  hub.setStatus(builder.conn, 'working', 'busy');
  await hub.send(builder.conn, 'misha', 'The page is built. Publish it?', 'info', null, null, { suggest: 'Publish it' });
  hub.setStatus(builder.conn, 'waiting', 'idle');
  assert.deepStrictEqual(bodies.at(-1), ['done', true]);
});

test('a checklist suggestion keeps its lines; stats: accepted, edited, ignored per agent', async () => {
  const { hub, misha, agent } = setup();
  const builder = agent('builder');
  const ceo = agent('leader');
  const list = await hub.send(builder.conn, 'misha', 'Which steps?', 'info', null, null, { suggest: 'do these:\n  - [x] tests  \n- [ ] tag\n\n' });
  assert.strictEqual(misha.seen().at(-1).suggest, 'do these:\n- [x] tests\n- [ ] tag');
  assert.strictEqual(list.person, true, 'the result says it went to a person');
  const a = await hub.send(builder.conn, 'misha', 'Ship?', 'info', null, null, { suggest: 'yes, ship it' });
  const b = await hub.send(ceo.conn, 'misha', 'Post?', 'info', null, null, { suggest: 'post at 9' });
  await hub.send(ceo.conn, 'misha', 'Title?', 'info', null, null, { suggest: 'the second' });
  await hub.send(misha.conn, 'builder', 'Yes, ship  it', 'command', null, null, { replyTo: a.id }); // as suggested (case, spaces)
  await hub.send(misha.conn, 'builder', 'do these:\n- [x] tests\n- [x] tag', 'command', null, null, { replyTo: list.id }); // ticked one more
  await hub.send(misha.conn, 'leader', 'post at 10', 'command', null, null, { replyTo: b.id }); // changed
  assert.deepStrictEqual(hub.suggestStats(misha.conn), {
    builder: { suggested: 2, accepted: 1, edited: 1, ignored: 0 },
    leader: { suggested: 2, accepted: 0, edited: 1, ignored: 1 },
  });
  assert.throws(() => hub.suggestStats(builder.conn), /Owners only/);
});

test('room/suggestions: the ones waiting for you, from all of the history, however far back', async () => {
  const { hub, misha, ana, agent } = setup();
  const builder = agent('builder');
  const ceo = agent('leader');
  const old = await hub.send(builder.conn, 'misha', 'Ship 0.2?', 'info', null, null, { suggest: 'yes, ship it' });
  const answered = await hub.send(builder.conn, 'misha', 'Tag it?', 'info', null, null, { suggest: 'tag v0.2.0', keepOlder: true });
  const plain = await hub.send(ceo.conn, 'misha', 'Post?', 'info', null, null, { suggest: 'post at 9' });
  hub.say(builder.conn, 'dev', '@ana approve the copy?', null, { suggest: 'Approved' });
  for (let i = 0; i < 600; i++) hub.say(builder.conn, 'dev', `log line ${i}`);
  await hub.send(misha.conn, 'builder', 'tag v0.2.0-rc1', 'command', null, null, { replyTo: answered.id });
  await hub.send(misha.conn, 'leader', 'not yet', 'command'); // answers leader's, no message in particular
  const later = await hub.send(ceo.conn, 'misha', 'Now?', 'info', null, null, { suggest: 'now', keepOlder: true });
  assert.ok(!hub.history(misha.conn, 'dev', 500).some((m) => m.id === old.id), 'older than any history window');
  assert.deepStrictEqual(hub.suggestions(misha.conn, 'dev').suggestions.map((m) => m.id), [old.id, later.id]);
  assert.deepStrictEqual(hub.suggestions(ana.conn, 'dev').suggestions.map((m) => m.suggest), ['Approved'], 'per reader');
  assert.deepStrictEqual(hub.suggestions(builder.conn, 'dev').suggestions, [], 'never an agent');
  assert.ok(plain.id);
  // the jump back to it: the room from just before it to now
  const back = hub.history(misha.conn, 'dev', 50, null, old.id);
  const at = back.findIndex((m) => m.id === old.id);
  assert.ok(at >= 0 && at <= 2, 'from just before it');
  assert.strictEqual(back.at(-1).id, later.id, 'to now');
  assert.strictEqual(back[at].suggest, 'yes, ship it');
  assert.throws(() => hub.history(misha.conn, 'dev', 50, null, 'nope'), /No such message/);
});

test('room/message: one message by id, its latest version, pinned, as its reader sees it', async () => {
  const { hub, misha, ana, agent } = setup();
  const builder = agent('builder');
  const ask = await hub.send(builder.conn, 'misha', 'Ship 0.2?', 'info', null, null, { suggest: 'yes' });
  for (let i = 0; i < 600; i++) hub.say(builder.conn, 'dev', `log line ${i}`);
  hub.edit(builder.conn, ask.id, 'Ship 0.2 today?');
  hub.pin(misha.conn, ask.id, true);
  const m = hub.message(misha.conn, 'dev', ask.id);
  assert.strictEqual(m.text, 'Ship 0.2 today?');
  assert.strictEqual(m.pinned, true);
  assert.strictEqual(m.suggest, 'yes');
  assert.strictEqual(hub.message(ana.conn, 'dev', ask.id).suggest, undefined, 'per reader');
  assert.throws(() => hub.message(misha.conn, 'dev', '00000000-0000-4000-8000-000000000000'), /No such message/);
  assert.throws(() => hub.message(misha.conn, 'dev', 'x'), /the id of a message/);
});

test('Esc puts a suggestion away for good: for that person, on all their devices, after a reload', async () => {
  const { hub, dir, misha, ana, agent } = setup();
  const builder = agent('builder');
  const a = await hub.send(builder.conn, 'misha', 'Ship 0.2?', 'info', null, null, { suggest: SUGGEST });
  const b = await hub.send(builder.conn, 'misha', 'And tag it?', 'info', null, null, { suggest: 'Tag it v0.2', keepOlder: true });
  hub.say(builder.conn, 'dev', '@ana @misha the copy is ready, approve?', null, { suggest: 'Approved', keepOlder: true });
  const waiting = (conn) => hub.suggestions(conn, 'dev').suggestions.map((m) => m.text);
  assert.deepStrictEqual(waiting(misha.conn), ['Ship 0.2?', 'And tag it?', '@ana @misha the copy is ready, approve?']);
  // his phone is open too: it is told, and drops it from its queue
  const phone = fakeClient();
  const phoneConn = hub.bind(phone, misha.conn.record, '127.0.0.1');
  phoneConn.name = 'misha';
  phoneConn.room = 'dev';
  assert.deepStrictEqual(hub.dismiss(misha.conn, 'dev', a.id), { room: 'dev', id: a.id });
  assert.deepStrictEqual(phone.events.filter(([e]) => e === 'room/dismissed').map(([, d]) => d), [{ room: 'dev', id: a.id }]);
  assert.ok(!ana.client.events.some(([e]) => e === 'room/dismissed'), 'nobody else is told');
  assert.deepStrictEqual(waiting(misha.conn), ['And tag it?', '@ana @misha the copy is ready, approve?']);
  // the message stays in the feed, without its suggestion for him
  const shown = hub.history(misha.conn, 'dev').find((m) => m.id === a.id);
  assert.deepStrictEqual([shown.text, shown.suggest], ['Ship 0.2?', undefined]);
  assert.strictEqual(hub.history(misha.conn, 'dev').find((m) => m.id === b.id).suggest, 'Tag it v0.2');
  // ana's own offer of the shared one is hers to put away, not his
  const shared = hub.history(misha.conn, 'dev').at(-1);
  hub.dismiss(misha.conn, 'dev', shared.id);
  assert.deepStrictEqual(waiting(ana.conn), ['@ana @misha the copy is ready, approve?']);
  // a hub restarted: still away
  const again = new Hub({ dataDir: dir, auth: hub.auth, console: quiet });
  const conn = again.bind(fakeClient(), misha.conn.record, '127.0.0.1');
  again.register(conn, { name: 'misha', room: 'dev', kind: 'human' });
  assert.deepStrictEqual(again.suggestions(conn, 'dev').suggestions.map((m) => m.text), ['And tag it?']);
  assert.throws(() => hub.dismiss(misha.conn, 'dev', 'nope'), /the id of a message/);
});

test('a suggestion stops waiting: after 12 hours (or its own suggestTtl), withdrawn by its sender, or superseded by a newer one to the same person', async () => {
  const { hub, misha, ana, agent } = setup();
  const builder = agent('builder');
  const ceo = agent('leader');
  const waiting = () => hub.suggestions(misha.conn, 'dev').suggestions.map((m) => m.text);
  const t0 = Date.now();
  const realNow = Date.now;
  try {
    const old = await hub.send(builder.conn, 'misha', 'Ship 0.2?', 'info', null, null, { suggest: 'ship' });
    const short = await hub.send(ceo.conn, 'misha', 'Lunch?', 'info', null, null, { suggest: 'yes', suggestTtl: 1 });
    assert.deepStrictEqual(waiting(), ['Ship 0.2?', 'Lunch?']);
    assert.ok(hub.history(misha.conn, 'dev').find((m) => m.id === old.id).suggestUntil, 'the clients are told until when');
    Date.now = () => t0 + 2 * 3600_000;
    assert.deepStrictEqual(waiting(), ['Ship 0.2?'], 'its own 1 h');
    Date.now = () => t0 + 13 * 3600_000;
    assert.deepStrictEqual(waiting(), [], 'the 12 h default');
    const shown = hub.history(misha.conn, 'dev').find((m) => m.id === old.id);
    assert.deepStrictEqual([shown.text, shown.suggest], ['Ship 0.2?', undefined], 'expired: in the feed, without it');
    assert.ok(short.id);
  } finally {
    Date.now = realNow;
  }
  // a newer one from the same sender to the same person stops the older; another sender's stays
  const a = await hub.send(builder.conn, 'misha', 'Push 0.3?', 'info', null, null, { suggest: 'push' });
  const c = await hub.send(ceo.conn, 'misha', 'Post it?', 'info', null, null, { suggest: 'post' });
  hub.say(builder.conn, 'dev', '@ana copy ok?', null, { suggest: 'ok' });
  const b = await hub.send(builder.conn, 'misha', 'Push 0.3 and restart?', 'info', null, null, { suggest: 'push restart' });
  assert.deepStrictEqual(waiting(), ['Post it?', 'Push 0.3 and restart?']);
  assert.deepStrictEqual(hub.suggestions(ana.conn, 'dev').suggestions.map((m) => m.text), ['@ana copy ok?'], 'to another person: stays');
  assert.ok(misha.client.events.some(([e, d]) => e === 'room/withdrawn' && d.ids.includes(a.id)), 'the clients are told');
  // unless the new one says to keep them
  await hub.send(builder.conn, 'misha', 'Also tag it?', 'info', null, null, { suggest: 'tag', keepOlder: true });
  assert.deepStrictEqual(waiting(), ['Post it?', 'Push 0.3 and restart?', 'Also tag it?']);
  // withdrawn by its sender, only
  assert.throws(() => hub.unsuggest(builder.conn, c.id), /Only its sender/);
  assert.deepStrictEqual(hub.unsuggest(builder.conn, b.id), { id: b.id, room: 'dev', withdrawn: true });
  assert.deepStrictEqual(waiting(), ['Post it?', 'Also tag it?']);
  assert.strictEqual(hub.history(misha.conn, 'dev').find((m) => m.id === b.id).text, 'Push 0.3 and restart?', 'the message stays');
  await assert.rejects(hub.send(builder.conn, 'misha', 'x', 'info', null, null, { suggest: 'y', suggestTtl: 0 }), /suggestTtl/);
});
