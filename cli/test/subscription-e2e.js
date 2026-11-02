'use strict';
// A Claude subscription handed to an agent (the room secret CLAUDE_CODE_OAUTH_TOKEN) replaces the
// per-token provider in its environment (OpenRouter's base URL, key and model names), which would
// otherwise win. A real wrapper around a stand-in `claude` that writes down the names it got.
//   node test/subscription-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-e2e-'));
const home = path.join(dir, 'home');
const bin = path.join(dir, 'bin');
for (const d of [home, bin]) fs.mkdirSync(d);
const port = 21000 + Math.floor(Math.random() * 9000);
const AGENT = 'subscription-e2e-agent-token-0123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
require('fs').writeFileSync(require('path').join(process.env.HOME, 'env-' + process.env.MC_AGENT + '.json'), JSON.stringify(Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN)/.test(k)).sort()));
process.stdout.write('\\x1b]0;claude\\x07> '); setInterval(() => {}, 1000);
`, { mode: 0o755 });

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  const procs = [];
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    // OpenRouter, as the values container sets it
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MC_HUB_URL: `ws://127.0.0.1:${port}/`, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'or-key', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'anthropic/claude-opus-5.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5.5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5' };
    for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID', 'MC_AGENT_KEY']) delete env[k];
    // subbed holds the subscription token (as a room secret leaves it), plain does not
    const store = path.join(home, '.config', 'metacom-hub', 'env');
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(store, 'subbed@values.env'), "CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-test-token-value'\n", { mode: 0o600 });
    // login: the machine's own `claude /login`, and first-party model names in the store
    fs.writeFileSync(path.join(store, 'login@values.env'), "CLAUDE_SUBSCRIPTION='login'\nANTHROPIC_MODEL='claude-opus-5-5'\n", { mode: 0o600 });
    procs.push(spawn(process.execPath, [MC, 'values', '-n', 'login', 'claude'], { env, cwd: dir, stdio: 'ignore' }));
    for (const n of ['subbed', 'plain']) procs.push(spawn(process.execPath, [MC, 'values', '-n', n, 'claude'], { env, cwd: dir, stdio: 'ignore' }));
    const got = (n) => JSON.parse(fs.readFileSync(path.join(home, `env-${n}.json`), 'utf8'));
    await until('all started', () => ['subbed', 'plain', 'login'].every((n) => fs.existsSync(path.join(home, `env-${n}.json`))));
    assert.deepStrictEqual(got('login'), ['ANTHROPIC_MODEL'], 'CLAUDE_SUBSCRIPTION=login: no OpenRouter, the first-party model name from the store');
    assert.deepStrictEqual(got('subbed'), ['CLAUDE_CODE_OAUTH_TOKEN'], 'the subscription, and no OpenRouter base URL, key or model names');
    assert.deepStrictEqual(got('plain'), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_MODEL'], 'without the token: as it was');
    console.log('PASS with CLAUDE_CODE_OAUTH_TOKEN held, the agent gets the subscription and none of the per-token provider; without it, as before');
  } finally {
    for (const p of procs) p.kill();
    hubProc.kill();
  }
};

main().then(() => process.exit(0), (e) => { console.error(`FAIL ${e.stack || e.message}`); process.exit(1); });
