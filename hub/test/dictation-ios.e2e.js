'use strict';
// iOS dictation in the web chat: dictated words show in the box before any input event, and the page
// must not write its last known text back over them when something else re-renders it (a message
// arriving, an agent's status). WebKit with an iPhone viewport: words put into the box the way
// dictation does (no input event), then a message arrives in the room; the words are still there.
// Typing, sending (the box empties) and a chosen @name (text set by the page) still work.
//   PLAYWRIGHT=<path to node_modules/playwright> node test/dictation-ios.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { webkit, devices } = require(process.env.PLAYWRIGHT || 'playwright');
const { connect } = require('../../cli/lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-ios-'));
  const port = 29200 + Math.floor(Math.random() * 300);
  const OWNER = 'dict-owner-token-0123456789abcdef';
  const AGENT = 'dict-agent-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + detail : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const agent = await connect({ url: `ws://127.0.0.1:${port}/`, token: AGENT });
  await agent.api.agents.register({ name: 'builder', room: 'dev' });
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
    await page.goto(`http://127.0.0.1:${port}/dev`);
    await page.fill('#token', OWNER);
    await page.fill('#name', 'misha');
    await page.tap('#loginBtn');
    await page.waitForSelector('#text', { timeout: 10000 });
    await sleep(800);
    const box = () => page.$eval('#text', (t) => t.value);

    // dictation: words land in the box with no input event yet
    await page.$eval('#text', (t) => {
      t.focus();
      t.value = 'please check the deploy logs';
    });
    // something else re-renders the page meanwhile: a message, an agent's status
    await agent.api.room.say({ room: 'dev', text: 'status: build green' });
    await agent.api.agents.status({ status: 'working', reason: 'build' });
    await page.waitForFunction(() => document.body.innerText.includes('build green'), null, { timeout: 5000 });
    await sleep(500);
    ok('dictated words survive a re-render', (await box()) === 'please check the deploy logs', JSON.stringify(await box()));

    // dictation ends: the input event comes; then send, and the box empties
    await page.$eval('#text', (t) => t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' logs' })));
    await page.locator('#text').press('Enter');
    let said = null;
    for (let i = 0; i < 30 && !said; i++) {
      await sleep(200);
      said = (await agent.api.room.history({ room: 'dev', limit: 10 })).find((m) => m.from && m.from.name === 'misha' && /deploy logs/.test(m.text));
    }
    ok('the dictated message is sent', Boolean(said));
    ok('…and the box is empty after sending', (await box()) === '', JSON.stringify(await box()));

    // typing as ever, and an @name picked from the list (the page sets the text)
    await page.locator('#text').focus();
    await page.keyboard.type('@bui');
    await page.waitForSelector('#popup, .popup', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Tab');
    await sleep(300);
    ok('an @name picked from the list goes into the box', /^@builder /.test(await box()), JSON.stringify(await box()));
    await page.keyboard.type('run the tests');
    ok('typing after it keeps both', (await box()) === '@builder run the tests', JSON.stringify(await box()));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    agent.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
