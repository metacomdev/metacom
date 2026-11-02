'use strict';

// Handing a task on when an agent hits its plan limit: the limit line is recognised on screen
// (and a quote of it is not), and the brief carries the owner's last instruction, what the agent
// said since, and its repository's state.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { limitOf } = require('../lib/screen.js');
const { contextOf, briefOf } = require('../lib/handoff.js');

test('limit lines: Claude Code and Codex, as their own line; a quote is not one', () => {
  assert.strictEqual(limitOf(['  ⎿  You\'ve hit your weekly limit · resets 5am (Europe/Berlin)', '     /rate-limit-options']), "You've hit your weekly limit · resets 5am (Europe/Berlin)");
  assert.strictEqual(limitOf(['■ You\'ve hit your usage limit. Upgrade to Pro or try again in 2 days.']), "You've hit your usage limit. Upgrade to Pro or try again in 2 days.");
  assert.strictEqual(limitOf(['● The error reads "You\'ve hit your weekly limit" when …']), null);
  assert.strictEqual(limitOf(['● You\'ve hit your weekly limit, you said?']), null, 'an assistant reply is no limit');
});

test("the brief: the owner's last instruction, what came after, the repository", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'a.js'), '2\n');
  const messages = [
    { kind: 'command', to: 'builder', from: { name: 'ada', kind: 'human' }, ts: 't1', text: 'old task' },
    { kind: 'command', to: 'builder', from: { name: 'writer', kind: 'agent' }, ts: 't2', text: 'an agent asking is not the task' },
    { kind: 'command', to: 'builder', from: { name: 'ada', kind: 'human' }, ts: 't3', text: 'build the offer page' },
    { kind: 'say', from: { name: 'builder' }, text: 'offer.html half done: packages in, form text missing' },
    { kind: 'say', from: { name: 'research' }, text: 'unrelated' },
    { kind: 'say', from: { name: 'builder' }, text: "You've hit your weekly limit · resets 5am" },
  ];
  const hub = { api: { room: { history: async () => messages } } };
  const member = { name: 'builder', room: 'launch', repo };
  const ctx = await contextOf(hub, member);
  assert.strictEqual(ctx.task.text, 'build the offer page');
  assert.deepStrictEqual(ctx.since.map((m) => m.text), ['offer.html half done: packages in, form text missing', "You've hit your weekly limit · resets 5am"]);
  assert.deepStrictEqual(ctx.repo.changed, [' M a.js']);
  const brief = briefOf(member, ctx);
  assert.match(brief, /^You are taking over from builder in room launch: it says "You've hit your weekly limit/);
  assert.match(brief, /The task \(from ada, t3\):\nbuild the offer page/);
  assert.match(brief, /- builder: offer\.html half done/);
  assert.match(brief, /Uncommitted changes:\n   M a\.js/);
  assert.match(brief, /don't redo what is done/);
});
