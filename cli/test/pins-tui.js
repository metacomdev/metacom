// Pins in the terminal chat: a click on a pin above the input (or /pins <n>) scrolls the
// conversation to that message, loading back to it when it is older than what is shown.
//   node test/pins-tui.js [dir]
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pins-tui-'));
  const port = 25000 + Math.floor(Math.random() * 4000);
  const OWNER = 'pj-owner-token-0123456789abcdef', AGENT = 'pj-agent-token-0123456789abcdef';
  const hubProc = spawn(process.execPath, [require('node:path').join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir + '/hub', HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  const ok = (w, c, d = '') => console.log(`${c ? 'PASS' : 'FAIL'} ${w}${d ? ' — ' + d : ''}`);
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const url = `ws://127.0.0.1:${port}/`;
    const lead = await connect({ url, token: AGENT });
    await lead.api.agents.register({ name: 'lead', room: 'dev' });
    const target = await lead.api.room.say({ room: 'dev', text: 'DECISION: launch on Tuesday' });
    for (let i = 1; i <= 40; i++) await lead.api.room.say({ room: 'dev', text: `filler message ${i}` });
    await lead.api.room.pin({ id: target.id, on: true });
    const c = spawnChat({ room: 'dev', name: 'misha', cols: 100, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER } });
    await c.wait(/filler message 40/, 15000);
    const feedHas = () => c.view().some((l) => /^ *DECISION: launch on Tuesday *$/.test(l));
    ok('the pinned message is out of view at first', !feedHas());
    const pinRow = c.view().findIndex((l) => /⚑ lead \d\d:\d\d +DECISION/.test(l));
    ok('its pin is shown above the input', pinRow >= 0);
    await c.type(`\x1b[<0;10;${pinRow + 1}M\x1b[<0;10;${pinRow + 1}m`, 800);
    ok('a click on the pin scrolls to the message', feedHas(), c.view().find((l) => /DECISION/.test(l) && !/⚑ lead \d/.test(l)));
    // back to the bottom, then /pins 1
    await c.type('\x1b[F', 300); // End
    await c.type('\x1b[6~', 300); // PageDown
    for (let i = 0; i < 10; i++) await c.type('\x1b[6~', 50);
    await sleep(400);
    await c.paste('/pins 1');
    await c.type('\r', 800);
    ok('/pins 1 goes there too', feedHas());
    
    c.kill(); lead.m.close();
  } finally { hubProc.kill(); }
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message.slice(0, 2000)); process.exit(1); });
