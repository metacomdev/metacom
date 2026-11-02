'use strict';
// Live mode's scrolling back, end to end: a real wrapper around a stand-in agent that has printed
// 150 numbered lines (more than its screen holds); the owner, live, scrolls back through the hub
// (and in the terminal chat: shift+↑↓, shift+PgUp, the wheel), sees the older lines, and any other
// key is back at the bottom and reaches the agent.
//   node test/live-scroll-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { connect } = require('../lib/client.js');
const { spawnChat } = require('./tui-driver.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scroll-e2e-'));
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'live-scroll-owner-token-0123456';
const AGENT = 'live-scroll-agent-token-0123456';
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};
const agentJs = path.join(dir, 'agent.js');
fs.writeFileSync(agentJs, `let out = '';
for (let i = 0; i < 150; i++) out += 'history line ' + i + '\\r\\n';
process.stdout.write(out + '\\x1b]0;agent\\x07> ');
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'typed'))}, d); process.stdout.write(d.toString()); });
setInterval(() => {}, 1000);`);

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  const env = { ...process.env, HOME: dir, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT };
  for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID', 'MC_AGENT_KEY']) delete env[k];
  let wrapper = null;
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    wrapper = spawn(process.execPath, [MC, 'dev', '-n', 'scroller', 'node', agentJs], { env, cwd: dir, stdio: 'ignore' });
    const owner = await connect({ url, token: OWNER });
    await owner.api.agents.register({ name: 'misha', room: 'dev', kind: 'human' });
    await until('the agent', async () => ((await owner.api.agents.list({ room: 'dev' })).find((m) => m.name === 'scroller') || {}).connected);
    await sleep(800);

    // 1. through the hub: a screenful from the scrollback
    await owner.api.agents.live({ name: 'scroller', on: true });
    const page = await owner.api.agents.liveScroll({ name: 'scroller', offset: 50 });
    const nums = page.lines.map((l) => (/history line (\d+)/.exec(l) || [])[1]).filter(Boolean).map(Number);
    assert.ok(page.max > 100 && page.offset === 50 && nums.length > 5 && nums.at(-1) < 150 - 40, JSON.stringify({ max: page.max, offset: page.offset, nums }));
    const top = await owner.api.agents.liveScroll({ name: 'scroller', offset: 100000 });
    assert.ok(top.offset === top.max && /history line 0\b/.test(top.lines[0]), top.lines.slice(0, 2).join('|'));
    assert.ok(!fs.existsSync(path.join(dir, 'typed')), 'nothing typed into the agent');
    await owner.api.agents.live({ name: 'scroller', on: false });
    pass(`agents.liveScroll: 50 rows up shows lines up to ${nums.at(-1)}; all the way up starts at line 0; nothing reaches the agent`);

    // 2. in the terminal chat
    const c = spawnChat({ room: 'dev', name: 'misha', cols: 100, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER } });
    await c.wait(/message dev/, 15000);
    await c.type('/live scroller', 300);
    await c.type('\r', 2000);
    const last = () => Math.max(-1, ...c.view().map((l) => Number((/history line (\d+)/.exec(l) || [])[1] ?? -1)));
    await until('the live screen', () => last() === 149);
    await c.type('\x1b[5;2~', 1200);
    const afterPage = last();
    assert.ok(afterPage < 149 && afterPage > 100 && c.view().some((l) => /scrolled \d+ up · ↓ to return/.test(l)), `after shift+PgUp: ${afterPage}\n${c.view().slice(-3).join('\n')}`);
    await c.type('\x1b[1;2A', 900);
    assert.strictEqual(last(), afterPage - 1, 'shift+↑: a row more');
    await c.type('\x1b[<64;20;10M', 900);
    assert.strictEqual(last(), afterPage - 4, 'the wheel: three rows');
    await c.type('\x1b[1;2B', 900);
    assert.strictEqual(last(), afterPage - 3, 'shift+↓: a row back');
    assert.ok(!fs.existsSync(path.join(dir, 'typed')), 'still nothing typed into the agent');
    await c.type('z', 1500);
    assert.ok(last() === 149 && !c.view().some((l) => /scrolled \d+ up/.test(l)), 'another key: back at the bottom');
    await until('z typed in', () => fs.existsSync(path.join(dir, 'typed')) && fs.readFileSync(path.join(dir, 'typed'), 'utf8') === 'z').catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(fs.existsSync(path.join(dir, 'typed')) ? fs.readFileSync(path.join(dir, 'typed'), 'utf8') : null)}`); });
    c.kill();
    pass(`terminal chat: shift+PgUp a page (to line ${afterPage}), shift+↑ a row, the wheel three, shift+↓ one back, "scrolled … · ↓ to return"; "z" is back at the bottom and typed into the agent`);
    owner.m.close();
  } finally {
    if (wrapper) wrapper.kill();
    hubProc.kill();
  }
};

main().then(() => process.exit(0), (e) => {
  console.error(`FAIL ${e.stack || e.message}`);
  process.exit(1);
});
