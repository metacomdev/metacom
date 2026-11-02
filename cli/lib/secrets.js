'use strict';

// `metacom secrets exec [--only A,B] -- <command>`: an agent runs a command with the room's
// secrets in its environment. The agent writes $API_KEY in the command and never sees the value:
// it comes from the hub (with the agent's token, said in the room by name), goes into the child's
// environment only, and what the command prints has every value replaced by its $NAME.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/// The input `$NAME=value$` (and `$NAME=$` to remove): typed in a chat, it is stored, not posted.
const SECRET_INPUT = /^\s*\$([A-Z][A-Z0-9_]*)=([\s\S]*)\$\s*$/;

/// Replaces values with $NAME in a stream of chunks, holding back only the end of a chunk that
/// could be the start of a value continued in the next one.
const redactor = (values) => {
  const pairs = Object.entries(values)
    .filter(([, v]) => v)
    .sort((a, b) => b[1].length - a[1].length);
  let carry = '';
  const hold = (t) => {
    let k = 0;
    for (const [, v] of pairs) for (let n = Math.min(v.length - 1, t.length); n > k; n--) if (t.endsWith(v.slice(0, n))) k = n;
    return k;
  };
  const swap = (t) => pairs.reduce((out, [name, v]) => out.split(v).join(`$${name}`), t);
  return {
    push(chunk) {
      const t = swap(carry + chunk);
      const k = hold(t);
      carry = t.slice(t.length - k);
      return t.slice(0, t.length - k);
    },
    end() {
      const t = swap(carry);
      carry = '';
      return t;
    },
  };
};

/// Runs `command` (one string goes through sh -c, so $NAME is expanded by the child's shell)
/// with `values` in its environment; resolves with its exit code.
const run = (command, values, { stdout = process.stdout, stderr = process.stderr } = {}) =>
  new Promise((resolve, reject) => {
    const [file, args] = command.length === 1 ? ['sh', ['-c', command[0]]] : [command[0], command.slice(1)];
    const child = spawn(file, args, { env: { ...process.env, ...values }, stdio: ['inherit', 'pipe', 'pipe'] });
    for (const [from, to] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ]) {
      const r = redactor(values);
      from.setEncoding('utf8');
      from.on('data', (d) => to.write(r.push(d)));
      from.on('end', () => to.write(r.end()));
    }
    const forward = (sig) => child.kill(sig);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code === null ? (signal === 'SIGINT' ? 130 : 1) : code);
    });
  });

/// `$API`, `API` or `secret://API`: the name of a secret, in the commands that take one.
const nameOf = (ref) => {
  const m = /^(?:secret:\/\/|\$)?([A-Z][A-Z0-9_]{0,63})$/.exec(String(ref || '').trim());
  return m ? m[1] : null;
};

/// A value as a .env line holds it: bare when plain, else in double quotes with \ " and newlines
/// escaped (as dotenv, docker compose and most loaders read it).
const envValue = (v) => (/^[\w.\-/+=:@~%,]*$/.test(v) ? v : JSON.stringify(v));

/// Where git stands on a file: in a work tree at all, tracked, ignored.
const gitState = (file, git = execFileSync) => {
  const dir = path.dirname(file);
  const run = (...args) => {
    try {
      git('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  };
  if (!run('rev-parse', '--is-inside-work-tree')) return { repo: false, tracked: false, ignored: false };
  return { repo: true, tracked: run('ls-files', '--error-unmatch', '--', file), ignored: run('check-ignore', '-q', '--', file) };
};

/// Writes a file only this user can read (600), in one step: a reader never sees half of it.
const writePrivate = (file, body) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
};

/// `metacom secrets put NAME --env F [--as VAR]` sets VAR (default NAME) in F, keeping its
/// other lines; `--file F` writes the bare value to F. Either way mode 600. A file git tracks is
/// refused without `force` (it would be committed); one in a repository but not ignored is
/// written with a warning. Returns what to say: never the value.
const put = ({ name, value, envFile, file, as, force = false, cwd = process.cwd() }) => {
  if (!envFile === !file) throw new Error('usage: metacom secrets put NAME --env PATH [--as VAR] | --file PATH');
  const target = path.resolve(cwd, envFile || file);
  const shown = path.relative(cwd, target) || target;
  const variable = as || name;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error(`--as ${variable}: a variable name is letters, digits and _`);
  const git = gitState(target);
  if (git.tracked && !force) throw new Error(`${shown} is tracked by git: a key written there would be committed. Use a file git ignores, or --force`);
  const warnings = git.repo && !git.ignored && !git.tracked ? [`${shown} is not in .gitignore: add it, or the key may be committed`] : [];
  if (envFile) {
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const lines = before ? before.replace(/\n$/, '').split('\n') : [];
    const line = `${variable}=${envValue(value)}`;
    const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`).test(l));
    if (at >= 0) lines[at] = /^\s*export\s/.test(lines[at]) ? `export ${line}` : line;
    else lines.push(line);
    writePrivate(target, lines.join('\n') + '\n');
  } else {
    writePrivate(target, value);
  }
  return { path: shown, as: envFile ? variable : null, warnings, said: `wrote $${name} to ${shown}${envFile ? ` as ${variable}` : ''}` };
};

module.exports = { SECRET_INPUT, redactor, run, nameOf, put, gitState };
