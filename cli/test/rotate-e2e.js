'use strict';
// Session rotation end to end, on a hub of its own: real wrappers around a stand-in Claude Code
// and a stand-in Codex that keep a context the size real ones would (in their real session file
// formats), answer the way agents do, and log what is typed into them. Measures the context
// before and after each rotation.
//   node test/rotate-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-e2e-'));
const home = path.join(dir, 'home');
const work = path.join(dir, 'work');
for (const d of [home, work, path.join(work, 'a'), path.join(work, 'b'), path.join(work, 'c'), path.join(work, 'd')]) fs.mkdirSync(d, { recursive: true });
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'rotate-e2e-owner-token-012345';
const AGENT = 'rotate-e2e-agent-token-012345';
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};

// one stand-in for both: its name (claude or codex) says which session format it writes
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const kind = path.basename(process.argv[1]), name = process.env.MC_AGENT, home = process.env.HOME, cwd = process.cwd();
let ctx = 0, file = null;
const fresh = () => {
  const id = crypto.randomUUID();
  if (kind === 'codex') {
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '13');
    fs.mkdirSync(day, { recursive: true });
    file = path.join(day, 'rollout-2026-10-13T' + Date.now() + '-' + id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\\n');
  } else {
    const proj = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(proj, { recursive: true });
    file = path.join(proj, id + '.jsonl');
    fs.writeFileSync(file, '');
    // as Claude Code does: the session this process is in, by its pid (/clear changes it)
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id, cwd }));
  }
  ctx = 0;
};
const usage = () => fs.appendFileSync(file, (kind === 'codex'
  ? JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: ctx, cached_input_tokens: Math.max(0, ctx - 2000) } } } })
  : JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2000, cache_read_input_tokens: Math.max(0, ctx - 3000), cache_creation_input_tokens: 1000, output_tokens: 300 } } })) + '\\n');
const busy = (on) => process.stdout.write('\\x1b]9;4;' + (on ? 3 : 0) + '\\x07\\x1b]0;' + (on ? '✶ working' : kind) + '\\x07');
fresh();
busy(false);
process.stdout.write('> ');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, i).replace(/\\x1b\\[20[01]~/g, '').trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    fs.appendFileSync(path.join(home, 'typed-' + name + '.log'), line + '\\n');
    if (line === '/clear' || line === '/new') { fresh(); continue; }
    busy(true);
    setTimeout(() => {
      if (/Update your PROGRESS.md/.test(line)) { if (!fs.existsSync(path.join(home, 'api-down-' + name))) fs.writeFileSync(path.join(cwd, 'PROGRESS.md'), 'done: step one, step two\\nopen: none\\nnext: wait\\n'); ctx += 1000; }
      else if (/Read your ROLE.md and PROGRESS.md/.test(line)) ctx = 9000;
      else if (/finish it/.test(line)) { ctx += 60000; spawnSync(process.execPath, [process.env.FAKE_MC, 'send', 'misha', 'Done: step one and two'], { env: process.env }); }
      else if (/big job/.test(line)) ctx += 120000;
      else ctx += 20000;
      usage();
      busy(false);
    }, 1200);
  }
});
setInterval(() => {}, 1000);
`;

const main = async () => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const n of ['claude', 'codex']) fs.writeFileSync(path.join(bin, n), FAKE, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, FAKE_MC: MC, METACOM_ROTATE_TICK_MS: '1000' };
  for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID', 'MC_AGENT_KEY']) delete env[k];
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT },
    stdio: 'ignore',
  });
  const procs = [];
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    const owner = await connect({ url, token: OWNER });
    await owner.api.agents.register({ name: 'misha', room: 'e2e', kind: 'human' });
    // alpha: Claude Code, --rotate task (150k); beta: Codex, idle for 3 seconds
    procs.push(spawn(process.execPath, [MC, 'e2e', '-n', 'alpha', '--rotate', 'task', 'claude'], { env, cwd: path.join(work, 'a'), stdio: 'ignore' }));
    procs.push(spawn(process.execPath, [MC, 'e2e', '-n', 'beta', '--rotate', 'idle:0.05', 'codex'], { env, cwd: path.join(work, 'b'), stdio: 'ignore' }));
    const member = async (n) => (await owner.api.agents.list({ room: 'e2e' })).find((m) => m.name === n) || {};
    await until('both idle', async () => (await member('alpha')).status === 'waiting' && (await member('beta')).status === 'waiting');
    const typed = (n) => (fs.existsSync(path.join(home, `typed-${n}.log`)) ? fs.readFileSync(path.join(home, `typed-${n}.log`), 'utf8').trim().split('\n') : []);
    const lines = async () => (await owner.api.room.history({ room: 'e2e', limit: 80 })).map((m) => m.text);
    const task = async (n, text) => {
      const before = typed(n).length;
      await owner.api.agents.send({ to: n, text, kind: 'command' });
      await until(`${n} took "${text}"`, () => typed(n).length > before);
    };

    // 1. Claude: a big job, then "finish it": its context passes 150k and it says done: rotated
    await task('alpha', 'a big job');
    await until('alpha idle', async () => (await member('alpha')).status === 'waiting' && (await member('alpha')).ctx === 120000);
    assert.ok(!(await lines()).some((t) => /^rotated alpha/.test(t)), '120k, nothing done yet: no rotation');
    await task('alpha', 'now finish it');
    await until('alpha rotated', async () => (await lines()).some((t) => /^rotated alpha/.test(t)), 60000);
    const line = (await lines()).find((t) => /^rotated alpha/.test(t));
    assert.strictEqual(line, 'rotated alpha (ctx 180k → 9k)');
    const t = typed('alpha');
    const at = t.findIndex((x) => /Update your PROGRESS.md now/.test(x));
    assert.deepStrictEqual([t[at + 1], /Read your ROLE.md and PROGRESS.md, then wait for the next task/.test(t[at + 2])], ['/clear', true]);
    assert.match(fs.readFileSync(path.join(work, 'a', 'PROGRESS.md'), 'utf8'), /done: step one/);
    const a = await member('alpha');
    assert.deepStrictEqual([a.ctx, a.rotations], [9000, 1]);
    pass(`Claude Code: 120k after a big job; "Done" to the tasker at 180k: PROGRESS.md written, /clear, ROLE.md + PROGRESS.md read again: ${line}`);

    // 2. a small task and the owner's "thanks": rotated on the sign-off, below the limit
    await task('alpha', 'a small fix');
    await until('alpha at 29k', async () => (await member('alpha')).ctx === 29000);
    await task('alpha', 'thanks');
    await until('rotated again', async () => (await lines()).filter((x) => /^rotated alpha/.test(x)).length === 2, 60000);
    assert.strictEqual((await lines()).filter((x) => /^rotated alpha/.test(x))[1], 'rotated alpha (ctx 49k → 9k)');
    pass('the owner\'s "thanks": rotated below the limit too (49k → 9k)');

    // 3. KEEP CONTEXT in PROGRESS.md: not rotated, even far above the limit
    fs.writeFileSync(path.join(work, 'a', 'PROGRESS.md'), 'open: the audit\nKEEP CONTEXT until the audit is signed\n');
    await task('alpha', 'a big job');
    await task('alpha', 'another big job');
    await until('alpha at 249k', async () => (await member('alpha')).ctx === 249000).catch(async (e) => {
      throw new Error(`${e.message} (ctx ${(await member('alpha')).ctx}; typed ${JSON.stringify(typed('alpha').slice(-6))})`);
    });
    await sleep(3000);
    assert.strictEqual((await lines()).filter((x) => /^rotated alpha/.test(x)).length, 2);
    pass('"KEEP CONTEXT until …" in PROGRESS.md: kept, at 249k');

    // 3b. the API failing (a turn that writes nothing): the save does not happen, so nothing is cleared
    fs.writeFileSync(path.join(work, 'a', 'PROGRESS.md'), 'open: nothing kept\n');
    fs.writeFileSync(path.join(home, 'api-down-alpha'), '');
    const clears = () => typed('alpha').filter((x) => x === '/clear').length;
    const c0 = clears();
    await task('alpha', 'a big job');
    await until('asked to save', () => typed('alpha').filter((x) => /Update your PROGRESS.md now/.test(x)).length === 3, 30000);
    await sleep(4000);
    assert.strictEqual(clears(), c0, 'not cleared: its notes were not written');
    pass('the save turn writes nothing (API down): the context is not cleared');

    // 4. Codex, idle:0.05: a job, then 3 quiet seconds: /new, not /clear
    await task('beta', 'a big job');
    await until('beta rotated', async () => (await lines()).some((x) => /^rotated beta/.test(x)), 60000);
    assert.strictEqual((await lines()).find((x) => /^rotated beta/.test(x)), 'rotated beta (ctx 120k → 9k)');
    assert.ok(typed('beta').includes('/new') && !typed('beta').includes('/clear'));
    pass('Codex, --rotate idle: after 3 quiet seconds, /new: rotated beta (ctx 120k → 9k)');

    // 6. the default (never) and the owner's "@all !/clear": in their own room, gamma (Claude Code)
    // and delta (Codex) are never cleared by themselves, even far above 150k; "@all !/clear" clears
    // both, gamma only once its turn is over; one line for the room
    procs.push(spawn(process.execPath, [MC, 'e2e2', '-n', 'gamma', 'claude'], { env, cwd: path.join(work, 'c'), stdio: 'ignore' }));
    procs.push(spawn(process.execPath, [MC, 'e2e2', '-n', 'delta', 'codex'], { env, cwd: path.join(work, 'd'), stdio: 'ignore' }));
    const in2 = async (n) => (await owner.api.agents.list({ room: 'e2e2' })).find((m) => m.name === n) || {};
    await until('gamma and delta idle', async () => (await in2('gamma')).status === 'waiting' && (await in2('delta')).status === 'waiting');
    await task('gamma', 'a big job');
    await task('gamma', 'another big job');
    await task('delta', 'a big job');
    await until('gamma at 240k, delta at 120k', async () => (await in2('gamma')).ctx === 240000 && (await in2('delta')).ctx === 120000);
    await task('gamma', 'thanks');
    await sleep(3000);
    const lines2 = async () => (await owner.api.room.history({ room: 'e2e2', limit: 80 })).map((m) => m.text);
    assert.ok(!typed('gamma').includes('/clear') && !typed('delta').includes('/new') && !(await lines2()).some((x) => /rotated|cleared/.test(x)), 'never by themselves');
    pass('the default, never: not cleared at 240k, nor on a "thanks"');
    await owner.api.agents.send({ to: 'gamma', text: 'a big job', kind: 'command' });
    await until('gamma busy', async () => (await in2('gamma')).status === 'working');
    await owner.api.room.say({ room: 'e2e2', text: '@all !/clear' });
    await until('the room line', async () => (await lines2()).some((x) => /^misha cleared/.test(x)), 60000);
    assert.deepStrictEqual((await lines2()).filter((x) => /cleared|^rotated/.test(x)), ['misha cleared 2 agents (ctx 120k+380k → fresh)']);
    const g = typed('gamma');
    const save = g.findIndex((x) => /Update your PROGRESS.md now/.test(x));
    assert.ok(save > g.lastIndexOf('a big job') && g[save + 1] === '/clear' && /Read your ROLE.md and PROGRESS.md/.test(g[save + 2]), JSON.stringify(g.slice(-5)));
    assert.ok(typed('delta').includes('/new') && !typed('delta').includes('/clear'));
    assert.deepStrictEqual([(await in2('gamma')).ctx, (await in2('delta')).ctx], [9000, 9000]);
    pass('"@all !/clear": both cleared, gamma after its turn (notes, /clear, notes read again), delta with /new: one line, "misha cleared 2 agents (ctx 120k+380k → fresh)"');

    // 7. the owner's "@all !hello there": typed into each as plain text, as at its terminal (no
    // "[hub misha]", not /hello); "@gamma !/compact": a slash command
    await owner.api.room.say({ room: 'e2e2', text: '@all !hello there' });
    await owner.api.agents.send({ to: 'gamma', text: '!/compact', kind: 'command' });
    await until('typed in', () => typed('gamma').includes('hello there') && typed('delta').includes('hello there') && typed('gamma').includes('/compact'));
    assert.ok(!typed('gamma').some((x) => /\[hub misha\] !?hello|\/hello/.test(x)));
    pass('"@all !hello there": "hello there" typed into each as plain text; "@gamma !/compact": /compact');

    // 5. metacom usage: the context now, and the rotations
    const u = spawnSync(process.execPath, [MC, 'usage', '--days', '1'], { env: { ...env, MC_TOKEN: OWNER }, encoding: 'utf8' });
    assert.match(u.stdout, /alpha@e2e\s+\d+k\s+rotated 2×/);
    assert.match(u.stdout, /beta@e2e\s+9k\s+rotated 1×/);
    pass('metacom usage: the context now and the rotations, per agent');
    owner.m.close();
  } finally {
    for (const p of procs) p.kill();
    hubProc.kill();
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exit(1);
  },
);
