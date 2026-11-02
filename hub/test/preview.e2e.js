'use strict';
// /preview in the web chat, on a throwaway hub: a picture posted in dev and in opn shows in the feed;
// "/preview off" in dev leaves only its ↗ link there while opn still shows it; "/preview off all"
// hides it everywhere, a reload keeps that; "/preview on" brings dev's back. "/preview off hub" (the
// owner) turns them off for everyone at once, live; a member's own "/preview on" still wins on their
// device, and a member cannot change the hub's.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/preview.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'));
  const port = 28400 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const OWNER = 'pv-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, PNG);
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    await page.goto(`${base}/dev`);
    await page.fill('#token', OWNER);
    await page.fill('#name', 'misha');
    await page.click('#loginBtn');
    await page.waitForSelector('#text');
    const type = async (text) => {
      await page.fill('#text', text);
      await sleep(200);
      // the command list, if open, closed first (esc on a line with no list would clear it)
      if (await page.locator('#popup').isVisible().catch(() => false)) await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await sleep(400);
    };
    const post = async () => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#attachBtn')]);
      await chooser.setFiles(png);
      await page.waitForFunction(() => document.getElementById('text').value.includes('[shot.png]'));
      await page.keyboard.press('Enter');
      await page.waitForSelector('a.file', { timeout: 8000 });
    };
    const shown = () => page.locator('.picture img').count();
    const linked = () => page.locator('a.file').count();
    // a room by its address, signed in already
    const room = async (name) => {
      await page.goto(`${base}/${name}`);
      await page.waitForSelector('#text');
      await sleep(800);
    };
    await post();
    await room('opn');
    await post();
    ok('a picture shows in the feed', (await shown()) === 1);
    await room('dev');
    ok('…in dev too', (await shown()) === 1);

    await type('/preview off');
    ok('"/preview off": dev shows only its ↗ link', (await shown()) === 0 && (await linked()) === 1);
    ok('…and says so', /dev: only their ↗ links/.test(await page.textContent('body')));
    await room('opn');
    ok('…opn still shows its picture', (await shown()) === 1);

    await type('/preview off all');
    ok('"/preview off all": opn too', (await shown()) === 0 && (await linked()) === 1);
    await page.reload();
    await page.waitForSelector('#text');
    await sleep(800);
    ok('…kept over a reload', (await shown()) === 0 && (await linked()) === 1);

    await room('dev');
    await type('/preview on');
    ok('"/preview on" brings dev\'s back', (await shown()) === 1);
    await type('/preview');
    ok('"/preview" says how it is', /previews in dev: pictures and videos shown/.test(await page.textContent('body')));

    // the hub's default, for everyone: a member's page, open already, follows it live
    const { connect } = require('../../cli/lib/client.js');
    const owner = await connect({ url: `ws://127.0.0.1:${port}/`, token: OWNER });
    const member = await owner.api.admin.createToken({ name: 'karl', role: 'member', rooms: ['dev'] });
    owner.m.close();
    const kp = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    await kp.goto(`${base}/dev`);
    await kp.fill('#token', member.token);
    await kp.fill('#name', 'karl');
    await kp.click('#loginBtn');
    await kp.waitForSelector('#text');
    await kp.waitForSelector('.picture img', { timeout: 8000 }).catch(() => {});
    ok('karl sees the picture', (await kp.locator('.picture img').count()) === 1);
    await type('/preview off hub');
    ok('"/preview off hub": gone from karl\'s feed at once, its link kept', await kp.waitForFunction(() => !document.querySelector('.picture img') && document.querySelector('a.file'), null, { timeout: 8000 }).then(() => true, () => false));
    await kp.reload();
    await kp.waitForSelector('#text');
    await sleep(800);
    ok('…and for whoever opens the hub after', (await kp.locator('.picture img').count()) === 0);
    await kp.fill('#text', '/preview off hub');
    await kp.keyboard.press('Enter');
    ok('karl cannot change the hub\'s', await kp.waitForFunction(() => /owners only · your token has the member role/.test(document.body.innerText), null, { timeout: 8000 }).then(() => true, () => false));
    await kp.fill('#text', '/preview on');
    await kp.keyboard.press('Enter');
    await sleep(500);
    ok('karl\'s own "/preview on" wins on his device', (await kp.locator('.picture img').count()) === 1);
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
