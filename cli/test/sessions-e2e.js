'use strict';
// Room sessions end to end (docs/sessions.md): a real hub, an agent under the real wrapper (bash,
// so no model turn) in a git repository. /invite into trade: its wrapper starts a second wrapper,
// valuesdev@trade, in the same folder with notes of its own, welcomed there; the agent at home is told the work
// moved. /uninvite: the session stops. Invited while its machine is away: started when it is back.
//   node test/sessions-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { connect } = require('../lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-e2e-'));
  const port = 24000 + Math.floor(Math.random() * 3000);
  const OWNER = 'ss-owner-token-0123456789abcdef';
  const AGENT = 'ss-agent-token-0123456789abcdef';
  const url = `ws://127.0.0.1:${port}/`;
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const until = async (fn, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(300);
    }
    return false;
  };
  const repo = path.join(dir, 'valuesdao');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'values\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_') && !k.startsWith('CLAUDE'))), HOME: dir, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, PS1: '$ ' };
  const startHome = () => pty.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'values', '-n', 'valuesdev', 'bash', '--norc', '--noprofile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: repo, env });
  let home = startHome();
  const owner = await connect({ url, token: OWNER });
  const member = async (id) => (await owner.api.agents.list({})).find((m) => m.id === id);
  const pidOf = (room) => {
    try {
      return Number(fs.readFileSync(path.join(dir, '.local', 'share', 'metacom-hub', 'sessions', `valuesdev@${room}.pid`), 'utf8'));
    } catch {
      return null;
    }
  };
  const alive = (pid) => {
    try {
      return Boolean(pid) && process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  try {
    ok('the agent is up at home', await until(async () => (await member('valuesdev@values'))?.connected));

    // invite → started, in a worktree, welcomed; the agent at home told the work moved
    const r = await owner.api.agents.invite({ name: 'valuesdev', room: 'trade' });
    ok('/invite: its machine is online, the session is starting', r.starting === true, JSON.stringify(r));
    ok('valuesdev@trade comes up, by the same name, living in trade', await until(async () => (await member('valuesdev@trade'))?.connected), JSON.stringify(await owner.api.agents.list({})));
    const s = await member('valuesdev@trade');
    ok('…a session of the agent in values', s.home === 'values', JSON.stringify(s));
    ok('…in the same folder', s.repo === repo, s.repo);
    ok('…with notes of its own', fs.existsSync(path.join(s.repo, 'PROGRESS-valuesdev@trade.md')));
    const trade = await owner.api.room.history({ room: 'trade', limit: 20 });
    ok('the room says it was invited, starting…', trade.some((m) => m.kind === 'system' && /invited valuesdev \(from values\): its session here is starting…/.test(m.text)), trade.map((m) => m.text).join(' | '));
    ok('…and that it is up once it is', trade.some((m) => m.kind === 'system' && /valuesdev's session here is up \(from values/.test(m.text)), trade.map((m) => m.text).join(' | '));
    ok('the session is welcomed with where its work is, and told it shares the folder', trade.some((m) => m.to === 'valuesdev' && /You are valuesdev's session for room trade[\s\S]*PROGRESS-valuesdev@trade\.md[\s\S]*commit only your own files/.test(m.text)));
    const welcome = trade.find((m) => m.to === 'valuesdev' && /You are valuesdev's session/.test(m.text));
    ok('…with where every session keeps its notes, to read, never write', welcome && welcome.text.includes(`- valuesdev@values: ${path.join(repo, 'PROGRESS.md')}`) && welcome.text.includes(`- valuesdev@trade: ${path.join(repo, 'PROGRESS-valuesdev@trade.md')}`) && /never write them/.test(welcome.text), welcome && welcome.text);
    const values = await owner.api.room.history({ room: 'values', limit: 20 });
    ok('the agent at home is told trade\'s work moved there', values.some((m) => m.to === 'valuesdev' && /trade now has a session of you of its own/.test(m.text)));
    ok('it runs as its own process', alive(pidOf('trade')));

    // uninvite → it stops
    await owner.api.agents.uninvite({ name: 'valuesdev', room: 'trade' });
    ok('/uninvite: the session stops', await until(async () => !(await member('valuesdev@trade'))?.connected && !alive(pidOf('trade'))), JSON.stringify(await member('valuesdev@trade')));
    ok('…and the agent at home goes on', (await member('valuesdev@values'))?.connected);

    // its machine away: the invite waits, and the session starts when it is back
    home.kill();
    ok('the agent\'s machine goes away', await until(async () => !(await member('valuesdev@values'))?.connected));
    const later = await owner.api.agents.invite({ name: 'valuesdev@values', room: 'ops' });
    ok('/invite while it is away: waits', later.starting === false);
    await sleep(1500);
    const waiting = await member('valuesdev@ops');
    ok('…listed in ops, nothing starts meanwhile', waiting && !waiting.connected && waiting.reason === 'not started yet', JSON.stringify(waiting));
    home = startHome();
    ok('it is back: valuesdev@ops starts', await until(async () => (await member('valuesdev@ops'))?.connected), JSON.stringify(await owner.api.agents.list({})));
    // a restart of the home wrapper does not start a second one
    home.kill();
    await until(async () => !(await member('valuesdev@values'))?.connected);
    const pid = pidOf('ops');
    home = startHome();
    await until(async () => (await member('valuesdev@values'))?.connected);
    await sleep(1500);
    ok('a wrapper restart leaves the running session alone', pidOf('ops') === pid && alive(pid));
  } finally {
    for (const room of ['trade', 'ops']) {
      const pid = pidOf(room);
      if (alive(pid)) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // gone
        }
      }
    }
    home.kill();
    owner.m.close();
    hubProc.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e.stack || e.message);
  process.exit(1);
});
