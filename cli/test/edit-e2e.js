'use strict';
// Editable messages end to end, on a hub of its own: an agent posts a task list through its MCP
// bridge (hub_say), checks items off with hub_edit, hub_read shows the latest version as edited,
// the agent it names gets the final version once (after the hub's ~20 s), the owner can read
// every version (`metacom history`), and nobody else can edit it.
//   node test/edit-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('../lib/client.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MC = path.join(__dirname, '..', 'bin', 'metacom.js');
const port = 21000 + Math.floor(Math.random() * 9000);
const url = `ws://127.0.0.1:${port}/`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-e2e-'));
const OWNER = 'edit-e2e-owner-token-0123456789';
const AGENT = 'edit-e2e-agent-token-0123456789';
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
    // the wrappers: lead and builder, in room dev
    const wrapper = async (name) => {
      const h = await connect({ url, token: AGENT });
      await h.api.agents.register({ name, room: 'dev' });
      await h.api.agents.status({ status: 'waiting', reason: 'idle' });
      const got = [];
      h.api.agents.on('message', (m) => got.push(m));
      return { h, got };
    };
    const lead = await wrapper('lead');
    const builder = await wrapper('builder');
    const owner = await connect({ url, token: OWNER });

    // lead's MCP bridge, as the wrapper starts it
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MC, 'mcp'],
      env: { ...process.env, HOME: dir, MC_HUB_URL: url, MC_TOKEN: AGENT, MC_AGENT_TOKEN: AGENT, MC_AGENT: 'lead', MC_ROOM: 'dev' },
    });
    mcp = new Client({ name: 'edit-e2e', version: '1' });
    await mcp.connect(transport);
    const call = async (name, args) => (await mcp.callTool({ name, arguments: args })).content[0].text;
    assert.ok((await mcp.listTools()).tools.some((t) => t.name === 'hub_edit'));

    const posted = await call('hub_say', { text: 'Plan for the launch:\n- [ ] page (@builder)\n- [ ] email' });
    const id = /posted (\S+)/.exec(posted)[1];
    pass(`hub_say returns the id: ${posted}`);
    await sleep(300);
    const t0 = Date.now();
    assert.match(await call('hub_edit', { id, text: 'Plan for the launch:\n- [x] page (@builder)\n- [ ] email' }), /edited .*: now v2/);
    await sleep(1000);
    assert.match(await call('hub_edit', { id, text: 'Plan for the launch:\n- [x] page (@builder)\n- [x] email' }), /now v3/);
    pass('hub_edit: v2, then v3 a second later');
    const read = await call('hub_read', { limit: 5 });
    assert.match(read, /\(edited v3\) lead: Plan for the launch:\n- \[x\] page \(@builder\)\n- \[x\] email \[id /);
    pass('hub_read shows the latest version, "edited v3", and the id');

    // not anyone else's to edit: builder on the same machine token, and the owner
    await assert.rejects(builder.h.api.room.edit({ id, text: 'hijack' }), /Only its author/);
    await assert.rejects(owner.api.room.edit({ id, text: 'hijack' }), /Only its author/);
    pass('builder (same token) and the owner are refused');

    // builder hears it once, the final version, ~20 s after the last edit; lead itself never
    while (!builder.got.some((m) => m.edit) && Date.now() - t0 < 40_000) await sleep(250);
    const notes = builder.got.filter((m) => m.edit);
    await sleep(1500);
    assert.strictEqual(builder.got.filter((m) => m.edit).length, 1);
    assert.strictEqual(notes[0].text, `[edited v3 of ${id}] Plan for the launch:\n- [x] page (@builder)\n- [x] email`);
    assert.ok(!lead.got.some((m) => m.edit));
    pass(`builder got the final version once, ${((Date.now() - t0) / 1000).toFixed(0)} s after the first edit (kind ${notes[0].kind}); lead got nothing`);
    const inbox = await builder.h.api.agents.inbox();
    assert.ok(inbox.some((m) => m.id === notes[0].id), 'and it waits in the inbox like any directed message');

    // the owner's view: the room at the latest version, and every version on request
    const history = await owner.api.room.history({ room: 'dev', limit: 20 });
    const shown = history.filter((m) => m.id === id);
    assert.deepStrictEqual([shown.length, shown[0].rev, history.some((m) => m.kind === 'edit')], [1, 3, false]);
    const cli = spawnSync(process.execPath, [MC, 'history', id.slice(0, 8)], { env: { ...process.env, HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER }, encoding: 'utf8' });
    assert.match(cli.stdout, /^v1 .* lead\n {2}Plan for the launch:\n {2}- \[ \] page/m);
    assert.match(cli.stdout, /^v3 .* lead\n/m);
    assert.match(cli.stdout, /3 versions, the last one shown in the room/);
    pass('metacom history <8 chars>: all three versions');

    // pins: through the bridge, no message in the room, listed at the latest version
    const before = (await owner.api.room.history({ room: 'dev', limit: 50 })).length;
    assert.match(await call('hub_pin', { id }), /^pinned .*: 1 pinned$/);
    assert.match(await call('hub_read', { limit: 5 }), /\(edited v3\) \(pinned\) lead: Plan for the launch/);
    assert.match(await call('hub_pins', {}), /lead: Plan for the launch:\n- \[x\] page \(@builder\)\n- \[x\] email \[id .*, pinned by lead\]/);
    const roomView = await call('hub_room', {});
    assert.match(roomView, /^Room dev\nAgents \(2 online of 2\):\n- builder: waiting\n- lead \(you\): waiting/);
    assert.match(roomView, /Pinned \(1, latest pinned first\):\n- .* lead: Plan for the launch:/);
    assert.match(roomView, /Secrets: none$/);
    assert.match(await call('hub_read', { limit: 3 }), /^\(1 pinned in dev: hub_room shows them, and who is here\)/);
    pass('hub_room: who is here, what is pinned, the secrets by name; hub_read points to it');
    assert.strictEqual((await owner.api.room.history({ room: 'dev', limit: 50 })).length, before, 'a pin posts nothing');
    assert.match(await call('hub_pin', { id, on: false }), /^unpinned .*: 0 pinned$/);
    assert.match(await call('hub_pins', {}), /nothing is pinned/);
    pass('hub_pin, hub_pins, and hub_read marks (pinned); nothing posted');
    console.log(JSON.stringify({ port, id, owner: OWNER }));
    if (process.argv.includes('--keep')) {
      console.log('hub kept running for a look; ctrl+c ends it');
      await new Promise(() => {});
    }
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
