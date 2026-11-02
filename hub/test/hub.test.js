'use strict';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const agentTok = auth.create({ name: 'a', role: 'agent' });
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  const agentClient = fakeClient();
  const agentConn = hub.bind(agentClient, auth.verify(agentTok.token), '127.0.0.1');
  hub.register(agentConn, { name: 'Alex', room: 'dev', caps: ['swift'] });
  return { hub, ownerConn, agentConn, agentClient };
};

test('hub: command typed into an idle agent, done badge after the turn; going live or a new command clears it', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.setStatus(agentConn, 'waiting', 'idle');
  const sent = await hub.send(ownerConn, 'Alex', 'run tests');
  assert.strictEqual(sent.delivered, true);
  assert.ok(agentClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'run tests'));
  hub.setStatus(agentConn, 'working', 'progress');
  hub.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual(hub.list(ownerConn)[0].attention, true);
  hub.live(ownerConn, 'Alex', true);
  assert.strictEqual(hub.list(ownerConn)[0].attention, false);
  hub.live(ownerConn, 'Alex', false);
  await hub.send(ownerConn, 'Alex', 'again');
  hub.setStatus(agentConn, 'working', 'progress');
  hub.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual(hub.list(ownerConn)[0].attention, true);
  await hub.send(ownerConn, 'Alex', 'next');
  assert.strictEqual(hub.list(ownerConn)[0].attention, false);
});

test('hub: a message from an agent to a person stays in the agent\'s room, wherever the person is', async () => {
  const { hub, ownerConn, agentConn } = setup();
  const mishaClient = { events: [], source: '127.0.0.1', on() {}, emit(n, d) { this.events.push([n, d]); }, close() {} };
  const misha = hub.bind(mishaClient, ownerConn.record, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'nal', kind: 'human' });
  hub.join(misha, 'nal');
  const r = await hub.send(agentConn, 'misha', 'fixed the logo', 'info');
  assert.ok(hub.store.tailRoom('dev', 10).some((m) => m.id === r.id), 'in dev, where Alex works');
  assert.ok(!hub.store.tailRoom('nal', 10).some((m) => m.id === r.id), 'not in nal, where misha happens to be');
  assert.ok(mishaClient.events.some(([n, d]) => n === 'agents/message' && d.room === 'dev'), 'misha still gets it, with its room');
  // and a command to an agent stays in the agent's room, as before
  const c = await hub.send(misha, 'Alex', 'next task');
  assert.ok(hub.store.tailRoom('dev', 10).some((m) => m.id === c.id));
});

test('hub: a member back within the grace never left; one that stays away did', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, leaveGraceMs: 60 });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const say = () => hub.store.tailRoom('opn', 50).filter((m) => m.kind === 'system').map((m) => m.text.replace(/ from .*/, ''));
  const connectMisha = () => {
    const client = fakeClient();
    const conn = hub.bind(client, owner, '127.0.0.1');
    hub.register(conn, { name: 'misha', room: 'opn', kind: 'human', host: 'mac' });
    return client;
  };
  connectMisha().emit('close');
  const again = connectMisha(); // back at once: the tunnel cut the websocket
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(say(), ['misha joined'], 'no left/joined for a drop of a moment');
  again.emit('close'); // and now gone for good
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(say(), ['misha joined', 'misha left'], 'a real departure is still said');
});

test('hub: unread counts messages to you, not the room\'s, until you open the room', async () => {
  const { hub, ownerConn, agentConn } = setup();
  const client = fakeClient();
  const misha = hub.bind(client, ownerConn.record, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'nal', kind: 'human' });
  hub.join(misha, 'nal');
  hub.markRead(misha, 'dev');
  await new Promise((r) => setTimeout(r, 5));
  await hub.send(agentConn, 'misha', 'your report is ready', 'info');
  await hub.send(agentConn, 'misha', 'and the logo', 'info');
  hub.say(agentConn, 'dev', 'general news, for everyone');
  const unread = (room) => hub.rooms(misha).find((r) => r.room === room).unread;
  assert.strictEqual(unread('dev'), 2, 'the two directed to misha, not the general one');
  assert.strictEqual(unread('nal'), 0);
  await new Promise((r) => setTimeout(r, 5));
  hub.markRead(misha, 'dev');
  assert.strictEqual(unread('dev'), 0, 'opening the room reads them');
  assert.strictEqual(hub.rooms().find((r) => r.room === 'dev').unread, 0, 'no caller, no count');
});

test('hub: !/command is the owner\'s slash command, a control no agent may send', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const r = await hub.send(ownerConn, 'Alex', '!/loop 1h catch up with the team');
  assert.strictEqual(r.kind, 'control');
  assert.ok(agentClient.events.some(([n, d]) => n === 'agents/message' && d.kind === 'control' && d.text === '!/loop 1h catch up with the team'));
  await assert.rejects(hub.send(agentConn, 'Alex', '!/clear'), (e) => e.code === 403);
});

test('hub: blocked agents refuse commands but take control commands', async () => {
  const { hub, ownerConn, agentConn } = setup();
  hub.setStatus(agentConn, 'blocked', 'screen: Do you want to proceed');
  await assert.rejects(hub.send(ownerConn, 'Alex', 'more work'), (e) => e.code === 409);
  const ctl = await hub.send(ownerConn, 'Alex', '!type y');
  assert.strictEqual(ctl.delivered, true);
  assert.strictEqual(hub.list(ownerConn)[0].attention, true);
  await assert.rejects(hub.send(agentConn, 'Alex', '!stop'), (e) => e.code === 403);
});

test('hub: wait resolves on a status change, and send --wait observes a turn', async () => {
  const { hub, ownerConn, agentConn } = setup();
  hub.setStatus(agentConn, 'waiting', 'idle');
  const waiting = hub.wait(ownerConn, 'Alex', ['blocked'], 5000);
  hub.setStatus(agentConn, 'blocked', 'q');
  assert.strictEqual((await waiting).status, 'blocked');
  hub.setStatus(agentConn, 'waiting', 'idle');
  const turn = hub.send(ownerConn, 'Alex', 'go', 'command', { timeoutMs: 5000 });
  setTimeout(() => hub.setStatus(agentConn, 'working', 'progress'), 20);
  setTimeout(() => hub.setStatus(agentConn, 'waiting', 'idle'), 60);
  const result = await turn;
  assert.deepStrictEqual(result.turn, { status: 'waiting', stalled: false, timeout: false });
});

test('hub: system events, room rollups, and offline on disconnect', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.setStatus(agentConn, 'working', 'progress');
  assert.deepStrictEqual(hub.rooms().find((r) => r.room === 'dev'), { room: 'dev', agents: 1, online: 1, working: 1, blocked: 0, attention: 0, unread: 0 });
  hub.leaveGraceMs = 30;
  agentClient.emit('close');
  const list = hub.list(ownerConn);
  assert.strictEqual(list[0].connected, false, 'offline at once');
  assert.strictEqual(list[0].status, 'stopped');
  await new Promise((r) => setTimeout(r, 80)); // "left" is said once the grace is over
  const history = hub.history(ownerConn, 'dev', 10);
  assert.ok(history.some((m) => m.kind === 'system' && m.text.startsWith('Alex joined')));
  assert.ok(history.some((m) => m.kind === 'system' && m.text === 'Alex left'));
});

test('hub: anyone who reaches an agent instructs it; a note stays a note', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const auth = hub.auth;
  const bobClient = fakeClient();
  const bobConn = hub.bind(bobClient, auth.verify(auth.create({ name: 'b', role: 'agent' }).token), '127.0.0.1');
  hub.register(bobConn, { name: 'Bob', room: 'dev', accept: 'owner' }); // an old client's accept is ignored
  hub.setStatus(agentConn, 'waiting', 'idle');
  hub.setStatus(bobConn, 'waiting', 'idle');
  const toAlex = await hub.send(bobConn, 'Alex', 'run tests');
  assert.strictEqual(toAlex.kind, 'command');
  assert.strictEqual(agentClient.events.find(([n, d]) => n === 'agents/message' && d.text === 'run tests')[1].kind, 'command');
  assert.strictEqual((await hub.send(agentConn, 'Bob', 'deploy')).kind, 'command');
  assert.strictEqual((await hub.send(agentConn, 'Bob', 'fyi', 'info')).kind, 'info');
  assert.strictEqual((await hub.send(ownerConn, 'Alex', 'go')).kind, 'command');
  assert.strictEqual(hub.list(ownerConn).find((m) => m.name === 'Bob').accept, undefined);
});

test('hub: rooms are safe file names, and a room is listed once a human or a log is in it', () => {
  const { hub, ownerConn } = setup();
  for (const bad of ['../x', 'a/b', '.hidden', '', 'x'.repeat(65)]) {
    assert.throws(() => hub.register(ownerConn, { name: 'misha', kind: 'human', room: bad }), (e) => e.code === 400, bad);
  }
  assert.throws(() => hub.join(ownerConn, '../etc'), (e) => e.code === 400);
  assert.throws(() => hub.say(ownerConn, '../etc', 'hi'), (e) => e.code === 400);
  assert.strictEqual(hub.members.get('misha'), undefined);
  hub.register(ownerConn, { name: 'misha', kind: 'human', room: 'plans' });
  assert.deepStrictEqual(hub.rooms().find((r) => r.room === 'plans'), { room: 'plans', agents: 0, online: 0, working: 0, blocked: 0, attention: 0, unread: 0 });
  hub.say(ownerConn, 'notes', 'kept');
  assert.ok(hub.rooms().some((r) => r.room === 'notes'));
});

test('hub: agents are their name in their room: Alex@dev and Alex@studio are two, a bare name means the one in your room', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const studioClient = fakeClient();
  const studioAlex = hub.bind(studioClient, agentConn.record, '127.0.0.1');
  hub.register(studioAlex, { name: 'Alex', room: 'studio' });
  const lead = hub.bind(fakeClient(), agentConn.record, '127.0.0.1');
  hub.register(lead, { name: 'ceo', room: 'studio' });
  hub.setStatus(studioAlex, 'waiting', 'idle');
  hub.setStatus(agentConn, 'waiting', 'idle');
  assert.deepStrictEqual([hub.members.get('Alex@dev').room, hub.members.get('Alex@studio').room], ['dev', 'studio']);
  // ceo in studio says "Alex": the studio one gets it, logged in studio; the dev one hears nothing
  const sent = await hub.send(lead, 'Alex', 'cover review');
  assert.strictEqual(sent.room, 'studio');
  assert.ok(studioClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'cover review'));
  assert.ok(!agentClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'cover review'));
  assert.ok(hub.history(ownerConn, 'studio').some((m) => m.text === 'cover review'));
  assert.ok(!hub.history(ownerConn, 'dev').some((m) => m.text === 'cover review'));
  assert.strictEqual(hub.inboxFor(studioAlex).length, 1);
  assert.strictEqual(hub.inboxFor(agentConn).length, 0);
  // from nowhere in particular a bare name is ambiguous; name@room is exact
  await assert.rejects(hub.send(ownerConn, 'Alex', 'x'), (e) => e.code === 409 && /Alex@dev or Alex@studio/.test(e.message));
  assert.strictEqual((await hub.send(ownerConn, 'Alex@dev', 'tests')).room, 'dev');
  // the owner in a room means that room's Alex
  hub.join(ownerConn, 'dev');
  assert.strictEqual((await hub.send(ownerConn, 'Alex', 'again')).room, 'dev');
  // each bridge follows its own agent
  const bridge = hub.bind(fakeClient(), agentConn.record, '127.0.0.1');
  hub.register(bridge, { name: 'Alex', room: 'studio', follow: true });
  assert.strictEqual(hub.say(bridge, null, 'from the bridge').room, 'studio');
  // one leaving leaves the other online
  agentClient.emit('close');
  assert.deepStrictEqual([hub.members.get('Alex@dev').connected, hub.members.get('Alex@studio').connected], [false, true]);
  assert.deepStrictEqual(hub.list(ownerConn, 'studio').filter((m) => m.name === 'Alex').map((m) => m.id), ['Alex@studio']);
  assert.strictEqual(hub.named('Alex').length, 2);
});

test('hub: members and inboxes saved before agents were per room load under name@room', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify([{ name: 'cmo', kind: 'agent', room: 'opn' }, { name: 'misha', kind: 'human', room: 'dev' }]));
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ cmo: [{ id: '1', text: 'queued' }], misha: [] }));
  const hub = new Hub({ dataDir: dir, auth: new Auth(dir, quiet), console: quiet });
  assert.deepStrictEqual([...hub.members.keys()].sort(), ['cmo@opn', 'misha']);
  assert.strictEqual(hub.inbox.get('cmo@opn')[0].text, 'queued');
});

test('hub: the owner archives a room: read-only, log in place, agents told, hidden from the list; unarchive brings it back', () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.say(ownerConn, 'dev', 'hello');
  const logFile = hub.store.roomFile('dev');
  const before = fs.readFileSync(logFile, 'utf8');
  assert.throws(() => hub.archiveRoom(agentConn, 'dev'), /Owners only/);
  assert.throws(() => hub.archiveRoom(ownerConn, 'default'), /cannot be archived/);
  assert.throws(() => hub.archiveRoom(ownerConn, 'nowhere'), /No room/);
  const watcher = fakeClient();
  hub.register(hub.bind(watcher, ownerConn.record, '127.0.0.1'), { name: 'misha', kind: 'human', room: 'dev' });
  const r = hub.archiveRoom(ownerConn, 'dev');
  assert.deepStrictEqual(r, { room: 'dev', archived: true, agents: ['Alex'] });
  // the log stays where it was, everything in it, and the line that says so after
  assert.ok(fs.readFileSync(logFile, 'utf8').startsWith(before));
  assert.ok(hub.history(ownerConn, 'dev').some((m) => m.text === 'hello'));
  assert.ok(hub.history(ownerConn, 'dev').some((m) => /archived dev: it is read-only now/.test(m.text)));
  assert.ok(!fs.existsSync(path.join(hub.store.dir, 'rooms', '.deleted')), 'nothing moved to the trash');
  // read-only: no message, directed one, edit or pin; join/left lines are not written either
  assert.throws(() => hub.say(ownerConn, 'dev', 'more'), (e) => e.code === 423 && /dev is archived: read-only/.test(e.message));
  assert.throws(() => hub.say(agentConn, 'dev', 'from Alex'), (e) => e.code === 423);
  const hello = hub.history(ownerConn, 'dev').find((m) => m.text === 'hello');
  assert.throws(() => hub.edit(ownerConn, hello.id, 'hello!'), (e) => e.code === 423);
  assert.throws(() => hub.pin(ownerConn, hello.id, true), (e) => e.code === 423);
  const lines = hub.history(ownerConn, 'dev', 500).length;
  agentClient.emit('close');
  assert.strictEqual(hub.history(ownerConn, 'dev', 500).length, lines, 'no "left" line in an archived room');
  // Alex was told, directly
  assert.ok(agentClient.events.some(([n, m]) => n === 'agents/message' && /dev is archived: read-only/.test(m.text)));
  // the list: not among the rooms, in the archived folder with its numbers
  assert.ok(!hub.rooms(ownerConn).some((s) => s.room === 'dev'));
  const [a] = hub.rooms(ownerConn, { archived: true });
  assert.strictEqual(a.room, 'dev');
  assert.ok(a.archivedBy);
  assert.strictEqual(a.messages, 1);
  assert.ok(a.last);
  assert.ok(watcher.events.some(([n, d]) => n === 'room/archived' && d.room === 'dev' && d.archived === true));
  // remembered across a restart
  const again = new Hub({ dataDir: hub.store.dir, auth: hub.auth, console: quiet });
  assert.throws(() => again.say(ownerConn.record ? again.bind(fakeClient(), ownerConn.record, '127.0.0.1') : null, 'dev', 'x'), (e) => e.code === 423);
  // back
  assert.throws(() => hub.unarchiveRoom(agentConn, 'dev'), /Owners only/);
  assert.deepStrictEqual(hub.unarchiveRoom(ownerConn, 'dev'), { room: 'dev', archived: false });
  assert.ok(hub.rooms(ownerConn).some((s) => s.room === 'dev'));
  assert.deepStrictEqual(hub.rooms(ownerConn, { archived: true }), []);
  hub.say(ownerConn, 'dev', 'back again');
  assert.ok(hub.history(ownerConn, 'dev').some((m) => m.text === 'back again'));
  assert.throws(() => hub.unarchiveRoom(ownerConn, 'dev'), /not archived/);
});

test('hub: a token limited to a room works only there', async () => {
  const { hub, ownerConn } = setup();
  assert.throws(() => hub.auth.create({ name: 'x', role: 'owner', rooms: ['values'] }), /not limited/);
  assert.throws(() => hub.auth.create({ name: 'x', role: 'agent', rooms: ['../etc'] }), /rooms/);
  const { token, record } = hub.auth.create({ name: 'values-box', role: 'agent', rooms: ['values'] });
  assert.deepStrictEqual(record.rooms, ['values']);
  const boxClient = fakeClient();
  const box = hub.bind(boxClient, hub.auth.verify(token), '127.0.0.1');
  const no = (fn) => assert.throws(fn, (e) => e.code === 403 && /only for values/.test(e.message));
  no(() => hub.register(box, { name: 'valuesdev', room: 'dev' }));
  hub.register(box, { name: 'valuesdev', room: 'values' });
  hub.setStatus(box, 'waiting', 'idle');
  no(() => hub.say(box, 'dev', 'hi'));
  no(() => hub.join(box, '*'));
  no(() => hub.markRead(box, 'dev'));
  assert.throws(() => hub.history(box, 'dev'), (e) => e.code === 403);
  hub.say(box, 'values', 'hello values');
  // other rooms' agents are not there for it: not to message, wait on, list or see in updates
  await assert.rejects(hub.send(box, 'Alex', 'x'), (e) => e.code === 404);
  await assert.rejects(hub.send(box, 'Alex@dev', 'x'), (e) => e.code === 403 && /valuesdev is not in dev/.test(e.message));
  assert.throws(() => hub.wait(box, 'Alex'), (e) => e.code === 404);
  assert.deepStrictEqual(hub.list(box).map((m) => m.id), ['valuesdev@values']);
  assert.deepStrictEqual(hub.rooms(box).map((r) => r.room), ['values']);
  hub.changed();
  const update = boxClient.events.filter(([n]) => n === 'agents/changed').pop()[1];
  assert.deepStrictEqual(update.members.map((m) => m.id), ['valuesdev@values']);
  // a person is reached in the token's room, wherever they are
  hub.register(ownerConn, { name: 'misha', kind: 'human', room: 'dev' });
  assert.strictEqual((await hub.send(box, 'misha', 'done', 'info')).room, 'values');
  assert.ok(hub.history(ownerConn, 'values').some((m) => m.text === 'done'));
  // its bridge follows it in values, nowhere else
  const bridge = hub.bind(fakeClient(), hub.auth.verify(token), '127.0.0.1');
  hub.register(bridge, { name: 'valuesdev', room: 'values', follow: true });
  assert.throws(() => hub.register(hub.bind(fakeClient(), hub.auth.verify(token), '127.0.0.1'), { name: 'Alex', room: 'dev', follow: true }), (e) => e.code === 403);
  // the owner and unlimited tokens are as before
  assert.ok(hub.list(ownerConn).some((m) => m.id === 'Alex@dev'));
  // revoked: its connections are closed at once and it is offline
  hub.auth.revoke(record.id);
  assert.strictEqual(hub.cut(record.id), 3); // the agent, its bridge, and the refused follow
  assert.strictEqual(hub.members.get('valuesdev@values').connected, false);
  assert.strictEqual(hub.auth.verify(token), null);
});

test('hub: a member token is a person in its rooms, without the owner\'s powers', async () => {
  const { hub, ownerConn, agentConn } = setup();
  const { token } = hub.auth.create({ name: 'partner', role: 'member', rooms: ['values'] });
  // an agent in values that takes commands only from the owner
  hub.register(hub.bind(fakeClient(), agentConn.record, '127.0.0.1'), { name: 'agentv', room: 'values' });
  const partnerClient = fakeClient();
  const partner = hub.bind(partnerClient, hub.auth.verify(token), '127.0.0.1');
  assert.deepStrictEqual(hub.from(partner).rooms, ['values']);
  assert.throws(() => hub.register(partner, { name: 'anna', room: 'values', kind: 'agent' }), /for people/);
  assert.throws(() => hub.register(partner, { name: 'anna', room: 'dev', kind: 'human' }), (e) => e.code === 403);
  hub.register(ownerConn, { name: 'misha', kind: 'human', room: 'dev' });
  assert.throws(() => hub.register(partner, { name: 'misha', room: 'values', kind: 'human' }), /belongs to another token/);
  hub.register(partner, { name: 'anna', room: 'values', kind: 'human' });
  hub.join(partner, 'values');
  hub.say(partner, null, 'hi from anna');
  assert.ok(hub.history(partner, 'values').some((m) => m.text === 'hi from anna'));
  assert.throws(() => hub.history(partner, 'dev'), (e) => e.code === 403);
  assert.deepStrictEqual(hub.rooms(partner).map((r) => r.room), ['values']);
  // no owner powers
  assert.throws(() => hub.archiveRoom(partner, 'values'), /Owners only/);
  assert.throws(() => hub.live(partner, 'Alex@dev', true), /Owners only/);
  // their messages to the agents of their room are instructions
  const owner = hub.bind(fakeClient(), ownerConn.record, '127.0.0.1');
  hub.register(owner, { name: 'valuesdev', room: 'values', accept: 'any' });
  hub.setStatus(owner, 'waiting', 'idle');
  assert.strictEqual((await hub.send(partner, 'valuesdev', 'build it')).kind, 'command');
  assert.strictEqual((await hub.send(partner, 'agentv', 'fyi')).kind, 'command');
  await assert.rejects(hub.send(partner, 'valuesdev', '!stop'), /Owners only/);
});

test('hub: tokens show what runs on them, and their rooms change live', () => {
  const { hub } = setup();
  const { token, record } = hub.auth.create({ name: 'box', role: 'agent', rooms: ['values'], by: 'misha' });
  assert.strictEqual(hub.auth.find('box').createdBy, 'misha');
  assert.throws(() => hub.auth.find('nope'), /No token nope/);
  const a = hub.bind(fakeClient(), hub.auth.verify(token), '127.0.0.1');
  hub.register(a, { name: 'valuesdev', room: 'values' });
  assert.deepStrictEqual(hub.tokenUse(record.id), { connections: 1, agents: ['valuesdev@values'], people: [] });
  // more rooms: a second agent can start in ops, live, without a new token
  hub.auth.setRooms(record.id, ['values', 'ops']);
  assert.strictEqual(hub.rescope(record.id, ['values', 'ops']), 0);
  const b = hub.bind(fakeClient(), hub.auth.verify(token), '127.0.0.1');
  hub.register(b, { name: 'opsdev', room: 'ops' });
  assert.strictEqual(hub.say(a, 'values', 'still here').room, 'values');
  // ops taken away: what runs there is closed at once, values keeps going
  hub.auth.setRooms(record.id, ['values']);
  assert.strictEqual(hub.rescope(record.id, ['values']), 1);
  assert.strictEqual(hub.members.get('opsdev@ops').connected, false);
  assert.throws(() => hub.say(a, 'ops', 'x'), /only for values/);
  assert.deepStrictEqual(hub.tokenUse(record.id).agents, ['valuesdev@values']);
  // a token for every room still keeps an agent in its own: rooms are the owner's to open to it
  hub.auth.setRooms(record.id, null);
  hub.rescope(record.id, null);
  assert.throws(() => hub.say(a, 'ops', 'not mine'), /valuesdev is not in ops \(it is in values\)/);
  assert.strictEqual(hub.say(a, 'values', 'home').room, 'values');
  assert.throws(() => hub.auth.setRooms(hub.auth.list().find((t) => t.role === 'owner').id, ['values']), /not limited/);
});

test('hub: agents keep to their rooms; another room only by invitation, never one way', () => {
  const { hub, ownerConn } = setup();
  const devTok = hub.auth.create({ name: 'vm', role: 'agent' }); // no room limit on the token
  const valTok = hub.auth.create({ name: 'box', role: 'agent', rooms: ['values'] });
  const devClient = fakeClient();
  const dev = hub.bind(devClient, hub.auth.verify(devTok.token), '127.0.0.1');
  hub.register(dev, { name: 'metadev', room: 'dev', accept: 'any' });
  const valClient = fakeClient();
  const val = hub.bind(valClient, hub.auth.verify(valTok.token), '127.0.0.1');
  hub.register(val, { name: 'valuesdev', room: 'values', accept: 'any' });
  const mine = hub.say(val, 'values', 'the vault plan');

  // by default: only its own room; another room's agents are not even visible
  assert.throws(() => hub.say(dev, 'values', 'hi'), /metadev is not in values \(it is in dev\)/);
  assert.throws(() => hub.history(dev, 'values'), /metadev is not in values/);
  assert.throws(() => hub.pins(dev, 'values'), /metadev is not in values/);
  assert.throws(() => hub.suggestions(dev, 'values'), /metadev is not in values/);
  assert.throws(() => hub.message(dev, 'values', mine.id), /metadev is not in values/);
  assert.throws(() => hub.join(dev, '*'), /Only an owner/);
  assert.throws(() => hub.join(dev, 'values'), /metadev is not in values/);
  return (async () => {
    await assert.rejects(hub.send(dev, 'valuesdev@values', 'hi'), /metadev is not in values/);
    await assert.rejects(hub.send(dev, 'valuesdev', 'hi'), /No agent named "valuesdev"/);
    assert.throws(() => hub.wait(dev, 'valuesdev@values', ['waiting']), /metadev is not in values/);
    assert.ok(!hub.list(dev).some((m) => m.name === 'valuesdev'));
    assert.deepStrictEqual(hub.rooms(dev).map((r) => r.room), ['dev']);
    // the values container's token: only values; never dev, not even by registering there
    assert.throws(() => hub.say(val, 'dev', 'x'), /valuesdev is not in dev|only for values/);
    assert.throws(() => hub.history(val, 'dev'), /valuesdev is not in dev|only for values/);
    assert.throws(() => hub.register(hub.bind(fakeClient(), hub.auth.verify(valTok.token), '127.0.0.1'), { name: 'spy', room: 'dev' }), /only for values/);
    // an agent token that never registered may do nothing in a room
    const loose = hub.bind(fakeClient(), hub.auth.verify(devTok.token), '127.0.0.1');
    assert.throws(() => hub.say(loose, 'dev', 'x'), /Register as an agent first/);
    // the one-way channel is gone, for everyone
    assert.throws(() => hub.grant(dev, 'metadev', ['values']), /Owners only/);
    assert.throws(() => hub.grant(ownerConn, 'metadev@dev', ['values']), (e) => e.code === 410 && /invite the agent into the room/.test(e.message));
    // one saved from before does nothing
    hub.members.get('metadev@dev').sendTo = ['values'];
    await assert.rejects(hub.send(dev, 'valuesdev@values', 'hi'), /metadev is not in values/);
    delete hub.members.get('metadev@dev').sendTo;
    assert.throws(() => hub.invite(val, 'valuesdev', 'dev'), /Owners only/);

    // valuesdev's token is only for values: inviting it elsewhere adds the room to the token, and
    // taking it back removes it again (tested in full below)
    assert.strictEqual(hub.invite(ownerConn, 'valuesdev@values', 'dev').token.added, true);
    assert.strictEqual(hub.uninvite(ownerConn, 'valuesdev@values', 'dev').token.removed, true);
    assert.deepStrictEqual(hub.auth.find('box').rooms, ['values']);

    // a guest from before /invite started sessions (kept in members.json): metadev is a guest in
    // values — reads, writes, hears it, and is listed there
    hub.members.get('metadev@dev').invited = ['values'];
    assert.ok(hub.list(ownerConn, 'values').some((m) => m.name === 'metadev'));
    const asGuest = hub.say(dev, 'values', 'hello values');
    assert.strictEqual(asGuest.room, 'values');
    assert.ok(hub.history(dev, 'values', 5).length > 0);
    assert.ok(hub.list(val).some((m) => m.name === 'metadev')); // valuesdev sees its guest
    const toGuest = await hub.send(val, 'metadev', 'welcome', 'info');
    assert.strictEqual(toGuest.room, 'values'); // talked to where they share a room
    const fromGuest = await hub.send(dev, 'valuesdev', 'thanks', 'info');
    assert.strictEqual(fromGuest.room, 'values');
    devClient.events.length = 0;
    hub.say(val, 'values', 'everyone here');
    assert.ok(devClient.events.some(([n, d]) => n === 'room/message' && d.text === 'everyone here'));
    hub.uninvite(ownerConn, 'metadev@dev', 'values');
    assert.throws(() => hub.say(dev, 'values', 'x'), /metadev is not in values/);
    assert.throws(() => hub.history(dev, 'values'), /metadev is not in values/);
    await assert.rejects(hub.send(dev, 'valuesdev@values', 'again'), /metadev is not in values/);
    assert.throws(() => hub.edit(dev, asGuest.id, 'hello values, edited'), /metadev is not in values/, 'not even its own message there');
    // the owner is never limited
    assert.strictEqual(hub.say(ownerConn, 'values', 'owner here').room, 'values');
  })();
});

test('hub: speaking as an agent (follow) takes its key; the token alone does not, not even the owner\'s', () => {
  const { hub, ownerConn } = setup();
  const crypto = require('node:crypto');
  const token = hub.auth.create({ name: 'box', role: 'agent' }).token;
  const conn = () => hub.bind(fakeClient(), hub.auth.verify(token), '127.0.0.1');
  const key = crypto.randomBytes(32).toString('base64url');
  hub.register(conn(), { name: 'leader', room: 'dev', followHash: crypto.createHash('sha256').update(key).digest('base64url') });
  hub.register(conn(), { name: 'oldie', room: 'dev' }); // a wrapper from before keys
  const shell = conn();
  assert.throws(() => hub.register(shell, { name: 'leader', room: 'dev', follow: true }), (e) => e.code === 403 && /only leader's own processes speak as leader/.test(e.message));
  assert.throws(() => hub.register(shell, { name: 'leader', room: 'dev', follow: true, key: 'wrong' }), (e) => e.code === 403);
  assert.throws(() => hub.register(hub.bind(fakeClient(), ownerConn.record, '127.0.0.1'), { name: 'leader', room: 'dev', follow: true }), (e) => e.code === 403, 'not even the owner token');
  // a refused shell cannot post as leader, nor as anyone: an agent token speaks only as an agent
  assert.throws(() => hub.say(shell, 'dev', 'from a shell with MC_AGENT=leader'), /Register as an agent first/);
  assert.ok(!hub.history(ownerConn, 'dev').some((m) => m.text === 'from a shell with MC_AGENT=leader'));
  // its own process, with the key
  const bridge = conn();
  hub.register(bridge, { name: 'leader', room: 'dev', follow: true, key });
  hub.say(bridge, 'dev', 'from leader itself');
  assert.strictEqual(hub.history(ownerConn, 'dev').find((m) => m.text === 'from leader itself').from.name, 'leader');
  // an agent registered without a key (an old wrapper): as before, until it restarts
  hub.register(conn(), { name: 'oldie', room: 'dev', follow: true });
  assert.ok(!JSON.stringify(hub.list(ownerConn, 'dev')).includes(crypto.createHash('sha256').update(key).digest('base64url')), 'the hash is never shown');
});

test('hub: the owner\'s "@all !/clear" goes to every agent of the room, and one line says how it went', () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const tok = hub.auth.create({ name: 'b', role: 'agent' }).token;
  const join = (name, room) => {
    const client = fakeClient();
    const conn = hub.bind(client, hub.auth.verify(tok), '127.0.0.1');
    hub.register(conn, { name, room });
    return { conn, client };
  };
  hub.register(ownerConn, { name: 'misha', room: 'dev', kind: 'human' });
  const bob = join('Bob', 'dev');
  const guest = join('Gus', 'ops');
  hub.members.get('Gus@ops').invited = ['dev']; // a guest from before /invite started sessions
  const controls = (client) => client.events.filter(([n, d]) => n === 'agents/message' && d.kind === 'control').map(([, d]) => d);
  // not the owner: refused
  assert.throws(() => hub.say(bob.conn, 'dev', '@all !/clear'), /Owners only/);
  const said = hub.say(ownerConn, 'dev', '@all !/clear');
  assert.deepStrictEqual(said.all.sort(), ['Alex', 'Bob']);
  const [a] = controls(agentClient);
  assert.deepStrictEqual([a.text, a.batch], ['!/clear', said.id]);
  assert.strictEqual(controls(bob.client)[0].batch, said.id);
  assert.strictEqual(controls(guest.client).length, 0, 'a guest from another room: not its room');
  const lines = () => hub.history(ownerConn, 'dev').filter((m) => m.kind === 'system').map((m) => m.text);
  hub.rotated(agentConn, 412000, 9000, said.id);
  assert.ok(!lines().some((t) => /cleared/.test(t)), 'one line, when all are done');
  hub.rotated(bob.conn, null, null, said.id, 'its PROGRESS.md was not updated');
  assert.deepStrictEqual(lines().filter((t) => /cleared/.test(t)), ['misha cleared 1 agent (ctx 412k → fresh); not cleared: Bob (its PROGRESS.md was not updated)']);
  assert.ok(!lines().some((t) => /^rotated /.test(t)), 'no line per agent');
  assert.strictEqual(hub.list(ownerConn).find((m) => m.name === 'Alex').ctx, 9000);
  // any other command: typed as it is into each, no summary
  hub.say(ownerConn, 'dev', '@all !/compact');
  assert.deepStrictEqual([controls(agentClient).at(-1).text, controls(bob.client).at(-1).text], ['!/compact', '!/compact']);
  // "@all <text>" from a person: the room line, and typed into each agent of the room as an instruction
  const commands = (client) => client.events.filter(([n, d]) => n === 'agents/message' && d.kind === 'command').map(([, d]) => d.text);
  const standup = hub.say(ownerConn, 'dev', '@all reread TEAM.md');
  assert.deepStrictEqual([standup.kind, standup.text, standup.all.sort()], ['say', '@all reread TEAM.md', ['Alex', 'Bob']]);
  assert.deepStrictEqual([commands(agentClient), commands(bob.client), commands(guest.client)], [['reread TEAM.md'], ['reread TEAM.md'], []]);
  assert.strictEqual(hub.history(ownerConn, 'dev').filter((m) => /reread TEAM/.test(m.text)).length, 1, 'one line in the room');
  // an agent's "@all" is only text: it does not wake the others
  const fromBob = hub.say(bob.conn, 'dev', '@all FYI the build is green');
  assert.strictEqual(fromBob.all, undefined);
  assert.deepStrictEqual(commands(agentClient), ['reread TEAM.md']);
  assert.strictEqual(controls(agentClient).length, 2);
});

test('hub: the owner\'s bare "!hello …" to an agent is typed in as plain text ("hello …"), not a slash command; !stop, !type, !answer stay', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.setStatus(agentConn, 'waiting', 'idle');
  const got = () => agentClient.events.filter(([n]) => n === 'agents/message').map(([, d]) => [d.kind, d.text, Boolean(d.plain)]).at(-1);
  await hub.send(ownerConn, 'Alex', '!hello there');
  assert.deepStrictEqual(got(), ['control', '!hello there', true]);
  await hub.send(ownerConn, 'Alex', '!/status');
  assert.deepStrictEqual(got(), ['control', '!/status', false]);
  await hub.send(ownerConn, 'Alex', '!type y');
  assert.deepStrictEqual(got(), ['control', '!type y', false]);
  await hub.send(ownerConn, 'Alex', '!!! the build is red');
  assert.deepStrictEqual(got(), ['command', '!!! the build is red', false], 'not a word: a message');
  // from anyone else, a bare "!word" is a message like any other
  const tok = hub.auth.create({ name: 'b', role: 'agent' }).token;
  const bob = hub.bind(fakeClient(), hub.auth.verify(tok), '127.0.0.1');
  hub.register(bob, { name: 'Bob', room: 'dev' });
  await hub.send(bob, 'Alex', '!hello me');
  assert.deepStrictEqual(got(), ['command', '!hello me', false]);
  hub.say(ownerConn, 'dev', '@all !hello');
  assert.deepStrictEqual(got(), ['control', '!hello', true]);
  hub.say(ownerConn, 'dev', '@all !/compact');
  assert.deepStrictEqual(got(), ['control', '!/compact', false]);
});

test('hub: room/history before a message: the page just before it ("load more"), and nothing before the first', () => {
  const { hub, ownerConn } = setup();
  const said = [];
  for (let i = 0; i < 120; i++) said.push(hub.say(ownerConn, 'dev', `m${i}`));
  const page = hub.history(ownerConn, 'dev', 50, null, null, said[100].id);
  assert.deepStrictEqual([page.length, page[0].text, page.at(-1).text], [50, 'm50', 'm99']);
  const first = hub.history(ownerConn, 'dev', 50, null, null, said[30].id);
  assert.deepStrictEqual([first.length, first[0].text, first[1].text], [31, 'Alex joined', 'm0'], 'from the room\'s first line');
  assert.deepStrictEqual(hub.history(ownerConn, 'dev', 50, null, null, first[0].id), [], 'nothing before the first');
  assert.throws(() => hub.history(ownerConn, 'dev', 50, null, null, 'nope'), /No such message/);
});

test('hub: a message to a guest from a room it is invited into stays in that room, the owner\'s too; its answer goes back there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const box = auth.create({ name: 'valuesbox', role: 'agent', rooms: ['values', 'trade'] });
  const dev = hub.bind(fakeClient(), auth.verify(box.token), '127.0.0.1');
  hub.register(dev, { name: 'valuesdev', room: 'values' });
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'values', kind: 'human' });
  hub.members.get('valuesdev@values').invited = ['trade']; // a guest from before /invite started sessions
  const where = (id) => ['values', 'trade'].find((r) => hub.store.tailRoom(r, 50).some((m) => m.id === id));
  // misha has trade open: the message is trade's, and valuesdev's answer is too
  hub.join(misha, 'trade');
  const asked = await hub.send(misha, 'valuesdev', 'price the BTC basket');
  assert.strictEqual(asked.room, 'trade');
  assert.strictEqual(where(asked.id), 'trade');
  const answer = await hub.send(dev, 'misha', 'basket priced', 'info');
  assert.strictEqual(where(answer.id), 'trade', 'the answer goes where it was asked');
  // back in values: there, and the answers follow
  hub.join(misha, 'values');
  const home = await hub.send(misha, 'valuesdev', 'and the ETH one');
  assert.strictEqual(where(home.id), 'values');
  assert.strictEqual(where((await hub.send(dev, 'misha', 'done', 'info')).id), 'values');
  // a room it is not invited into: its home room, as before
  hub.join(misha, 'dev');
  assert.strictEqual((await hub.send(misha, 'valuesdev', 'one more')).room, 'values');
  // the room it was asked in survives a hub restart
  hub.join(misha, 'trade');
  await hub.send(misha, 'valuesdev', 'again from trade');
  const again = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  const dev2 = again.bind(fakeClient(), auth.verify(box.token), '127.0.0.1');
  again.register(dev2, { name: 'valuesdev', room: 'values' });
  assert.strictEqual((await again.send(dev2, 'misha', 'still trade', 'info')).room, 'trade');
});

test('hub: /invite gives an agent a session of its own in the room; offline, it starts when the machine is back; /uninvite stops it, notes first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const box = auth.create({ name: 'valuesbox', role: 'agent', rooms: ['values', 'trade', 'ops'] });
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'values', kind: 'human' });
  const wrapper = () => {
    const client = fakeClient();
    return { client, conn: hub.bind(client, auth.verify(box.token), '127.0.0.1'), events: (name) => client.events.filter(([n]) => n === name).map(([, d]) => d) };
  };
  const home = wrapper();
  const first = hub.register(home.conn, { name: 'valuesdev', room: 'values', repo: '/work/valuesdao' });
  assert.strictEqual(first.startSessions, undefined);

  // invite → its wrapper is told to start the session; the agent at home is told the work moved
  const r = hub.invite(misha, 'valuesdev', 'trade');
  assert.strictEqual(r.starting, true);
  // listed in trade at once, offline until the session starts
  const placed = hub.list(misha, 'trade').find((m) => m.id === 'valuesdev@trade');
  assert.deepStrictEqual([placed.connected, placed.reason, placed.home], [false, 'not started yet', 'values']);
  assert.deepStrictEqual(home.events('agents/session'), [{ name: 'valuesdev', room: 'trade', on: true, selfStops: false }]);
  assert.match(home.events('agents/message').at(-1).text, /trade now has a session of you of its own[\s\S]*keep your values work/);
  assert.ok(hub.history(misha, 'trade', 5).some((m) => m.kind === 'system' && /misha invited valuesdev \(from values\): its session here is starting…/.test(m.text)));
  assert.throws(() => hub.invite(misha, 'valuesdev', 'trade'), /already has a session in trade/);
  // a wrapper reconnecting before the session is up starts it again
  assert.deepStrictEqual(hub.register(home.conn, { name: 'valuesdev', room: 'values' }).startSessions, ['trade']);

  // the session registers: by the same name, living in trade, welcomed with where its work is
  const session = wrapper();
  const s = hub.register(session.conn, { name: 'valuesdev', room: 'trade' });
  assert.strictEqual(s.id, 'valuesdev@trade');
  assert.strictEqual(s.home, 'values');
  assert.match(hub.inbox.get('valuesdev@trade')[0].text, /You are valuesdev's session for room trade[\s\S]*hub_read[\s\S]*PROGRESS-valuesdev@trade\.md[\s\S]*commit only your own files/);
  assert.deepStrictEqual(hub.register(home.conn, { name: 'valuesdev', room: 'values' }).startSessions, [], 'running: nothing to start');
  // every session knows where the others keep their notes (to read, never write), kept current
  const listed = (text) => [...text.matchAll(/^- (valuesdev@\w+): (.+)$/gm)].map((m) => [m[1], m[2]]);
  hub.register(home.conn, { name: 'valuesdev', room: 'values', repo: '/work', notes: '/work/PROGRESS.md' });
  hub.register(session.conn, { name: 'valuesdev', room: 'trade', repo: '/work', notes: '/work/PROGRESS-valuesdev@trade.md' });
  assert.match(hub.inbox.get('valuesdev@trade')[0].text, /Notes of valuesdev's sessions \(read the others' when you need to; never write them\)/);
  assert.deepStrictEqual(listed(hub.notesList(hub.members.get('valuesdev@values'))), [['valuesdev@values', '/work/PROGRESS.md'], ['valuesdev@trade', '/work/PROGRESS-valuesdev@trade.md']]);
  assert.match(home.events('agents/message').filter((m) => m.kind === 'info').at(-1).text, /- valuesdev@trade: /, 'the agent at home heard the session came');
  // in trade "valuesdev" is the session; from values it is the agent at home; both listed once each
  hub.join(misha, 'trade');
  assert.strictEqual((await hub.send(misha, 'valuesdev', 'price the basket')).room, 'trade');
  assert.strictEqual(hub.inbox.get('valuesdev@trade').at(-1).text, 'price the basket');
  hub.join(misha, 'values');
  assert.strictEqual(hub.inbox.get('valuesdev@values').at(-1).text === 'price the basket', false);
  assert.strictEqual(hub.list(misha, 'trade').filter((m) => m.name === 'valuesdev').length, 1);

  // uninvite → the session is told to retire (its notes first, then it exits); its wrapper is told it stops itself
  hub.uninvite(misha, 'valuesdev', 'trade');
  assert.strictEqual(hub.inbox.get('valuesdev@trade').at(-1).text, '!retire');
  assert.strictEqual(hub.inbox.get('valuesdev@trade').at(-1).kind, 'control');
  assert.deepStrictEqual(home.events('agents/session').at(-1), { name: 'valuesdev', room: 'trade', on: false, selfStops: true });
  assert.throws(() => hub.uninvite(misha, 'valuesdev', 'trade'), /no session in trade/);
  // gone from trade's list once it has gone; a session never started goes at once
  session.client.emit('close');
  hub.unbind(session.client);
  assert.ok(!hub.list(misha, 'trade').some((m) => m.id === 'valuesdev@trade'));
  assert.deepStrictEqual(listed(home.events('agents/message').filter((m) => m.kind === 'info').at(-1).text), [['valuesdev@values', '/work/PROGRESS.md']], 'and that it went');

  // the machine offline: the invite waits, and its wrapper starts the session when it is back
  home.client.emit('close');
  hub.unbind(home.client);
  const later = hub.invite(misha, 'valuesdev@values', 'ops');
  assert.strictEqual(later.starting, false);
  // a hub restart keeps its place; one invited before places existed gets one
  const again = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  assert.ok(again.members.has('valuesdev@ops'));
  again.members.delete('valuesdev@ops');
  again.saveMembers();
  assert.ok(new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } }).members.has('valuesdev@ops'));
  assert.ok(hub.history(misha, 'ops', 5).some((m) => /its session here is waiting for its machine to be back/.test(m.text)));
  const back = wrapper();
  assert.deepStrictEqual(hub.register(back.conn, { name: 'valuesdev', room: 'values' }).startSessions, ['ops']);
});

test('hub: /invite adds the room to the agent\'s token, /uninvite takes it back, unless another member on that token is still there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'values', kind: 'human' });
  const box = auth.create({ name: 'valuesbox', role: 'agent', rooms: ['values'] });
  const agent = (name, room) => {
    const conn = hub.bind(fakeClient(), auth.verify(box.token), '127.0.0.1');
    hub.register(conn, { name, room });
    return conn;
  };
  const dev = agent('valuesdev', 'values');
  const line = (room) => hub.history(misha, room, 10).filter((m) => m.kind === 'system').map((m) => m.text).join(' | ');

  // invite: no separate grant; the room says so
  const r = hub.invite(misha, 'valuesdev', 'trade');
  assert.deepStrictEqual(r.token, { name: 'valuesbox', added: true });
  assert.deepStrictEqual(auth.find('valuesbox').rooms, ['values', 'trade']);
  assert.match(line('trade'), /misha invited valuesdev \(from values\)[^|]*· valuesbox token now covers trade/);
  // the live connection on that token hears it at once: the session can register there
  assert.deepStrictEqual(dev.record.rooms, ['values', 'trade']);
  agent('valuesdev', 'trade');
  // a second invite on the same token into a room it covers: nothing to add
  const sec = agent('security', 'values');
  assert.deepStrictEqual(hub.invite(misha, 'security', 'trade').token, { name: 'valuesbox', added: false });
  assert.doesNotThrow(() => sec);

  // shared token: chief lives in trade on valuesbox, so uninviting valuesdev keeps trade on it
  agent('chief', 'trade');
  const kept = hub.uninvite(misha, 'valuesdev', 'trade');
  assert.deepStrictEqual(kept.token, { name: 'valuesbox', removed: false, keptFor: ['security', 'chief'] });
  assert.deepStrictEqual(auth.find('valuesbox').rooms, ['values', 'trade']);
  assert.match(line('trade'), /valuesbox token keeps trade: security, chief are still here/);

  // when nobody on it is left there: the room comes off the token, in the room's line too
  hub.uninvite(misha, 'security', 'trade');
  hub.members.delete('chief@trade');
  const other = hub.invite(misha, 'valuesdev', 'ops');
  assert.strictEqual(other.token.added, true);
  const gone = hub.uninvite(misha, 'valuesdev', 'ops');
  assert.deepStrictEqual(gone.token, { name: 'valuesbox', removed: true, keptFor: [] });
  assert.deepStrictEqual(auth.find('valuesbox').rooms, ['values', 'trade']);
  assert.match(line('ops'), /valuesbox token no longer covers ops/);
  // a session still saving its notes keeps its connection until it goes; new ones are refused at once
  hub.invite(misha, 'valuesdev', 'desk');
  const deskClient = fakeClient();
  const desk = hub.bind(deskClient, auth.verify(box.token), '127.0.0.1');
  hub.register(desk, { name: 'valuesdev', room: 'desk' });
  hub.uninvite(misha, 'valuesdev', 'desk');
  assert.ok(!auth.find('valuesbox').rooms.includes('desk'));
  assert.ok(desk.record.rooms.includes('desk'), 'not cut off mid-notes');
  assert.throws(() => hub.register(hub.bind(fakeClient(), auth.verify(box.token), '127.0.0.1'), { name: 'spy', room: 'desk' }), /only for values, trade/);
  hub.unbind(deskClient);
  assert.ok(!dev.record.rooms.includes('desk'), 'once it is gone, the live connections narrow too');
  // its own room never comes off; a token without a room limit is left alone
  const vm = auth.create({ name: 'vm', role: 'agent' });
  hub.register(hub.bind(fakeClient(), auth.verify(vm.token), '127.0.0.1'), { name: 'metadev', room: 'dev' });
  assert.strictEqual(hub.invite(misha, 'metadev', 'values').token, null);
  assert.strictEqual(hub.uninvite(misha, 'metadev', 'values').token, null);
  assert.strictEqual(auth.find('vm').rooms, undefined);
});

test('hub: an invited session is "starting…" until it is up; a wrapper that never starts it, or fails, is said in the room', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 }, sessionStartMs: 50 });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'dev', kind: 'human' });
  const tok = auth.create({ name: 'vm', role: 'agent' });
  const wrapper = () => hub.bind(fakeClient(), auth.verify(tok.token), '127.0.0.1');
  const ceo = wrapper();
  hub.register(ceo, { name: 'leader', room: 'dev', host: 'ubuntu' });
  const lines = (room) => hub.history(misha, room, 20).filter((m) => m.kind === 'system').map((m) => m.text);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // an old wrapper: told, never starts it; a minute later (here 50 ms) the room says so and what to do
  hub.invite(misha, 'leader', 'default');
  assert.ok(lines('default').some((t) => /its session here is starting…/.test(t)));
  await pause(120);
  assert.ok(lines('default').some((t) => /leader's session here did not start within a minute: its wrapper on ubuntu may run a metacom from before sessions; restart leader there/.test(t)));

  // a wrapper that tried and failed says why
  hub.invite(misha, 'leader', 'ops');
  hub.sessionReport(ceo, 'ops', false, 'script: command not found');
  assert.ok(lines('ops').some((t) => t === "leader's session here could not start on ubuntu: script: command not found"));
  await pause(120);
  assert.ok(!lines('ops').some((t) => /did not start within a minute/.test(t)), 'the failure, not the timeout as well');

  // one that comes up in time: "up", and no timeout line
  hub.invite(misha, 'leader', 'trade');
  hub.register(wrapper(), { name: 'leader', room: 'trade', host: 'ubuntu' });
  assert.ok(lines('trade').some((t) => /leader's session here is up \(from dev, on ubuntu\)/.test(t)));
  await pause(120);
  assert.ok(!lines('trade').some((t) => /did not start/.test(t)));
  // and a wrapper reconnecting with a session still to start is timed too
  hub.register(ceo, { name: 'leader', room: 'dev', host: 'ubuntu' });
  await pause(120);
  assert.strictEqual(lines('default').filter((t) => /did not start within a minute/.test(t)).length, 2);
});

test('hub: a room\'s lead gets every message from a person that names no one; not one addressed to someone, not an answer, not an agent\'s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'mstudio', kind: 'human' });
  const tok = auth.create({ name: 'box', role: 'agent', rooms: ['mstudio'] });
  const agent = (name) => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(tok.token), '127.0.0.1');
    hub.register(conn, { name, room: 'mstudio' });
    return { conn, got: () => client.events.filter(([n]) => n === 'agents/message').map(([, d]) => d.text) };
  };
  const director = agent('director');
  const producer = agent('producer');
  const member = auth.create({ name: 'antonina', role: 'member', rooms: ['mstudio'] });
  const antonina = hub.bind(fakeClient(), auth.verify(member.token), '127.0.0.1');
  hub.register(antonina, { name: 'antonina', room: 'mstudio', kind: 'human' });

  // no lead: a message to the room reaches no agent (as before)
  hub.say(antonina, 'mstudio', 'відео на 5 сек');
  assert.deepStrictEqual(director.got(), []);
  // only the owner sets one; the room is told; it lasts across a restart
  assert.throws(() => hub.setLead(antonina, 'mstudio', 'director'), /Owners only/);
  hub.setLead(misha, 'mstudio', 'director');
  assert.ok(hub.history(misha, 'mstudio', 5).some((m) => /misha made director the lead here/.test(m.text)));
  assert.deepStrictEqual(new Hub({ dataDir: dir, auth, console: quiet, loops: { tickMs: 0 } }).leads, { mstudio: 'director' });

  const said = hub.say(antonina, 'mstudio', 'нехай спочатку скаже а тоді пʼє каву');
  assert.deepStrictEqual(director.got(), ['нехай спочатку скаже а тоді пʼє каву'], 'to the lead, as an instruction');
  assert.strictEqual(said.lead, 'director');
  assert.strictEqual(hub.history(misha, 'mstudio', 10).filter((m) => m.text === 'нехай спочатку скаже а тоді пʼє каву').length, 1, 'the room shows it once');
  hub.say(antonina, 'mstudio', '@producer зроби на 5 сек');
  assert.strictEqual(director.got().length, 1, 'addressed to producer: not the lead\'s');
  hub.say(producer.conn, 'mstudio', 'render done');
  assert.strictEqual(director.got().length, 1, 'an agent\'s message is not forwarded');
  hub.say(misha, 'mstudio', 'and keep it vertical');
  assert.strictEqual(director.got().at(-1), 'and keep it vertical', 'the owner\'s too');
  hub.setLead(misha, 'mstudio', 'off');
  hub.say(antonina, 'mstudio', 'ще раз');
  assert.strictEqual(director.got().length, 2, 'no lead any more');
  assert.throws(() => hub.setLead(misha, 'mstudio', 'nobody'), /no agent nobody in mstudio/);
});

test('steer: a member token with steer answers and drives the agents of its own rooms only; without it, nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const agentTok = auth.create({ name: 'box', role: 'agent', rooms: ['sb-1', 'sb-2'] });
  const here = hub.bind(fakeClient(), auth.verify(agentTok.token), '127.0.0.1');
  hub.register(here, { name: 'ceo', room: 'sb-1' });
  const there = hub.bind(fakeClient(), auth.verify(agentTok.token), '127.0.0.1');
  hub.register(there, { name: 'ceo', room: 'sb-2' });
  const question = { id: 'abcdef012345', text: 'Ship the box on Friday?', options: [{ label: 'Yes' }, { label: 'No' }] };
  hub.setStatus(here, 'blocked', 'question', question);
  hub.setStatus(there, 'blocked', 'question', question);
  const visitor = (steer) => {
    const t = auth.create({ name: steer ? 'guest' : 'plain', role: 'member', rooms: ['sb-1'], steer });
    const c = hub.bind(fakeClient(), auth.verify(t.token), '127.0.0.1');
    hub.register(c, { name: steer ? 'guest' : 'plain', room: 'sb-1', kind: 'human' });
    hub.join(c, 'sb-1');
    return c;
  };
  const guest = visitor(true);
  const r = await hub.send(guest, 'ceo', '1');
  assert.ok(r, 'its answer goes in');
  assert.ok(hub.store.tailRoom('sb-1', 20).some((m) => /guest answered ceo: 1\. Yes/.test(m.text || '')), 'the room hears who answered');
  assert.doesNotThrow(() => hub.live(guest, 'ceo', true), 'and it drives ceo live');
  assert.throws(() => hub.live(guest, 'ceo@sb-2', true), /No agent|Owners only|not in/, 'never another room');
  const plain = visitor(false);
  assert.throws(() => hub.live(plain, 'ceo', true), /Owners only/, 'a member without steer does not drive');
  await assert.rejects(hub.send(plain, 'ceo', '2'), /Owners only/, 'nor answers');
  await assert.rejects(hub.send(guest, 'ceo', '!stop'), /Owners only/, 'control commands stay with the owner');
  // steer "answer": answers its agents' questions, never drives them live
  const qt = auth.create({ name: 'quiet', role: 'member', rooms: ['sb-2'], steer: 'answer' });
  const quiet2 = hub.bind(fakeClient(), auth.verify(qt.token), '127.0.0.1');
  hub.register(quiet2, { name: 'quiet', room: 'sb-2', kind: 'human' });
  hub.join(quiet2, 'sb-2');
  assert.ok(await hub.send(quiet2, 'ceo', '2'), 'answer-only answers');
  assert.throws(() => hub.live(quiet2, 'ceo', true), /Direct view is not open/, 'but has no live mode');
  assert.throws(() => auth.create({ name: 'x', role: 'member', steer: true }), /steer/, 'steer needs rooms');
  assert.throws(() => auth.create({ name: 'y', role: 'agent', rooms: ['sb-1'], steer: true }), /steer/, 'and a member token');
});

test('user token (/token): a person who may also run agents of their own in its rooms, answers their questions, never drives live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const t = auth.create({ name: 'johntoken', role: 'member', rooms: ['opn'], steer: 'answer', agents: true });
  const record = auth.verify(t.token);
  const alen = hub.bind(fakeClient(), record, '127.0.0.1');
  hub.register(alen, { name: 'alen', room: 'opn', kind: 'human' });
  hub.join(alen, 'opn');
  assert.strictEqual(hub.from(alen).role, 'user', 'shown as a user');
  const bot = hub.bind(fakeClient(), record, '127.0.0.1');
  hub.register(bot, { name: 'alenclaude', room: 'opn' });
  assert.strictEqual(hub.list(alen, 'opn').find((m) => m.name === 'alenclaude').kind, 'agent', 'its agent joins the room');
  const elsewhere = hub.bind(fakeClient(), record, '127.0.0.1');
  assert.throws(() => hub.register(elsewhere, { name: 'sneaky', room: 'dev' }), /only for|not in|opn/, 'never outside its rooms');
  // a second person on the same token, under their own name
  const bo = hub.bind(fakeClient(), record, '127.0.0.1');
  hub.register(bo, { name: 'bo', room: 'opn', kind: 'human' });
  hub.join(bo, 'opn');
  hub.setStatus(bot, 'blocked', 'question', { id: 'abcdef012345', text: 'Run the tests?', options: [{ label: 'Yes' }, { label: 'No' }] });
  assert.ok(await hub.send(alen, 'alenclaude', '1'), 'answers its questions');
  // a plain member token still runs no agents
  const m = auth.create({ name: 'plainm', role: 'member', rooms: ['opn'] });
  const pm = hub.bind(fakeClient(), auth.verify(m.token), '127.0.0.1');
  assert.throws(() => hub.register(pm, { name: 'nope', room: 'opn' }), /Member tokens are for people/);
});

test('a name held by a revoked token goes to the next token that registers it; a live one stays its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const first = auth.create({ name: 'builder-a', role: 'agent' });
  const c1 = hub.bind(fakeClient(), auth.verify(first.token), '127.0.0.1');
  hub.register(c1, { name: 'builder', room: 'dev' });
  const other = auth.create({ name: 'builder-b', role: 'agent' });
  const c2 = hub.bind(fakeClient(), auth.verify(other.token), '127.0.0.1');
  assert.throws(() => hub.register(c2, { name: 'builder', room: 'dev' }), /belongs to another token/, 'while the first token lives');
  auth.revoke(first.record.id);
  hub.cut(first.record.id);
  assert.doesNotThrow(() => hub.register(c2, { name: 'builder', room: 'dev' }), 'once it is revoked');
  assert.strictEqual(hub.members.get('builder@dev').tokenId, other.record.id);
});

test('agents follow ownership: a user drives, stops and kills its own agents only; the hub owner, all; answering stays open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const userOf = (name) => auth.verify(auth.create({ name, role: 'member', rooms: ['opn'], steer: 'answer', agents: true }).token);
  const a = userOf('alen');
  const b = userOf('bo');
  const person = (record, name) => {
    const c = hub.bind(fakeClient(), record, '127.0.0.1');
    hub.register(c, { name, room: 'opn', kind: 'human' });
    hub.join(c, 'opn');
    return c;
  };
  const agentOf = (record, name) => {
    const client = fakeClient();
    const c = hub.bind(client, record, '127.0.0.1');
    hub.register(c, { name, room: 'opn' });
    return { c, client };
  };
  const alen = person(a, 'alen');
  const bo = person(b, 'bo');
  const ac = agentOf(a, 'alenclaude');
  const bc = agentOf(b, 'boclaude');
  const owner = hub.bind(fakeClient(), auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim()), '127.0.0.1');
  // the room shows whose each agent is
  const list = hub.list(alen, 'opn');
  assert.strictEqual(list.find((m) => m.name === 'alenclaude').owner, 'alen');
  assert.strictEqual(list.find((m) => m.name === 'boclaude').owner, 'bo');
  // live: its own yes, the other's no
  assert.doesNotThrow(() => hub.live(alen, 'alenclaude', true), 'alen drives alenclaude');
  assert.throws(() => hub.live(alen, 'boclaude', true), /boclaude isn't yours: ask its owner/);
  // !stop / !restart: its own goes through as a control its wrapper takes; the other's is refused
  const stop = await hub.send(alen, 'alenclaude', '!stop');
  assert.ok(stop && ac.client.events.some(([n, d]) => n === 'agents/message' && d.kind === 'control' && d.text === '!stop' && d.steered === true), 'its wrapper gets the control, marked');
  await assert.rejects(hub.send(alen, 'boclaude', '!restart'), /boclaude isn't yours: ask its owner/);
  // /kill: its notes first (!retire); refused on the other's
  assert.deepStrictEqual(hub.kill(alen, 'alenclaude'), { name: 'alenclaude', room: 'opn' });
  assert.ok(ac.client.events.some(([n, d]) => n === 'agents/message' && d.text === '!retire'), 'its wrapper is told to retire');
  assert.throws(() => hub.kill(alen, 'boclaude'), /boclaude isn't yours: ask its owner/);
  // the hub owner: every agent
  assert.doesNotThrow(() => hub.live(owner, 'boclaude@opn', true));
  assert.deepStrictEqual(hub.kill(owner, 'boclaude@opn'), { name: 'boclaude', room: 'opn' });
  // answering another's agent's question stays open to the room
  hub.setStatus(bc.c, 'blocked', 'question', { id: 'abcdef012345', text: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] });
  assert.ok(await hub.send(alen, 'boclaude', '2'), 'alen answers boclaude');
  assert.ok(bo, 'bo is there');
});
