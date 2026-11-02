'use strict';
// "!restart" end to end: a real hub, an agent under the real wrapper (bash, so no model turn). The
// owner's !restart: the wrapper hands its terminal to a new wrapper process on the code on disk,
// which joins again; the agent is the same member, idle; it works twice; the terminal stays.
//   node test/restart-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { connect } = require('../lib/client.js');
const { resumeArgs, freshArgs } = require('../lib/sessions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  // the command it comes back with: the conversation it was in, never the one it started with
  ok('claude: --continue becomes --resume <now>', JSON.stringify(resumeArgs('claude', ['--dangerously-skip-permissions', '--continue'], 'abc')) === JSON.stringify(['--dangerously-skip-permissions', '--resume', 'abc']));
  ok('claude: an older --resume is replaced', JSON.stringify(resumeArgs('/usr/bin/claude', ['--resume', 'old', '--permission-mode', 'auto'], 'new')) === JSON.stringify(['--permission-mode', 'auto', '--resume', 'new']));
  ok('codex: resume <now>, its other flags kept', JSON.stringify(resumeArgs('codex', ['resume', 'old', '-m', 'gpt', '-c', 'x=1'], 'new')) === JSON.stringify(['resume', 'new', '-m', 'gpt', '-c', 'x=1']));
  ok('no conversation known: the command as it was', JSON.stringify(resumeArgs('claude', ['--continue'], null)) === JSON.stringify(['--continue']));
  ok('another program: as it was', JSON.stringify(resumeArgs('bash', ['--norc'], 'x')) === JSON.stringify(['--norc']) && freshArgs('bash', ['-c', 'x']).length === 2);

  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'restart-e2e-'));
  const port = 26000 + Math.floor(Math.random() * 3000);
  const OWNER = 'rs-owner-token-0123456789abcdef';
  const AGENT = 'rs-agent-token-0123456789abcdef';
  const url = `ws://127.0.0.1:${port}/`;
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_') && !k.startsWith('CLAUDE'))), HOME: dir, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, PS1: '$ ' };
  let screen = '';
  const term = pty.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'dev', '-n', 'ticker', 'bash', '--norc', '--noprofile'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: dir, env });
  term.onData((d) => (screen += d));
  let exited = false;
  term.onExit(() => (exited = true));
  const owner = await connect({ url, token: OWNER });
  const me = async () => (await owner.api.agents.list({})).find((m) => m.id === 'ticker@dev');
  const until = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(300);
    }
    return false;
  };
  const wrappers = () => spawnSync('pgrep', ['-f', 'metacom.js dev -n ticker'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  try {
    ok('the agent is up', await until(async () => (await me())?.status === 'waiting'));
    const before = wrappers();
    for (const round of [1, 2]) {
      const r = await owner.api.agents.send({ to: 'ticker', text: '!restart' });
      ok(`!restart ${round}: an owner control, not text for the agent`, r.kind === 'control');
      ok(`…a new wrapper takes over`, await until(async () => wrappers().length === before.length + round), JSON.stringify(wrappers()));
      ok(`…the same member is back, idle`, await until(async () => {
        const m = await me();
        return m && m.connected && m.status === 'waiting';
      }));
      await owner.api.agents.send({ to: 'ticker', text: `echo after-restart-${round}` });
      ok(`…and takes instructions again`, await until(async () => screen.includes(`after-restart-${round}`)));
    }
    ok('the terminal it ran in is still there', !exited);
    const agents = (await owner.api.agents.list({})).filter((m) => m.name === 'ticker');
    ok('one member, not two', agents.length === 1, JSON.stringify(agents));
    const room = await owner.api.room.history({ room: 'dev', limit: 30 });
    ok('the room is not told it left and joined', !room.some((m) => /ticker left/.test(m.text)));
  } finally {
    for (const p of wrappers()) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {
        // gone
      }
    }
    term.kill();
    owner.m.close();
    hubProc.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e.stack);
  process.exit(1);
});
