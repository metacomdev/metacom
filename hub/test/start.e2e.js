'use strict';
// /start in the web chat: three questions (the business, this week's goal, how strict), the team the
// business sounds like, then the one command to run where the agents should work, copied whole.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/start.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'start-web-'));
  const port = 29300 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const OWNER = 'sw-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ctx.newPage();
    await page.goto(`${base}/bakery`);
    await page.fill('#token', OWNER);
    await page.fill('#name', 'misha');
    await page.click('#loginBtn');
    await page.waitForSelector('#text');
    const type = async (text) => {
      await page.fill('#text', text);
      await sleep(200);
      if (await page.locator('#popup').isVisible().catch(() => false)) await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await sleep(500);
    };
    const body = () => page.evaluate(() => document.body.innerText);
    // each answer's next question, waited for rather than slept for
    const until = (re) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, { timeout: 8000 }).then(() => true, () => false);
    await type('/start');
    ok('question 1: the business', await until(/1\/3 What is your business/));
    await type('A marketing agency for restaurants in Lisbon');
    ok('question 2: the agency\'s own goal question, the team it picked named', (await until(/2\/3 What should the agency make this week, and for whom\?/)) && /team: agency/.test(await body()));
    await type('A spring menu campaign for Casa Verde');
    ok('question 3: how strict', await until(/3\/3 How strict/));
    await type('strict');
    const cmd = 'metacom start --template agency --business "A marketing agency for restaurants in Lisbon" --goal "A spring menu campaign for Casa Verde" --rigor strict --room bakery';
    await until(/metacom start --template agency/);
    ok('the command to run, whole', (await body()).includes(cmd), (await body()).slice(-600));
    await page.locator('button.copylink').last().click();
    ok('…copied as it is', (await page.evaluate(() => navigator.clipboard.readText())) === cmd);
    const said = await fetch(`${base}/health`).then(() => true);
    ok('nothing of it was posted to the room', said && !(await page.locator('.entry.message', { hasText: 'A marketing agency' }).count()));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
