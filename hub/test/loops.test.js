'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { parseEvery, parseLine, parseCron, nextCron, labelOf } = require('../lib/loops.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const MIN = 60_000;

const fakeClient = () => ({ events: [], source: '127.0.0.1', on() {}, emit(name, data) { this.events.push([name, data]); }, close() {} });

/// A hub with a clock the test moves, and no jitter.
const setup = (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-loops-')), clock = { t: Date.parse('2026-10-15T10:00:00Z') }) => {
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet, loops: { clock: () => clock.t, random: () => 0, tickMs: 0 } });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(ownerConn, { name: 'misha', room: 'dev', kind: 'human' });
  const agents = {};
  // the same agent token across a restart, as the agents keep theirs
  const agentTok = auth.list().some((t) => t.name === 'a') ? { token: fs.readFileSync(path.join(dir, 'agent-token.test'), 'utf8') } : auth.create({ name: 'a', role: 'agent' });
  fs.writeFileSync(path.join(dir, 'agent-token.test'), agentTok.token);
  const join = (name, room = 'dev') => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(agentTok.token), '127.0.0.1');
    hub.register(conn, { name, room });
    agents[name] = { conn, client, got: () => client.events.filter(([n]) => n === 'agents/message').map(([, d]) => d) };
    return agents[name];
  };
  // the wrapper typing it in: off the inbox
  const typeIn = (name) => hub.ack(agents[name].conn, (hub.inbox.get(agents[name].conn.key) || []).map((m) => m.id));
  const later = (ms) => {
    clock.t += ms;
    hub.loops.tick();
  };
  return { dir, clock, hub, auth, ownerConn, join, agents, typeIn, later };
};

test('loops: schedules: 1m / 15m / 2h / 1d, a cron in the owner\'s time zone, every minute at the most often', () => {
  assert.strictEqual(parseEvery('2h').ms, 2 * 3600_000);
  assert.strictEqual(parseEvery('1m').ms, MIN);
  assert.strictEqual(parseEvery('1d').every, '1d');
  assert.strictEqual(parseEvery('* * * * *').ms, MIN);
  assert.throws(() => parseEvery('0m'), /every minute at the most/);
  assert.throws(() => parseEvery('soon'), /not 15m/);
  assert.strictEqual(parseEvery('17 * * * *').ms, 3600_000);
  // 9:00 on weekdays in Kyiv, from a Friday evening: the Monday, at 06:00 UTC (summer time, +3)
  const cron = parseCron('0 9 * * mon-fri');
  const next = nextCron(cron, 'Europe/Kyiv', Date.parse('2026-10-16T18:00:00Z'));
  assert.strictEqual(new Date(next).toISOString(), '2026-10-19T06:00:00.000Z');
  // and in winter time (+2), after the clocks go back on Oct 25
  assert.strictEqual(new Date(nextCron(cron, 'Europe/Kyiv', Date.parse('2026-10-26T12:00:00Z'))).toISOString(), '2026-10-27T07:00:00.000Z');
});

test('loops: free text: the target first, the schedule read from the words, and taken out of the prompt', () => {
  const read = (line) => {
    const r = parseLine(line);
    return [r.target, r.every && labelOf(r.every), r.prompt];
  };
  assert.deepStrictEqual(read('@all send me report every minute'), ['all', 'every 1m', 'send me report']);
  assert.deepStrictEqual(read('@leader do a catch up with the whole team and send a quick feedback to misha every 2h'), ['leader', 'every 2h', 'do a catch up with the whole team and send a quick feedback to misha']);
  assert.deepStrictEqual(read('@any tidy the backlog hourly'), ['any', 'every 1h', 'tidy the backlog']);
  assert.deepStrictEqual(read('@metadev every day at 9 post the standup'), ['metadev', 'every day at 09:00', 'post the standup']);
  assert.deepStrictEqual(read('@x check prices every 15 minutes'), ['x', 'every 15m', 'check prices']);
  assert.deepStrictEqual(read('@x check in every three hours'), ['x', 'every 3h', 'check in']);
  assert.deepStrictEqual(read('@x every half hour, ping'), ['x', 'every 30m', 'ping']);
  assert.deepStrictEqual(read('@x every weekday at 9:30am triage'), ['x', 'weekdays at 09:30', 'triage']);
  assert.deepStrictEqual(read('@x every monday at 10 plan the week'), ['x', 'Mondays at 10:00', 'plan the week']);
  assert.deepStrictEqual(read('@x the report at 6pm'), ['x', 'every day at 18:00', 'the report']);
  assert.deepStrictEqual(read('@x daily summary'), ['x', 'every 1d', 'summary']);
  assert.deepStrictEqual(read('@x "17 * * * *" ping'), ['x', 'cron 17 * * * *', 'ping']);
  // an explicit schedule after the target, or before it (the first form), still works
  assert.deepStrictEqual(read('@x 2h status?'), ['x', 'every 2h', 'status?']);
  assert.deepStrictEqual(read('2h @leader do a catch up'), ['leader', 'every 2h', 'do a catch up']);
  // none in the words: no schedule (the hub asks)
  assert.deepStrictEqual(read('@x send a report'), ['x', null, 'send a report']);
  assert.throws(() => parseLine('send it every day'), /usage/);
});

test('loops: fires on time as a command from its maker, marked as the loop\'s; survives a hub restart', () => {
  const s = setup();
  const ceo = s.join('leader');
  s.hub.setStatus(ceo.conn, 'waiting', 'idle');
  const loop = s.hub.loops.create(s.ownerConn, { room: 'dev', line: '2h @leader do a catch up with the whole team and send a quick feedback to misha', tz: 'Europe/Kyiv' });
  assert.strictEqual(loop.target, 'leader');
  assert.strictEqual(loop.tz, 'Europe/Kyiv');
  assert.ok(s.hub.store.tailRoom('dev', 5).some((m) => m.kind === 'system' && /misha set a loop: every 2h → @leader/.test(m.text)));
  s.later(119 * MIN);
  assert.strictEqual(ceo.got().length, 0, 'not before its time');
  s.later(1 * MIN);
  const [msg] = ceo.got();
  assert.strictEqual(msg.kind, 'command');
  assert.strictEqual(msg.from.name, 'misha');
  assert.deepStrictEqual(msg.loop, { id: loop.id, every: '2h', label: 'every 2h' });
  assert.ok(/catch up/.test(msg.text));
  assert.ok(s.hub.store.tailRoom('dev', 5).some((m) => m.id === msg.id), 'the room sees it');
  // a loop's turn is not one the owner is waiting on: no "done" alert when it ends
  s.hub.setStatus(ceo.conn, 'working', 'progress');
  s.hub.setStatus(ceo.conn, 'waiting', 'idle');
  assert.strictEqual(s.hub.list(s.ownerConn).find((m) => m.name === 'leader').attention, false);
  s.typeIn('leader');
  // the hub restarts: the loop is still there, due at the same time, and fires
  const again = setup(s.dir, s.clock);
  const [kept] = again.hub.loops.list(again.ownerConn, 'dev');
  assert.strictEqual(kept.id, loop.id);
  assert.strictEqual(kept.next, new Date(s.clock.t + 120 * MIN).toISOString());
  const ceo2 = again.join('leader');
  again.later(120 * MIN);
  assert.strictEqual(ceo2.got().length, 1);
  assert.strictEqual(again.hub.loops.list(again.ownerConn, 'dev')[0].fires, 2);
});

test('loops: a busy target gets it when idle (the wrapper types it in then); never stacked; offline skipped and recorded', () => {
  const s = setup();
  const dev = s.join('metadev');
  s.hub.setStatus(dev.conn, 'working', 'progress');
  const loop = s.hub.loops.create(s.ownerConn, { room: 'dev', every: '15m', target: '@metadev', prompt: 'status?' });
  s.later(15 * MIN);
  assert.strictEqual(dev.got().length, 1, 'sent to its inbox while busy');
  let [view] = s.hub.loops.list(s.ownerConn, 'dev');
  assert.strictEqual(view.last.outcome, 'sent');
  assert.match(view.last.why, /typed in when idle/);
  // still busy, the last one still in its inbox: the next fire is skipped, not queued behind it
  s.later(15 * MIN);
  assert.strictEqual(dev.got().length, 1);
  [view] = s.hub.loops.list(s.ownerConn, 'dev');
  assert.strictEqual(view.last.outcome, 'skipped');
  assert.match(view.last.why, /not picked up/);
  assert.strictEqual(view.skips, 1);
  // idle: the wrapper types it in (acks it); the next fire goes
  s.hub.setStatus(dev.conn, 'waiting', 'idle');
  s.typeIn('metadev');
  s.later(15 * MIN);
  assert.strictEqual(dev.got().length, 2);
  // offline: skipped, and the loop says why
  s.typeIn('metadev');
  s.hub.unbind(dev.client);
  s.later(15 * MIN);
  [view] = s.hub.loops.list(s.ownerConn, 'dev');
  assert.strictEqual(view.last.outcome, 'skipped');
  assert.match(view.last.why, /offline/);
  assert.strictEqual(view.id, loop.id);
});

test('loops: @any goes to the first idle agent, or waits for one; @all to every agent online, each never stacked', () => {
  const s = setup();
  const a = s.join('alpha');
  const b = s.join('beta');
  s.hub.setStatus(a.conn, 'working', 'progress');
  s.hub.setStatus(b.conn, 'waiting', 'idle');
  s.hub.loops.create(s.ownerConn, { room: 'dev', line: '1h @any tidy the backlog' });
  s.later(60 * MIN);
  assert.strictEqual(a.got().length, 0);
  assert.strictEqual(b.got().length, 1, 'beta is the idle one');
  s.typeIn('beta');
  // both busy: it waits, and the first to go idle gets it
  s.hub.setStatus(b.conn, 'working', 'progress');
  s.later(60 * MIN);
  assert.strictEqual(s.hub.loops.list(s.ownerConn, 'dev')[0].last.outcome, 'waiting');
  s.hub.setStatus(a.conn, 'waiting', 'idle');
  assert.strictEqual(a.got().length, 1, 'alpha went idle first');
  assert.strictEqual(b.got().length, 1);
  // while one is still waiting for an idle agent, the next fire is skipped
  s.typeIn('alpha');
  s.hub.setStatus(a.conn, 'working', 'progress');
  s.later(60 * MIN);
  s.later(60 * MIN);
  const [any] = s.hub.loops.list(s.ownerConn, 'dev');
  assert.strictEqual(any.last.outcome, 'skipped');
  assert.match(any.last.why, /still waiting/);

  const t = setup();
  const x = t.join('x');
  const y = t.join('y');
  t.hub.loops.create(t.ownerConn, { room: 'dev', line: '30m @all check in' });
  t.later(30 * MIN);
  assert.strictEqual(x.got().length, 1);
  assert.strictEqual(y.got().length, 1);
  assert.strictEqual(t.hub.store.tailRoom('dev', 10).filter((m) => m.loop).length, 1, 'one line for the room');
  t.typeIn('x');
  t.later(30 * MIN);
  assert.strictEqual(x.got().length, 2, 'x picked it up, so it gets the next');
  assert.strictEqual(y.got().length, 1, 'y did not: skipped for y');
  assert.match(t.hub.loops.list(t.ownerConn, 'dev')[0].last.why, /skipped y/);
});

test('loops: toggle and delete; an agent loops only to itself or @any, in its own room, and changes only its own', () => {
  const s = setup();
  const ceo = s.join('leader');
  const dev = s.join('metadev');
  s.hub.setStatus(ceo.conn, 'waiting', 'idle');
  const mine = s.hub.loops.create(ceo.conn, { every: '1h', target: 'leader', prompt: 'hourly tick' });
  assert.strictEqual(mine.room, 'dev');
  assert.strictEqual(mine.by.name, 'leader');
  assert.throws(() => s.hub.loops.create(ceo.conn, { every: '1h', target: 'metadev', prompt: 'x' }), /only to itself or @any/);
  assert.throws(() => s.hub.loops.create(ceo.conn, { every: '1h', target: 'all', prompt: 'x' }), /only to itself or @any/);
  assert.throws(() => s.hub.loops.create(ceo.conn, { room: 'other', every: '1h', target: 'leader', prompt: 'x' }), /not in other/);
  assert.throws(() => s.hub.loops.create(s.ownerConn, { room: 'dev', every: '1h', target: 'nobody', prompt: 'x' }), /no agent nobody/);
  assert.throws(() => s.hub.loops.create(s.ownerConn, { room: 'dev', every: '1h', target: 'all', prompt: '!/clear' }), /not looped/);
  s.hub.loops.create(ceo.conn, { every: '20h', target: 'any', prompt: 'b' });
  s.hub.loops.create(ceo.conn, { every: '21h', target: 'any', prompt: 'c' });
  assert.throws(() => s.hub.loops.create(ceo.conn, { every: '4h', target: 'any', prompt: 'd' }), /3 loops already/);
  // another agent cannot touch it; the owner can
  assert.throws(() => s.hub.loops.toggle(dev.conn, mine.id, false), /only the owner or leader/);
  const off = s.hub.loops.toggle(s.ownerConn, mine.id, false);
  assert.strictEqual(off.on, false);
  assert.strictEqual(off.next, null);
  s.later(60 * MIN);
  assert.strictEqual(ceo.got().length, 0, 'off: does not fire');
  const on = s.hub.loops.toggle(ceo.conn, mine.id.slice(0, 4), true);
  assert.strictEqual(on.next, new Date(s.clock.t + 60 * MIN).toISOString(), 'on again: counts from now');
  s.later(60 * MIN);
  assert.strictEqual(ceo.got().length, 1);
  // run now: fired at once, its schedule unchanged; not stacked on one not picked up
  const before = s.hub.loops.list(s.ownerConn, 'dev').find((l) => l.id === mine.id).next;
  s.typeIn('leader');
  assert.strictEqual(s.hub.loops.run(s.ownerConn, mine.id).next, before);
  assert.strictEqual(ceo.got().length, 2);
  assert.strictEqual(s.hub.loops.run(ceo.conn, mine.id).last.outcome, 'skipped');
  assert.throws(() => s.hub.loops.run(dev.conn, mine.id), /only the owner or leader/);
  assert.deepStrictEqual(s.hub.loops.remove(ceo.conn, mine.id), { deleted: mine.id });
  assert.strictEqual(s.hub.loops.list(s.ownerConn, 'dev').length, 2);
  assert.ok(s.hub.store.tailRoom('dev', 10).some((m) => m.kind === 'system' && /leader deleted the loop every 1h/.test(m.text)));
  // the owner sees every room's loops
  assert.strictEqual(s.hub.loops.list(s.ownerConn, null, true).length, 2);
  assert.throws(() => s.hub.loops.list(ceo.conn, null, true), /Owners only/);
  // a person with a member token makes none
  const member = s.hub.bind(fakeClient(), s.auth.verify(s.auth.create({ name: 'guest', role: 'member', rooms: ['dev'] }).token), '127.0.0.1');
  assert.throws(() => s.hub.loops.create(member, { room: 'dev', line: '1h @any x' }), /owner and the agents/);
});

test('loops: an agent\'s loop runs in the owner\'s time zone; a cron loop fires at its wall-clock minute', () => {
  const s = setup(undefined, { t: Date.parse('2026-10-15T10:05:00Z') });
  const ceo = s.join('leader');
  s.hub.setStatus(ceo.conn, 'waiting', 'idle');
  s.hub.loops.create(s.ownerConn, { room: 'dev', line: '"0 14 * * *" @leader daily summary', tz: 'Europe/Kyiv' });
  const agentLoop = s.hub.loops.create(ceo.conn, { line: '"17 * * * *" @leader hourly tick' });
  assert.strictEqual(agentLoop.tz, 'Europe/Kyiv', 'the owner\'s, from the owner\'s last loop');
  const [daily] = s.hub.loops.list(s.ownerConn, 'dev');
  assert.strictEqual(daily.next, '2026-10-15T11:00:00.000Z', '14:00 in Kyiv');
  assert.strictEqual(agentLoop.next, '2026-10-15T10:17:00.000Z');
  s.later(12 * MIN);
  assert.strictEqual(ceo.got().length, 1);
  assert.strictEqual(s.hub.loops.list(s.ownerConn, 'dev')[1].next, '2026-10-15T11:17:00.000Z');
});

test('loops: no schedule in the words: asked once, with numbered choices; the answer makes it, shown back as parsed', () => {
  const s = setup();
  s.join('leader');
  const asked = s.hub.loops.create(s.ownerConn, { room: 'dev', line: '@leader send me a report' });
  assert.ok(asked.ask, 'a question, no loop');
  assert.match(asked.ask.text, /how often should @leader get "send me a report"/);
  assert.deepStrictEqual(asked.ask.options.map((o) => o.label), ['every 15m', 'every 1h', 'every day at 09:00']);
  assert.strictEqual(s.hub.loops.list(s.ownerConn, 'dev').length, 0);
  const made = s.hub.loops.create(s.ownerConn, { room: 'dev', line: '@leader send me a report', every: asked.ask.options[2].every });
  assert.strictEqual(made.label, 'every day at 09:00');
  assert.strictEqual(made.prompt, 'send me a report');
  const minute = s.hub.loops.create(s.ownerConn, { room: 'dev', line: '@all send me report every minute' });
  assert.strictEqual(minute.label, 'every 1m');
  assert.strictEqual(minute.target, 'all');
  assert.ok(s.hub.store.tailRoom('dev', 5).some((m) => m.kind === 'system' && m.text.startsWith('misha set a loop: every 1m → @all: send me report')));
  // an agent's tool call: the schedule in the prompt's words too
  const ceo = s.agents.leader.conn;
  const tick = s.hub.loops.create(ceo, { target: 'leader', prompt: 'check the queue every 30 minutes' });
  assert.deepStrictEqual([tick.label, tick.prompt], ['every 30m', 'check the queue']);
  // a prompt that is only a schedule says what is missing
  assert.throws(() => s.hub.loops.create(s.ownerConn, { room: 'dev', line: '@all every minute' }), /needs a prompt/);
});
