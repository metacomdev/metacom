'use strict';
// An agent's own token, made by the wrapper: with an owner sign-in (`metacom connect <hub> <owner
// token>`) and no agent token saved, `metacom dev -n builder <cmd>` makes an agent token for builder
// ("builder · sh @ <host>"), says so once, keeps it, and joins with it; a restart reuses it; a revoke
// stops it, and the next start makes a new one; a user's sign-in (an invite) runs its agent on its
// own token and makes none.
//   node test/agent-token-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-'));
  const port = 29960 + Math.floor(Math.random() * 30);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'at-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 500) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: home };
  spawnSync(process.execPath, [MC, 'connect', url, OWNER], { env });
  const owner = await connect({ url, token: OWNER });
  const tokens = async () => (await owner.api.admin.tokens({})).filter((t) => t.role === 'agent');
  const start = (name, extra = {}) => {
    const p = spawn(process.execPath, [MC, 'dev', '-n', name, '--', 'sh', '-c', 'sleep 60'], { env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    return { p, err: () => err, done: new Promise((r) => p.on('exit', r)) };
  };
  const online = async (name, ms = 10000) => {
    for (let t = 0; t < ms / 250; t++) {
      const m = (await owner.api.agents.list({ room: 'dev' })).find((x) => x.name === name && x.connected);
      if (m) return m;
      await sleep(250);
    }
    return null;
  };
  const procs = [];
  try {
    const a = start('builder');
    procs.push(a.p);
    const m = await online('builder');
    ok('builder starts on an owner sign-in, no agent token saved', Boolean(m));
    const list = await tokens();
    const t = list.find((x) => x.label === `builder · sh @ ${os.hostname()}`);
    ok('…on an agent token of its own, labelled from its command', t && t.name.startsWith('builder-') && list.length === 1, JSON.stringify(list));
    ok('…said once in its terminal', new RegExp(`agent token 'builder · sh @ ${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' created \\(revoke with /revoke builder-`).test(a.err()), a.err());
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'metacom-hub', 'config.json'), 'utf8'));
    ok('…and the room shows it as its runner\'s', m.owner === os.userInfo().username, JSON.stringify(m));
    ok('…kept in config.json by hub, host and name', Object.keys(cfg.agents || {}).some((k) => k.endsWith(`|${os.hostname()}|builder`)));
    a.p.kill();
    await a.done;
    await sleep(500);

    // a restart reuses it
    const b = start('builder');
    procs.push(b.p);
    ok('a restart joins again', Boolean(await online('builder')));
    ok('…on the same token, no new one', (await tokens()).length === 1 && !/created/.test(b.err()), JSON.stringify(await tokens()));
    // another agent gets its own
    const c = start('reviewer');
    procs.push(c.p);
    await online('reviewer');
    ok('another agent gets a token of its own', (await tokens()).map((x) => x.label).sort().join() === [`builder · sh @ ${os.hostname()}`, `reviewer · sh @ ${os.hostname()}`].sort().join());

    // revoked: it stops; the next start makes a new one
    await owner.api.admin.revokeToken({ id: t.id });
    await b.done;
    b.p.kill();
    const d = start('builder');
    procs.push(d.p);
    const code = await Promise.race([d.done, sleep(8000).then(() => 'running')]);
    ok('a start on the revoked token says so and stops', code !== 'running' && /was revoked on the hub\. Start it again/.test(d.err()), `${code} ${d.err()}`);
    const e = start('builder');
    procs.push(e.p);
    ok('the next start makes a new one and joins', Boolean(await online('builder')) && /created/.test(e.err()) && (await tokens()).filter((x) => x.label.startsWith('builder')).length === 1);

    // a user (an invite) runs its agent on its own token, makes none
    const user = await owner.api.admin.createToken({ name: 'alen', role: 'member', rooms: ['dev'], steer: 'answer', agents: true });
    const uhome = fs.mkdtempSync(path.join(dir, 'uhome-'));
    spawnSync(process.execPath, [MC, 'connect', url, user.token], { env: { ...env, HOME: uhome } });
    const before = (await tokens()).length;
    const u = start('alenclaude', { HOME: uhome });
    procs.push(u.p);
    ok('a user\'s agent joins on the user\'s token, no agent token made', Boolean(await online('alenclaude')) && (await tokens()).length === before && !/created/.test(u.err()), u.err());
  } catch (err) {
    ok('ran', false, err.stack);
  } finally {
    for (const p of procs) p.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
