'use strict';
// The web chat on a phone (WebKit, as iOS Safari, iPhone viewport and touch): the paperclip opens the
// file picker, a PDF chosen there goes into the message as its token and reaches the room as an
// attachment. iOS gives a page no files on paste, so on a phone this button is the way in. On a
// desktop (Chromium, a mouse) the same paperclip, the same way.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/attach-ios.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { webkit, chromium, devices } = require(process.env.PLAYWRIGHT || 'playwright');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'attach-ios-'));
  const port = 28900 + Math.floor(Math.random() * 500);
  const OWNER = 'ios-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const pdf = path.join(dir, 'report 10x.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
    await page.goto(`http://127.0.0.1:${port}/dev`);
    await page.fill('#token', OWNER);
    await page.fill('#name', 'misha');
    await page.tap('#loginBtn');
    await page.waitForSelector('#text', { timeout: 10000 });
    const btn = page.locator('#attachBtn');
    ok('the paperclip is there on a phone', await btn.isVisible() && (await btn.locator('svg.clip').count()) === 1);
    const box = await btn.boundingBox();
    ok('…a finger-sized target', box && box.height >= 44, JSON.stringify(box));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), btn.tap()]);
    ok('a tap opens the file picker', Boolean(chooser));
    await chooser.setFiles(pdf);
    await page.waitForFunction(() => document.getElementById('text').value.includes('[report 10x.pdf]'), null, { timeout: 5000 });
    ok('the PDF goes into the message as its token', true);
    await page.locator('#text').focus();
    await page.keyboard.type('the 10x report');
    await page.keyboard.press('Enter');
    let msg = null;
    for (let i = 0; i < 40 && !msg; i++) {
      await sleep(250);
      const log = path.join(dir, 'hub', 'rooms', 'dev.jsonl');
      if (fs.existsSync(log)) msg = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => Array.isArray(m.media) && m.media.length);
    }
    ok('it reaches the room as a PDF attachment', msg && msg.media[0].type === 'application/pdf' && msg.media[0].name === 'report 10x.pdf', JSON.stringify(msg));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'attach-phone.png') });

    // a desktop: the same paperclip, a click opens the picker
    const desk = await chromium.launch();
    try {
      const dp = await (await desk.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
      await dp.goto(`http://127.0.0.1:${port}/dev`);
      await dp.fill('#token', OWNER);
      await dp.fill('#name', 'misha');
      await dp.click('#loginBtn');
      await dp.waitForSelector('#text', { timeout: 10000 });
      const db = dp.locator('#attachBtn');
      ok('the same paperclip on a desktop, the icon alone', (await db.isVisible()) && (await db.locator('svg.clip').count()) === 1 && (await db.innerText()).trim() === '', await db.innerText());
      const [dc] = await Promise.all([dp.waitForEvent('filechooser', { timeout: 5000 }), db.click()]);
      ok('…a click opens the file picker', Boolean(dc));
      await dc.setFiles(pdf);
      ok('…and the file goes into the message', await dp.waitForFunction(() => document.getElementById('text').value.includes('[report 10x.pdf]'), null, { timeout: 5000 }).then(() => true, () => false));
      if (process.env.SHOTS) await dp.screenshot({ path: path.join(process.env.SHOTS, 'attach-desktop.png') });
    } finally {
      await desk.close();
    }
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
