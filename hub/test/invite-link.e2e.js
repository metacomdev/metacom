'use strict';
// /invite and its link, end to end on a throwaway hub: the owner types `/invite johntoken` in room
// opn and gets the link copied; the link opened on a phone (WebKit) asks only a name, takes the token
// out of the address, shows the three agent steps with this hub and token filled in, and joins as a
// user; a second person joins with the same link under another name; one of them brings an agent with
// the real CLI on that token; `/invite johntoken + trade` widens it; other rooms stay closed.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/invite-link.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT || 'playwright');
const { connect } = require('../../cli/lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'token-invite-'));
  const port = 29300 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const OWNER = 'ti-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url: `ws://127.0.0.1:${port}/`, token: OWNER });
  await owner.api.agents.register({ name: 'misha', room: 'dev', kind: 'human' });
  await owner.api.room.say({ room: 'dev', text: 'private dev talk' });
  const browsers = [];
  let agent = null;
  try {
    // the owner, in room opn, issues the token
    const b1 = await chromium.launch();
    browsers.push(b1);
    const ctx = await b1.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await ctx.newPage();
    await page.goto(`${base}/opn`);
    await page.fill('#token', OWNER);
    await page.fill('#name', 'misha');
    await page.click('#loginBtn');
    await page.waitForSelector('#text');
    await page.fill('#text', '/invite johntoken');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tokenlink', { timeout: 8000 });
    const link = await page.evaluate(() => navigator.clipboard.readText());
    ok('/invite gives a link to this room, copied', new RegExp(`^${base}/opn/invite/[\\w-]{20,}$`).test(link), link);
    ok('…said in green', /Invite link copied/.test(await page.textContent('body')));
    const token = link.split('/invite/')[1];
    const shownLink = (await page.textContent('.tokenlink')).trim();
    ok('the owner\'s screen shows the token masked, never whole', shownLink.endsWith(`${token.slice(0, 6)}…••••…${token.slice(-4)}`) && !(await page.content()).includes(token), shownLink);
    ok('…marked as the owner\'s alone', /invite johntoken · only you see this/.test(await page.textContent('body')));
    const shots = process.env.SHOTS;
    if (shots) await page.screenshot({ path: path.join(shots, 'token-owner.png') });

    // a person opens it on a phone
    const b2 = await webkit.launch();
    browsers.push(b2);
    const phone = await (await b2.newContext({ ...devices['iPhone 13'] })).newPage();
    await phone.goto(link);
    await phone.waitForSelector('#login.invite', { timeout: 8000 });
    ok('the token leaves the address at once', new URL(phone.url()).pathname === '/opn', phone.url());
    ok('only a name is asked', (await phone.$('#token')) === null && (await phone.isVisible('#name')));
    await phone.fill('#name', 'alen');
    if (shots) await phone.screenshot({ path: path.join(shots, 'token-invite-phone.png') });
    const steps = await phone.textContent('.steps');
    const mask = `${token.slice(0, 6)}…••••…${token.slice(-4)}`;
    ok('the three agent steps, this hub filled in, the token masked', steps.includes('curl -fsSL https://metacom.dev/install.sh | sh') && steps.includes(`metacom connect ws://127.0.0.1:${port} ${mask}`) && steps.includes('metacom opn -n alenclaude claude'), steps);
    ok('the whole token is nowhere in the invite page (text, attributes)', !(await phone.content()).includes(token));
    await phone.tap('#loginBtn');
    await phone.waitForSelector('#text', { timeout: 10000 });
    const head = await phone.textContent('body');
    ok('alen is in opn, as a user', /opn/.test(head) && /alen/.test(head) && /\(user\)/.test(head), head.slice(0, 300));
    ok('the owner\'s invite block is not in the room for others', !/invite johntoken|only you see this|\/revoke johntoken/.test(head));
    ok('the steps stay in the feed for later', /bring your own agent/.test(head));
    ok('…masked there too', head.includes(mask) && !(await phone.content()).includes(token));

    // a second person, same link, own name
    const thirdCtx = await b1.newContext();
    await thirdCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const third = await thirdCtx.newPage();
    await third.goto(link);
    await third.fill('#name', 'bo');
    // copy on the masked step puts the whole command on the clipboard
    await third.locator('.step').nth(1).locator('button.copylink').click();
    ok('copy gives the whole command, real token', (await third.evaluate(() => navigator.clipboard.readText())) === `metacom connect ws://127.0.0.1:${port} ${token}`);
    await third.click('#loginBtn');
    await third.waitForSelector('#text', { timeout: 10000 });
    const members = await owner.api.agents.list({ room: 'opn' });
    ok('two people on one token, each under their own name', ['alen', 'bo'].every((n) => members.some((m) => m.name === n && m.connected)), JSON.stringify(members.map((m) => m.name)));

    // alen's agent, with the real CLI on that token
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    agent = spawn(process.execPath, [path.join(__dirname, '..', '..', 'cli', 'bin', 'metacom.js'), 'opn', '-n', 'alenclaude', '--', 'sh', '-c', 'sleep 60'], { env: { ...process.env, HOME: home, MC_HUB_URL: `ws://127.0.0.1:${port}/`, MC_TOKEN: token }, stdio: 'ignore' });
    let joined = null;
    for (let i = 0; i < 40 && !joined; i++) {
      await sleep(250);
      joined = (await owner.api.agents.list({ room: 'opn' })).find((m) => m.name === 'alenclaude' && m.kind === 'agent' && m.connected);
    }
    ok('alen\'s agent joins opn on the same token', Boolean(joined));

    // what the token cannot do
    const as = await connect({ url: `ws://127.0.0.1:${port}/`, token });
    const dev = await as.api.room.history({ room: 'dev', limit: 5 }).then((r) => JSON.stringify(r), (e) => e.message);
    ok('other rooms stay closed', !/private dev talk/.test(dev), dev);
    const mint = await as.api.admin.createToken({ name: 'x', role: 'member' }).then(() => 'minted', (e) => e.message);
    ok('no tokens of its own', mint !== 'minted', mint);
    as.m.close();

    // the owner widens it
    await page.fill('#text', '/invite johntoken + trade');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /johntoken now works in opn, trade/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    const t = (await owner.api.admin.tokens({})).find((x) => x.name === 'johntoken');
    ok('/invite johntoken + trade widens it', t && t.rooms.join(',') === 'opn,trade' && t.bringsAgents && t.steer === 'answer', JSON.stringify(t));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    if (agent) agent.kill();
    for (const b of browsers) await b.close();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
