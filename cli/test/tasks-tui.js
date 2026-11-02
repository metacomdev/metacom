// Task lists and edits in the terminal chat: boxes are shown, and ticked by a click in the input only, an
// edited message moves to the bottom marked "edited", and ⋯ shows its versions.
//   node test/tasks-tui.js
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
(async () => {
  const port = 25000 + Math.floor(Math.random() * 4000);
  const dir = fs.mkdtempSync('/tmp/tasks-tui-');
  const OWNER = 'tasks-owner-token-0123456789abc', AGENT = 'tasks-agent-token-0123456789abc';
  const hubProc = spawn(process.execPath, [require('node:path').join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir + '/hub', HUB_OWNER_TOKEN: OWNER, HUB_AGENT_TOKEN: AGENT }, stdio: 'ignore' });
  const ok = (w, c, d = '') => console.log(`${c ? 'PASS' : 'FAIL'} ${w}${d ? ' — ' + d : ''}`);
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const url = `ws://127.0.0.1:${port}/`;
    const owner = await connect({ url, token: OWNER });
    const c = spawnChat({ room: 'dev', name: 'misha', cols: 100, rows: 36, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: OWNER } });
    await c.wait(/message dev/, 15000);
    await c.paste('Launch plan:\n- [ ] page live\n- [ ] email to the list');
    await sleep(300);
    ok('the input shows the task lines', /- \[ \] page live/.test(c.dump()));
    // a click on a box in the input ticks it, and again unticks it; elsewhere it does nothing
    const inRow = () => c.view().findIndex((l) => /│ +(❯ )? *- \[[ x]\] page live/.test(l));
    const press = async (row, col) => c.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`, 500);
    let ir = inRow();
    await press(ir, c.view()[ir].indexOf('- [') + 3);
    ok('a click on the box in the input ticks it', /- \[x\] page live/.test(c.view()[inRow()]), c.view()[inRow()].trim());
    ir = inRow();
    await press(ir, c.view()[ir].indexOf('- [') + 2);
    ok('again unticks it', /- \[ \] page live/.test(c.view()[inRow()]));
    ir = inRow();
    await press(ir, c.view()[ir].indexOf('page live') + 3);
    ok('a click on the text beside it changes nothing', /- \[ \] page live/.test(c.view()[inRow()]));
    await c.type('\r', 1000);
    await c.wait(/\[ \] email to the list/);
    const lead = await connect({ url, token: AGENT });
    await lead.api.agents.register({ name: 'lead', room: 'dev' });
    await lead.api.room.say({ room: 'dev', text: 'On it.' });
    await c.wait(/On it\./);
    const rows = () => c.view();
    const rowOf = (re) => rows().findIndex((l) => re.test(l));
    const click = async (row, col) => c.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`, 700);
    // a box in a message is shown, not pressed: a click does nothing; the owner edits through the hub
    const r = rowOf(/\[ \] email to the list/);
    await click(r, rows()[r].indexOf('[') + 1);
    await sleep(500);
    const before = (await owner.api.room.history({ room: 'dev', limit: 10 })).find((x) => /Launch plan/.test(x.text));
    ok('a click on a box in a message changes nothing', !before.rev);
    await owner.api.agents.register({ name: 'misha', room: 'dev', kind: 'human' }); // its author, as the chat
    await owner.api.room.edit({ id: before.id, text: before.text.replace('- [ ] email', '- [x] email') });
    await sleep(800);
    const h = await owner.api.room.history({ room: 'dev', limit: 10 });
    const m = h.find((x) => /Launch plan/.test(x.text));
    ok('the edit is saved', m && m.rev === 2 && /- \[x\] email to the list/.test(m.text), m && `v${m.rev}`);
    const v = rows();
    const at = v.findIndex((l) => /\[x\] email to the list/.test(l));
    const on = v.findIndex((l) => /On it\./.test(l));
    ok('the new version is at the bottom, the old place gone', at > on && v.filter((l) => /email to the list/.test(l)).length === 1);
    ok('"edited", no /history', v.some((l) => /misha +\d\d:\d\d +edited$/.test(l.trim()) || /misha  \d\d:\d\d  edited/.test(l)) && !v.some((l) => /\/history/.test(l)), v.find((l) => /edited/.test(l)));
    const act = v.map((l, i) => [l, i]).filter(([l]) => l.includes('↩ reply')).at(-1)[1];
    await click(act, v[act].indexOf('⋯'));
    await c.wait(/≡ versions/);
    ok('⋯ offers versions', true, rows()[act].trim());
    await click(act, rows()[act].indexOf('≡ versions'));
    await c.wait(/versions of/);
    ok('⋯ → versions shows them', /v1 · .*page live/.test(c.dump()) || /v1 ·/.test(c.dump()));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], c.dump());
    c.kill(); lead.m.close(); owner.m.close();
  } finally { hubProc.kill(); }
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message.slice(0, 2500)); process.exit(1); });
