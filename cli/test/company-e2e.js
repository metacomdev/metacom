'use strict';
// A company template started for real, on a throwaway hub: `template use agency` (strict) with each
// role a stand-in agent under the real wrapper on the owner's sign-in. When the team has joined, the
// lead is the room's manager, every role has its budget (scaled by the rigor), the template's loop is
// set, each role is briefed (the lead told to post the first plan) and the kickoff is in the room.
//   node test/company-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const templates = require('../lib/templates.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
  const port = 29880 + Math.floor(Math.random() * 40);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'co-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_')));
  spawnSync(process.execPath, [MC, 'connect', url, OWNER], { env: { ...base, HOME: home } });
  const owner = await connect({ url, token: OWNER });
  await owner.api.agents.register({ name: 'misha', room: 'agency', kind: 'human' });
  const t = templates.load('agency');
  const procs = [];
  const log = [];
  try {
    // the team: each role a stand-in that idles, started as `template use --print` would have you do
    const started = templates.use({
      name: 'agency', goal: 'A launch campaign for a bakery (test)', rigor: 'strict', launch: 'print', timeoutSec: 60, hub: owner, log: (l) => log.push(l),
    });
    for (const role of t.roles) procs.push(spawn(process.execPath, [MC, 'agency', '-n', role.name, '--', 'sh', '-c', 'echo ready; sleep 120'], { env: { ...base, HOME: home, MC_NO_SPEND: '1', MC_NO_TRUST: '1' }, stdio: 'ignore' }));
    const r = await started;
    ok('the team started: every role joined', r.roles.join() === t.roles.map((x) => x.name).join(), JSON.stringify(r));
    const said = (await owner.api.room.history({ room: 'agency', limit: 100 })).map((m) => `${m.from && m.from.name}→${m.to || ''}: ${m.text}`);
    ok('the lead manages the room', said.some((x) => /made director the manager of agency/.test(x)), said.join(' | '));
    const budgets = await owner.api.agents.budgets({});
    const want = templates.withRigor(t, 'strict').roles.map((x) => [x.name, x.budget]);
    ok('each role has its budget, scaled by strict', want.every(([n, b]) => budgets.some((x) => x.name === n && x.room === 'agency' && x.budget === b)), JSON.stringify(budgets));
    const loops = await owner.api.loops.list({ room: 'agency' });
    ok('the template\'s loop is set', loops.length === 1 && loops[0].target === 'director' && loops[0].every === '0 9 * * *', JSON.stringify(loops));
    ok('each role is briefed; the lead is told to post the first plan', t.roles.every((x) => said.some((m) => m.includes(`→${x.name}: You are ${x.name} in room agency`))) && said.some((m) => m.startsWith('misha→director:') && /You lead this team/.test(m) && /post the first plan/.test(m)));
    ok('the strict rules and the review are in the briefs', said.some((m) => /hub_request first/.test(m) && /Review: before work reaches the owner/.test(m)));
    ok('the kickoff is in the room', said.some((x) => /Team "agency" started/.test(x)));
    ok('the log says what was set', log.some((l) => /director leads agency/.test(l)) && log.some((l) => /budgets: director \$21/.test(l)) && log.some((l) => /loop: @director/.test(l)), log.join('\n'));
  } catch (e) {
    ok('ran', false, `${e.stack}\n${log.join('\n')}`);
  } finally {
    for (const p of procs) p.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
