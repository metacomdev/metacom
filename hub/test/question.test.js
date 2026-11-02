'use strict';

// An agent blocked on a dialog asks in its room; the owner answers by replying (a number, a label,
// or what to do instead), from any client, and the wrapper gets `!answer <id> <n>`.

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

const PERMISSION = { id: '9dde9d9af169', text: 'Bash command\ntouch made.txt\nDo you want to proceed?', options: [{ label: 'Yes' }, { label: 'Yes, and always allow access to dlg from this project' }, { label: 'Yes, and switch to auto mode' }, { label: 'No' }] };

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  const agent = (name) => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(auth.create({ name, role: 'agent' }).token), '127.0.0.1');
    hub.register(conn, { name, room: 'dev' });
    hub.setStatus(conn, 'waiting', 'idle');
    return { conn, client, controls: () => client.events.filter(([e, m]) => e === 'agents/message' && m.kind === 'control').map(([, m]) => m.text) };
  };
  const room = () => hub.history(ownerConn, 'dev', 50).messages || hub.history(ownerConn, 'dev', 50);
  return { hub, ownerConn, agent, room };
};

test('question: posted once to the room as the agent, with numbered options', () => {
  const { hub, agent, room } = setup();
  const a = agent('Alex');
  hub.setStatus(a.conn, 'blocked', 'screen: Do you want to proceed', PERMISSION);
  hub.setStatus(a.conn, 'blocked', 'screen: Do you want to proceed', PERMISSION);
  const asked = room().filter((m) => m.question);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].from.name, 'Alex');
  assert.match(asked[0].text, /^needs you:\nBash command\ntouch made.txt\nDo you want to proceed\?\n1\. Yes\n2\. Yes, and always/);
  assert.match(asked[0].text, /4\. No\nReply 1-4, or say what to do instead\.$/);
  assert.strictEqual(hub.list(hub.conns.values().next().value)[0].asking, PERMISSION.id);
  // a new dialog is a new message
  hub.setStatus(a.conn, 'blocked', 'screen: x', { ...PERMISSION, id: 'aaaaaaaaaaaa', text: 'Edit file?' });
  assert.strictEqual(room().filter((m) => m.question).length, 2);
});

test('question: a number, a label or y/n in the room answers the one agent asking', () => {
  const { hub, ownerConn, agent, room } = setup();
  const a = agent('Alex');
  hub.setStatus(a.conn, 'blocked', 'screen: q', PERMISSION);
  hub.say(ownerConn, 'dev', '2');
  assert.deepStrictEqual(a.controls(), [`!answer ${PERMISSION.id} 2`]);
  assert.ok(room().some((m) => m.kind === 'system' && /answered Alex: 2\. Yes, and always/.test(m.text)));
  hub.say(ownerConn, 'dev', 'no');
  hub.say(ownerConn, 'dev', 'Yes');
  hub.say(ownerConn, 'dev', 'y');
  assert.deepStrictEqual(a.controls().slice(1), [`!answer ${PERMISSION.id} 4`, `!answer ${PERMISSION.id} 1`, `!answer ${PERMISSION.id} 1`]);
  // ordinary talk is not an answer
  hub.say(ownerConn, 'dev', 'what is it doing?');
  hub.say(ownerConn, 'dev', '7');
  assert.strictEqual(a.controls().length, 4);
});

test('question: with two agents asking, a bare reply is not guessed; @name N picks', async () => {
  const { hub, ownerConn, agent, room } = setup();
  const a = agent('Alex');
  const b = agent('Bea');
  hub.setStatus(a.conn, 'blocked', 'screen: q', PERMISSION);
  hub.setStatus(b.conn, 'blocked', 'screen: q', { ...PERMISSION, id: 'bbbbbbbbbbbb' });
  assert.match(room().filter((m) => m.question).at(-1).text, /Reply @Bea 1-4/);
  hub.say(ownerConn, 'dev', '1');
  assert.deepStrictEqual([a.controls(), b.controls()], [[], []]);
  assert.ok(room().some((m) => m.kind === 'system' && /both asking/.test(m.text)));
  const r = await hub.send(ownerConn, 'Bea', '3');
  assert.strictEqual(r.kind, 'answer');
  assert.deepStrictEqual(b.controls(), ['!answer bbbbbbbbbbbb 3']);
});

test('question: anything else to the agent turns it down ("No") and goes in as the command', async () => {
  const { hub, ownerConn, agent } = setup();
  const a = agent('Alex');
  hub.setStatus(a.conn, 'blocked', 'screen: q', PERMISSION);
  const r = await hub.send(ownerConn, 'Alex', 'use a temp dir instead');
  assert.strictEqual(r.kind, 'command');
  const got = a.client.events.filter(([e]) => e === 'agents/message').map(([, m]) => [m.kind, m.text]);
  assert.deepStrictEqual(got, [['control', `!answer ${PERMISSION.id} 4`], ['command', 'use a temp dir instead']]);
});

test('question: without a "No" option other text is refused with the range; without options, live mode', async () => {
  const { hub, ownerConn, agent, room } = setup();
  const a = agent('Alex');
  hub.setStatus(a.conn, 'blocked', 'screen: q', { id: 'cccccccccccc', text: 'Trust this folder?', options: [{ label: 'Trust' }, { label: 'Exit' }] });
  await assert.rejects(hub.send(ownerConn, 'Alex', 'hmm'), (e) => e.code === 409 && /reply with 1-2/.test(e.message));
  hub.setStatus(a.conn, 'blocked', 'screen: Press enter to continue', { id: 'dddddddddddd', text: 'Press enter to continue', options: [] });
  assert.match(room().filter((m) => m.question).at(-1).text, /Answer it on its screen: \/direct Alex\./);
  await assert.rejects(hub.send(ownerConn, 'Alex', '1'), (e) => e.code === 409 && /\/direct Alex/.test(e.message));
  assert.strictEqual((await hub.send(ownerConn, 'Alex', '!type y')).kind, 'control');
});

test('question: cleared when the agent moves on; only the owner answers', async () => {
  const { hub, ownerConn, agent } = setup();
  const a = agent('Alex');
  const b = agent('Bea');
  hub.setStatus(a.conn, 'blocked', 'screen: q', PERMISSION);
  hub.say(b.conn, 'dev', '1');
  assert.deepStrictEqual(a.controls(), []);
  hub.setStatus(a.conn, 'working', 'progress');
  assert.strictEqual(hub.list(ownerConn).find((m) => m.name === 'Alex').asking, undefined);
  hub.say(ownerConn, 'dev', '1');
  assert.deepStrictEqual(a.controls(), []);
});
