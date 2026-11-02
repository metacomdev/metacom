'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachables } = require('../lib/media.js');

const files = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-attach-'));
  fs.mkdirSync(path.join(dir, 'my dir'));
  for (const f of ['abi.zip', 'AGENTS.md', 'notes.txt', 'my dir/session 1.zip']) fs.writeFileSync(path.join(dir, f), 'x');
  const rel = (list) => list && list.map((f) => path.relative(dir, f));
  return { dir, rel };
};

test('attach: several files dropped at once are each attached', () => {
  const { dir, rel } = files();
  assert.deepStrictEqual(rel(attachables(`${dir}/abi.zip ${dir}/AGENTS.md ${dir}/notes.txt`)), ['abi.zip', 'AGENTS.md', 'notes.txt']);
  // macOS terminals escape spaces in a dropped path; some quote it instead
  assert.deepStrictEqual(rel(attachables(`${dir}/abi.zip ${dir}/my\\ dir/session\\ 1.zip`)), ['abi.zip', 'my dir/session 1.zip']);
  assert.deepStrictEqual(rel(attachables(`'${dir}/my dir/session 1.zip' ${dir}/AGENTS.md`)), ['my dir/session 1.zip', 'AGENTS.md']);
  // one path with bare spaces is still one file
  assert.deepStrictEqual(rel(attachables(`${dir}/my dir/session 1.zip`)), ['my dir/session 1.zip']);
});

test('attach: a line that is not all files stays text', () => {
  const { dir } = files();
  assert.strictEqual(attachables(`look at ${dir}/abi.zip please`), null);
  assert.strictEqual(attachables(`${dir}/abi.zip ${dir}/missing.zip`), null);
  assert.strictEqual(attachables(`${dir}/abi.zip\n${dir}/AGENTS.md`), null);
  assert.strictEqual(attachables(''), null);
});
