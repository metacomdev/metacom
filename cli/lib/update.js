'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/// `metacom update`: bring this installation to the latest version. Two ways to be installed,
/// so two ways to update: a git checkout (the usual one here: clone, npm install, npm link) is
/// fast-forwarded and its dependencies refreshed when the lockfile moved; anything else came
/// from npm and is reinstalled globally. Nothing is ever forced: local edits to files the update
/// changes, or a branch that has diverged, are reported and left alone; other local edits and
/// untracked files are kept and do not stop it.
const PKG = path.join(__dirname, '..');

/// Every command this runs goes through here, so a test can watch or stand in for them.
const runner = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

/// Where this copy lives and how it can be updated.
const source = (root = PKG, exists = fs.existsSync) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let dir = root;
  while (dir !== path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) return { kind: 'git', repo: dir, root, name: pkg.name, version: pkg.version };
    dir = path.dirname(dir);
  }
  return { kind: 'npm', root, name: pkg.name, version: pkg.version };
};

const gitUpdate = (src, { check = false, run = runner } = {}) => {
  const git = (...args) => run('git', args, src.repo);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') return { ...src, state: 'detached', message: 'this checkout is not on a branch; `git checkout <branch>` first' };
  // Edits to tracked files; files git does not track (notes, a .claude folder) never count.
  const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  const upstream = (() => {
    try {
      return git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
    } catch {
      return null;
    }
  })();
  if (!upstream) return { ...src, branch, state: 'no-upstream', message: `${branch} does not track a remote branch` };
  git('fetch', '--quiet', upstream.split('/')[0]);
  const behind = Number(git('rev-list', '--count', `HEAD..${upstream}`));
  const ahead = Number(git('rev-list', '--count', `${upstream}..HEAD`));
  const log = behind ? git('log', '--oneline', '--no-decorate', `HEAD..${upstream}`).split('\n').filter(Boolean) : [];
  const at = { branch, upstream, behind, ahead, log };
  if (behind === 0) return { ...src, ...at, state: 'current', message: `already up to date with ${upstream}` };
  if (check) return { ...src, ...at, state: 'available', message: `${behind} commit${behind === 1 ? '' : 's'} to pull from ${upstream}` };
  if (ahead > 0) return { ...src, ...at, state: 'diverged', message: `${branch} has ${ahead} commit${ahead === 1 ? '' : 's'} of its own; merge or rebase by hand` };
  // Local edits are in the way only where the update changes the same files; the rest are kept.
  const incoming = new Set(git('diff', '--name-only', 'HEAD', upstream).split('\n').filter(Boolean));
  const blocking = changed.filter((f) => incoming.has(f));
  const dirty = (files, detail = '') => ({
    ...src,
    ...at,
    state: 'dirty',
    files,
    message: `the update changes ${files.length === 1 ? 'a file' : 'files'} you edited here: ${files.join(', ')}. Keep your edits with \`git -C ${src.repo} stash\`, or drop them with \`git -C ${src.repo} checkout -- ${files.join(' ')}\`, then update again${detail}`,
  });
  if (blocking.length) return dirty(blocking);
  const lockBefore = fs.existsSync(path.join(src.root, 'package-lock.json')) ? fs.readFileSync(path.join(src.root, 'package-lock.json'), 'utf8') : '';
  try {
    git('merge', '--ff-only', upstream);
  } catch (error) {
    // an untracked file where the update adds one, say: git names it
    const named = [...String(error.stderr || '').matchAll(/^\s+(\S.*)$/gm)].map((m) => m[1]).filter((f) => !/^(Please|Aborting)/.test(f));
    if (/would be overwritten/.test(String(error.stderr || ''))) return dirty(named.length ? named : ['(see git status)']);
    throw error;
  }
  const lockAfter = fs.existsSync(path.join(src.root, 'package-lock.json')) ? fs.readFileSync(path.join(src.root, 'package-lock.json'), 'utf8') : '';
  let installed = false;
  if (lockBefore !== lockAfter) {
    run('npm', ['install', '--no-audit', '--no-fund'], src.root);
    installed = true;
  }
  const kept = changed.length ? `; your edits to ${changed.join(', ')} are kept` : '';
  return { ...src, ...at, state: 'updated', installed, kept: changed, head: git('log', '--oneline', '-1', '--no-decorate'), message: `pulled ${behind} commit${behind === 1 ? '' : 's'}${kept}` };
};

const npmUpdate = (src, { check = false, run = runner } = {}) => {
  const latest = run('npm', ['view', src.name, 'version'], src.root);
  if (latest === src.version) return { ...src, latest, state: 'current', message: `already on ${latest}` };
  if (check) return { ...src, latest, state: 'available', message: `${latest} is out (this is ${src.version})` };
  run('npm', ['install', '--global', `${src.name}@latest`], src.root);
  return { ...src, latest, state: 'updated', message: `installed ${latest}` };
};

/// Result: { kind, state, message, … }. `state` is one of current, available, updated, or a
/// reason nothing was done (dirty, diverged, detached, no-upstream).
const update = (options = {}) => {
  const src = options.source || source(options.root);
  try {
    return src.kind === 'git' ? gitUpdate(src, options) : npmUpdate(src, options);
  } catch (error) {
    const detail = (error.stderr || error.stdout || '').toString().trim().split('\n').slice(-2).join(' ');
    return { ...src, state: 'failed', message: detail || error.message };
  }
};

module.exports = { update, source };
