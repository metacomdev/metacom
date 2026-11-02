'use strict';
// `metacom start`, the one command to a working team, on a throwaway hub: the business, the week's
// goal and how strict (here as flags, as the three questions would give them); it picks the team
// the business sounds like (sales-desk), starts it (--print: the roles are stand-ins started here),
// sets the lead, light budgets and loops, briefs everyone, and ends with one line to follow.
//   node test/start-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const templates = require('../lib/templates.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'start-'));
  const port = 29920 + Math.floor(Math.random() * 20);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'st-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 500) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: home, MC_NO_SPEND: '1', MC_NO_TRUST: '1' };
  spawnSync(process.execPath, [MC, 'connect', url, OWNER], { env });
  const owner = await connect({ url, token: OWNER });
  const procs = [];
  try {
    const start = spawn(process.execPath, [MC, 'start', '--business', 'We sell coffee subscriptions to offices in Berlin', '--goal', '20 researched leads and 10 drafts', '--rigor', 'light', '--room', 'shop', '--print', '--timeout', '60'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    start.stdout.on('data', (d) => (out += d));
    start.stderr.on('data', (d) => (out += d));
    const done = new Promise((r) => start.on('exit', r));
    const t = templates.load('sales-desk');
    for (let i = 0; i < 40 && !/waiting for/.test(out); i++) await sleep(250);
    ok('it picks the team the business sounds like: sales-desk', /sales-desk: 4 roles in room shop/.test(out), out);
    for (const role of t.roles) procs.push(spawn(process.execPath, [MC, 'shop', '-n', role.name, '--', 'sh', '-c', 'echo ready; sleep 120'], { env, stdio: 'ignore' }));
    const code = await Promise.race([done, sleep(90000).then(() => 'timeout')]);
    ok('it finishes', code === 0, `${code}\n${out}`);
    const last = out.trim().split('\n').pop();
    ok('one last line a stranger can follow: where to watch and steer it', new RegExp(`^✓ Your sales-desk team is working in room shop\\. Watch and steer it: http://127\\.0\\.0\\.1:${port}/shop  \\(or: metacom shop\\)$`).test(last), last);
    const budgets = await owner.api.agents.budgets({});
    ok('light: budgets ×1.5', t.roles.every((r) => budgets.some((b) => b.name === r.name && b.budget === Math.round(r.budget * 1.5))), JSON.stringify(budgets));
    const said = (await owner.api.room.history({ room: 'shop', limit: 100 })).map((m) => m.text).join('\n');
    ok('the lead manages the room; the goal carries the business', /made desk the manager of shop/.test(said) && /We sell coffee subscriptions to offices in Berlin\. This week: 20 researched leads and 10 drafts/.test(said));
    const bad = spawnSync(process.execPath, [MC, 'start', '--business', 'x'], { env, encoding: 'utf8' });
    ok('without a goal and no terminal to ask in: says how, in one line', bad.status === 1 && /usage: metacom start --business/.test(bad.stderr), bad.stderr);
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
