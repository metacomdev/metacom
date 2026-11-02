'use strict';
// Back after a drop: the terminal chat shows what was said in its room while its connection was
// down. A relay between the chat and the hub is cut (the chat drops, the hub stays up), an agent
// posts meanwhile, the relay comes back: the chat reconnects and the missed messages appear, in
// order, none twice.
//   node test/catchup-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

/// A TCP relay to the hub that can be cut and restored, as a network drop would.
const relay = (to, port) => {
  const sockets = new Set();
  let server = null;
  const up = () =>
    new Promise((resolve) => {
      server = net.createServer((client) => {
        const hub = net.connect(to, '127.0.0.1');
        for (const s of [client, hub]) {
          sockets.add(s);
          s.on('close', () => sockets.delete(s));
          s.on('error', () => {});
        }
        client.pipe(hub).pipe(client);
      });
      server.listen(port, '127.0.0.1', resolve);
    });
  const down = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return { up, down };
};

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-e2e-'));
  const port = 28100 + Math.floor(Math.random() * 800);
  const front = port + 1000;
  const OWNER = 'cu-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const r = relay(port, front);
  await r.up();
  const poster = await connect({ url: `ws://127.0.0.1:${port}/`, token: OWNER });
  await poster.api.agents.register({ name: 'lead', room: 'dev', kind: 'human' });
  await poster.api.room.say({ room: 'dev', text: 'before the drop' });
  const chat = spawnChat({ room: 'dev', name: 'misha', cols: 100, rows: 30, env: { HOME: dir, MC_HUB_URL: `ws://127.0.0.1:${front}/`, MC_TOKEN: OWNER } });
  try {
    await chat.wait(/before the drop/, 10000);
    ok('the chat is in the room', true);
    await r.down();
    ok('the connection drops', await chat.wait(/reconnecting/, 8000).then(() => true, () => false), chat.dump());
    await poster.api.room.say({ room: 'dev', text: 'said while you were away: one' });
    await poster.api.room.say({ room: 'dev', text: 'said while you were away: two' });
    await sleep(1500);
    ok('nothing arrives while it is down', !/while you were away/.test(chat.dump()));
    await r.up();
    ok('back: the missed messages appear', await chat.wait(/away: one[\s\S]*away: two/, 15000).then(() => true, () => false), chat.dump());
    await sleep(1500);
    const screen = chat.dump();
    ok('…each once', (screen.match(/away: one/g) || []).length === 1 && (screen.match(/away: two/g) || []).length === 1, screen);
    await poster.api.room.say({ room: 'dev', text: 'and live again' });
    ok('live messages go on', await chat.wait(/and live again/, 8000).then(() => true, () => false), chat.dump());
  } finally {
    chat.kill();
    poster.m.close();
    await r.down().catch(() => {});
    hubProc.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e.stack);
  process.exit(1);
});
