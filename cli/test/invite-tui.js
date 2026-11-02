'use strict';
// /invite in the terminal chat: the owner types `/invite johntoken` in room opn; the chat shows the invite
// link (<hub>/opn/invite/<token>) and says it is copied; the token in it is a user token for opn.
//   node test/invite-tui.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'token-tui-'));
  const port = 29800 + Math.floor(Math.random() * 150);
  const OWNER = 'tt-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 600) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const chat = spawnChat({ room: 'opn', name: 'misha', cols: 140, rows: 30, env: { HOME: dir, MC_HUB_URL: `ws://127.0.0.1:${port}/`, MC_TOKEN: OWNER } });
  try {
    await chat.wait(/opn/, 10000);
    await chat.type('/invite johntoken', 200);
    await chat.type('\r', 1500);
    const screen = chat.dump();
    // the clipboard gets the whole link (here through OSC 52: no clipboard tool in the test's HOME)
    const osc = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(chat.raw());
    const link = osc ? Buffer.from(osc[1], 'base64').toString('utf8') : '';
    ok('the whole link goes to the clipboard', /^http:\/\/127\.0\.0\.1:\d+\/opn\/invite\/[\w-]{20,}$/.test(link), link);
    const token = link.split('/invite/')[1] || 'none';
    ok('the screen shows it masked, never whole', screen.replace(/\s*\n\s*/g, '').includes(`/opn/invite/${token.slice(0, 6)}…••••…${token.slice(-4)}`) && !screen.replace(/\s*\n\s*/g, '').includes(token), screen);
    ok('…and said copied', /Invite link copied/.test(screen), screen);
    ok('…marked as yours alone', /invite johntoken · only you see this/.test(screen), screen);
    const owner = await connect({ url: `ws://127.0.0.1:${port}/`, token: OWNER });
    const t = (await owner.api.admin.tokens({})).find((x) => x.name === 'johntoken');
    ok('nothing of it goes to the room', !(await owner.api.room.history({ room: 'opn', limit: 50 })).some((m) => /johntoken|invite\//.test(m.text)));
    ok('a user token for opn', t && t.rooms.join() === 'opn' && t.bringsAgents && t.steer === 'answer', JSON.stringify(t));
    owner.m.close();
  } catch (e) {
    ok('ran', false, e.message);
  } finally {
    chat.kill();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
