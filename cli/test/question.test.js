'use strict';

// screen.js questionOf on dialogs captured from Claude Code 2.1 (110 columns): what the owner is
// sent, and where the cursor is, so an answer knows how far to move.

const { test } = require('node:test');
const assert = require('node:assert');
const { questionOf } = require('../lib/screen.js');

const RULE = '─'.repeat(100);
const PERMISSION = [
  '❯ Run exactly this shell command with the Bash tool and nothing else: touch',
  '  ⎿  $ touch /tmp/dlg/made.txt',
  RULE,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  '   │ touch /tmp/dlg/made.txt',
  '   Create empty made.txt file',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to',
  '      /tmp/dlg from',
  '      this project',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  ' Esc to cancel · Tab to amend',
];
const TRUST = [
  RULE,
  ' Accessing workspace:',
  ' /tmp/dlg',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  ' well-known open source project, or work from your team).',
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
];

test('questionOf: a permission dialog, numbered options with wrapped lines joined', () => {
  const q = questionOf(PERMISSION);
  assert.strictEqual(q.text, 'Bash command\ntouch /tmp/dlg/made.txt\nCreate empty made.txt file\nDo you want to proceed?');
  assert.deepStrictEqual(q.options.map((o) => o.label), ['Yes', 'Yes, and always allow access to /tmp/dlg from this project', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
  assert.strictEqual(q.pointer, 0);
  assert.match(q.id, /^[0-9a-f]{12}$/);
  // the cursor moved: the same question, the pointer follows
  const moved = PERMISSION.map((r) => r.replace('❯ 1. Yes', '  1. Yes').replace('   4. No', ' ❯ 4. No'));
  assert.deepStrictEqual([questionOf(moved).id, questionOf(moved).pointer], [q.id, 3]);
});

test('questionOf: the trust dialog, options without numbers', () => {
  const q = questionOf(TRUST);
  assert.deepStrictEqual(q.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.match(q.text, /^Accessing workspace:\n\/tmp\/dlg\nQuick safety check/);
  assert.strictEqual(q.pointer, 0);
});

test('questionOf: y/n prompts are typed; no dialog, no question', () => {
  assert.deepStrictEqual(questionOf(['Overwrite config.json? (y/n)']).options, [{ label: 'Yes', keys: 'y\r' }, { label: 'No', keys: 'n\r' }]);
  assert.strictEqual(questionOf(['● Done.', RULE, '❯ ', RULE]), null);
  // answered: ordinary output below the question
  assert.strictEqual(questionOf([...PERMISSION.slice(0, -1), '● Created made.txt', '✻ Worked for 3s']), null);
});

// Codex 0.160's update offer at start-up (dogfood, 2026-10-10): "Update now" is the default, so it
// must be a question for the owner and never look idle, or the next command typed in accepts it
const CODEX_UPDATE = [
  '  Update available · 0.160.0 → 0.162.1',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '  enter continue · esc skip',
  '›',
];

test('codex update offer: blocked, asked with its three options, cursor on Update now', () => {
  const { blockedReason } = require('../lib/screen.js');
  assert.ok(blockedReason(CODEX_UPDATE));
  const q = questionOf(CODEX_UPDATE);
  assert.deepStrictEqual(q.options.map((o) => o.label), ['Update now (runs `npm install -g @openai/codex`)', 'Skip', 'Skip until next version']);
  assert.strictEqual(q.pointer, 0);
  assert.match(q.text, /^Update available/);
});

// Gemini CLI 0.63 (80 columns): its folder trust dialog, drawn in a box with ● on the chosen option
test('Gemini trust dialog: in a box, ● the pointer', () => {
  const W = 76;
  const row = (t) => ` │ ${t.padEnd(W - 2)} │`;
  const rows = [
    'ℹ Skipping project agents due to untrusted folder. To enable, ensure that the',
    '  project root is trusted.',
    ` ╭${'─'.repeat(W)}╮`,
    row(''),
    row('Do you trust the files in this folder?'),
    row(''),
    row('Trusting a folder allows Gemini CLI to load its local configurations,'),
    row('including custom commands, hooks, MCP servers, agent skills, and settings.'),
    row(''),
    row('● 1. Trust folder (work)'),
    row('  2. Trust parent folder (root)'),
    row("  3. Don't trust"),
    row(''),
    ` ╰${'─'.repeat(W)}╯`,
  ];
  const q = questionOf(rows);
  assert.deepStrictEqual(q.options.map((o) => o.label), ['Trust folder (work)', 'Trust parent folder (root)', "Don't trust"]);
  assert.strictEqual(q.pointer, 0);
  assert.match(q.text, /^Do you trust the files in this folder\?\nTrusting a folder/);
  assert.doesNotMatch(q.text, /Skipping|│/);
});

test('Gemini sign-in dialog: a box at the bottom of the screen is still unanswered', () => {
  const W = 78;
  const row = (t) => `│ ${t.padEnd(W - 2)} │`;
  const rows = [
    ` Gemini CLI v0.63.0`,
    `╭${'─'.repeat(W)}╮`,
    row('? Get started'),
    row(''),
    row('  How would you like to authenticate for this project?'),
    row(''),
    row('  ● 1. Sign in with Google'),
    row('    2. Use Gemini API Key'),
    row('    3. Vertex AI'),
    row(''),
    row('  No authentication method selected.'),
    row(''),
    row('  (Use Enter to select)'),
    row(''),
    row('  Terms of Services and Privacy Notice for Gemini CLI'),
    row(''),
    row('  https://geminicli.com/docs/resources/tos-privacy/'),
    `╰${'─'.repeat(W)}╯`,
  ];
  const q = questionOf(rows);
  assert.deepStrictEqual(q.options.map((o) => o.label), ['Sign in with Google', 'Use Gemini API Key', 'Vertex AI']);
  assert.strictEqual(q.text, '? Get started\nHow would you like to authenticate for this project?');
  // the same box with ordinary output after it was answered
  assert.strictEqual(questionOf([...rows, '✦ Done.']), null);
});

// Claude Code 2.1 on an unattended session: the permission dialog counts down to an automatic deny,
// redrawn every second. It is one question: one id (so the hub relays it once), and the countdown
// is not in what the owner is sent.
test('a dialog with a ticking auto-deny countdown keeps one id', () => {
  const screen = (n) => [
    '● Bash(rm -f x)',
    RULE,
    ' Bash command',
    '   rm -f "${T:?}"/*.webm',
    '   Run the check',
    ` ⚠ Claude Code will automatically deny this request in 0:0${n}, to avoid blocking progress`,
    ' on an unattended session',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel · Tab to amend',
  ];
  const ids = [5, 4, 3, 2, 1, 0].map((n) => questionOf(screen(n)).id);
  assert.strictEqual(new Set(ids).size, 1);
  const q = questionOf(screen(5));
  assert.doesNotMatch(q.text, /automatically deny|unattended/);
  assert.match(q.text, /Do you want to proceed\?$/);
  // a different command is a different question
  const other = screen(5).map((l) => l.replace('rm -f', 'mv'));
  assert.notStrictEqual(questionOf(other).id, q.id);
});
