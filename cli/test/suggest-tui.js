'use strict';
// Suggested replies in the terminal chat: the suggestions waiting for you form a queue, oldest first,
// each shown in the empty input as "@sender suggestion · tab" (a checklist: its first line and how
// many items); Enter does not send it, Tab takes it, the reply answers that message (never with the
// suggestion); Esc dismisses it for good (on the hub) and offers the next; the counter under the input goes to the message offered.
//   node test/suggest-tui.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-tui-'));
  const port = 25000 + Math.floor(Math.random() * 4000);
  const O = 'st-owner-token-0123456789abcdef', A = 'st-agent-token-0123456789abcdef';
  const hubProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: path.join(dir, 'hub'), HUB_OWNER_TOKEN: O, HUB_AGENT_TOKEN: A }, stdio: 'ignore' });
  let fails = 0;
  const ok = (w, c, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${w}${d ? ' — ' + d : ''}`); };
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100);
    const url = `ws://127.0.0.1:${port}/`;
    const builder = await connect({ url, token: A });
    await builder.api.agents.register({ name: 'builder', room: 'dev' });
    await builder.api.agents.status({ status: 'waiting', reason: 'idle' });
    const got = [];
    builder.api.agents.on('message', (m) => got.push(m));
    const c = spawnChat({ room: 'dev', name: 'misha', cols: 110, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: O } });
    await c.wait(/message dev/, 15000);
    const inputLine = () => c.view().find((l) => /│ ❯ /.test(l)) || '';
    const replyRowOf = (re) => {
      const v = c.view();
      const at = v.findIndex((l) => re.test(l));
      return v.findIndex((l, i) => i > at && l.includes('↩ reply'));
    };
    const clickReply = async (re) => {
      const r = replyRowOf(re);
      const col = c.view()[r].indexOf('↩') + 2;
      await c.type(`\x1b[<0;${col};${r + 1}M\x1b[<0;${col};${r + 1}m`, 600);
    };
    const ask = await builder.api.agents.send({ to: 'misha', text: 'Tests are green. Ship 0.2 now?', kind: 'info', suggest: 'yes, ship it', keepOlder: true });
    await c.wait(/Ship 0\.2 now\?/);
    await sleep(400);
    ok('no click: the input shows "@builder yes, ship it · tab"', inputLine().includes('@builder yes, ship it · tab'), inputLine().trim());
    await c.type('\r', 600);
    ok('Enter on the untouched ghost sends nothing', got.length === 0);
    await c.type('\t', 400);
    ok('Tab takes it as text, without the hint', inputLine().includes('@builder yes, ship it') && !inputLine().includes('· tab'));
    await c.type('\r', 1000);
    const sent = got.at(-1);
    ok('Enter sends it, a reply to that message, without the suggestion', sent && sent.text === 'yes, ship it' && sent.replyTo === ask.id && sent.suggest === undefined, JSON.stringify(sent && { text: sent.text, replyTo: sent.replyTo }));
    await sleep(300);
    ok('answered: the placeholder is gone', !inputLine().includes('yes, ship it'), inputLine().trim());
    // a queue, oldest first; a checklist shows its first line and how many items
    await builder.api.agents.send({ to: 'misha', text: 'Tag it v0.2.0?', kind: 'info', suggest: 'tag v0.2.0', keepOlder: true });
    await sleep(200);
    await builder.api.agents.send({ to: 'misha', text: 'Which steps?', kind: 'info', suggest: 'do these:\n- [x] tests\n- [ ] notes', keepOlder: true });
    await c.wait(/Which steps\?/);
    await sleep(400);
    const counter = () => c.view().find((l) => /waiting for reply/.test(l)) || '';
    ok('the oldest first', inputLine().includes('@builder tag v0.2.0 · tab'), inputLine().trim());
    ok('counter "1/2 waiting for reply"', counter().includes('1/2 waiting for reply'), counter().trim());
    await c.type('\x1b', 600);
    ok('Esc dismisses it: the next, the checklist, first line + (+2 items)', inputLine().includes('@builder do these: (+2 items) · tab'), inputLine().trim());
    ok('counter "1/1": the dismissed one left the queue', counter().includes('1/1 waiting for reply'), counter().trim());
    await c.type('n', 300);
    ok('typing hides it', /❯ n\b/.test(inputLine()));
    await c.type('\x7f', 400);
    ok('…and it is back when the input is empty', inputLine().includes('(+2 items)'));
    await c.type('\t', 500);
    ok('Tab: real checkbox lines in the input', c.view().some((l) => /│ +- \[x\] tests/.test(l)) && c.view().some((l) => /│ +- \[ \] notes/.test(l)));
    const notes = c.view().findIndex((l) => /│ +- \[ \] notes/.test(l));
    const col = c.view()[notes].indexOf('[') + 2;
    await c.type(`\x1b[<0;${col};${notes + 1}M\x1b[<0;${col};${notes + 1}m`, 500);
    ok('a click ticks an item in the input', c.view().some((l) => /│ +- \[x\] notes/.test(l)));
    await c.type('\r', 1000);
    ok('Enter sends the checklist as the reply', got.at(-1).text === 'do these:\n- [x] tests\n- [x] notes' && Boolean(got.at(-1).replyTo), JSON.stringify(got.at(-1).text));
    ok('the dismissed one is not waiting; its message stays', !counter() && c.view().some((l) => /Tag it v0\.2\.0\?/.test(l)), counter().trim());
    await builder.api.agents.send({ to: 'misha', text: 'Tag it v0.2.1?', kind: 'info', suggest: 'tag v0.2.1', keepOlder: true });
    await c.wait(/Tag it v0\.2\.1\?/);
    await sleep(400);
    const cnt = c.view().findIndex((l) => /waiting for reply/.test(l));
    ok('the counter is on the line under the input, on its right (no line of its own)', /\S.* {2,}\d?\/?\d waiting for reply\s*$/.test(c.view()[cnt]) && /╰/.test(c.view()[cnt - 1]), c.view()[cnt]);
    const ccol = c.view()[cnt].search(/\d+(\/\d+)? waiting for reply/) + 2;
    await c.type(`\x1b[<0;${ccol};${cnt + 1}M\x1b[<0;${ccol};${cnt + 1}m`, 700);
    ok('the counter goes to its message', c.view().some((l) => /Tag it v0\.2\.1\?/.test(l)));
    await clickReply(/Tag it v0\.2\.1\?/);
    ok('↩ reply on it: its own ghost', inputLine().includes('@builder tag v0.2.1'), inputLine().trim());
    await c.type('\t', 300);
    await c.type('\r', 1000);
    ok('and it answers that one; nothing waits', got.at(-1).text === 'tag v0.2.1' && !counter());
    // taken with Tab, then Esc: dismissed too, not only the reply cancelled
    await builder.api.agents.send({ to: 'misha', text: 'Roll back the cache?', kind: 'info', suggest: 'roll it back', keepOlder: true });
    await c.wait(/Roll back the cache\?/);
    await sleep(400);
    await c.type('\t', 500);
    ok('Tab takes it', /❯ @builder roll it back/.test(inputLine()), inputLine().trim());
    await c.type('\x1b', 800);
    ok('Esc after Tab: dismissed, the input empty, nothing waits', !/roll it back/.test(inputLine()) && !counter(), `${inputLine().trim()} | ${counter().trim()}`);
    // ⌫ in the empty input: dismissed like Esc, and the next offered
    await builder.api.agents.send({ to: 'misha', text: 'Backspace me?', kind: 'info', suggest: 'gone', keepOlder: true });
    await builder.api.agents.send({ to: 'misha', text: 'Keep me?', kind: 'info', suggest: 'kept', keepOlder: true });
    await c.wait(/Keep me\?/);
    await sleep(400);
    ok('two waiting, the first offered', counter().includes('1/2 waiting for reply') && inputLine().includes('@builder gone · tab'), `${inputLine().trim()} | ${counter().trim()}`);
    await c.type('\x7f', 600);
    ok('⌫ in the empty input dismisses it: the next, "1/1"', counter().includes('1/1 waiting for reply') && inputLine().includes('@builder kept · tab'), `${inputLine().trim()} | ${counter().trim()}`);
    await c.type('\x1b', 600);
    await builder.api.agents.send({ to: 'misha', text: 'Build is done.', kind: 'info' });
    await c.wait(/Build is done\./);
    await clickReply(/Build is done\./);
    ok('a message without a suggestion: ↩ reply as before', /❯ @builder/.test(inputLine()), inputLine().trim());
    // replying shows in the message itself and under the input; no line above the input
    const footer = () => c.view().find((l) => l.includes('✕ cancel reply · esc')) || '';
    ok('replying: no "↩ replying to" line; the message\'s actions are only "↩ replying"; "✕ cancel reply · esc" on the right under the input', !c.view().some((l) => /replying to/.test(l)) && c.view().some((l) => /^\s*↩ replying\s*$/.test(l)) && /✕ cancel reply · esc\s*$/.test(footer()), footer());
    await c.type('thanks', 300);
    const fr = c.view().findIndex((l) => l.includes('✕ cancel reply'));
    const fc = c.view()[fr].indexOf('✕') + 2;
    await c.type(`\x1b[<0;${fc};${fr + 1}M\x1b[<0;${fc};${fr + 1}m`, 600);
    ok('a click on ✕ cancel reply: the reply goes, what you typed stays', /❯ @builder thanks/.test(inputLine()) && !footer() && !c.view().some((l) => /↩ replying/.test(l)), inputLine().trim());
    for (let i = 0; i < 20; i++) await c.type('\x7f', 30);
    await sleep(300);
    // its "↩ replying" cancels too
    await clickReply(/Build is done\./);
    const rr = c.view().findIndex((l) => /^\s*↩ replying\s*$/.test(l));
    const rc = c.view()[rr].indexOf('↩') + 2;
    await c.type(`\x1b[<0;${rc};${rr + 1}M\x1b[<0;${rc};${rr + 1}m`, 600);
    ok('a click on "↩ replying" cancels the reply; the actions are back', !footer() && c.view().some((l) => /↩ reply  ⋯/.test(l)) && !c.view().some((l) => /↩ replying/.test(l)));
    for (let i = 0; i < 20; i++) await c.type('\x7f', 30);
    // forwarding: the message shows only "↪ forwarding", which cancels it
    const moreRow = (re) => { const v = c.view(); const at = v.findIndex((l) => re.test(l)); return v.findIndex((l, i) => i > at && l.includes('↩ reply')); };
    let mr = moreRow(/Build is done\./);
    let mc = c.view()[mr].indexOf('⋯') + 1;
    await c.type(`\x1b[<0;${mc};${mr + 1}M\x1b[<0;${mc};${mr + 1}m`, 500);
    mr = c.view().findIndex((l) => l.includes('↪ forward'));
    mc = c.view()[mr].indexOf('↪') + 2;
    await c.type(`\x1b[<0;${mc};${mr + 1}M\x1b[<0;${mc};${mr + 1}m`, 600);
    const fr2 = c.view().findIndex((l) => /^\s*↪ forwarding\s*$/.test(l));
    ok('forwarding: the message\'s actions are only "↪ forwarding"', fr2 >= 0 && /❯ @/.test(inputLine()), c.view().slice(-12).join('\n'));
    const fc2 = c.view()[fr2].indexOf('↪') + 2;
    await c.type(`\x1b[<0;${fc2};${fr2 + 1}M\x1b[<0;${fc2};${fr2 + 1}m`, 600);
    ok('a click on it cancels the forward', !c.view().some((l) => /↪ forwarding/.test(l)) && !/❯ @/.test(inputLine()), inputLine().trim());
    c.kill();
    // older than the 30 loaded: still waiting, from the hub's list, and Tab goes back to it
    const old = await builder.api.agents.send({ to: 'misha', text: 'Release notes: publish them?', kind: 'info', suggest: 'publish', keepOlder: true });
    for (let i = 0; i < 60; i++) await builder.api.room.say({ room: 'dev', text: `build step ${i}` });
    const c2 = spawnChat({ room: 'dev', name: 'misha', cols: 110, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: O } });
    await c2.wait(/build step 59/, 15000);
    await sleep(600);
    const input2 = () => c2.view().find((l) => /│ ❯ /.test(l)) || '';
    ok('an old one, 60 back: in the input and counted', input2().includes('@builder publish · tab') && c2.view().some((l) => /1 waiting for reply/.test(l)), input2().trim());
    const deploy = await builder.api.agents.send({ to: 'misha', text: 'Deploy now?', kind: 'info', suggest: 'deploy', keepOlder: true });
    await c2.wait(/Deploy now\?/);
    await sleep(400);
    const counter2 = () => c2.view().find((l) => /waiting for reply/.test(l)) || '';
    const filled = (t) => new RegExp(`❯ @builder ${t}(  · enter sends( · tab next)?)? +│`).test(input2());
    const keysHint = () => (/· enter sends · tab next/.test(input2()) ? 'next' : /· enter sends/.test(input2()) ? 'sends' : '');
    // a click on "1/2 waiting" switches to the next, as Tab does
    let wr = c2.view().findIndex((l) => /waiting for reply/.test(l));
    let wc = c2.view()[wr].search(/\d+\/\d+ waiting/) + 2;
    await c2.type(`\x1b[<0;${wc};${wr + 1}M\x1b[<0;${wc};${wr + 1}m`, 1200);
    ok('a click on "1/2 waiting": the next one, "2/2"', input2().includes('@builder deploy · tab') && counter2().includes('2/2'), `${input2().trim()} | ${counter2().trim()}`);
    wr = c2.view().findIndex((l) => /waiting for reply/.test(l));
    wc = c2.view()[wr].search(/\d+\/\d+ waiting/) + 2;
    await c2.type(`\x1b[<0;${wc};${wr + 1}M\x1b[<0;${wc};${wr + 1}m`, 1500);
    ok('and round the end: the first again, "1/2"', input2().includes('@builder publish · tab') && counter2().includes('1/2'), input2().trim());
    await c2.type('\t', 1500);
    ok('Tab: takes the oldest, its message alone at the top, "1/2"', filled('publish') && counter2().includes('1/2') && !c2.view().some((l) => /waiting for your reply ·|📌/.test(l)) && c2.view().some((l) => /Release notes: publish them\?/.test(l)), `${input2().trim()} | ${counter2().trim()}`);
    await c2.type('\t', 1000);
    ok('Tab again, unchanged: the next in its place, "2/2"', filled('deploy') && counter2().includes('2/2'), `${input2().trim()} | ${counter2().trim()}`);
    ok('after the filled text, dim: "· enter sends · tab next" (two waiting)', keysHint() === 'next', input2().trim());
    await c2.type('\t', 1500);
    ok('Tab round the end: the first, "1/2"', filled('publish') && counter2().includes('1/2'), input2().trim());
    await c2.type('\x1b[Z', 1000);
    ok('shift+tab: the previous (round the start)', filled('deploy') && counter2().includes('2/2'), input2().trim());
    await c2.type(' now', 500);
    await c2.type('\t', 800);
    ok('edited: Tab switches nothing, the text stays; the keys hint is gone', filled('deploy now') && keysHint() === '', input2().trim());
    await c2.type('\r', 1000);
    ok('Enter sends it, a reply to the one shown', got.at(-1).text === 'deploy now' && got.at(-1).replyTo === deploy.id, JSON.stringify(got.at(-1) && { text: got.at(-1).text, replyTo: got.at(-1).replyTo }));
    await sleep(400);
    await c2.type('\t', 1500);
    ok('one waiting: just "· enter sends"', keysHint() === 'sends', input2().trim());
    await c2.type('\r', 1000);
    ok('and the one left: Tab, Enter answers it', got.at(-1).text === 'publish' && got.at(-1).replyTo === old.id);
    c2.kill();
    // a pin 600 back: only that message is fetched, shown at the top, and ↩ reply works
    const pinner = await connect({ url, token: O });
    await pinner.api.agents.register({ name: 'pinner', room: 'dev', kind: 'human' });
    const plan = await builder.api.agents.send({ to: 'misha', text: 'Old plan: three phases', kind: 'info' });
    // the hub takes 200 calls per 10 s from one connection: 600 lines from a few
    for (let k = 0; k < 4; k++) {
      const f = await connect({ url, token: A });
      await f.api.agents.register({ name: `filler${k}`, room: 'dev' });
      for (let i = k * 150; i < (k + 1) * 150; i++) await f.api.room.say({ room: 'dev', text: `filler ${i}` });
      f.m.close();
    }
    await builder.api.room.edit({ id: plan.id, text: 'Old plan: three phases (v2)' });
    await builder.api.room.edit({ id: plan.id, text: 'Old plan: three phases (v3)' });
    await pinner.api.room.pin({ id: plan.id, on: true });
    const c3 = spawnChat({ room: 'dev', name: 'misha', cols: 110, rows: 30, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: O } });
    await c3.wait(/filler 599/, 15000);
    await sleep(500);
    await c3.type('/pins 1', 500);
    await c3.type('\r', 1500);
    const v3 = c3.view();
    const card = /^\s*⚑ builder → misha  \d\d:\d\d  edited\s*$/;
    const head = v3.findIndex((l) => card.test(l));
    const gapAt = v3.findIndex((l, i) => i > head && /─ …\s*$/.test(l));
    ok('/pins 1, 600 back: at the top, a message like any other, "⚑ builder → misha <time> edited", no header line', head >= 0 && v3.slice(head).some((l) => /Old plan: three phases \(v3\)/.test(l)) && !v3.some((l) => /📌/.test(l)), v3.slice(Math.max(0, head - 2), head + 8).join('\n'));
    ok('under it a "…" line, then the loaded messages: the history between is not loaded', gapAt > head && gapAt - head <= 5 && v3.slice(gapAt).some((l) => /filler 5[6-9]\d/.test(l)) && !v3.some((l) => /filler [0-9]\b|filler [1-9][0-9]\b/.test(l)), v3.slice(head, gapAt + 4).join('\n'));
    const row = v3.findIndex((l, i) => i > head && l.includes('↩ reply'));
    const col3 = v3[row].indexOf('↩') + 2;
    await c3.type(`\x1b[<0;${col3};${row + 1}M\x1b[<0;${col3};${row + 1}m`, 600);
    await c3.type('noted', 300);
    await c3.type('\r', 1000);
    ok('↩ reply on the card answers that message', got.at(-1)?.text === 'noted' && got.at(-1)?.replyTo === plan.id, JSON.stringify(got.at(-1) && { text: got.at(-1).text, replyTo: got.at(-1).replyTo }));
    await c3.type('/pins 1', 500);
    await c3.type('\r', 1200);
    ok('/pins 1 again: scrolled back up to it', c3.view().some((l) => card.test(l)));
    for (let i = 0; i < 12; i++) await c3.type('\x1b[6~', 120);
    await sleep(300);
    for (let i = 0; i < 40; i++) await c3.type('\x1b[5~', 60);
    await sleep(400);
    ok('it stays: scrolled to the end and back to the top, still there, the oldest', c3.view().some((l) => card.test(l)) && c3.view().some((l) => /─ …\s*$/.test(l)));
    // a pin in the conversation, edited twice while it is open: found where it is now, no card
    const sheet = await builder.api.room.say({ room: 'dev', text: '**BLUE SHEET** Q4' });
    await pinner.api.room.pin({ id: sheet.id, on: true });
    await builder.api.room.edit({ id: sheet.id, text: '**BLUE SHEET** Q4 v2' });
    await builder.api.room.edit({ id: sheet.id, text: '**BLUE SHEET** Q4 v3' });
    await c3.wait(/BLUE SHEET Q4 v3/);
    await c3.type('/pins 1', 500);
    await c3.type('\r', 1200);
    ok('a pin in the conversation, edited twice: there, no card, no "no longer in the room"', c3.view().some((l) => /BLUE SHEET Q4 v3/.test(l)) && !c3.view().some((l) => /no longer in the room/.test(l)), c3.view().slice(-14).join('\n'));
    c3.kill();
    pinner.m.close();
    builder.m.close();
  } finally {
    hubProc.kill();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.message.slice(0, 2000)); process.exit(1); });
