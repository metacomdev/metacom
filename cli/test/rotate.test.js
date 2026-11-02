'use strict';

// Session rotation (lib/rotate.js): when to rotate, and the context read from Claude Code's and
// Codex's own session files.
//   node --test test/rotate.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide, parseRotate, isDone, isSignOff, claudeContext, codexContext, keepsContext, notesOf, Rotator } = require('../lib/rotate.js');

const idle = { mode: 'task', idleMin: null, maxContext: 150000, status: 'waiting', question: false, queued: false, keep: false, rotating: false, taskDone: false, idleForMin: 0, ctx: 20000, fresh: false };

test('when to rotate: only idle, never mid-turn, never with a question or messages waiting, never if kept', () => {
  assert.strictEqual(decide({ ...idle, taskDone: true }), 'task');
  assert.strictEqual(decide({ ...idle, ctx: 412000 }), 'context');
  assert.strictEqual(decide({ ...idle, status: 'working', ctx: 412000 }), null, 'mid-turn');
  assert.strictEqual(decide({ ...idle, question: true, taskDone: true }), null, 'a question on screen');
  assert.strictEqual(decide({ ...idle, queued: true, taskDone: true }), null, 'messages waiting to be typed in');
  assert.strictEqual(decide({ ...idle, keep: true, ctx: 412000 }), null, 'KEEP CONTEXT');
  assert.strictEqual(decide({ ...idle, mode: 'never', ctx: 412000 }), null);
  assert.strictEqual(decide({ ...idle, rotating: true, ctx: 412000 }), null);
  assert.strictEqual(decide({ ...idle, fresh: true, taskDone: true }), null, 'just rotated, nothing done since');
  assert.strictEqual(decide({ ...idle, mode: 'idle', idleMin: 30, idleForMin: 31 }), 'idle');
  assert.strictEqual(decide({ ...idle, mode: 'idle', idleMin: 30, idleForMin: 5, taskDone: true }), null, 'idle mode waits for idle');
  assert.deepStrictEqual(parseRotate('idle:30'), { mode: 'idle', idleMin: 30 });
  assert.throws(() => parseRotate('sometimes'), /task, idle:<minutes> or never/);
  assert.ok(isDone('Done in 4a71: the vault') && isDone('✅ finished the review') && !isDone('not done yet') && !isDone('I am done with step 1 of 3? no'.replace(/^I am /, 'step: ')));
  assert.ok(isSignOff('thanks!') && isSignOff('@valuesdev ok') && !isSignOff('ok, now also deploy the vault to the testnet and report the address and gas used'));
});

test('the context, from the session files: Claude Code (input + cache read + cache written), Codex (last input)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-'));
  const cwd = '/work/valuesdao';
  const proj = path.join(home, '.claude', 'projects', '-work-valuesdao');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 400000, cache_creation_input_tokens: 12000, output_tokens: 500 } } }),
    JSON.stringify({ type: 'user', message: { content: 'thanks' } }),
  ].join('\n') + '\n');
  assert.strictEqual(claudeContext(cwd, home).tokens, 412003);
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '13');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-2026-10-13T10-00-00-x.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 250000, cached_input_tokens: 240000 } } } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(day, 'rollout-2026-10-13T11-00-00-y.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: '/elsewhere' } }) + '\n');
  assert.strictEqual(codexContext(cwd, home).tokens, 250000, 'the newest session in this folder, not another folder\'s');
  assert.strictEqual(claudeContext('/nowhere', home), null);
  fs.writeFileSync(path.join(home, 'PROGRESS.md'), 'open: the audit\nKEEP CONTEXT until the audit is signed\n');
  assert.ok(keepsContext([home]) && !keepsContext([proj]));
  // only a line that starts with it: the phrase quoted in an instruction is not a hold
  fs.writeFileSync(path.join(home, 'PROGRESS.md'), 'open: the audit\nTo hold, write "KEEP CONTEXT until <task>" here.\n');
  assert.ok(!keepsContext([home]), 'quoted mid-line');
  fs.writeFileSync(path.join(home, 'PROGRESS.md'), 'keep context until the audit\nKEEP CONTEXT UNTIL\n');
  assert.ok(!keepsContext([home]), 'not the exact words');
  fs.writeFileSync(path.join(home, 'PROGRESS.md'), 'open: the audit\n  KEEP CONTEXT until the audit is signed\n');
  assert.ok(keepsContext([home]), 'indented line still holds');
});

test('agents sharing a folder: each reads its own session (by its pid), not the newest in the folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-pid-'));
  const cwd = '/work';
  const proj = path.join(home, '.claude', 'projects', '-work');
  const sessions = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const turn = (n) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
  fs.writeFileSync(path.join(proj, 'dev-session.jsonl'), turn(40000));
  fs.writeFileSync(path.join(proj, 'sec-session.jsonl'), turn(330000)); // newest: security's
  fs.utimesSync(path.join(proj, 'dev-session.jsonl'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(sessions, '58.json'), JSON.stringify({ pid: 58, sessionId: 'dev-session', cwd }));
  fs.writeFileSync(path.join(sessions, '257.json'), JSON.stringify({ pid: 257, sessionId: 'sec-session', cwd }));
  assert.strictEqual(claudeContext(cwd, home, 58).tokens, 40000, "valuesdev's own, not security's 330k");
  assert.strictEqual(claudeContext(cwd, home, 257).tokens, 330000);
  // just cleared: its new session has no file yet
  fs.writeFileSync(path.join(sessions, '58.json'), JSON.stringify({ pid: 58, sessionId: 'after-clear', cwd }));
  assert.strictEqual(claudeContext(cwd, home, 58).tokens, 0);
  // no sessions file for it (an older Claude Code): the newest in the folder, as before
  assert.strictEqual(claudeContext(cwd, home, 999).tokens, 330000);
});

test('agents sharing a folder: their own ROLE-<name>.md and PROGRESS-<name>.md when there', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-notes-'));
  assert.deepStrictEqual(notesOf('cmo', [d]), { role: 'ROLE.md', progress: 'PROGRESS.md' });
  fs.writeFileSync(path.join(d, 'ROLE-cmo.md'), 'cmo');
  fs.writeFileSync(path.join(d, 'PROGRESS-cmo.md'), 'KEEP CONTEXT until the launch\n');
  assert.deepStrictEqual(notesOf('cmo', [d]), { role: 'ROLE-cmo.md', progress: 'PROGRESS-cmo.md' });
  assert.deepStrictEqual(notesOf('cfo', [d]), { role: 'ROLE.md', progress: 'PROGRESS.md' });
  assert.ok(keepsContext([d], 'PROGRESS-cmo.md') && !keepsContext([d]));
});

test('a room session stopping: its own notes file, asked for only once it is idle, then done', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-retire-'));
  fs.writeFileSync(path.join(d, 'PROGRESS-valuesdev@trade.md'), '# valuesdev in trade\n');
  let status = 'working';
  const typed = [];
  const r = new Rotator({ kind: 'claude', name: 'valuesdev', notesName: 'valuesdev@trade', cwd: d, type: (t) => typed.push(t), command: () => {}, state: () => ({ status, question: false, queued: false }) });
  const saving = r.saveNotes(60_000);
  await new Promise((res) => setTimeout(res, 1200));
  assert.deepStrictEqual(typed, [], 'not mid-turn');
  status = 'waiting';
  await new Promise((res) => setTimeout(res, 1200));
  assert.match(typed[0], /Update your PROGRESS-valuesdev@trade\.md now/);
  r.turnEnded();
  await saving;
});
