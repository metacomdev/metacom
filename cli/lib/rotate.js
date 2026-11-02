'use strict';

// Session rotation: an agent's context is cleared between tasks so it does not carry hundreds of
// thousands of tokens into every turn (cost: each turn re-reads them; after an idle gap, the cache
// is written again). Before clearing, the agent writes down where it is (PROGRESS.md), and after,
// reads its ROLE.md and PROGRESS.md again: the work goes on, the context starts small.
//
// Off unless asked for (--rotate task|idle:N). The owner's "@all !/clear" runs the same steps on
// every agent of a room, each when it is idle (manual()).
//
// When: only while the agent is idle (never mid-turn, never with a question on screen, never with
// messages waiting to be typed in), and
//   a) task (the default): it replied "done" to whoever gave it the task, or the owner signed off;
//   b) idle:<min>: that long since its last turn;
//   c) either way: its context is above --max-context.
// Never, if its PROGRESS.md says "KEEP CONTEXT until …".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX = 150_000;
/// Its own notes: ROLE-<name>.md and PROGRESS-<name>.md where agents share a folder (when there),
/// else ROLE.md and PROGRESS.md.
const notesOf = (name, dirs) => {
  const own = (base) => dirs.some((d) => fs.existsSync(path.join(d, `${base}-${name}.md`))) ? `${base}-${name}.md` : `${base}.md`;
  return { role: own('ROLE'), progress: own('PROGRESS') };
};
const saveText = (n) => `Update your ${n.progress} now (done / open / next, at most 10 lines), then reply OK.`;
const resumeText = (n) => `Read your ${n.role} and ${n.progress}, then wait for the next task.`;
const SAVE = saveText({ progress: 'PROGRESS.md' });
const RESUME = resumeText({ role: 'ROLE.md', progress: 'PROGRESS.md' });

/// `task`, `idle:<minutes>`, `never` (the default).
const parseRotate = (value = 'never') => {
  const v = String(value).trim();
  if (v === 'task' || v === 'never') return { mode: v, idleMin: null };
  const m = /^idle:(\d+(?:\.\d+)?)$/.exec(v);
  if (m) return { mode: 'idle', idleMin: Number(m[1]) };
  throw new Error('--rotate: task, idle:<minutes> or never');
};

const tail = (file, bytes = 512 * 1024) => {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
};

const newest = (dir, pick) => {
  try {
    return fs
      .readdirSync(dir)
      .filter(pick)
      .map((f) => [path.join(dir, f), fs.statSync(path.join(dir, f)).mtimeMs])
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
  } catch {
    return [];
  }
};

const projectOf = (cwd, home) => path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/// The session a Claude Code process is in now: it keeps it in ~/.claude/sessions/<pid>.json, and
/// /clear changes it there. Agents sharing a folder share its project, so the newest session in it
/// may be another agent's.
const ownSession = (pid, cwd, home) => {
  if (!pid) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
    return s.sessionId ? path.join(projectOf(s.cwd || cwd, home), `${s.sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
};

/// Claude Code: its own session (by its pid), else the newest in the folder's project; the context
/// is what the last turn read: its input, plus what it read from the cache and wrote to it.
const claudeContext = (cwd, home = os.homedir(), pid = null) => {
  const own = ownSession(pid, cwd, home);
  if (own && !fs.existsSync(own)) return { tokens: 0, file: own }; // just cleared: nothing said yet
  const [file] = own ? [own] : newest(projectOf(cwd, home), (f) => f.endsWith('.jsonl'));
  if (!file) return null;
  const lines = tail(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i]).message?.usage;
      if (u) return { tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), file };
    } catch {}
  }
  return { tokens: 0, file };
};

/// Codex: the newest session started in this folder (its first line says where); the context is
/// the last turn's input (cached input included).
const codexContext = (cwd, home = os.homedir()) => {
  const root = path.join(home, '.codex', 'sessions');
  const days = [];
  for (const y of newest(root, () => true).slice(0, 2)) for (const m of newest(y, () => true).slice(0, 2)) for (const d of newest(m, () => true).slice(0, 3)) days.push(d);
  const files = days.flatMap((d) => newest(d, (f) => f.startsWith('rollout-') && f.endsWith('.jsonl')).map((f) => [f, fs.statSync(f).mtimeMs])).sort((a, b) => b[1] - a[1]);
  for (const [file] of files.slice(0, 20)) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0]);
    } catch {}
    if (!meta || meta.payload?.cwd !== cwd) continue;
    const lines = tail(file);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const u = JSON.parse(lines[i]).payload?.info?.last_token_usage;
        if (u) return { tokens: u.input_tokens || 0, file };
      } catch {}
    }
    return { tokens: 0, file };
  }
  return null;
};

const contextOf = (kind, cwd, home, pid) => (kind === 'codex' ? codexContext(cwd, home) : claudeContext(cwd, home, pid));

/// Its PROGRESS.md (or PROGRESS-<name>.md) asks to keep the context: a line that starts "KEEP CONTEXT until <task>".
/// The phrase quoted mid-line (an instruction on how to hold) does not count.
const keepsContext = (dirs, file = 'PROGRESS.md') => dirs.some((d) => {
  try {
    return /^[ \t]*KEEP CONTEXT until\b/m.test(fs.readFileSync(path.join(d, file), 'utf8'));
  } catch {
    return false;
  }
});

/// A reply that says the task is done: its first line starts so ("Done", "Done in 4a71", "✅ finished").
const isDone = (text) => /^\s*(?:✅\s*)?(?:done|finished|completed)\b/i.test(String(text || '').split('\n')[0]);
/// The owner signing off: a short "ok", "thanks", "great", "lgtm", "👍".
const isSignOff = (text) => {
  const t = String(text || '').trim();
  return t.length <= 60 && /^(?:@\S+\s+)?(?:ok(?:ay)?|thanks?|thank you|great|good|perfect|lgtm|nice|done|👍|✅)\b/iu.test(t);
};

/// Whether to rotate now, and why; null when not.
const decide = ({ mode, idleMin, maxContext, status, question, queued, keep, rotating, taskDone, idleForMin, ctx, fresh }) => {
  if (mode === 'never' || rotating) return null;
  if (status !== 'waiting' || question || queued || keep) return null;
  if (ctx !== null && ctx > maxContext) return 'context';
  if (fresh) return null; // nothing since the last rotation but its own re-reading
  if (mode === 'task' && taskDone) return 'task';
  if (mode === 'idle' && idleForMin >= idleMin) return 'idle';
  return null;
};

const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/// The wrapper's side: told when a turn ends, what was typed in and what the agent said; rotates
/// when decide() says so, through the steps above.
class Rotator {
  constructor({ kind, name, notesName = name, cwd, dirs = [cwd], rotate = 'never', maxContext = DEFAULT_MAX, home, pid = () => null, type, command, state, onContext = () => {}, onRotated = () => {}, onSkipped = () => {}, trace = () => {}, now = () => Date.now() }) {
    Object.assign(this, parseRotate(rotate), { kind, name, notesName, cwd, dirs, maxContext: Number(maxContext) || DEFAULT_MAX, home, pid, type, command, state, onContext, onRotated, onSkipped, trace, now });
    this.manualBatch = null;
    this.manualTimer = null;
    this.tasker = null;
    this.taskDone = false;
    this.fresh = true; // nothing to clear until it is given something (its context limit aside)
    this.rotating = false;
    this.lastTurn = now();
    this.waiters = [];
  }

  /// A message typed into the agent: who gave it work (and the owner's "thanks" is a sign-off).
  typed(msg) {
    if (!msg || !msg.from) return;
    this.fresh = false;
    if (msg.from.role === 'owner' && isSignOff(msg.text)) this.taskDone = true;
    else this.tasker = msg.from.name;
  }

  /// A message in the room: the agent's own "done" to whoever tasked it.
  said(msg) {
    if (!msg || !msg.from || msg.from.name !== this.name || !this.tasker) return;
    const toTasker = msg.to === this.tasker || new RegExp(`(^|\\s)@${this.tasker}\\b`).test(msg.text || '');
    if (toTasker && isDone(msg.text)) this.taskDone = true;
  }

  context() {
    const c = contextOf(this.kind, this.cwd, this.home || os.homedir(), this.pid());
    return c ? c.tokens : null;
  }

  /// A turn ended (the agent is idle again).
  turnEnded() {
    this.lastTurn = this.now();
    const waiter = this.waiters.shift();
    if (waiter) return waiter();
    const ctx = this.context();
    if (ctx !== null) this.onContext(ctx);
    this.check(ctx);
  }

  /// Every half minute, for idle:<min>.
  tick() {
    if (this.mode === 'idle') this.check(this.context());
  }

  check(ctx) {
    const s = this.state();
    const why = decide({ ...this, ...s, keep: keepsContext(this.dirs, notesOf(this.notesName, this.dirs).progress), idleForMin: (this.now() - this.lastTurn) / 60000, ctx });
    if (why) this.rotate(why, ctx).catch((e) => this.trace(`rotate failed: ${e.message}`));
  }

  /// The owner's "@all !/clear": the same steps, as soon as it is idle (never mid-turn, never with a
  /// question on screen or messages waiting). "KEEP CONTEXT until …" in its notes still keeps it.
  manual(batch) {
    this.manualBatch = batch;
    clearTimeout(this.manualTimer);
    this.tryManual();
  }

  tryManual() {
    const batch = this.manualBatch;
    if (!batch) return;
    const s = this.state();
    if (this.rotating || s.status !== 'waiting' || s.question || s.queued) {
      this.manualTimer = setTimeout(() => this.tryManual(), 2000);
      if (this.manualTimer.unref) this.manualTimer.unref();
      return;
    }
    this.manualBatch = null;
    const notes = notesOf(this.notesName, this.dirs);
    if (keepsContext(this.dirs, notes.progress)) return this.onSkipped({ batch, reason: `KEEP CONTEXT in its ${notes.progress}` });
    this.rotate('manual', this.context(), batch).catch((e) => {
      this.trace(`rotate failed: ${e.message}`);
      this.onSkipped({ batch, reason: e.message });
    });
  }

  /// Before a room session stops (/uninvite): its notes, as soon as it is idle. Resolves when they
  /// are written, or after a while without (it stops either way).
  async saveNotes(ms = 5 * 60 * 1000) {
    const until = this.now() + ms;
    while (this.now() < until) {
      const s = this.state();
      if (!this.rotating && s.status === 'waiting' && !s.question) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.type(saveText(notesOf(this.notesName, this.dirs)));
    await this.nextTurn(Math.max(30_000, until - this.now())).catch(() => this.trace('notes: no answer'));
  }

  /// The next turn's end (or a timeout: the agent is then left as it is).
  nextTurn(ms = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error('no answer'));
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  async rotate(why, before, batch = null) {
    this.rotating = true;
    this.trace(`rotate (${why}): ctx ${before}`);
    try {
      const notes = notesOf(this.notesName, this.dirs);
      const saved = () => Math.max(0, ...this.dirs.map((d) => {
        try {
          return fs.statSync(path.join(d, notes.progress)).mtimeMs;
        } catch {
          return 0;
        }
      }));
      const savedAt = saved();
      this.type(saveText(notes));
      await this.nextTurn();
      // nothing is cleared unless its notes were written (a failing turn, an API error, writes none)
      if (saved() <= savedAt) {
        this.trace(`rotate: ${notes.progress} was not updated; not clearing`);
        this.fresh = true; // asked once; wait for real work before asking again
        if (batch) this.onSkipped({ batch, reason: `its ${notes.progress} was not updated` });
        return;
      }
      this.command(this.kind === 'codex' ? '/new' : '/clear');
      await new Promise((r) => setTimeout(r, 3000));
      this.type(resumeText(notes));
      await this.nextTurn();
      const after = this.context();
      this.taskDone = false;
      this.fresh = true;
      this.onRotated({ why, batch, before, after, line: `rotated ${this.name} (ctx ${before === null ? '?' : k(before)} → ${after === null ? 'fresh' : k(after)})` });
      if (after !== null) this.onContext(after);
    } finally {
      this.rotating = false;
    }
  }
}

module.exports = { Rotator, parseRotate, decide, isDone, isSignOff, contextOf, claudeContext, codexContext, keepsContext, notesOf, DEFAULT_MAX, SAVE, RESUME };
