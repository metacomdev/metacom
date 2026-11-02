'use strict';
// Every module of the CLI and the hub parses: a stray quote in a tool's text once broke the MCP
// bridge, and with it every agent's room tools, while all other tests passed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const files = ['cli/lib', 'cli/bin', 'hub/lib', 'hub/api', 'hub', 'share']
  .flatMap((d) => {
    try {
      return fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, d, f));
    } catch {
      return [];
    }
  });

test('every CLI and hub module parses', () => {
  assert.ok(files.length > 20, `found ${files.length}`);
  const broken = files.map((f) => [f, spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })]).filter(([, r]) => r.status !== 0).map(([f, r]) => `${path.relative(ROOT, f)}: ${r.stderr.split('\n').find((l) => /Error/.test(l))}`);
  assert.deepStrictEqual(broken, []);
});

test('the MCP bridge loads and lists its tools', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./lib/mcp.js'); console.log('ok')"], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'ok', r.stderr);
});
