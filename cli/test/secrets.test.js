'use strict';

// `metacom secrets exec`: the room's values in the child's environment only, and what it prints
// redacted, also when a value is split across chunks of output.

const { test } = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const { SECRET_INPUT, redactor, run } = require('../lib/secrets.js');

const VALUES = { API_KEY: 'sk-live-4f9a8b7c6d5e', DB: 'hunter2-long' }; // gitleaks:allow (made-up values for the masking tests)

test('the redactor: whole values, and values split across chunks', () => {
  const r = redactor(VALUES);
  const chunks = ['Bearer sk-li', 've-4f9a8b7', 'c6d5e and hun', 'ter2-long; sk-live-x', ' ok'];
  const out = chunks.map((c) => r.push(c)).join('') + r.end();
  assert.strictEqual(out, 'Bearer $API_KEY and $DB; sk-live-x ok');
  // text that is not the start of a value is not held back
  const r2 = redactor(VALUES);
  assert.strictEqual(r2.push('plain line\n'), 'plain line\n');
});

test('run: values in the environment, never in the output', async () => {
  let out = '';
  const sink = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await run(['echo "key=$API_KEY"; printf %s "$API_KEY" | wc -c; exit 3'], VALUES, { stdout: sink, stderr: sink });
  assert.strictEqual(code, 3);
  assert.match(out, /^key=\$API_KEY\n\s*20\n$/);
  assert.ok(!out.includes(VALUES.API_KEY));
});

test('the input syntax matches the hub\'s', () => {
  assert.deepStrictEqual(SECRET_INPUT.exec('$API_KEY=abc$def$').slice(1), ['API_KEY', 'abc$def']);
  assert.ok(!SECRET_INPUT.test('use $API_KEY=x$ here'));
});
