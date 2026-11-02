'use strict';

// Room pages whose names are the RPC's or the file store's paths: GET /api, /media (and /apiary)
// open the web client, while RPC (WebSocket at /, POST /api) and uploads (POST /media) still work.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { connect } = require('../../cli/lib/client.js');

test('a room named api or media opens in the web client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-routes-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const owner = 'routes-owner-token-0123456789';
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir, HUB_OWNER_TOKEN: owner }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
    for (const room of ['/api', '/media', '/apiary', '/api?x=1']) {
      const r = await fetch(base + room);
      assert.strictEqual(r.status, 200, room);
      assert.match(r.headers.get('content-type'), /text\/html/, room);
    }
    assert.strictEqual((await fetch(`${base}/media`, { method: 'POST', body: 'x' })).status, 401, 'uploads are still the file store');
    assert.notStrictEqual((await fetch(`${base}/api`, { method: 'POST', body: '{}' })).headers.get('content-type'), 'text/html; charset=utf-8', 'RPC over HTTP is still metacom');
    const h = await connect({ url: `ws://127.0.0.1:${port}/`, token: owner });
    await h.api.room.say({ room: 'api', text: 'hello' });
    const history = await h.api.room.history({ room: 'api', limit: 5 });
    assert.ok((history.messages || history).some((m) => m.text === 'hello'));
    h.m.close();
  } finally {
    hub.kill();
  }
});
