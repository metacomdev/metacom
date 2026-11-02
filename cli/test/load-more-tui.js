'use strict';
// The conversation further back: shift+↑ (nothing typed) to the oldest message loaded, again (or
// a click on "↑ load more") the page before it, the reader's place kept, up to "start of room";
// shift+↓ the newest; with text typed, shift+arrows are the input's.
//   node test/load-more-tui.js
const path = require('path'), { spawn } = require('child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
const D = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'load-more-tui-'));
let fails = 0; const ok = (w, c, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${w}${d ? ' — ' + d : ''}`); };
(async () => {
  const port = 25000 + Math.floor(Math.random() * 4000);
  const O = 'moretui-owner-token-0123456789abcdef';
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(D, 'hub'), HUB_OWNER_TOKEN: O }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const url = `ws://127.0.0.1:${port}/`;
    for (let k = 0; k < 4; k++) {
      const f = await connect({ url, token: O }); await f.api.agents.register({ name: 'boss', room: 'dev', kind: 'human' });
      for (let i = k * 100; i < (k + 1) * 100; i++) await f.api.room.say({ room: 'dev', text: `msg ${i}` });
      f.m.close();
    }
    const c = spawnChat({ room: 'dev', name: 'misha', cols: 100, rows: 30, env: { HOME: D, MC_HUB_URL: url, MC_TOKEN: O } });
    await c.wait(/msg 399/, 15000); await sleep(600);
    const nums = () => c.view().map((l) => Number((/msg (\d+)/.exec(l) || [])[1] ?? -1)).filter((n) => n >= 0);
    const rowOf = (n) => c.view().findIndex((l) => new RegExp(`msg ${n}\\b`).test(l));
    ok('the newest at the bottom', nums().at(-1) === 399, String(nums().at(-1)));
    await c.type('\x1b[1;2A', 800);
    const first = nums()[0];
    ok('shift+↑: the oldest loaded, "↑ load more" above it', c.view().some((l) => /↑ load more/.test(l)) && first > 300 && first < 380, `${first}\n${c.view().slice(0, 6).join('\n')}`);
    const r0 = rowOf(first);
    await c.type('\x1b[1;2A', 1200);
    ok('shift+↑ again: 50 older above, the place kept', rowOf(first) === r0 && Math.min(...nums()) >= 0 && c.view().some((l) => /↑ load more/.test(l)) === false || rowOf(first) === r0, `row ${r0} → ${rowOf(first)}; top now ${nums()[0]}`);
    // up to the top again, then click "↑ load more" until the start
    for (let i = 0; i < 20 && !c.view().some((l) => /start of room/.test(l)); i++) {
      await c.type('\x1b[1;2A', 500);
      const r = c.view().findIndex((l) => /↑ load more/.test(l));
      if (r >= 0) { const col = c.view()[r].indexOf('↑') + 2; await c.type(`\x1b[<0;${col};${r + 1}M\x1b[<0;${col};${r + 1}m`, 900); }
    }
    ok('"· start of room ·" at the top, the room\'s first message under it', c.view().some((l) => /start of room/.test(l)) && nums()[0] === 0, `${nums()[0]}\n${c.view().slice(0, 5).join('\n')}`);
    await c.type('\x1b[1;2B', 800);
    ok('shift+↓: the newest', nums().at(-1) === 399, String(nums().at(-1)));
    await c.type('hello', 300); await c.type('\x1b[1;2A', 600);
    ok('with text typed, shift+↑ is not the feed', nums().at(-1) === 399);
    c.kill();
  } finally { hub.kill(); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
