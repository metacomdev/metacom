'use strict';
// Who a message is from, on a hub of its own: agents of one machine share a token, so the token
// alone must not let one speak as another. Each wrapper puts a key of its own in its agent's
// environment (MC_AGENT_KEY); `metacom` and the MCP bridge speak as the agent only with it. A shell
// that merely has MC_AGENT set (as one did, posting under another agent's name) cannot.
//   node test/identity-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-e2e-'));
const home = path.join(dir, 'home');
fs.mkdirSync(home);
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'identity-e2e-owner-token-012345';
const AGENT = 'identity-e2e-agent-token-012345';
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};
const env = { ...process.env, HOME: home, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT };
for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID', 'MC_AGENT_KEY']) delete env[k];
// a stand-in agent: writes down the key its wrapper gave it, then waits
const agentJs = path.join(dir, 'agent.js');
fs.writeFileSync(agentJs, `require('fs').writeFileSync(process.argv[2], process.env.MC_AGENT_KEY || ''); process.stdout.write('> '); setInterval(() => {}, 1000);`);
const keyOf = (name) => path.join(dir, `${name}.key`);
const wrap = (name) => spawn(process.execPath, [MC, 'dev', '-n', name, 'node', agentJs, keyOf(name)], { env, stdio: 'ignore', cwd: dir });
const say = (text, extra) => spawnSync(process.execPath, [MC, 'say', text, '--room', 'dev'], { env: { ...env, ...extra }, encoding: 'utf8', cwd: dir });

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT },
    stdio: 'ignore',
  });
  const procs = [];
  let mcp = null;
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    const owner = await connect({ url, token: OWNER });
    procs.push(wrap('builder'), wrap('tester'));
    await until('both keys', () => fs.existsSync(keyOf('builder')) && fs.existsSync(keyOf('tester')) && fs.readFileSync(keyOf('builder'), 'utf8') && fs.readFileSync(keyOf('tester'), 'utf8'));
    const key = (n) => fs.readFileSync(keyOf(n), 'utf8');
    assert.notStrictEqual(key('builder'), key('tester'));
    await until('both online', async () => (await owner.api.agents.list({ room: 'dev' })).filter((m) => m.status === 'waiting').length === 2);
    const room = async () => (await owner.api.room.history({ room: 'dev', limit: 50 })).filter((m) => m.kind === 'say');
    pass('each wrapper gives its agent a key of its own (MC_AGENT_KEY)');

    let r = say('posted as builder?', { MC_AGENT: 'builder', MC_ROOM: 'dev' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /not speaking as builder: only builder's own processes speak as builder/);
    assert.ok(!(await room()).some((m) => m.text === 'posted as builder?'));
    pass('a shell with only MC_AGENT=builder (and the machine\'s token): refused, nothing posted');

    r = say('posted with the wrong key', { MC_AGENT: 'builder', MC_ROOM: 'dev', MC_AGENT_KEY: key('tester') });
    assert.ok(!(await room()).some((m) => m.text === 'posted with the wrong key'));
    pass('tester\'s key does not speak as builder');

    r = say('from builder, really', { MC_AGENT: 'builder', MC_ROOM: 'dev', MC_AGENT_KEY: key('builder') });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual((await room()).find((m) => m.text === 'from builder, really').from.name, 'builder');
    pass('builder\'s own key: from builder');

    mcp = new Client({ name: 'identity-e2e', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [MC, 'mcp'], env: { ...env, MC_AGENT: 'builder', MC_ROOM: 'dev', MC_AGENT_KEY: key('builder') } }));
    await mcp.callTool({ name: 'hub_say', arguments: { text: 'builder through its MCP bridge' } });
    assert.strictEqual((await room()).find((m) => m.text === 'builder through its MCP bridge').from.name, 'builder');
    pass('its MCP bridge, with the key: from builder');
    owner.m.close();
  } finally {
    if (mcp) await mcp.close().catch(() => {});
    for (const p of procs) p.kill();
    hubProc.kill();
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exit(1);
  },
);
