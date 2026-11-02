'use strict';
// Several hubs in one chat: `metacom connect … --hub work` saves a second hub (`login`, the old name, still does: the third), the room list shows
// each hub's name and link above its rooms, and choosing a room on the other hub moves the chat there.
//   node test/hubs-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

const bin = path.join(__dirname, '..', 'bin', 'metacom.js');
const base = 18900 + Math.floor(Math.random() * 900);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubs-e2e-'));
let failed = 0;
const ok = (what, pass, detail = '') => {
  if (!pass) failed++;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}\n`);
};

const startHub = (port, token, extra = {}) => {
  const data = fs.mkdtempSync(path.join(dir, 'hub-'));
  return spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: data, HUB_OWNER_TOKEN: token, ...extra }, stdio: 'ignore' });
};

const main = async () => {
  const [pa, pb] = [base, base + 1];
  const [ta, tb] = ['hubs-a-' + Math.random().toString(36).slice(2), 'hubs-b-' + Math.random().toString(36).slice(2)];
  // hub A sits behind a tunnel: it says so with HUB_PUBLIC_URL, and the chat shows that address
  const hubs = [startHub(pa, ta, { HUB_PUBLIC_URL: 'https://a.example.test/' }), startHub(pb, tb)];
  await sleep(900);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), HOME: dir };
  const cli = (...args) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  try {
    cli('connect', `ws://127.0.0.1:${pa}`, ta);
    cli('connect', `ws://127.0.0.1:${pb}`, tb, '--hub', 'work');
    cli('login', 'ws://127.0.0.1:9', 'nobody-listens', '--hub', 'gone');
    const list = cli('hubs');
    ok('metacom hubs lists all three, the default first', /^local\s+http:\/\/127\.0\.0\.1:\d+\s+\(default\)\nwork\s+http:\/\/127\.0\.0\.1:\d+\ngone\s+http:\/\/127\.0\.0\.1:9\n$/.test(list), JSON.stringify(list));
    cli('hubs', 'rename', 'local', 'home');
    ok('hubs rename names the default hub', /^home\s+http.*\(default\)/.test(cli('hubs')));
    cli('hubs', 'rename', 'home', 'local');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.config', 'metacom-hub', 'config.json'), 'utf8'));
    ok('the default hub stays what agents use', cfg.url === `ws://127.0.0.1:${pa}/` && cfg.token === ta);

    // a room with an agent on the other hub
    const b = await connect({ url: `ws://127.0.0.1:${pb}/`, token: tb });
    await b.api.agents.register({ name: 'opsbot', room: 'ops', kind: 'agent' });

    const chat = spawnChat({ room: 'dev', name: 'ada', cols: 100, rows: 30, env: { HOME: dir } });
    try {
      await chat.wait(/message dev/, 8000);
      await chat.type('\x1b[D', 300);
      await chat.wait(/opsbot|ops\s+1\/1 online/, 8000);
      const view = chat.view().join('\n');
      if (process.env.DUMP) process.stdout.write(view + '\n----\n');
      ok('room list: this hub\'s public address (HUB_PUBLIC_URL) without the scheme and room count above its rooms', new RegExp(`(?<!/)a\\.example\\.test  2 rooms\\s*\\n\\s*\\n\\s+default`).test(view), view.split('\n').find((l) => l.includes('example.test')));
      ok('room list: the other hub\'s link, room count and rooms', new RegExp(`(?<!/)127\\.0\\.0\\.1:${pb}  2 rooms\\s*\\n[\\s\\S]*ops\\s+1/1 online`).test(view));
      await chat.wait(/(?<!\/)127\.0\.0\.1:9\s*\n\s*\n\s*not reachable/, 8000).then(() => ok('a hub that does not answer is listed as not reachable, the rest still work', true), (e) => ok('a hub that does not answer is listed as not reachable', false, e.message.slice(-400)));
      await chat.type('ops', 300);
      ok('typing ops: the room on work is chosen, "+ create ops" (here) is not', /›\s+ops\s+1\/1 online/.test(chat.dump()) && /^\s+\+ create ops/m.test(chat.dump()), chat.view().filter((l) => /ops/.test(l)).map((l) => l.trim()).join(' | '));
      await chat.type('\r', 300);
      await chat.wait(new RegExp(`message ops`), 8000);
      const members = await b.api.agents.list({});
      ok('choosing ops moves the chat to the work hub', members.some((m) => m.name === 'ada' && m.room === 'ops' && m.connected), JSON.stringify(members.map((m) => [m.name, m.room, m.connected])));
      await chat.type('\x1b[D', 300);
      await chat.wait(/a\.example\.test  \d+ rooms/, 8000);
      const again = chat.view().join('\n');
      ok('there, work is listed first and local below it, still by its public link', again.indexOf(`:${pb}  `) >= 0 && again.indexOf(`:${pb}  `) < again.indexOf('a.example.test  '));
    } finally {
      chat.kill();
    }
    b.m.close();
  } finally {
    for (const h of hubs) h.kill();
  }
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
