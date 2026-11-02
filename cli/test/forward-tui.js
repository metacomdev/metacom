'use strict';
// Forwarding in the terminal chat forwards the message whose "↪ forward" was clicked: three quick
// messages from one agent (drawn as a group), the feed scrolled back to them, "⋯" then
// "↪ forward" on the first, sent to another member: that member gets the first, not a neighbour.
//   node test/forward-tui.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'forward-tui-'));
  const port = 26800 + Math.floor(Math.random() * 500);
  const OWNER = 'fw-owner-token-0123456789abcdef';
  const AGENT = 'fw-agent-token-0123456789abcdef';
  const url = `ws://127.0.0.1:${port}/`;
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const dev = await connect({ url, token: AGENT });
  await dev.api.agents.register({ name: 'valuesdev', room: 'values' });
  const lead = await connect({ url, token: AGENT });
  await lead.api.agents.register({ name: 'keeper', room: 'values' });
  const got = [];
  lead.api.agents.on('message', (m) => got.push(m.text));
  // valuesdev also has a session in trade (as live): the same name in both rooms
  const devTrade = await connect({ url, token: AGENT });
  await devTrade.api.agents.register({ name: 'valuesdev', room: 'trade' });
  const toTrade = [];
  devTrade.api.agents.on('message', (m) => toTrade.push(m.text));
  const toValues = [];
  dev.api.agents.on('message', (m) => toValues.push(m.text));
  await dev.api.room.say({ room: 'values', text: 'FIRST: trade vault v5 is live for the team test' });
  await dev.api.room.say({ room: 'values', text: 'SECOND: one question about the v5 weights' });
  await dev.api.room.say({ room: 'values', text: 'THIRD: security re-checked the VALUES vault' });
  await dev.api.room.say({ room: 'values', text: 'FOURTH: the v5 numbers for trade' });
  for (let i = 1; i <= 25; i++) await dev.api.room.say({ room: 'values', text: `filler ${i}` });
  const chat = spawnChat({ room: 'values', name: 'misha', cols: 100, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER, MC_MOUSE: '1' } });
  const click = (col, row) => chat.type(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`, 500);
  const scrollTo = async (marker) => {
    for (let i = 0; i < 14 && !chat.dump().includes(marker); i++) await chat.type('\x1b[5~', 250);
  };
  const forwardFrom = async (marker, room = null, to = 'keeper') => {
    await scrollTo(marker);
    // the action row under the message: "↩ reply  ⋯"
    let rows = chat.view();
    const body = rows.findIndex((l) => l.includes(marker));
    if (body < 0) throw new Error(`${marker} not on screen:\n${chat.dump()}`);
    const actions = rows.findIndex((l, i) => i > body && l.includes('↩ reply'));
    await click(rows[actions].indexOf('⋯') + 1, actions + 1);
    rows = chat.view();
    const col = rows[actions].indexOf('↪ forward');
    if (col < 0) throw new Error(`no "↪ forward" after ⋯:\n${chat.dump()}`);
    await click(col + 2, actions + 1);
    if (!(await chat.wait(/forwarding valuesdev's message/, 3000).then(() => true, () => false))) throw new Error(`no forwarding after the click on ${marker}:\n${chat.view().join('\n')}`);
    if (room) {
      // another room: clear the @, ← for the room list, the room, then who in it
      await chat.type('\x7f', 200);
      await chat.type('\x1b[D', 600);
      await chat.type(room, 300);
      await chat.type('\r', 900);
      await chat.type(to, 300);
      await chat.type('\r', 1200);
      return;
    }
    await chat.type(to, 300);
    if (process.env.FW_DEBUG) console.log('--- before enter\n' + chat.view().slice(-8).join('\n'));
    await chat.type('\r', 600);
    if (/❯ @keeper/.test(chat.dump())) await chat.type('\r', 1200); // the first enter picks the name, the second sends
    if (process.env.FW_DEBUG) console.log('--- after enter\n' + chat.view().slice(-6).join('\n'));
  };
  try {
    await chat.wait(/filler 25/, 10000);
    // scrolled back: the three quick ones in sight
    for (let i = 0; i < 12 && !/FIRST: trade vault/.test(chat.dump()); i++) await chat.type('\x1b[5~', 250);
    ok('scrolled back to the group of three', /FIRST: trade vault/.test(chat.dump()) && /THIRD/.test(chat.dump()), chat.dump());
    await forwardFrom('FIRST: trade vault');
    for (let i = 0; i < 20 && !got.length; i++) await sleep(200);
    ok('the clicked message is the one forwarded (scrolled back)', /FIRST: trade vault v5 is live/.test(got.at(-1) || ''), JSON.stringify(got));
    await forwardFrom('SECOND: one question');
    for (let i = 0; i < 20 && got.length < 2; i++) await sleep(200);
    ok('…and the next one too', /SECOND: one question/.test(got.at(-1) || ''), JSON.stringify(got));
    // to valuesdev in another room (values → trade), as misha did: the one in trade gets it
    await forwardFrom('FOURTH: the v5 numbers', 'trade', 'valuesdev');
    for (let i = 0; i < 20 && !toTrade.length && !toValues.length; i++) await sleep(200);
    ok('to valuesdev in trade: its trade session gets it, not the one in values', /FOURTH: the v5 numbers/.test(toTrade.at(-1) || '') && !toValues.length, `trade got ${JSON.stringify(toTrade)}, values got ${JSON.stringify(toValues)}`);
    // at the bottom of the feed as well
    await chat.type('\x1b[F', 300);
    for (let i = 0; i < 12; i++) await chat.type('\x1b[6~', 80);
    await sleep(500);
    await forwardFrom('filler 24');
    for (let i = 0; i < 20 && got.length < 3; i++) await sleep(200);
    ok('at the bottom: the clicked one', /filler 24$/.test(got.at(-1) || ''), JSON.stringify(got));
  } catch (e) {
    ok('ran', false, e.message);
  } finally {
    chat.kill();
    dev.m.close();
    lead.m.close();
    devTrade.m.close();
    hubProc.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e.stack);
  process.exit(1);
});
