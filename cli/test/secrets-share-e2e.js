'use strict';
// Secrets handed in a message, end to end, on a hub of its own: "@builder … $OPENROUTER_KEY=…$"
// puts the value in builder's env file on its machine (mode 600) and nowhere else; builder's
// agent is typed the message with $OPENROUTER_KEY; `secrets exec` has the value; builder passes it
// to tester with `secrets share` (the value never in either agent's input); an offline agent is
// refused; a restarted agent starts with it; the room shows names only.
//   node test/secrets-share-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-share-e2e-'));
const home = path.join(dir, 'home');
fs.mkdirSync(home);
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'share-e2e-owner-token-0123456789';
const AGENT = 'share-e2e-agent-token-0123456789';
const VALUE = `sk-or-v1-${crypto.randomBytes(16).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};

// the stand-in agent: everything typed into it goes to its transcript (what a model would read);
// at start it notes a hash of $OPENROUTER_KEY from its environment
const agentJs = path.join(dir, 'agent.js');
fs.writeFileSync(
  agentJs,
  `const fs = require('fs'); const n = process.argv[2];
fs.writeFileSync(n + '.key', process.env.MC_AGENT_KEY || '');
fs.writeFileSync(n + '.start', require('crypto').createHash('sha256').update(process.env.OPENROUTER_KEY || '').digest('hex'));
process.stdin.on('data', (d) => fs.appendFileSync(n + '.transcript', d));
process.stdout.write(n + '> ');`,
);
const env = { ...process.env, HOME: home, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT };
for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID', 'MC_AGENT_KEY']) delete env[k];
const wrap = (name) => spawn(process.execPath, [MC, 'dev', '-n', name, 'node', agentJs, path.join(dir, name)], { env, stdio: 'ignore', cwd: dir });
const cli = (args, extra = {}) => spawnSync(process.execPath, [MC, ...args], { env: { ...env, ...extra }, encoding: 'utf8', cwd: dir });
const envFile = (name) => path.join(home, '.config', 'metacom-hub', 'env', `${name}@dev.env`);

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT },
    stdio: 'ignore',
  });
  const procs = [];
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    const owner = await connect({ url, token: OWNER });
    const online = async (n) => ((await owner.api.agents.list({ room: 'dev' })).find((m) => m.name === n) || {}).status === 'waiting';
    let builder = wrap('builder');
    const tester = wrap('tester');
    procs.push(tester);
    await until('builder and tester online', async () => (await online('builder')) && (await online('tester')));

    // 1. the owner hands it to builder in a message
    const sent = await owner.api.agents.send({ to: 'builder', text: `here's the key $OPENROUTER_KEY=${VALUE}$, use it for the eval`, kind: 'command' });
    assert.ok(sent.id);
    await until('builder env file', () => fs.existsSync(envFile('builder')));
    assert.strictEqual(fs.statSync(envFile('builder')).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(envFile('builder'), 'utf8'), `OPENROUTER_KEY='${VALUE}'\n`);
    await until('builder is typed the message', () => fs.existsSync(path.join(dir, 'builder.transcript')) && /\$OPENROUTER_KEY, use it for the eval/.test(fs.readFileSync(path.join(dir, 'builder.transcript'), 'utf8')));
    pass("builder's wrapper keeps it in its env file (600); builder is typed $OPENROUTER_KEY");

    // 2. builder uses it without seeing it
    // its own processes: they have the key its wrapper gave it
    const asBuilder = { MC_AGENT: 'builder', MC_ROOM: 'dev', MC_AGENT_KEY: fs.readFileSync(path.join(dir, 'builder.key'), 'utf8') };
    const exec = cli(['secrets', 'exec', '--only', 'OPENROUTER_KEY', '--', 'printf %s "$OPENROUTER_KEY" | sha256sum | cut -c1-64; echo "key is $OPENROUTER_KEY"'], asBuilder);
    assert.strictEqual(exec.status, 0, exec.stderr);
    assert.strictEqual(exec.stdout, `${sha(VALUE)}\nkey is $OPENROUTER_KEY\n`);
    pass('secrets exec: the command has the value, what it prints shows $OPENROUTER_KEY');

    // 3. builder passes it on to tester: the value goes from builder's machine, not its model
    const share = cli(['secrets', 'share', 'OPENROUTER_KEY', '--to', '@tester'], asBuilder);
    assert.strictEqual(share.status, 0, share.stderr);
    await until('tester env file', () => fs.existsSync(envFile('tester')));
    assert.strictEqual(fs.readFileSync(envFile('tester'), 'utf8'), `OPENROUTER_KEY='${VALUE}'\n`);
    pass('secrets share --to @tester: tester has it in its env file');

    // 4. an offline agent is refused, nothing kept
    tester.kill();
    await until('tester offline', async () => !(await online('tester')), 60000);
    await assert.rejects(owner.api.agents.send({ to: 'tester', text: 'for you: $OTHER_KEY=abcdefgh1234$', kind: 'command' }), /offline/);
    pass('to an offline agent: refused');

    // 5. builder started again: the value is in its environment from the start
    builder.kill();
    await until('builder offline', async () => !(await online('builder')), 60000);
    fs.writeFileSync(path.join(dir, 'builder.start'), '');
    builder = wrap('builder');
    procs.push(builder);
    await until('builder started again', () => fs.readFileSync(path.join(dir, 'builder.start'), 'utf8').length > 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'builder.start'), 'utf8'), sha(VALUE));
    pass('a restarted agent has it in its environment');

    // 6. names only, everywhere but the two env files
    const log = (await owner.api.room.history({ room: 'dev', limit: 100 })).map((m) => m.text).join('\n');
    for (const line of ['env-owner shared $OPENROUTER_KEY with builder', 'builder used $OPENROUTER_KEY', 'builder shared $OPENROUTER_KEY with tester']) assert.ok(log.includes(line), line);
    const holders = [];
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile() && fs.readFileSync(p).includes(VALUE)) holders.push(path.relative(dir, p));
    }
    assert.deepStrictEqual(holders.sort(), ['home/.config/metacom-hub/env/builder@dev.env', 'home/.config/metacom-hub/env/tester@dev.env']);
    assert.ok(!log.includes(VALUE));
    pass('the room: shared/used by name; the value only in the two env files (no hub file, no transcript)');
    owner.m.close();
    builder.kill();
  } finally {
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
