'use strict';
// Loops end to end: a real hub, an agent under the real wrapper (bash, so no model turn), and the
// terminal chat. /loop makes one (asking how often when the words do not say), /loops lists it like the room list; "run now" fires it and the wrapper types it in as
// "[hub misha (loop every 5m)] …"; it is turned off and on, and deleted (asked twice). A loop survives a hub
// restart. The schedule itself (on time, busy, stacking, @any, @all) is hub/test/loops.test.js.
//   node test/loops-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pty = require('node-pty');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
const { Screen } = require('../lib/screen.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'loops-e2e-'));
  const port = 21000 + Math.floor(Math.random() * 3000);
  const OWNER = 'lp-owner-token-0123456789abcdef';
  const AGENT = 'lp-agent-token-0123456789abcdef';
  const url = `ws://127.0.0.1:${port}/`;
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const startHub = async () => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    return p;
  };
  let hubProc = await startHub();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_') && !k.startsWith('CLAUDE'))), HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER, MC_AGENT_TOKEN: AGENT, PS1: '$ ' };
  const screen = new Screen(120, 30);
  const agent = pty.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'dev', '-n', 'ticker', 'bash', '--norc', '--noprofile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: dir, env });
  agent.onData((d) => screen.write(d));
  const owner = await connect({ url, token: OWNER });
  let c = null;
  // the driver's wait throws on a timeout; here it is a FAIL with the screen, and the run goes on
  const seen = (re, ms) => c.wait(re, ms).then(() => true, () => false);
  try {
    for (let i = 0; i < 50 && !(await owner.api.agents.list({})).some((m) => m.name === 'ticker' && m.connected); i++) await sleep(200);
    const idle = await owner.api.agents.wait({ name: 'ticker', until: ['waiting'], timeoutMs: 20_000 });
    ok('the bash agent is up and idle', !idle.timeout, idle.status);

    c = spawnChat({ room: 'dev', name: 'misha', cols: 120, rows: 32, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER } });
    await seen(/ticker/, 15000);
    // no schedule in the words: asked once, with numbered choices; "2" answers it
    await c.paste('/loop @ticker echo LOOP-$((6*7))');
    await c.type('\r', 300);
    ok('no schedule: the hub asks how often, numbered', await seen(/how often should @ticker get[\s\S]*1\. every 15m[\s\S]*2\. every 1h[\s\S]*3\. every day at 09:00/, 5000), c.dump());
    await c.type('2', 100);
    await c.type('\r', 300);
    ok('2 makes it, shown back as read', await seen(/loop set: every 1h → @ticker: echo LOOP/, 5000), c.dump());
    const [first] = await owner.api.loops.list({ room: 'dev' });
    await owner.api.loops.delete({ id: first.id });
    // misha's form: the target first, when in the words
    await c.paste('/loop @ticker echo LOOP-$((6*7)) every 5 minutes');
    await c.type('\r', 300);
    ok('/loop @ticker … every 5 minutes sets it', await seen(/loop set: every 5m → @ticker: echo LOOP-\$\(\(6\*7\)\) ·/, 5000), c.dump());
    ok('the room is told', await seen(/misha set a loop: every 5m → @ticker/, 5000), c.dump());
    const [made] = (await owner.api.loops.list({ room: 'dev' })).filter((l) => l.every === '5m');
    ok('the hub keeps it, in this terminal\'s time zone', made && made.tz === Intl.DateTimeFormat().resolvedOptions().timeZone, JSON.stringify(made));

    await c.paste('/loops');
    await c.type('\r', 500);
    ok('/loops opens in the room list\'s place', await seen(/loops in dev[\s\S]*› ● every 5m +@ticker +echo LOOP[\s\S]*filter · ↑↓ enter · esc back/, 4000), c.dump());
    ok('…with the conversation out of view', !/misha set a loop/.test(c.dump()), c.dump());
    await c.type('zzz', 300);
    ok('typing filters it, as in the room list', await seen(/no loop matches/, 3000), c.dump());
    for (let i = 0; i < 3; i++) await c.type(c.key.backspace, 80);
    ok('…and back', await seen(/› ● every 5m/, 3000), c.dump());

    // enter opens the loop, as the archived folder opens: its actions
    await c.type('\r', 400);
    ok('enter opens it: turn off, run now, delete', await seen(/‹ every 5m → @ticker[\s\S]*› turn off[\s\S]*run now[\s\S]*delete/, 3000), c.dump());
    await c.type(c.key.down, 200);
    await c.type('\r', 300);
    const typedIn = async () => {
      for (let i = 0; i < 60; i++) {
        if (screen.lines(30).some((l) => /\[hub misha \(loop every 5m\)\] echo LOOP/.test(l))) return true;
        await sleep(200);
      }
      return false;
    };
    ok('run now: the wrapper types it in, marked as the loop\'s', await typedIn(), screen.lines(30).join('\n'));
    ok('…and it says how the run went', await seen(/last [^·]* sent to ticker/, 4000), c.dump());

    await c.type(c.key.up, 200);
    await c.type('\r', 400);
    ok('turn off', await seen(/· off · ← or esc back[\s\S]*› turn on/, 3000), c.dump());
    ok('the hub has it off', (await owner.api.loops.list({ room: 'dev' }))[0].on === false);
    await c.type('\r', 400);
    ok('turn on again', await seen(/· on · ← or esc back[\s\S]*› turn off/, 3000), c.dump());
    await c.type(c.key.esc, 300);
    ok('esc goes back to the list', await seen(/loops in dev[\s\S]*› ● every 5m/, 3000), c.dump());

    // the hub restarts: the loop is still there, and the open list keeps working after the reconnect
    hubProc.kill();
    await sleep(500);
    hubProc = await startHub();
    await sleep(2500);
    const owner2 = await connect({ url, token: OWNER });
    const kept = await owner2.api.loops.list({ room: 'dev' });
    ok('it survives a hub restart', kept.length === 1 && kept[0].id === made.id && kept[0].on && kept[0].fires === 1, JSON.stringify(kept));
    owner2.m.close();

    await c.type(c.key.right, 300);
    await c.type(c.key.down, 100);
    await c.type(c.key.down, 100);
    await c.type('\r', 400);
    ok('delete asks first', await seen(/sure\? enter deletes it/, 3000) && (await owner.api.loops.list({ room: 'dev' })).length === 1, c.dump());
    await c.type(c.key.up, 300);
    ok('moving away keeps it', await seen(/› run now[\s\S]*\n *delete/, 3000), c.dump());
    await c.type(c.key.down, 200);
    await c.type('\r', 300);
    await c.type('\r', 800);
    ok('enter twice deletes it, back to the list', (await owner.api.loops.list({ room: 'dev' })).length === 0 && (await seen(/no loops in dev · \/loop @agent/, 3000)), c.dump());
    await c.type(c.key.esc, 400);
    ok('esc closes it: the conversation is back', await seen(/misha deleted the loop every 5m → @ticker/, 3000), c.dump());

    await c.paste('/loop @all send me report every minute');
    await c.type('\r', 500);
    ok('every minute, to @all: the shortest there is', await seen(/loop set: every 1m → @all: send me report/, 3000), c.dump());
  } finally {
    if (c) c.kill();
    agent.kill();
    owner.m.close();
    hubProc.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e.stack || e.message);
  process.exit(1);
});
