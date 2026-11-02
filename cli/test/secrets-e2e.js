'use strict';
// Secrets with nothing kept at the hub, end to end on a hub of its own: a message that is only
// `$API_KEY=…$` goes to every agent online in the room (each wrapper keeps it on its machine) and
// the sender is told who got it; `metacom secrets` lists names per agent; an agent's own CLI and
// MCP posts mask the value; `$API_KEY=$` takes it back; and no file under the hub's data ever
// holds the value.
//   node test/secrets-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-e2e-'));
const home = path.join(dir, 'home');
fs.mkdirSync(home);
const hubData = path.join(dir, 'hub');
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'secrets-e2e-owner-token-012345';
const AGENT = 'secrets-e2e-agent-token-012345';
const VALUE = `sk-live-${crypto.randomBytes(12).toString('hex')}`;
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
};
const env = { ...process.env, HOME: home, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT };
for (const k of ['MC_AGENT', 'MC_ROOM', 'MC_WRAPPER_PID']) delete env[k];
const agentJs = path.join(dir, 'agent.js');
fs.writeFileSync(agentJs, `require('fs').writeFileSync(process.argv[2] + '.key', process.env.MC_AGENT_KEY || ''); process.stdin.on('data', (d) => require('fs').appendFileSync(process.argv[2] + '.transcript', d)); process.stdout.write('> ');`);
const wrap = (name) => spawn(process.execPath, [MC, 'dev', '-n', name, 'node', agentJs, path.join(dir, name)], { env, stdio: 'ignore', cwd: dir });
const cli = (args, extra = {}) => spawnSync(process.execPath, [MC, ...args], { env: { ...env, ...extra }, encoding: 'utf8', cwd: dir });
const envFile = (name) => path.join(home, '.config', 'metacom-hub', 'env', `${name}@dev.env`);

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: hubData, HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT },
    stdio: 'ignore',
  });
  const procs = [];
  let mcp = null;
  try {
    await until('the hub', () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false));
    const owner = await connect({ url, token: OWNER });
    const online = async (n) => ((await owner.api.agents.list({ room: 'dev' })).find((m) => m.name === n) || {}).status === 'waiting';
    procs.push(wrap('builder'), wrap('tester'));
    await until('builder and tester online', async () => (await online('builder')) && (await online('tester')));
    // an agent of the room that is offline: registered once, then gone
    const ghost = await connect({ url, token: AGENT });
    await ghost.api.agents.register({ name: 'ghost', room: 'dev' });
    ghost.m.close();
    await until('ghost offline', async () => ((await owner.api.agents.list({ room: 'dev' })).find((m) => m.name === 'ghost') || {}).status === 'stopped');

    // 1. only a secret, nobody named: every agent online in the room, and the sender is told who
    const said = cli(['say', `$API_KEY=${VALUE}$`, '--room', 'dev'], { MC_TOKEN: OWNER });
    assert.strictEqual(said.status, 0, said.stderr);
    assert.match(said.stdout, /🔒 handed to builder, tester \(not online: ghost\)/);
    await until('both env files', () => fs.existsSync(envFile('builder')) && fs.existsSync(envFile('tester')));
    for (const n of ['builder', 'tester']) assert.strictEqual(fs.readFileSync(envFile(n), 'utf8'), `API_KEY='${VALUE}'\n`);
    const room = await owner.api.room.history({ room: 'dev', limit: 50 });
    assert.ok(room.some((m) => m.text === '🔒 env-owner shared $API_KEY with builder, tester (not online: ghost)'));
    assert.ok(!room.some((m) => m.kind === 'say'), 'nothing posted but the line');
    pass('a message that is only $API_KEY=…$: both online agents keep it; the sender is told who, and who was offline');

    // 2. names per agent, as the wrappers report them
    await until('names reported', async () => (await owner.api.room.secrets({ room: 'dev' })).agents.length === 2);
    assert.match(cli(['secrets', '--room', 'dev'], { MC_TOKEN: OWNER }).stdout, /^builder +\$API_KEY\ntester +\$API_KEY\n$/);
    pass('metacom secrets: names per agent');

    // 3. what the agent posts never carries the value: its CLI, and its MCP bridge
    // as builder's own processes are: with the key its wrapper gave it
    const asBuilder = { MC_AGENT: 'builder', MC_ROOM: 'dev', MC_AGENT_KEY: fs.readFileSync(path.join(dir, 'builder.key'), 'utf8') };
    cli(['say', `oops, the key is ${VALUE}`, '--room', 'dev'], asBuilder);
    const transport = new StdioClientTransport({ command: process.execPath, args: [MC, 'mcp'], env: { ...env, ...asBuilder } });
    mcp = new Client({ name: 'secrets-e2e', version: '1' });
    await mcp.connect(transport);
    await mcp.callTool({ name: 'hub_say', arguments: { text: `via the model: ${VALUE}` } });
    const room2 = (await owner.api.room.history({ room: 'dev', limit: 50 })).map((m) => m.text);
    assert.ok(room2.includes('oops, the key is $API_KEY'));
    assert.ok(room2.includes('via the model: $API_KEY'));
    const roomView = (await mcp.callTool({ name: 'hub_room', arguments: {} })).content[0].text;
    assert.match(roomView, /Secrets by name .*builder \(you\): \$API_KEY; tester: \$API_KEY/);
    pass("an agent's CLI and MCP posts show $API_KEY; hub_room lists names per agent");

    // 3b. put where the agent wants it: a .env (new or existing, --as), a bare file; mode 600; a
    // tracked file refused, one not ignored warned about; the value never on stdout or stderr
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-put-'));
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nkeys/\n');
    fs.writeFileSync(path.join(repo, '.env'), '# app\nFOO=1\nexport OPENAI_API_KEY=old\nBAR="two words"\n');
    fs.writeFileSync(path.join(repo, 'config.env'), 'X=1\n');
    git('add', '.gitignore', 'config.env');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const put = (...args) => spawnSync(process.execPath, [MC, 'secrets', 'put', ...args], { env: { ...env, ...asBuilder }, encoding: 'utf8', cwd: repo });
    const clean = (r) => !r.stdout.includes(VALUE) && !r.stderr.includes(VALUE);
    const mode = (f) => (fs.statSync(path.join(repo, f)).mode & 0o777).toString(8);
    let r = put('API_KEY', '--env', '.env', '--as', 'OPENAI_API_KEY');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'wrote $API_KEY to .env as OPENAI_API_KEY\n');
    assert.strictEqual(r.stderr, '', 'ignored: no warning');
    assert.strictEqual(fs.readFileSync(path.join(repo, '.env'), 'utf8'), `# app\nFOO=1\nexport OPENAI_API_KEY=${VALUE}\nBAR="two words"\n`);
    assert.strictEqual(mode('.env'), '600');
    r = put('$API_KEY', '--env-file', '.env');
    assert.match(fs.readFileSync(path.join(repo, '.env'), 'utf8'), new RegExp(`\nAPI_KEY=${VALUE}\n$`), 'a new line at the end, the others kept');
    assert.ok(clean(r));
    pass('put into an existing .env: --as replaces its line (export kept), without --as adds one; 600; prints the name only');
    r = put('secret://API_KEY', '--env', 'fresh.env');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(repo, 'fresh.env'), 'utf8'), `API_KEY=${VALUE}\n`);
    assert.match(r.stderr, /warning: fresh\.env is not in \.gitignore/);
    assert.ok(clean(r) && mode('fresh.env') === '600');
    pass('a new .env, by secret://API_KEY: created 600; not in .gitignore: a warning');
    fs.mkdirSync(path.join(repo, 'keys'));
    r = put('API_KEY', '--file', 'keys/openai.txt');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'wrote $API_KEY to keys/openai.txt\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'keys/openai.txt'), 'utf8'), VALUE);
    assert.ok(clean(r) && mode('keys/openai.txt') === '600');
    pass('--file: the bare value, 600');
    r = put('API_KEY', '--env-file', 'config.env');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /config\.env is tracked by git/);
    assert.strictEqual(fs.readFileSync(path.join(repo, 'config.env'), 'utf8'), 'X=1\n', 'untouched');
    r = put('API_KEY', '--env-file', 'config.env', '--force');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(clean(r));
    pass('a file git tracks: refused, untouched; --force writes it');
    assert.notStrictEqual(put('NOPE', '--env-file', '.env').status, 0, 'a secret it does not hold');
    await until('put said in the room', async () => (await owner.api.room.history({ room: 'dev', limit: 80 })).some((m) => m.text === 'builder put $API_KEY into .env'));
    const told = (await owner.api.room.history({ room: 'dev', limit: 80 })).map((m) => m.text).join('\n');
    assert.ok(told.includes('builder put $API_KEY into keys/openai.txt') && !told.includes(VALUE));
    pass('the room is told "builder put $API_KEY into .env": name and path, never the value');
    // the first time the agent reads a message naming it: how to use it
    await owner.api.room.say({ room: 'dev', text: 'use $API_KEY for the OpenAI calls' });
    const read1 = (await mcp.callTool({ name: 'hub_read', arguments: {} })).content[0].text;
    assert.match(read1, /shared \$API_KEY with builder, tester \(not online: ghost\) \(\$API_KEY is a secret: use `metacom secrets put API_KEY --env \.env`/, 'on the first line naming it');
    assert.strictEqual(read1.split('is a secret: use').length, 2, 'that line only');
    const read2 = (await mcp.callTool({ name: 'hub_read', arguments: {} })).content[0].text;
    assert.ok(!read2.includes('is a secret: use'), 'once');
    pass('hub_read: the first line naming $API_KEY carries the hint, once');
    await owner.api.agents.send({ to: 'tester', text: 'call the API with $API_KEY', kind: 'command' });
    const typed = () => (fs.existsSync(path.join(dir, 'tester.transcript')) ? fs.readFileSync(path.join(dir, 'tester.transcript'), 'utf8') : '');
    await until('typed into tester', () => typed().includes('call the API with $API_KEY'));
    assert.match(typed(), /call the API with \$API_KEY \(\$API_KEY is a secret: use `metacom secrets put API_KEY --env \.env`/);
    pass('typed into the agent: the first message naming $API_KEY carries the hint');

    // 4. taken back
    cli(['say', '$API_KEY=$', '--room', 'dev'], { MC_TOKEN: OWNER });
    await until('removed', () => !fs.readFileSync(envFile('builder'), 'utf8').includes('API_KEY'));
    await until('names updated', async () => (await owner.api.room.secrets({ room: 'dev' })).agents.length === 0);
    pass('$API_KEY=$ takes it back from both');

    // 5. never at the hub: not in its data, not in either agent's input
    const holders = [];
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile() && fs.readFileSync(p).includes(VALUE)) holders.push(path.relative(dir, p));
    }
    assert.deepStrictEqual(holders, [], 'after it was taken back, nothing anywhere holds it');
    assert.ok(!fs.existsSync(path.join(hubData, 'secrets.json')) && !fs.existsSync(path.join(hubData, 'secrets.key')));
    pass('no file under the hub data, no agent input, ever held the value; no secrets.json or secrets.key');
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
