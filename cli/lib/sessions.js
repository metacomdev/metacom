'use strict';

// Room sessions (docs/sessions.md): `/invite valuesdev` into trade gives valuesdev a session of its
// own there. The hub cannot start processes, so the agent's wrapper at home does: the same
// `metacom` line, in the invited room, with the same command minus what resumes the old
// conversation (a fresh context), in the same folder (misha: just a new session there; its notes
// are its own file), headless as the agent boxes run them (script(1) gives it a terminal).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const dir = () => path.join(os.homedir(), '.local', 'share', 'metacom-hub', 'sessions');
const pidFile = (name, room) => path.join(dir(), `${name}@${room}.pid`);

/// The agent's command without what continues its old conversation: Claude Code's --continue / -c
/// and --resume / -r <id>, Codex's `resume <id>`.
const freshArgs = (command, args) => {
  const out = [];
  const base = path.basename(command);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (base === 'codex' && i === 0 && a === 'resume') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a === '--continue' || (a === '-c' && base === 'claude')) continue;
    if (a === '--resume' || a === '-r' || a === '--session-id') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (/^--(?:resume|session-id)=/.test(a)) continue;
    out.push(a);
  }
  return out;
};

/// The `metacom` arguments for the session: the wrapper's own, in the other room, in its folder.
/// `argv` is what this wrapper was started with after `metacom` (room first, then its options,
/// then the agent's command and its arguments).
const sessionArgv = ({ argv, room, to, dir: where, command, args }) => {
  const opts = argv.slice(1, argv.length - 1 - args.length);
  const kept = [];
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--repo') {
      i++;
      continue;
    }
    if (opts[i] === '--worktree' || opts[i] === '--' || /^--repo=/.test(opts[i])) continue;
    kept.push(opts[i]);
  }
  return [to, ...kept, '--repo', where, '--', command, ...freshArgs(command, args)];
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/// The session's process, when it is running. A pid file left from before a restart (a box's pids
/// start small again and get reused) only counts when that pid still runs this session's line.
const running = (name, room) => {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile(name, room), 'utf8'));
  } catch {
    return null;
  }
  if (!pid || !alive(pid)) return null;
  try {
    const line = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    if (!line.includes(` ${room} `) || !line.includes(`-n ${name} `)) return null;
  } catch {
    // no /proc (macOS): the pid alone
  }
  return pid;
};

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/// Starts the session in `to` unless it runs already, in the agent's own folder.
const start = ({ name, room, to, repo, command, args, argv = process.argv.slice(2), bin = path.join(__dirname, '..', 'bin', 'metacom.js'), env = process.env, trace = () => {}, onFail = () => {} }) => {
  const pid = running(name, to);
  if (pid) {
    trace(`session ${to}: already running (${pid})`);
    return { pid, started: false };
  }
  const where = repo;
  const line = [process.execPath, bin, ...sessionArgv({ argv, room, to, dir: where, command, args })].map(quote).join(' ');
  const { MC_AGENT, MC_AGENT_KEY, MC_ROOM, MC_WRAPPER_PID, ...rest } = env;
  const childEnv = { ...rest, MC_SESSION_HOME: room };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  // a terminal for it, as the agent boxes give theirs: util-linux script on Linux, BSD script on macOS
  const linux = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
  const child = linux
    ? spawn('script', ['-qfc', line, '/dev/null'], { cwd: where, env: childEnv, detached: true, stdio: 'ignore' })
    : spawn('script', ['-q', '/dev/null', 'sh', '-c', line], { cwd: where, env: childEnv, detached: true, stdio: 'ignore' });
  // what went wrong, for the room: it could not be run, or it ended at once
  const born = Date.now();
  child.on('error', (error) => onFail(`could not run script(1): ${error.message}`));
  child.on('exit', (code, signal) => {
    if (Date.now() - born < 15_000) onFail(`it ended at once (${signal || `exit ${code}`}); run by hand to see why: cd ${where} && ${line}`);
  });
  child.unref();
  fs.writeFileSync(pidFile(name, to), String(child.pid), { mode: 0o600 });
  trace(`session ${to}: started (${child.pid}) in ${where}: ${line}`);
  return { pid: child.pid, started: true, dir: where };
};

/// Ends the session's process: only when it cannot stop itself (it is not connected to say its notes).
const stop = (name, to, trace = () => {}) => {
  const pid = running(name, to);
  if (!pid) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
  trace(`session ${to}: stopped (${pid})`);
  return true;
};

/// The conversation an agent process is in now: Claude Code's ~/.claude/sessions/<pid>.json, or the
/// Codex rollout file it (or a process under it) has open. Null when there is none to tell.
const currentSession = (kind, pid) => {
  if (kind === 'claude') {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId || null;
    } catch {
      return null;
    }
  }
  if (kind !== 'codex') return null;
  const under = (p) => {
    try {
      return spawnSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  const all = [pid];
  for (let i = 0; i < all.length && i < 50; i++) all.push(...under(all[i]));
  for (const p of all) {
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = '';
      try {
        target = fs.readlinkSync(`/proc/${p}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/.exec(target);
      if (m) return m[1];
    }
  }
  return null;
};

/// The agent's command resuming conversation `id`: Claude Code `--resume <id>` (in place of
/// --continue or an older --resume), Codex `resume <id>`.
const resumeArgs = (command, args, id) => {
  const base = path.basename(command);
  if (!id || (base !== 'claude' && base !== 'codex')) return args;
  const fresh = freshArgs(command, args);
  return base === 'codex' ? ['resume', id, ...fresh] : [...fresh, '--resume', id];
};

module.exports = { start, stop, running, freshArgs, sessionArgv, pidFile, currentSession, resumeArgs };
