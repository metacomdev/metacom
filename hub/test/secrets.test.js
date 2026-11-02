'use strict';

// Secrets in messages, with nothing kept at the hub: `$NAME=value$` is handed, in memory, to the
// wrappers of the agents it is for (the ones it names, or every agent online in the room), and
// everything the hub logs or relays carries `$NAME`. Wrappers report the names they hold.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { SECRET_INPUT, INLINE } = require('../lib/secrets.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => ({ events: [], source: '127.0.0.1', on() {}, emit(name, data) { this.events.push([name, data]); }, close() {} });
const KEY = 'sk-or-v1-9f8e7d6c5b4a3210'; // gitleaks:allow (a made-up key for the masking tests)

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-secrets-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = hub.bind(fakeClient(), auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim()), '127.0.0.1');
  const member = hub.bind(fakeClient(), auth.verify(auth.create({ name: 'ana', role: 'member', rooms: ['dev'] }).token), '127.0.0.1');
  hub.join(member, 'dev');
  const agentToken = auth.create({ name: 'machine', role: 'agent' }).token;
  const agent = (name, room = 'dev') => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(agentToken), '127.0.0.1');
    hub.register(conn, { name, room });
    hub.setStatus(conn, 'waiting', 'idle');
    return { conn, client, got: () => client.events.filter(([e]) => e === 'agents/secret').map(([, d]) => d) };
  };
  const roomLog = () => fs.readFileSync(path.join(dir, 'rooms', 'dev.jsonl'), 'utf8');
  const nothingHolds = (value) => {
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(value), `${f} holds the value`);
    }
  };
  return { hub, owner, member, agent, dir, roomLog, nothingHolds };
};

test('the syntax', () => {
  assert.deepStrictEqual([...`@b use $API_KEY=${KEY}$ now`.matchAll(INLINE)].map((m) => [m[1], m[2]]), [['API_KEY', KEY]]);
  assert.deepStrictEqual(SECRET_INPUT.exec('$API_KEY=$').slice(1), ['API_KEY', '']);
  for (const no of ['$api_key=abc$', '$API_KEY=abc', 'API_KEY=abc$']) assert.strictEqual([...no.matchAll(INLINE)].length, 0, no);
});

test('named: only those agents, on their wrappers; nothing at the hub', () => {
  const { hub, member, agent, roomLog, nothingHolds } = setup();
  const builder = agent('builder');
  const tester = agent('tester');
  // builder's MCP bridge follows the wrapper's member: the model's side, never handed a value
  const bridgeClient = fakeClient();
  hub.register(hub.bind(bridgeClient, builder.conn.record, '127.0.0.1'), { name: 'builder', room: 'dev', follow: true });
  const said = hub.say(member, 'dev', `@builder here's the key $OPENROUTER_KEY=${KEY}$, use it for the eval`);
  assert.strictEqual(said.text, "@builder here's the key $OPENROUTER_KEY, use it for the eval");
  assert.deepStrictEqual(said.handed, { to: ['builder'], missed: [], names: ['OPENROUTER_KEY'] });
  assert.deepStrictEqual(builder.got(), [{ room: 'dev', agent: 'builder', from: 'ana', secrets: [{ name: 'OPENROUTER_KEY', value: KEY }], removed: [] }]);
  assert.deepStrictEqual(tester.got(), []);
  assert.ok(!bridgeClient.events.some(([e]) => e === 'agents/secret'), 'the bridge (the model) never gets it');
  assert.ok(roomLog().includes('🔒 ana shared $OPENROUTER_KEY with builder'));
  nothingHolds(KEY);
  assert.ok(!fs.existsSync(path.join(hub.store.dir, 'secrets.json')) && !fs.existsSync(path.join(hub.store.dir, 'secrets.key')));
});

test('nobody named: every agent online in the room, and the sender is told who', () => {
  const { hub, owner, agent, roomLog, nothingHolds } = setup();
  const builder = agent('builder');
  const tester = agent('tester');
  const away = agent('away');
  const other = agent('other', 'elsewhere');
  hub.unbind(away.client);
  // the value on its own: no message, just the line about who has it
  const r = hub.say(owner, 'dev', `$API_KEY=${KEY}$`);
  assert.deepStrictEqual(r, { id: null, room: 'dev', handed: { to: ['builder', 'tester'], missed: ['away'], names: ['API_KEY'] } });
  assert.deepStrictEqual([builder.got().length, tester.got().length, other.got().length], [1, 1, 0]);
  assert.ok(roomLog().includes('🔒 bootstrap-owner shared $API_KEY with builder, tester (not online: away)'));
  assert.ok(!roomLog().includes('"kind":"say"'), 'no message was posted');
  // taken back the same way
  hub.say(owner, 'dev', '$API_KEY=$');
  assert.deepStrictEqual(builder.got()[1].removed, ['API_KEY']);
  assert.ok(roomLog().includes('🔒 bootstrap-owner took $API_KEY back from builder, tester'));
  // an agent hands one over with `metacom secrets share`, never in a message: refused, nothing posted
  assert.throws(() => hub.say(builder.conn, 'dev', `for everyone: $SHARED_KEY=${KEY}$`), /metacom secrets share SHARED_KEY --to @agent/);
  assert.deepStrictEqual([builder.got().length, tester.got().length], [2, 2]);
  // …which is a say that says it shares
  hub.say(builder.conn, 'dev', `@tester $SHARED_KEY=${KEY}$`, null, { share: true });
  assert.deepStrictEqual([builder.got().length, tester.got().length], [2, 3]);
  nothingHolds(KEY);
});

test('the syntax as an example is never a share: placeholders, code, an agent writing about it', () => {
  const { hub, owner, agent, roomLog } = setup();
  const builder = agent('builder');
  agent('tester');
  // a person: placeholder values stay text, and nobody is handed anything
  for (const ex of ['send it as $OPENROUTER_KEY_YC=sk-or-...$', 'like @builder $OPENROUTER_KEY_YC=<key>$', '$API_KEY=…$ works', 'in code `$API_KEY=…$` is shown']) {
    const r = hub.say(owner, 'dev', ex);
    assert.ok(r.id && !r.handed, ex);
  }
  assert.deepStrictEqual(builder.got().length, 0, 'no placeholder reached a wrapper');
  assert.ok(!roomLog().includes('🔒'), 'no share line');
  assert.ok(roomLog().includes('$OPENROUTER_KEY_YC=sk-or-...$'), 'the example is posted as written');
  // an agent writing about it: placeholders and taking back go as text, nobody loses a secret
  const t = hub.say(builder.conn, 'dev', 'misha, send it as $OPENROUTER_KEY_YC=<key>$; unset with $OPENROUTER_KEY_YC=$');
  assert.ok(t.id && !t.handed);
  assert.ok(roomLog().includes('unset with $OPENROUTER_KEY_YC=$'));
  assert.ok(!roomLog().includes('🔒'), 'still no share line');
});

test('refused: a named agent offline, nobody online, in an edit', () => {
  const { hub, member, agent, roomLog } = setup();
  const builder = agent('builder');
  const away = agent('away');
  hub.unbind(away.client);
  assert.throws(() => hub.say(member, 'dev', '@away $KEY_A=abcdefgh$'), /away is offline/);
  hub.unbind(builder.client);
  assert.throws(() => hub.say(member, 'dev', '$KEY_B=abcdefgh$'), /No agent in dev is online/);
  assert.ok(!roomLog().includes('abcdefgh'));
  const b2 = agent('b2');
  const m = hub.say(b2.conn, 'dev', 'plain text');
  assert.throws(() => hub.edit(b2.conn, m.id, 'now $KEY_C=abcdefgh$'), /in a new message, not in an edit/);
  assert.throws(() => hub.say(member, 'dev', '@b2 $PATH=abcdefgh$'), /environment needs/);
});

test('names held, as the wrappers report them; used, by name', () => {
  const { hub, member, agent, roomLog } = setup();
  const builder = agent('builder');
  agent('tester');
  hub.reportSecretNames(builder.conn, ['OPENROUTER_KEY', 'API_KEY', 'not-a-name']);
  assert.deepStrictEqual(hub.listSecrets(member, 'dev'), { room: 'dev', agents: [{ agent: 'builder', names: ['API_KEY', 'OPENROUTER_KEY'], connected: true }] });
  hub.secretsUsed(builder.conn, ['OPENROUTER_KEY'], 'exec');
  hub.secretsUsed(builder.conn, ['API_KEY', 'OPENROUTER_KEY'], 'spawn');
  assert.ok(roomLog().includes('builder used $OPENROUTER_KEY'));
  assert.ok(!roomLog().includes('started with'), 'starting with them is not said in the room');
  hub.secretsUsed(builder.conn, ['API_KEY'], 'put', 'app/.env\nforged line');
  assert.ok(roomLog().includes('builder put $API_KEY into app/.env forged line'), 'name and path, on one line');
});

test('in code it is an example: `$NAME=…$` and ``` blocks are shown as they are; a real-looking value there is refused', () => {
  const { hub, owner, agent, roomLog } = setup();
  const builder = agent('builder');
  const doc = 'hand one over with `$NAME=…$`, or:\n```\n@builder $API_KEY=<your key>$\n```\nand take it back with `$NAME=$`';
  hub.say(owner, 'dev', doc);
  assert.ok(hub.history(owner, 'dev').some((m) => m.text === doc), 'posted as written');
  assert.deepStrictEqual(builder.got(), [], 'nothing handed over');
  // outside code in the same message: still a secret, handed, and only that one masked
  hub.say(owner, 'dev', '@builder $API_KEY=sk-live-0123456789$ (written `$API_KEY=…$`)');
  assert.strictEqual(builder.got().length, 1);
  assert.ok(hub.history(owner, 'dev').some((m) => m.text === '@builder $API_KEY (written `$API_KEY=…$`)'));
  // a real-looking value in code: refused, not posted in the clear
  assert.throws(() => hub.say(owner, 'dev', 'the key is `$API_KEY=sk-live-0123456789$`'), (e) => e.code === 400 && /inside code looks like a real secret/.test(e.message));
  assert.throws(() => hub.say(owner, 'dev', '```\n$API_KEY=sk-live-0123456789$\n```'), /looks like a real secret/);
  assert.ok(!roomLog().includes('sk-live-0123456789'), 'the value is nowhere in the log');
  // an edit may show the syntax too
  const mine = hub.say(owner, 'dev', 'how to hand a secret?');
  hub.edit(owner, mine.id, 'like this: `$NAME=…$`');
  assert.throws(() => hub.edit(owner, mine.id, 'like this: `$API_KEY=sk-live-0123456789$`'), /looks like a real secret/);
});
