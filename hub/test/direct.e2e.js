'use strict';
// /direct (was /live), on a throwaway hub with real agents: the owner opens an agent's terminal with
// "@builder /direct", "/direct builder" and the old "/live builder", the bar says "direct"; a user
// (invited, with an agent of its own) is told "boclaude isn't yours: ask its owner" on someone
// else's agent, and "@alenclaude /kill" stops its own (its process ends).
//   PLAYWRIGHT=<path to node_modules/playwright> node test/direct.e2e.js [dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { connect } = require('../../cli/lib/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MC = path.join(__dirname, '..', '..', 'cli', 'bin', 'metacom.js');

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'direct-'));
  const port = 29630 + Math.floor(Math.random() * 40);
  const base = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/`;
  const OWNER = 'di-owner-token-0123456789abcdef';
  let failed = 0;
  const ok = (what, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${!cond && detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
  };
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: OWNER }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
  const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_')));
  const owner = await connect({ url, token: OWNER });
  const procs = [];
  const agent = (home, name) => {
    const p = spawn(process.execPath, [MC, 'opn', '-n', name, '--', 'sh', '-c', 'echo ready; sleep 120'], { env: { ...env0, HOME: home }, stdio: 'ignore' });
    procs.push(p);
    return new Promise((r) => p.on('exit', () => r(true)));
  };
  const online = async (name) => {
    for (let i = 0; i < 40; i++) {
      if ((await owner.api.agents.list({ room: 'opn' })).some((m) => m.name === name && m.connected)) return true;
      await sleep(250);
    }
    return false;
  };
  const browser = await chromium.launch();
  try {
    // the owner's agent (its own token, made by the wrapper), and two users with an agent each
    const ohome = fs.mkdtempSync(path.join(dir, 'owner-'));
    spawnSync(process.execPath, [MC, 'connect', url, OWNER], { env: { ...env0, HOME: ohome } });
    agent(ohome, 'builder');
    const users = {};
    for (const n of ['alen', 'bo']) {
      const t = await owner.api.admin.createToken({ name: n, role: 'member', rooms: ['opn'], steer: 'answer', agents: true });
      const home = fs.mkdtempSync(path.join(dir, `${n}-`));
      spawnSync(process.execPath, [MC, 'connect', url, t.token], { env: { ...env0, HOME: home } });
      users[n] = { token: t.token, exited: agent(home, `${n}claude`) };
    }
    ok('the agents are up', (await online('builder')) && (await online('alenclaude')) && (await online('boclaude')));

    const signIn = async (token, name) => {
      const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
      await page.goto(`${base}/opn`);
      await page.fill('#token', token);
      await page.fill('#name', name);
      await page.click('#loginBtn');
      await page.waitForSelector('#text');
      return page;
    };
    const type = async (page, text) => {
      await page.fill('#text', text);
      await page.keyboard.press('Enter');
    };
    const opens = async (page) => {
      const bar = await page.waitForSelector('#livebar', { timeout: 10000 }).then(() => page.textContent('#livebar'), () => '');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#livebar', { state: 'detached', timeout: 10000 }).catch(() => {});
      return bar;
    };
    const misha = await signIn(OWNER, 'misha');
    await type(misha, '@builder /direct');
    const bar = await opens(misha);
    ok('"@builder /direct" opens its terminal, the bar says direct', /builder/.test(bar) && /direct ·/.test(bar) && !/live ·/.test(bar), bar);
    await type(misha, '/direct builder');
    ok('"/direct builder" too', /direct ·/.test(await opens(misha)));
    await type(misha, '@builder ');
    ok('"@builder" alone and enter opens its terminal too', /direct ·/.test(await opens(misha)));
    await type(misha, '/direct @builder');
    ok('"/direct @builder" too', /direct ·/.test(await opens(misha)));
    // the agents are offered after "/direct "
    await misha.fill('#text', '/direct bu');
    await misha.waitForTimeout(400);
    const offered = await misha.textContent('#popup');
    ok('"/direct bu" offers the agent', /builder/.test(offered), offered);
    await misha.keyboard.press('Tab');
    ok('…taking it fills in the name, no @', (await misha.inputValue('#text')) === '/direct builder ', await misha.inputValue('#text'));
    await misha.keyboard.press('Enter');
    ok('…and enter opens it', /direct ·/.test(await opens(misha)));
    await type(misha, '/live builder');
    ok('"/live builder", the old name, still does', /direct ·/.test(await opens(misha)));
    // the command list opens on "/help": esc closes it, enter then runs it
    await misha.fill('#text', '/help');
    await misha.keyboard.press('Escape');
    await misha.keyboard.press('Enter');
    await misha.waitForFunction(() => /commands/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {});
    const help = await misha.evaluate(() => document.body.innerText);
    ok('help lists /direct, not /live', /\/direct <agent>/.test(help) && !/\/live <name>/.test(help));

    const alen = await signIn(users.alen.token, 'alen');
    await type(alen, '@boclaude /direct');
    ok('alen on bo\'s agent: "isn\'t yours"', await alen.waitForFunction(() => /boclaude isn't yours: ask its owner/.test(document.body.innerText), null, { timeout: 8000 }).then(() => true, () => false));
    const before = (await owner.api.room.history({ room: 'opn', limit: 100 })).length;
    await type(alen, '@boclaude ');
    ok('"@boclaude" alone, not his: the hint, no empty message', await alen.waitForFunction(() => (document.body.innerText.match(/boclaude isn't yours/g) || []).length >= 1, null, { timeout: 8000 }).then(() => true, () => false) && !(await owner.api.room.history({ room: 'opn', limit: 100 })).slice(before).some((m) => m.from && m.from.name === 'alen' && m.to === 'boclaude'));
    await type(alen, '@alenclaude ');
    ok('"@alenclaude" alone opens his own', /alenclaude/.test(await opens(alen)));
    await type(alen, '@alenclaude /direct');
    ok('alen opens his own', /alenclaude/.test(await opens(alen)));
    await type(alen, '/kill @boclaude');
    ok('"/kill @boclaude": not his either', await alen.waitForFunction(() => (document.body.innerText.match(/boclaude isn't yours/g) || []).length >= 2, null, { timeout: 8000 }).then(() => true, () => false));
    await type(alen, '@alenclaude /kill');
    ok('"@alenclaude /kill" stops his own: the process ends', await Promise.race([users.alen.exited, sleep(12000).then(() => false)]));
    ok('…bo\'s goes on', await online('boclaude'));
  } catch (e) {
    ok('ran', false, e.stack);
  } finally {
    await browser.close();
    for (const p of procs) p.kill();
    owner.m.close();
    hub.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
