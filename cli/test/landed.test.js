'use strict';

// "What landed" and --worktree (lib/landed.js), on a real temporary repository.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const landed = require('../lib/landed.js');

const repo = () => {
  // real path: macOS's tmpdir is a symlink (/var → /private/var), and git hands back the real one
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'landed-')));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  const put = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  const commit = (msg) => {
    g('add', '-A');
    g('commit', '-qm', msg);
    return g('rev-parse', 'HEAD');
  };
  return { dir, g, put, commit };
};

test('what landed: commits, files, and the interface lines added and removed', () => {
  const r = repo();
  r.put('slug.js', 'function slugify(str) {\n  return str;\n}\nmodule.exports = { slugify };\n');
  r.put('util.py', 'def helper(x):\n    return x\n');
  const a = r.commit('first');
  r.put('slug.js', 'function slugify(str, opts = {}) {\n  return str.toLowerCase();\n}\nfunction internal() {}\nmodule.exports = { slugify };\n');
  r.put('util.py', 'def helper(x, y=1):\n    return x\n');
  r.put('main.go', 'package main\nfunc Run(n int) error {\n  return nil\n}\n');
  const b = r.commit('slugify takes options');
  const c = landed.between(r.dir, a, b);
  assert.deepStrictEqual(c.files.sort(), ['main.go', 'slug.js', 'util.py']);
  assert.deepStrictEqual(c.removed.sort(), ['def helper(x):', 'function slugify(str)']);
  assert.deepStrictEqual(c.added.sort(), ['def helper(x, y=1):', 'func Run(n int) error', 'function internal() {}', 'function slugify(str, opts = {})']);
  const text = landed.describe(c);
  assert.match(text, /^landed \w{7} slugify takes options · /);
  assert.match(text, /interface:\n− def helper\(x\):/);
  assert.match(text, /\+ function slugify\(str, opts = \{\}\)/);
});

test('a moved line is no interface change', () => {
  const r = repo();
  r.put('a.js', 'export function a() {}\nexport function b() {}\n');
  const a = r.commit('one');
  r.put('a.js', 'export function b() {}\nexport function a() {}\n');
  const b = r.commit('reorder');
  const c = landed.between(r.dir, a, b);
  assert.deepStrictEqual([c.added, c.removed], [[], []]);
  assert.match(landed.describe(c), /no interface change$/);
});

test('--worktree: its own checkout and branch, made once, reused, ignored by git status', () => {
  const r = repo();
  r.put('a.js', '1\n');
  r.commit('one');
  const wt = landed.worktree(r.dir, 'builder');
  assert.deepStrictEqual([path.relative(r.dir, wt.dir), wt.branch, wt.created], [path.join('.metacom', 'worktrees', 'builder'), 'metacom/builder', true]);
  assert.ok(fs.existsSync(path.join(wt.dir, 'a.js')));
  assert.strictEqual(r.g('status', '--short'), '', '.metacom/ is excluded');
  const again = landed.worktree(r.dir, 'builder');
  assert.deepStrictEqual([again.dir, again.created], [wt.dir, false]);
  // from inside a worktree, a second one still goes under the main checkout
  const other = landed.worktree(wt.dir, 'reviewer');
  assert.strictEqual(path.dirname(other.dir), path.dirname(wt.dir));
  assert.strictEqual(landed.commonDir(wt.dir), landed.commonDir(other.dir));
});

test('watch: a commit is said once; a checkout of another branch is not', async () => {
  const r = repo();
  r.put('a.js', '1\n');
  r.commit('one');
  const said = [];
  const stop = landed.watch(r.dir, (text, hash) => said.push([hash, text.split('\n')[0]]), 100);
  r.put('a.js', 'export const x = 2;\n');
  const h = r.commit('two');
  await new Promise((res) => setTimeout(res, 350));
  r.g('checkout', '-q', '-b', 'side', 'HEAD~1');
  await new Promise((res) => setTimeout(res, 350));
  stop();
  assert.deepStrictEqual(said.map(([hash]) => hash), [h.slice(0, 7)]);
  assert.match(said[0][1], /^landed \w{7} two · a\.js/);
});
