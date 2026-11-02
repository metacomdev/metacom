'use strict';
// Agents follow ownership, with real wrappers: two invited users each start an agent with the CLI on
// their own token; the room shows whose each is ("alenclaude · alen"); alen drives and kills his own
// (the process ends, its notes first) and is refused on bo's ("isn't yours: ask its owner"); the hub
// owner drives and kills anyone's.
//   node test/ownership-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-'));
  const port = 29990 + Math.floor(Math.random() * 9);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'ow-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url, token: OWNER });
  await owner.api.agents.register({ name: 'misha', room: 'opn', kind: 'human' });
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_')));
  const user = async (name) => {
    const t = await owner.api.admin.createToken({ name, role: 'member', rooms: ['opn'], steer: 'answer', agents: true });
    const home = fs.mkdtempSync(path.join(dir, `${name}-`));
    spawnSync(process.execPath, [MC, 'connect', url, t.token], { env: { ...base, HOME: home } });
    const agent = spawn(process.execPath, [MC, 'opn', '-n', `${name}claude`, '--', 'sh', '-c', 'sleep 120'], { env: { ...base, HOME: home }, stdio: 'ignore' });
    const exited = new Promise((r) => agent.on('exit', () => r(true)));
    const c = await connect({ url, token: t.token });
    await c.api.agents.register({ name, room: 'opn', kind: 'human' });
    await c.api.room.join({ room: 'opn' });
    return { c, agent, exited };
  };
  const online = async (name) => {
    for (let i = 0; i < 40; i++) {
      const m = (await owner.api.agents.list({ room: 'opn' })).find((x) => x.name === name && x.connected);
      if (m) return m;
      await sleep(250);
    }
    return null;
  };
  const err = (p) => p.then(() => 'ok', (e) => e.message);
  const procs = [];
  try {
    const alen = await user('alen');
    const bo = await user('bo');
    procs.push(alen.agent, bo.agent);
    const a = await online('alenclaude');
    const b = await online('boclaude');
    ok('each user\'s agent is in the room, its owner shown', a && a.owner === 'alen' && b && b.owner === 'bo', JSON.stringify([a && a.owner, b && b.owner]));
    ok('alen drives his own live', (await err(alen.c.api.agents.live({ name: 'alenclaude', on: true }))) === 'ok');
    await alen.c.api.agents.live({ name: 'alenclaude', on: false }).catch(() => {});
    ok('…not bo\'s', /boclaude isn't yours: ask its owner/.test(await err(alen.c.api.agents.live({ name: 'boclaude', on: true }))));
    ok('alen cannot !restart bo\'s', /boclaude isn't yours: ask its owner/.test(await err(alen.c.api.agents.send({ to: 'boclaude', text: '!restart', kind: 'command' }))));
    ok('alen cannot /kill bo\'s', /boclaude isn't yours: ask its owner/.test(await err(alen.c.api.agents.kill({ name: 'boclaude' }))));
    ok('alen /kills his own', (await err(alen.c.api.agents.kill({ name: 'alenclaude' }))) === 'ok');
    ok('…its process ends (notes first)', await Promise.race([alen.exited, sleep(12000).then(() => false)]));
    ok('the hub owner drives bo\'s live', (await err(owner.api.agents.live({ name: 'boclaude', on: true }))) === 'ok');
    await owner.api.agents.live({ name: 'boclaude', on: false }).catch(() => {});
    ok('…and /kills it', (await err(owner.api.agents.kill({ name: 'boclaude' }))) === 'ok' && (await Promise.race([bo.exited, sleep(12000).then(() => false)])));
    const said = (await owner.api.room.history({ room: 'opn', limit: 30 })).map((m) => m.text).join('\n');
    ok('the room is told who stopped what', /alen stopped alenclaude \(notes first\)/.test(said) && /stopped boclaude/.test(said), said);
    alen.c.m.close();
    bo.c.m.close();
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    for (const p of procs) p.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
