'use strict';
// The share tools (metacom-share) go only to agents on the hub their keys are for: on the hub
// `metacom connect` saved, room dev gets them; on another hub (a test or demo hub) with a room of the
// same name, it does not. `claude` here is a stand-in that writes down the MCP servers it was given.
//   node test/share-scope-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'share-scope-'));
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
  };
  const hubs = [];
  const startHub = async (port, owner) => {
    const h = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, `hub-${port}`), HUB_OWNER_TOKEN: owner }, stdio: 'ignore' });
    hubs.push(h);
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  };
  const A = 29850 + Math.floor(Math.random() * 10);
  const B = A + 20;
  const OWNER = 'ss-owner-token-0123456789abcdef';
  await startHub(A, OWNER);
  await startHub(B, OWNER);
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const base = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: home, MC_NO_SPEND: '1', MC_NO_TRUST: '1' };
  spawnSync(process.execPath, [MC, 'connect', `ws://127.0.0.1:${A}/`, OWNER], { env: base });
  fs.writeFileSync(path.join(home, '.config', 'metacom-hub', 'share.json'), JSON.stringify({ api: 'http://127.0.0.1:1', keys: { dev: 'share-key-for-dev' } }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const seen = (tag) => path.join(dir, `seen-${tag}.json`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const i = process.argv.indexOf('--mcp-config');
require('fs').writeFileSync(process.env.SEEN, i > 0 ? process.argv[i + 1] : '{}');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const procs = [];
  const run = async (tag, env) => {
    procs.push(spawn(process.execPath, [MC, 'dev', '-n', `builder${tag}`, 'claude'], { env: { ...base, ...env, PATH: `${bin}:${process.env.PATH}`, SEEN: seen(tag) }, stdio: 'ignore' }));
    for (let i = 0; i < 80 && !fs.existsSync(seen(tag)); i++) await sleep(250);
    return fs.existsSync(seen(tag)) ? Object.keys(JSON.parse(fs.readFileSync(seen(tag), 'utf8')).mcpServers || {}) : null;
  };
  try {
    const home1 = await run('a', {});
    ok('on the saved hub, room dev gets the share tools', home1 && home1.includes('metacom-share') && home1.includes('hub'), JSON.stringify(home1));
    const other = await run('b', { MC_HUB_URL: `ws://127.0.0.1:${B}/`, MC_TOKEN: OWNER });
    ok('on another hub, the same room name gets none (the room tools still come)', other && !other.includes('metacom-share') && other.includes('hub'), JSON.stringify(other));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    for (const p of procs) p.kill();
    for (const h of hubs) h.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
