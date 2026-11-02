'use strict';
// Suggested replies from the agent's side, through its real MCP bridge: the suggest parameter says
// what it is for; a message to a person that asks for a decision without one gets a tip (never a
// refusal); and `metacom usage --suggest` says how each agent's suggestions fared.
//   node test/suggest-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-e2e-'));
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const OWNER = 'suggest-e2e-owner-token-012345';
const AGENT = 'suggest-e2e-agent-token-012345';
const pass = (what) => console.log(`PASS ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT },
    stdio: 'ignore',
  });
  let mcp = null;
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const misha = await connect({ url, token: OWNER });
    await misha.api.agents.register({ name: 'misha', room: 'dev', kind: 'human' });
    const wrapper = await connect({ url, token: AGENT });
    await wrapper.api.agents.register({ name: 'builder', room: 'dev' });
    const other = await connect({ url, token: AGENT });
    await other.api.agents.register({ name: 'tester', room: 'dev' });
    mcp = new Client({ name: 'suggest-e2e', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [MC, 'mcp'], env: { ...process.env, HOME: dir, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, MC_AGENT: 'builder', MC_ROOM: 'dev' } }));
    const call = async (name, args) => (await mcp.callTool({ name, arguments: args })).content[0].text;

    const tools = (await mcp.listTools()).tools;
    for (const n of ['hub_say', 'hub_send']) {
      const props = tools.find((t) => t.name === n).inputSchema.properties;
      assert.match(props.suggest.description, /^When you need a decision from a person, put the reply you recommend here: one line, or a - \[ \] checklist with your recommended items ticked\. It waits 12 h \(suggest_ttl\).*When the decision is no longer needed, withdraw the suggestion: hub_unsuggest\.$/);
      assert.ok(props.suggest_ttl && props.suggest_keep_older);
    }
    assert.match(tools.find((t) => t.name === 'hub_unsuggest').description, /when the decision is no longer needed/);
    pass('suggest says what it is for, how long it waits and to withdraw it when no longer needed, in hub_say and hub_send; hub_unsuggest');

    const TIP = /Tip: add suggest with the reply you recommend/;
    const asked = await call('hub_send', { to: 'misha', text: 'Tests are green. Ship 0.2 now?', kind: 'info' });
    assert.match(asked, TIP);
    assert.match(asked, /^delivered to misha/, 'never blocking: it was sent');
    assert.doesNotMatch(await call('hub_send', { to: 'misha', text: 'Ship 0.2 now?', kind: 'info', suggest: 'yes, ship it' }), TIP);
    assert.doesNotMatch(await call('hub_send', { to: 'tester', text: 'Can you run the tests?', kind: 'command' }), TIP, 'an agent: no tip');
    assert.doesNotMatch(await call('hub_send', { to: 'misha', text: 'The page is published.', kind: 'info' }), TIP, 'no decision asked');
    assert.doesNotMatch(await call('hub_send', { to: 'misha', text: 'Pins now show at the end of the feed as a card, with reply and ⋯ on it.', kind: 'info' }), TIP, 'the bare word reply asks nothing');
    assert.doesNotMatch(await call('hub_send', { to: 'misha', text: 'Details: https://hub.example.com/?room=dev and `--x?`.', kind: 'info' }), TIP, 'a ? in a link or code is no question');
    assert.match(await call('hub_send', { to: 'misha', text: 'Build is ready. Say go and I deploy.', kind: 'info' }), TIP, 'an explicit ask');
    assert.match(await call('hub_say', { text: '@misha approve the copy before 5?' }), TIP);
    assert.doesNotMatch(await call('hub_say', { text: 'all tests green' }), TIP);
    pass('the tip: for a question or an explicit ask of a person without a suggestion, and only then (not the bare word reply)');

    // misha answers two of builder's suggestions: one as suggested, one in other words
    const h = await misha.api.room.history({ room: 'dev', limit: 50 });
    const withSuggest = h.filter((m) => m.suggest);
    await misha.api.agents.send({ to: 'builder', text: 'yes, ship it', kind: 'command', replyTo: withSuggest[0].id });
    const second = (await wrapper.api.agents.send({ to: 'misha', text: 'Tag it?', kind: 'info', suggest: 'tag v0.2.0' })).id;
    await misha.api.agents.send({ to: 'builder', text: 'tag v0.2.0-rc1', kind: 'command', replyTo: second });
    await wrapper.api.agents.send({ to: 'misha', text: 'Docs too?', kind: 'info', suggest: 'yes' });
    // withdrawn through the MCP bridge: it stops waiting for misha
    const late = (await misha.api.room.history({ room: 'dev', limit: 5 })).at(-1);
    assert.strictEqual(await call('hub_unsuggest', { id: late.id }), `withdrawn the suggestion on ${late.id}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await misha.api.room.suggestions({ room: 'dev' })).suggestions.some((m) => m.id === late.id));
    pass('hub_unsuggest: the suggestion stops waiting');
    const usage = spawnSync(process.execPath, [MC, 'usage', '--suggest'], { env: { ...process.env, HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER }, encoding: 'utf8' });
    assert.strictEqual(usage.status, 0, usage.stderr);
    assert.match(usage.stdout, /^builder\s+3\s+1\s+1\s+1\s+33%$/m, usage.stdout);
    pass('metacom usage --suggest: builder 3 suggested, 1 accepted, 1 edited, 1 ignored');
    misha.m.close();
    wrapper.m.close();
    other.m.close();
  } finally {
    if (mcp) await mcp.close().catch(() => {});
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
