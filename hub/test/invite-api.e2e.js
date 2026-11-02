'use strict';
// "or join over the API" on the invite page, on a throwaway hub: the page shows the HTTPS calls
// and the WebSocket client for this room with the token masked, and copies them whole; the copied
// curl reads the room and posts to it with the token as Bearer, and the copied WebSocket client,
// run as it is, signs in and posts. The Bearer token has the link's rights: its room, as a user;
// another room, a bad token and a missing one are refused.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/invite-api.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { connect } = require('../../cli/lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'invite-api-'));
  const port = 29700 + Math.floor(Math.random() * 100);
  const base = `http://127.0.0.1:${port}`;
  const OWNER = 'ia-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url: `ws://127.0.0.1:${port}/`, token: OWNER });
  await owner.api.agents.register({ name: 'misha', room: 'deal', kind: 'human' });
  await owner.api.room.say({ room: 'deal', text: 'the terms are in brief.md' });
  await owner.api.agents.register({ name: 'misha', room: 'dev', kind: 'human' });
  await owner.api.room.say({ room: 'dev', text: 'private dev talk' });
  const { token } = await owner.api.admin.createToken({ name: 'partner', role: 'member', rooms: ['deal'], steer: 'answer', agents: true });
  const said = async () => (await owner.api.room.history({ room: 'deal', limit: 50 })).map((m) => `${m.from && m.from.name}: ${m.text}`);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ctx.newPage();
    await page.goto(`${base}/deal/invite/${token}`);
    await page.waitForSelector('#login.invite');
    await page.fill('#name', 'alen');
    await page.click('details.api summary');
    const section = await page.textContent('details.api');
    ok('the section is there: HTTPS with the token as Bearer, and the WebSocket address', /join over the API/.test(section) && section.includes(`${base}/api/room/history`) && section.includes(`ws://127.0.0.1:${port}/`) && /Bearer/.test(section), section.slice(0, 400));
    ok('the token is masked on screen, never whole', section.includes(`${token.slice(0, 6)}…••••…${token.slice(-4)}`) && !(await page.content()).includes(token));
    const steps = page.locator('details.api .step');
    ok('read, post and the WebSocket client, each with copy', (await steps.count()) === 4);
    const copied = async (i) => {
      await steps.nth(i).locator('button.copylink').click();
      return page.evaluate(() => navigator.clipboard.readText());
    };

    // the copied curl, as it is
    const read = await copied(1);
    ok('copy gives the whole token', read.includes(`Bearer ${token}`) && read.startsWith('curl '), read);
    const out = JSON.parse(execFileSync('sh', ['-c', read], { encoding: 'utf8' }));
    ok('the copied curl reads the room', Array.isArray(out.result) && out.result.some((m) => m.text === 'the terms are in brief.md'), JSON.stringify(out).slice(0, 300));
    const post = await copied(2);
    execFileSync('sh', ['-c', post], { encoding: 'utf8' });
    ok('the copied curl posts to it, as the link\'s user', (await said()).includes('partner: hello from the API'), (await said()).join(' | '));

    // the copied WebSocket client, run with node as it is
    const js = await copied(3);
    ok('the client signs in with the whole token, as alen', js.includes(`token: '${token}'`) && js.includes("name: 'alen'"), js);
    fs.writeFileSync(path.join(dir, 'client.mjs'), `${js}\nsetTimeout(() => process.exit(0), 3000);\n`);
    execFileSync(process.execPath, [path.join(dir, 'client.mjs')], { encoding: 'utf8', timeout: 10000 });
    ok('the copied WebSocket client posts as alen', (await said()).includes('alen: hello from the API'), (await said()).join(' | '));

    // the Bearer token has the link's rights, and no more
    const call = (method, args, auth = `Bearer ${token}`) => fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(args) }).then((r) => r.json());
    ok('another room is refused', /only for deal/.test((await call('room/history', { room: 'dev', limit: 5 })).error?.message || ''));
    ok('a bad token is refused', (await call('room/list', {}, 'Bearer nope')).error?.code === 401);
    ok('no token, no answer', (await call('room/list', {}, null)).error?.code === 401);
    ok('no token management', (await call('admin/createToken', { name: 'x', role: 'member', rooms: ['deal'] })).error?.code === 403);
    const preflight = await fetch(`${base}/api/room/list`, { method: 'OPTIONS' });
    ok('a browser may send the Authorization header (CORS)', /authorization/i.test(preflight.headers.get('access-control-allow-headers') || ''));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
