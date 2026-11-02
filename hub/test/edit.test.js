'use strict';

// Editable messages: only the author edits, every version stays in the log, history shows the
// latest, and the agents concerned get the final version once, after edits in a row settle.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => ({ events: [], source: '127.0.0.1', on() {}, emit(name, data) { this.events.push([name, data]); }, close() {} });
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-edit-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, editCoalesceMs: 50 });
  const ownerClient = fakeClient();
  const owner = hub.bind(ownerClient, auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim()), '127.0.0.1');
  // agents of one machine share one token, as with metacom token … --save
  const agentToken = auth.create({ name: 'machine', role: 'agent' }).token;
  const agent = (name, room = 'dev') => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(agentToken), '127.0.0.1');
    hub.register(conn, { name, room });
    hub.setStatus(conn, 'waiting', 'idle');
    const notes = () => client.events.filter(([e, m]) => e === 'agents/message' && m.edit).map(([, m]) => m);
    return { conn, client, notes };
  };
  return { hub, owner, ownerClient, agent, dir };
};

test('only the author edits; every version stays; history shows the latest', async () => {
  const { hub, owner, ownerClient, agent, dir } = setup();
  const lead = agent('lead');
  const other = agent('other');
  const twin = agent('lead', 'elsewhere'); // the same name and token, in another room
  const msg = hub.say(lead.conn, 'dev', 'Tasks:\n- [ ] page\n- [ ] email');
  assert.throws(() => hub.edit(other.conn, msg.id, 'mine now'), /Only its author/);
  assert.throws(() => hub.edit(twin.conn, msg.id, 'mine now'), /Only its author/);
  assert.throws(() => hub.edit(owner, msg.id, 'owner too'), /Only its author/);
  assert.deepStrictEqual(hub.edit(lead.conn, msg.id, 'Tasks:\n- [x] page\n- [ ] email'), { id: msg.id, rev: 2, room: 'dev', edit: hub.store.tailRoom('dev', 1)[0].id });
  assert.strictEqual(hub.edit(lead.conn, msg.id, 'Tasks:\n- [x] page\n- [ ] email').unchanged, true);
  hub.edit(lead.conn, msg.id, 'Tasks:\n- [x] page\n- [x] email');
  const shown = hub.history(owner, 'dev', 50).filter((m) => m.id === msg.id);
  assert.strictEqual(shown.length, 1);
  assert.deepStrictEqual([shown[0].text, shown[0].rev, Boolean(shown[0].edited)], ['Tasks:\n- [x] page\n- [x] email', 3, true]);
  assert.ok(!hub.history(owner, 'dev', 50).some((m) => m.kind === 'edit'));
  assert.deepStrictEqual(hub.versions(owner, msg.id).versions.map((v) => [v.rev, v.text.split('\n')[1]]), [[1, '- [ ] page'], [2, '- [x] page'], [3, '- [x] page']]);
  // append-only: three records for it in the log, the first one unchanged
  const log = fs.readFileSync(path.join(dir, 'rooms', 'dev.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(log.find((r) => r.id === msg.id).text, 'Tasks:\n- [ ] page\n- [ ] email');
  assert.strictEqual(log.filter((r) => r.kind === 'edit' && r.target === msg.id).length, 2);
  // the room sees each edit live, as the whole new message
  const live = ownerClient.events.filter(([e]) => e === 'room/edit').map(([, d]) => d);
  assert.deepStrictEqual(live.map((d) => [d.message.id, d.message.rev]), [[msg.id, 2], [msg.id, 3]]);
  // what is not a message of someone's cannot be edited
  hub.system('dev', 'lead joined');
  const sys = hub.store.tailRoom('dev', 1)[0];
  assert.throws(() => hub.edit(lead.conn, sys.id, 'x'), /cannot be edited/);
  assert.throws(() => hub.edit(lead.conn, '00000000-0000-0000-0000-000000000000', 'x'), /No message/);
});

test('the agents concerned get the final version once; never the editor', async () => {
  const { hub, owner, agent } = setup();
  const lead = agent('lead');
  const builder = agent('builder');
  const writer = agent('writer');
  const qa = agent('qa');
  const bystander = agent('bystander');
  // a directed message, naming writer
  const sent = await hub.send(owner, 'builder', 'Build the page; @writer does the copy', 'command');
  hub.edit(owner, sent.id, 'Build the page; @writer does the copy, @qa checks it');
  hub.edit(owner, sent.id, 'Build the page and the form; @qa checks it');
  assert.deepStrictEqual([builder.notes(), writer.notes(), qa.notes()].map((n) => n.length), [0, 0, 0], 'not before the edits settle');
  await settle();
  for (const a of [builder, writer, qa]) {
    const notes = a.notes();
    assert.strictEqual(notes.length, 1, 'once, for two edits');
    assert.strictEqual(notes[0].text, `[edited v3 of ${sent.id}] Build the page and the form; @qa checks it`);
  }
  assert.strictEqual(builder.notes()[0].kind, 'command', 'from the owner: an instruction, as the message was');
  assert.strictEqual(bystander.notes().length, 0);
  assert.strictEqual(hub.inboxFor(qa.conn).filter((m) => m.edit).length, 1, 'queued for an agent that is busy or away');

  // an agent's own room message, checked off by editing: the agents it names are told, not itself
  const list = hub.say(lead.conn, 'dev', 'Plan: @builder page, @writer copy');
  hub.edit(lead.conn, list.id, 'Plan: @builder page ✓, @writer copy, @lead review');
  await settle();
  assert.deepStrictEqual(builder.notes().at(-1).text, `[edited v2 of ${list.id}] Plan: @builder page ✓, @writer copy, @lead review`);
  assert.strictEqual(builder.notes().at(-1).kind, 'command', 'typed in like any directed message');
  assert.strictEqual(writer.notes().length, 2);
  assert.strictEqual(lead.notes().length, 0, 'never the editor');
});

test('pins: anyone in the room, kept as records, no message in the room, latest version listed', async () => {
  const { hub, owner, ownerClient, agent, dir } = setup();
  const lead = agent('lead');
  const builder = agent('builder');
  const a = hub.say(lead.conn, 'dev', 'Decision: launch Tuesday');
  const b = hub.say(owner, 'dev', 'The brief is in brief.md');
  const before = hub.history(owner, 'dev', 50).length;
  assert.deepStrictEqual(hub.pin(builder.conn, a.id, true), { id: a.id, room: 'dev', pinned: true, count: 1 });
  assert.strictEqual(hub.pin(builder.conn, a.id, true).unchanged, true);
  hub.pin(owner, b.id, true);
  hub.edit(lead.conn, a.id, 'Decision: launch Tuesday, 9:00 CET');
  assert.strictEqual(hub.history(owner, 'dev', 50).length, before, 'no room message for a pin');
  const shown = hub.history(owner, 'dev', 50);
  assert.deepStrictEqual(shown.filter((m) => m.pinned).map((m) => m.id), [a.id, b.id]);
  assert.deepStrictEqual(hub.pins(lead.conn, 'dev').pins.map((p) => [p.id, p.text, p.pinnedBy]), [[b.id, 'The brief is in brief.md', 'bootstrap-owner'], [a.id, 'Decision: launch Tuesday, 9:00 CET', 'builder']]);
  assert.deepStrictEqual(hub.pin(lead.conn, b.id, false), { id: b.id, room: 'dev', pinned: false, count: 1 });
  // the clients in the room get the new list, and nothing else
  const events = ownerClient.events.filter(([e]) => e === 'room/pins');
  assert.deepStrictEqual(events.map(([, d]) => d.pins.length), [1, 2, 1]);
  // kept in the log: a hub started again reads the same pins
  const log = fs.readFileSync(path.join(dir, 'rooms', 'dev.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(log.filter((r) => r.kind === 'pin' || r.kind === 'unpin').map((r) => [r.kind, r.target === a.id ? 'a' : 'b', r.from.name]), [['pin', 'a', 'builder'], ['pin', 'b', 'bootstrap-owner'], ['unpin', 'b', 'lead']]);
  hub.pinned.clear();
  assert.deepStrictEqual(hub.pins(owner, 'dev').pins.map((p) => p.id), [a.id]);
  hub.system('dev', 'x');
  assert.throws(() => hub.pin(owner, hub.store.tailRoom('dev', 1)[0].id, true), /cannot be pinned/);
});
