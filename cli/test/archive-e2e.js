'use strict';
// Archiving a room, from the command line and the terminal chat, on a hub of its own: nothing is
// deleted; the room leaves the list for its "archived" folder, takes no message, keeps its log;
// unarchive brings it back.
//   node test/archive-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-e2e-'));
  const port = 25000 + Math.floor(Math.random() * 4000);
  const O = 'ar-owner-token-0123456789abcdef', A = 'ar-agent-token-0123456789abcdef';
  const hubData = path.join(dir, 'hub');
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: hubData, HUB_OWNER_TOKEN: O, HUB_AGENT_TOKEN: A }, stdio: 'ignore' });
  let fails = 0;
  const ok = (w, c, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${w}${d ? ' — ' + d : ''}`); };
  const env = { ...process.env, HOME: dir, MC_HUB_URL: `ws://127.0.0.1:${port}/`, MC_TOKEN: O };
  for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID']) delete env[k];
  const cli = (...args) => spawnSync(process.execPath, [MC, ...args], { env, encoding: 'utf8' });
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const url = `ws://127.0.0.1:${port}/`;
    const owner = await connect({ url, token: O });
    await owner.api.agents.register({ name: 'misha', room: 'default', kind: 'human' });
    const builder = await connect({ url, token: A });
    await builder.api.agents.register({ name: 'builder', room: 'oldproj' });
    const told = [];
    builder.api.agents.on('message', (m) => told.push(m));
    await builder.api.room.say({ room: 'oldproj', text: 'the old plan, kept' });
    await owner.api.room.say({ room: 'live', text: 'still going' });
    const logFile = path.join(hubData, 'rooms', 'oldproj.jsonl');
    const before = fs.readFileSync(logFile, 'utf8');

    // the command line
    let r = cli('archive', 'oldproj');
    ok('metacom archive oldproj', r.status === 0 && /oldproj archived: read-only, its log kept · told builder · metacom unarchive oldproj brings it back/.test(r.stdout), r.stdout + r.stderr);
    r = cli('rooms');
    ok('metacom rooms: not listed; "1 archived room" at the end', !/^oldproj /m.test(r.stdout) && /^live /m.test(r.stdout) && /\n1 archived room\n?$/.test(r.stdout), r.stdout);
    r = cli('rooms', '--archived');
    ok('metacom rooms --archived: name, when, by whom, messages, last', /^oldproj +archived \d{4}-\d\d-\d\d by \S+ · 1 message · last /m.test(r.stdout), r.stdout);
    ok('the log is where it was, all of it, and nothing in a trash', fs.readFileSync(logFile, 'utf8').startsWith(before) && !fs.existsSync(path.join(hubData, 'rooms', '.deleted')));
    await sleep(300);
    ok('builder, in it, was told', told.some((m) => /oldproj is archived: read-only/.test(m.text)));
    const refused = await builder.api.room.say({ room: 'oldproj', text: 'more' }).then(() => null, (e) => e.message);
    ok('read-only: an agent\'s post is refused, with why', /oldproj is archived: read-only/.test(refused || ''), refused);

    // the terminal chat: the folder at the bottom of the room list, the room read-only, back again
    const c = spawnChat({ room: 'live', name: 'misha', cols: 100, rows: 28, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: O } });
    await c.wait(/still going/, 15000);
    await sleep(500);
    await c.type('\x1b[D', 1200); // ← on the empty input: the room list
    ok('the room list: oldproj not among the rooms; "1 archived room" at the bottom, no icon', !c.view().some((l) => /^\s*[› ] oldproj /.test(l)) && c.view().some((l) => /^\s*[› ] 1 archived room\s*$/.test(l)) && !c.view().some((l) => /🗄/.test(l)), c.view().slice(-12).join('\n'));
    for (let i = 0; i < 6; i++) await c.type('\x1b[B', 120);
    // down to the folder (the last row), and in
    const rows = () => c.view();
    let guard = 0;
    while (!rows().some((l) => /› 1 archived room/.test(l)) && guard++ < 10) await c.type('\x1b[B', 150);
    await c.type('\r', 800);
    ok('in the folder: the archived rooms, with messages and last activity', c.view().some((l) => /archived rooms · read-only · esc back/.test(l)) && c.view().some((l) => /oldproj +1 message · last /.test(l)) && !c.view().some((l) => /^\s*[› ] live /.test(l)), c.view().slice(-10).join('\n'));
    await c.type('\r', 2000);
    const input = () => c.view().find((l) => /│ ❯ /.test(l)) || '';
    ok('opened read-only: its log, "is archived · read-only · /unarchive", "🗄 unarchive" under the input', c.view().some((l) => /the old plan, kept/.test(l)) && /oldproj is archived · read-only · \/unarchive/.test(input()) && c.view().some((l) => /🗄 unarchive\s*$/.test(l)), c.view().slice(-8).join('\n'));
    await c.type('hello?', 200);
    await c.type('\r', 800);
    ok('a message there is not sent: "oldproj is archived: read-only"', c.view().some((l) => /oldproj is archived: read-only · \/unarchive brings it back/.test(l)) && !(await owner.api.room.history({ room: 'oldproj', limit: 50 })).some((m) => m.text === 'hello?'));
    for (let i = 0; i < 10; i++) await c.type('\x7f', 30);
    // a filter finds it from the main list too, under the folder's name
    await c.type('/unarchive', 300);
    await c.type('\r', 1500);
    ok('/unarchive: back; a message goes again', c.view().some((l) => /oldproj is back from the archive/.test(l)) && !/is archived/.test(input()), input().trim());
    await c.type('back to work', 200);
    await c.type('\r', 1200);
    ok('…and is in its log', (await owner.api.room.history({ room: 'oldproj', limit: 50 })).some((m) => m.text === 'back to work'));
    await c.type('/archive', 300);
    await c.type('\r', 1200);
    await c.type('\x1b[D', 1200);
    await c.type('old', 600);
    ok('a filter matches archived rooms too, under "archived"', c.view().some((l) => /^\s*archived\s*$/.test(l)) && c.view().some((l) => /oldproj +\d+ messages · last /.test(l)), c.view().slice(-8).join('\n'));
    c.kill();
    r = cli('unarchive', 'oldproj');
    ok('metacom unarchive oldproj', r.status === 0 && /oldproj is back from the archive/.test(r.stdout) && /^oldproj /m.test(cli('rooms').stdout), r.stdout + r.stderr);
    owner.m.close();
    builder.m.close();
  } finally {
    hubProc.kill();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.message.slice(0, 2000)); process.exit(1); });
