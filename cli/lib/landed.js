'use strict';

// "What landed": when the agent's repository gets new commits, the wrapper posts what changed to the
// room (commits, files, and the interface lines added or removed: exported functions, classes, types,
// signatures), and tells the other agents working in the same repository directly. In a benchmark of
// parallel patches, a message like this recovered ~82% of the breakage at merge (arXiv 2609.25396).
//
// And `--worktree`: the agent gets its own git worktree and branch, so agents in one repository stop
// editing the same files in place.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.replace(/\s+$/, '') : null;
};

// a line that changes how other code calls this code, in the common languages
const SIGNATURE = new RegExp(
  [
    String.raw`^export\s+(default\s+)?(async\s+)?(function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\b`,
    String.raw`^module\.exports\b`,
    String.raw`^exports\.\w+\s*=`,
    String.raw`^(async\s+)?function\*?\s+\w+\s*\(`,
    String.raw`^(abstract\s+)?class\s+\w+`,
    String.raw`^(async\s+)?def\s+\w+\s*\(`,
    String.raw`^func\s+(\([^)]*\)\s*)?\w+\s*\(`,
    String.raw`^pub(\(crate\))?\s+(async\s+)?(fn|struct|enum|trait|type|const)\b`,
    String.raw`^(public|protected)\s+[\w<>\[\],\s]+\s+\w+\s*\(`,
    String.raw`^(interface|type)\s+\w+`,
  ].join('|'),
);

/// What came in between two commits: { commits, files, stat, added, removed }.
const between = (dir, from, to) => {
  const commits = (git(dir, 'log', '--format=%h %s', `${from}..${to}`) || '').split('\n').filter(Boolean);
  const files = (git(dir, 'diff', '--name-only', from, to) || '').split('\n').filter(Boolean);
  const stat = git(dir, 'diff', '--shortstat', from, to) || '';
  const added = [];
  const removed = [];
  for (const line of (git(dir, 'diff', '-U0', '--no-color', from, to) || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    const code = line.slice(1).trim().replace(/\s*\{\s*$/, '').slice(0, 140);
    if (!SIGNATURE.test(code)) continue;
    (sign === '+' ? added : removed).push(code);
  }
  // a line both removed and added only moved: not a change to the interface
  const same = new Set(added.filter((l) => removed.includes(l)));
  return { commits, files, stat, added: [...new Set(added)].filter((l) => !same.has(l)), removed: [...new Set(removed)].filter((l) => !same.has(l)) };
};

/// The room message: the newest commit first, then the files, then the interface lines.
const describe = (c) => {
  const [first] = c.commits;
  const more = c.commits.length > 1 ? ` (+${c.commits.length - 1} more)` : '';
  const num = (re) => Number((c.stat.match(re) || [])[1] || 0);
  const [f, plus, minus] = [num(/(\d+) files? changed/), num(/(\d+) insertion/), num(/(\d+) deletion/)];
  const counts = f ? `${f} file${f === 1 ? '' : 's'}, +${plus} −${minus}` : '';
  const lines = [`landed ${first}${more} · ${c.files.slice(0, 6).join(', ')}${c.files.length > 6 ? ` +${c.files.length - 6}` : ''}${counts ? ` (${counts})` : ''}`];
  const iface = [...c.removed.slice(0, 6).map((l) => `− ${l}`), ...c.added.slice(0, 6).map((l) => `+ ${l}`)];
  if (iface.length) lines.push('interface:', ...iface);
  else lines.push('no interface change');
  return lines.join('\n');
};

/// Watch `dir` and call `onLanded(text, hash)` for each fast-forward of HEAD. Returns a stop function.
const watch = (dir, onLanded, everyMs = 3000) => {
  if (git(dir, 'rev-parse', '--is-inside-work-tree') !== 'true') return () => {};
  let head = git(dir, 'rev-parse', 'HEAD');
  const timer = setInterval(() => {
    const now = git(dir, 'rev-parse', 'HEAD');
    if (!now || now === head) return;
    const before = head;
    head = now;
    // a checkout of another branch, or a rewrite, is not new work landing
    if (!before || spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', before, now]).status !== 0) return;
    const c = between(dir, before, now);
    if (c.commits.length) onLanded(describe(c), now.slice(0, 7));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/// The repository's shared git dir: worktrees of one repository share it.
const commonDir = (dir) => {
  const d = git(dir, 'rev-parse', '--git-common-dir');
  return d ? path.resolve(dir, d) : null;
};

/// `--worktree`: <repo>/.metacom/worktrees/<name> on branch metacom/<name>, made once and reused.
/// .metacom/ goes into the repository's own exclude file, so it never shows as untracked.
const worktree = (cwd, name) => {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  if (!root) throw new Error('--worktree needs a git repository: run it inside one');
  const common = commonDir(cwd);
  // worktrees live under the main checkout, also when this is run from inside a worktree
  const mainRoot = path.basename(common) === '.git' ? path.dirname(common) : root;
  const dir = path.join(mainRoot, '.metacom', 'worktrees', name);
  const branch = `metacom/${name}`;
  const exclude = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\/?\.metacom\/?$/m.test(ex)) fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}.metacom/\n`);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') || branch, created: false };
  const has = spawnSync('git', ['-C', mainRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  const args = has ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, 'HEAD'];
  const r = spawnSync('git', ['-C', mainRoot, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return { dir, branch, created: true };
};

module.exports = { between, describe, watch, commonDir, worktree, SIGNATURE };
