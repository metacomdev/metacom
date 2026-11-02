'use strict';
// An agent started on the owner's own sign-in never waits on Claude Code's "trust this folder?": the
// wrapper marks its folder trusted in ~/.claude.json first (keeping what else is there); an invited
// user's agent is not, and gets the question. `claude` here is a stand-in that only idles.
//   node test/trust-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
  const port = 29940 + Math.floor(Math.random() * 20);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'tr-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url, token: OWNER });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho ready\nexec sleep 60\n', { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_') && k !== 'CLAUDE_CONFIG_DIR'));
  const procs = [];
  const start = (home, folder, name) => {
    const p = spawn(process.execPath, [MC, 'dev', '-n', name, 'claude'], { cwd: folder, env: { ...base, HOME: home, PATH: `${bin}:${process.env.PATH}`, MC_NO_SPEND: '1' }, stdio: 'ignore' });
    procs.push(p);
  };
  const online = async (name) => {
    for (let i = 0; i < 60; i++) {
      if ((await owner.api.agents.list({ room: 'dev' })).some((m) => m.name === name && m.connected)) return true;
      await sleep(250);
    }
    return false;
  };
  const trusted = (home, folder) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  try {
    // the owner's sign-in, with Claude Code settings already there
    const home = fs.mkdtempSync(path.join(dir, 'owner-'));
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'work-')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark', projects: { '/elsewhere': { hasTrustDialogAccepted: false, allowedTools: ['x'] } } }));
    spawnSync(process.execPath, [MC, 'connect', url, OWNER], { env: { ...base, HOME: home } });
    start(home, folder, 'builder');
    ok('the agent joins', await online('builder'));
    const cfg = trusted(home);
    ok('its folder is trusted for Claude Code, before it starts', cfg.projects && cfg.projects[folder] && cfg.projects[folder].hasTrustDialogAccepted === true, JSON.stringify(cfg).slice(0, 300));
    ok('…and the rest of the settings kept', cfg.theme === 'dark' && cfg.projects['/elsewhere'].allowedTools[0] === 'x' && cfg.projects['/elsewhere'].hasTrustDialogAccepted === false);

    // an invited user's agent: no
    const user = await owner.api.admin.createToken({ name: 'alen', role: 'member', rooms: ['dev'], steer: 'answer', agents: true });
    const uhome = fs.mkdtempSync(path.join(dir, 'user-'));
    const ufolder = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'uwork-')));
    spawnSync(process.execPath, [MC, 'connect', url, user.token], { env: { ...base, HOME: uhome } });
    start(uhome, ufolder, 'alenclaude');
    ok('a user\'s agent joins', await online('alenclaude'));
    const ucfg = trusted(uhome);
    ok('…its folder is not trusted for it: it gets the question', !(ucfg.projects && ucfg.projects[ufolder]), JSON.stringify(ucfg).slice(0, 200));
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
