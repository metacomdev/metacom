'use strict';
// /direct in the terminal chat: "@builder /direct" opens the agent's terminal, the bar says "direct";
// esc leaves; "/live builder", the old name, does the same.
//   node test/direct-tui.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'direct-tui-'));
  const port = 29680 + Math.floor(Math.random() * 30);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'dt-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 600) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_')));
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'connect', url, OWNER], { env: { ...env0, HOME: home } });
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'opn', '-n', 'builder', '--', 'sh', '-c', 'echo building-here; sleep 120'], { env: { ...env0, HOME: home }, stdio: 'ignore' });
  const chat = spawnChat({ room: 'opn', name: 'misha', cols: 120, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER } });
  try {
    await chat.wait(/builder/, 15000);
    await chat.type('@builder /direct', 200);
    await chat.type('\r', 300);
    ok('"@builder /direct" opens its terminal, the bar says direct', await chat.wait(/direct · /, 10000).then(() => true, () => false) && /building-here/.test(chat.dump()), chat.dump());
    await chat.type('\x1b', 800);
    ok('esc leaves', !/direct · /.test(chat.dump()), chat.dump());
    await chat.type('@builder ', 300);
    await chat.type('\r', 300);
    ok('"@builder" alone and enter opens its terminal', await chat.wait(/direct · /, 10000).then(() => true, () => false), chat.dump());
    await chat.type('\x1b', 800);
    await chat.type('/direct bu', 400);
    ok('"/direct bu" offers the agent', /builder/.test(chat.dump()) && /@builder|builder /.test(chat.dump()), chat.dump());
    await chat.type('\t', 300);
    ok('…tab fills in the name, no @', /\/direct builder /.test(chat.dump()) && !/\/direct @builder/.test(chat.dump()), chat.dump());
    await chat.type('\r', 300);
    ok('…enter opens it', await chat.wait(/direct · /, 10000).then(() => true, () => false), chat.dump());
    await chat.type('\x1b', 800);
    await chat.type('/live builder', 200);
    await chat.type('\r', 300);
    ok('"/live builder", the old name, still opens it', await chat.wait(/direct · /, 10000).then(() => true, () => false), chat.dump());
    await chat.type('\x1b', 500);
  } catch (e) {
    ok('ran', false, e.message);
  } finally {
    chat.kill();
    agent.kill();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
