'use strict';

// metacom usage on made-up logs: a Claude Code session named by the wrapper (a reply written twice,
// a subagent, a cost record that sets the rate), one Claude Code titles itself, and a Codex session.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
process.env.HOME = HOME;
const { usage, report, format, note } = require('../lib/usage.js');

const now = new Date();
const ts = now.toISOString();
const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const reply = (id, u, model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: ts, requestId: 'r' + id, cwd: '/work', message: { id, model, usage: u } });

test.before(() => {
  const proj = path.join(HOME, '.claude', 'projects', '-work');
  write(path.join(proj, 's1.jsonl'), [
    { type: 'custom-title', customTitle: 'builder', sessionId: 's1' },
    reply('m1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    reply('m1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }), // the same reply, second block
    reply('m2', { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 80 }),
    // Claude Code's cost record: 1,000,000 weighted tokens for $3 → $3 per million input tokens
    // the limit was hit, and resets an hour from now
    { type: 'assistant', timestamp: ts, requestId: 'rq', cwd: '/work', message: { id: 'mq', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }, error: 'rate_limit', quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'seven_day' } },
    { type: 'cost-state', modelUsage: { 'claude-opus-5-5[1m]': { inputTokens: 1000000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 3 } } },
  ]);
  write(path.join(proj, 's1', 'subagents', 'agent-x.jsonl'), [reply('m3', { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
  write(path.join(proj, 's2.jsonl'), [{ type: 'agent-name', agentName: 'report generation pdf' }, reply('m4', { input_tokens: 7, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
  const d = ts.slice(0, 10).split('-');
  write(path.join(HOME, '.codex', 'sessions', ...d, 'rollout-1.jsonl'), [
    { type: 'session_meta', timestamp: ts, payload: { cwd: '/work' } },
    { type: 'response_item', timestamp: ts, payload: { type: 'message', content: 'You are connected to metacom as agent "reviewer" in room "job". …' } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6.1' } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 30 } } } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 30 } } } }, // repeated
    { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 600, output_tokens: 50 } }, rate_limits: { plan_type: 'plus', primary: { used_percent: 77, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 }, secondary: null } } },
  ]);
  note({ name: 'builder', room: 'job', cwd: '/work', command: 'claude' });
});
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('per agent: a reply counted once, its subagent included, the room from the wrapper note, cost from the rate', async () => {
  const rows = await usage({ days: 1 });
  const b = rows.find((r) => r.agent === 'builder');
  assert.ok(b, JSON.stringify(rows));
  assert.deepStrictEqual([b.room, b.input, b.output, b.cacheRead, b.cacheWrite], ['job', 150, 30, 1000, 80]);
  // weighted: 150 + 5*30 + 0.1*1000 + 1.25*80 = 500 tokens at $3/M
  assert.ok(b.costKnown && Math.abs(b.cost - 0.0015) < 1e-9, String(b.cost));
});

test('codex: named and roomed from the room prompt, cumulative counts counted once, no cost', async () => {
  const r = (await usage({ days: 1 })).find((x) => x.agent === 'reviewer');
  assert.deepStrictEqual([r.room, r.tool, r.input, r.cacheRead, r.output, r.costKnown], ['job', 'codex', 900, 600, 50, false]);
});

test("Claude Code's own titles are not agents; --all counts them under (you)", async () => {
  assert.ok(!(await usage({ days: 1 })).some((r) => /report generation/.test(r.agent)));
  assert.ok((await usage({ days: 1, all: true })).some((r) => r.agent === '(you) work' && r.input === 7));
  const text = format(await usage({ days: 1 }));
  assert.match(text, /builder@job\s+claude/);
  assert.match(text, /≈\$0\.00\+/); // the total leaves Codex out, and says so
});

test('limits: a Claude agent capped until its reset, and Codex\'s weekly window', async () => {
  const { rows, limits } = await report({ days: 1 });
  assert.deepStrictEqual(limits.claude.map((c) => [c.agent, c.type]), [['builder', 'seven_day']]);
  assert.strictEqual(limits.codex.plan_type, 'plus');
  const text = format(rows, limits);
  assert.match(text, /builder \(claude\): hit the weekly limit, resets .* · metacom handoff builder --start codex/);
  assert.match(text, /codex \(plus\): weekly 77% used, resets/);
});
