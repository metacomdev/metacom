'use strict';
// Owner approvals, end to end on a throwaway hub: an agent under the real wrapper runs
// `metacom request "push main" --wait`; the owner sees it in the web chat with approve / decline and
// taps approve; the agent's command exits 0 and the room records it. A second request is declined:
// exit 1. A member sees the request but no buttons, and the hub refuses its decision.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/approvals.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { connect } = require('../../cli/lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', '..', 'cli', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  const port = 29400 + Math.floor(Math.random() * 100);
  const base = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'ap-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const owner = await connect({ url, token: OWNER });
  const { token } = await owner.api.admin.createToken({ name: 'builder', role: 'agent', rooms: ['dev'] });
  const member = await owner.api.admin.createToken({ name: 'alen', role: 'member', rooms: ['dev'], steer: 'answer', agents: true });
  const out = path.join(dir, 'out.txt');
  // the agent's session: two requests, each waited for, the exit codes written down
  const script = `${process.execPath} ${MC} request "push main to origin" --detail "3 commits, tests green" --wait; echo "first=$?" >> ${out}; ${process.execPath} ${MC} request "publish the release" --wait; echo "second=$?" >> ${out}; sleep 60`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: fs.mkdtempSync(path.join(dir, 'home-')), MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT_TOKEN: token };
  const agent = spawn(process.execPath, [MC, 'dev', '-n', 'builder', '--', 'sh', '-c', script], { env, stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    const signIn = async (tok, name) => {
      const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
      await page.goto(`${base}/dev`);
      await page.fill('#token', tok);
      await page.fill('#name', name);
      await page.click('#loginBtn');
      await page.waitForSelector('#text');
      return page;
    };
    const misha = await signIn(OWNER, 'misha');
    const alen = await signIn(member.token, 'alen');
    await misha.waitForSelector('.entry.request', { timeout: 20000 });
    const card = (await misha.textContent('.entry.request')) || '';
    ok('the owner sees the request: who, what, the detail, its id', /builder/.test(card) && /push main to origin/.test(card) && /3 commits, tests green/.test(card) && /request [0-9a-f]{8}/.test(card), card);
    ok('…with approve and decline', (await misha.locator('.entry.request button.approve').count()) === 1 && (await misha.locator('.entry.request button.decline').count()) === 1);
    await alen.waitForSelector('.entry.request', { timeout: 10000 });
    const seen = await alen.textContent('.entry.request');
    ok('a member sees it, without the buttons', (await alen.locator('.entry.request button.approve, .entry.request button.decline').count()) === 0 && /waiting for the owner/.test(seen), `${await alen.locator('.entry.request button').count()} buttons · ${seen}`);
    const rid = /request ([0-9a-f]{8})/.exec(card)[1];
    const alenHub = await connect({ url, token: member.token });
    ok('the hub refuses a member\'s decision', /Only the hub owner/.test(await alenHub.api.agents.decide({ id: rid, approve: true }).then(() => 'decided', (e) => e.message)));
    alenHub.m.close();

    await misha.click('.entry.request button.approve');
    for (let i = 0; i < 40 && !(fs.existsSync(out) && /first=/.test(fs.readFileSync(out, 'utf8'))); i++) await sleep(250);
    ok('approved: the agent\'s request --wait exits 0', /first=0/.test(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''), fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'no output');
    ok('the request line now shows it approved by misha', await misha.waitForFunction((id) => [...document.querySelectorAll('.entry.request')].some((e) => e.textContent.includes(id) && /approved by misha/.test(e.textContent)), rid, { timeout: 8000 }).then(() => true, () => false));
    const log = (await owner.api.room.history({ room: 'dev', limit: 50 })).map((m) => m.text);
    ok('the room records it', log.some((t) => t === `misha approved "push main to origin" (request ${rid})`), log.join(' | '));

    // the second: declined
    await misha.waitForFunction(() => [...document.querySelectorAll('.entry.request')].some((e) => /publish the release/.test(e.textContent) && e.querySelector('button.decline')), null, { timeout: 15000 });
    await misha.locator('.entry.request', { hasText: 'publish the release' }).locator('button.decline').click();
    for (let i = 0; i < 40 && !/second=/.test(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''); i++) await sleep(250);
    ok('declined: request --wait exits 1', /second=1/.test(fs.readFileSync(out, 'utf8')), fs.readFileSync(out, 'utf8'));

    // routine ones, batched: "approve all 2 routine", and /approvals lists what still waits
    const t2 = await owner.api.admin.createToken({ name: 'tester', role: 'agent', rooms: ['dev'] });
    const tester = await connect({ url, token: t2.token });
    await tester.api.agents.register({ name: 'tester', room: 'dev' });
    const r1 = await tester.api.agents.request({ room: 'dev', action: 'restart the preview server', risk: 'routine' });
    const r2 = await tester.api.agents.request({ room: 'dev', action: 'rerun the nightly build', risk: 'routine' });
    const r3 = await tester.api.agents.request({ room: 'dev', action: 'delete the old staging data', risk: 'irreversible' });
    const all = misha.locator('button.approveall').first();
    await all.waitFor({ timeout: 10000 });
    ok('two routine requests offer "approve all 2 routine"', /approve all 2 routine/.test(await all.textContent()), await all.textContent());
    ok('the irreversible one is marked so', /irreversible/.test(await misha.locator('.entry.request', { hasText: 'delete the old staging data' }).textContent()));
    await all.click();
    const status = async (rid) => (await owner.api.agents.requestStatus({ id: rid })).status;
    for (let i = 0; i < 20 && (await status(r2.id)) !== 'approved'; i++) await sleep(250);
    ok('…which approves both routine ones', (await status(r1.id)) === 'approved' && (await status(r2.id)) === 'approved');
    ok('…and leaves the irreversible one to decide on its own', (await status(r3.id)) === 'open');
    await misha.fill('#text', '/approvals');
    await misha.keyboard.press('Escape');
    await misha.keyboard.press('Enter');
    ok('/approvals lists what still waits, by room', await misha.waitForFunction((id) => document.body.innerText.includes(`dev · ${id} · tester (irreversible): delete the old staging data`), r3.id, { timeout: 8000 }).then(() => true, () => false));
    tester.m.close();
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    agent.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
