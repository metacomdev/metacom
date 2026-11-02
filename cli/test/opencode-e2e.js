'use strict';
// OpenCode gets the room: under the wrapper, a command named `opencode` (here a stand-in that writes
// down what it was given) starts with OPENCODE_CONFIG_CONTENT holding the hub MCP server for this
// agent and room, the room prompt as an instructions file of its own, and the user's own settings
// in that variable kept; the prompt file is gone when the wrapper ends.
//   node test/opencode-e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { connect } = require('../lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-'));
  const port = 29870 + Math.floor(Math.random() * 60);
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'oc-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url, token: OWNER });
  const { token } = await owner.api.admin.createToken({ name: 'oc', role: 'agent', rooms: ['dev'] });
  // the stand-in: records its config and the prompt file's text, then idles
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const seen = path.join(dir, 'seen.json');
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env node
const fs = require('fs');
const c = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const prompt = (c.instructions || []).filter((f) => f.endsWith('.md') && fs.existsSync(f)).map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ c, prompt }));
console.log('ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: home, PATH: `${bin}:${process.env.PATH}`, MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT_TOKEN: token, OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'opencode/some-model', instructions: ['AGENTS.md'] }) };
  const agent = spawn(process.execPath, [MC, 'dev', '-n', 'oc', '--', 'opencode'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  agent.stderr.on('data', (d) => (stderr += d));
  const ended = new Promise((r) => agent.on('exit', r));
  try {
    for (let i = 0; i < 160 && !fs.existsSync(seen); i++) await sleep(250);
    const { c, prompt } = JSON.parse(fs.readFileSync(seen, 'utf8'));
    const hubServer = c.mcp && c.mcp.hub;
    ok('the hub MCP server, local, for this agent and room', hubServer && hubServer.type === 'local' && hubServer.enabled && hubServer.command.some((a) => a.endsWith('metacom.js')) && hubServer.command.at(-1) === 'mcp' && hubServer.environment.MC_AGENT === 'oc' && hubServer.environment.MC_ROOM === 'dev' && hubServer.environment.MC_HUB_URL === url, JSON.stringify(hubServer));
    ok('…on this agent\'s own token', hubServer && hubServer.environment.MC_AGENT_TOKEN === token);
    ok('the user\'s own settings in the variable kept (model, instructions)', c.model === 'opencode/some-model' && c.instructions[0] === 'AGENTS.md', JSON.stringify(c).slice(0, 300));
    ok('the room prompt, as an instructions file of its own', prompt.length === 1 && /oc/.test(prompt[0].text) && /dev/.test(prompt[0].text) && fs.statSync(prompt[0].f).mode % 0o1000 === 0o600, JSON.stringify(prompt).slice(0, 300));
    await owner.api.agents.kill({ name: 'oc' }).catch(() => {});
    await Promise.race([ended, sleep(15000)]);
    agent.kill();
    await sleep(300);
    ok('the prompt file is gone when the wrapper ends', prompt.length === 1 && !fs.existsSync(prompt[0].f));
  } catch (e) {
    ok('ran', false, `${e.stack}\n${stderr}`);
  } finally {
    agent.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
