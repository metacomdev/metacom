'use strict';

// `metacom handoff <agent> --start codex` (or `--to <agent>`): an agent that has hit its plan's limit
// passes its task on. Only a hub that runs agents from several vendors can do this: the owner's last
// instruction to it, what it said since, and the state of its repository go to another agent (a
// Codex or OpenCode one started for the purpose in the same folder and room, or one already there),
// which carries on.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const templates = require('./templates.js');

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.replace(/\s+$/, '') : ''; // the end only: status lines start with a space
};

/// What the next agent needs: the task, where it got to, the repository's state.
const contextOf = async (hub, member) => {
  const history = await hub.api.room.history({ room: member.room, limit: 300 });
  const messages = Array.isArray(history) ? history : history.messages || [];
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'command' && m.to === member.name && m.from && m.from.kind !== 'agent') {
      at = i;
      break;
    }
  }
  const task = at >= 0 ? messages[at] : null;
  const since = messages.slice(at >= 0 ? at + 1 : -40).filter((m) => (m.from && m.from.name === member.name) || m.to === member.name).slice(-12);
  const limit = [...messages].reverse().find((m) => m.from && m.from.name === member.name && /limit/i.test(m.text || ''));
  let repo = null;
  if (member.repo && fs.existsSync(member.repo)) {
    const status = git(member.repo, 'status', '--short').split('\n').filter(Boolean);
    repo = {
      path: member.repo,
      branch: git(member.repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
      changed: status.slice(0, 15),
      more: Math.max(0, status.length - 15),
      commits: git(member.repo, 'log', '--oneline', '-5').split('\n').filter(Boolean),
    };
  }
  return { task, since, limit, repo };
};

const briefOf = (member, ctx) => {
  const parts = [`You are taking over from ${member.name} in room ${member.room}${ctx.limit ? `: it says "${clip(ctx.limit.text, 160)}"` : ', which has stopped'}.`];
  parts.push(ctx.task ? `The task (from ${ctx.task.from.name}, ${ctx.task.ts}):\n${ctx.task.text}` : 'No instruction to it was found in the room: read the room (hub_read) for what it was doing.');
  if (ctx.since.length) parts.push(`Where it got to, its last messages in the room:\n${ctx.since.map((m) => `- ${m.from.name}${m.to ? ` → ${m.to}` : ''}: ${clip(m.text, 300)}`).join('\n')}`);
  if (ctx.repo) {
    const r = ctx.repo;
    parts.push(
      `The work is in ${r.path}${r.branch ? ` (branch ${r.branch})` : ''}.` +
        (r.changed.length ? `\nUncommitted changes:\n${r.changed.map((l) => `  ${l}`).join('\n')}${r.more ? `\n  … and ${r.more} more` : ''}` : '\nNo uncommitted changes.') +
        (r.commits.length ? `\nLast commits:\n${r.commits.map((l) => `  ${l}`).join('\n')}` : ''),
    );
  }
  parts.push(`Carry on from where ${member.name} stopped (don't redo what is done), and post in the room with hub_say when it is finished.`);
  return parts.join('\n\n');
};

/// Start the next agent in a tmux window of the room's session, in the same folder.
const start = (cmd, room, name, dir) => {
  const session = `metacom-${room}`.replace(/[.:]/g, '-');
  const env = ['MC_HUB_URL', 'MC_AGENT_TOKEN', 'MC_TOKEN'].filter((k) => process.env[k]).flatMap((k) => ['-e', `${k}=${process.env[k]}`]);
  const line = cmd.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'\\''`)}'`)).join(' ');
  const exists = spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
  const args = exists ? ['new-window', '-t', session, '-n', name, '-c', dir, ...env, line] : ['new-session', '-d', '-s', session, '-n', name, '-c', dir, ...env, line];
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tmux: ${(r.stderr || '').trim()}`);
  return session;
};

const handoff = async ({ hub, from, room, to, agent, name, agentArgs = [], launch, timeoutSec = 300, log }) => {
  const members = await hub.api.agents.list({});
  const matches = members.filter((m) => m.kind === 'agent' && m.name === from && (!room || m.room === room));
  if (!matches.length) throw new Error(`no agent ${from}${room ? ` in ${room}` : ''}`);
  if (matches.length > 1) throw new Error(`${from} is in ${matches.map((m) => m.room).join(' and ')}: say which with --room`);
  const member = matches[0];
  const ctx = await contextOf(hub, member);
  const brief = briefOf(member, ctx);
  let target = to;
  if (!target) {
    if (!agent) throw new Error('who carries on? --start codex (or opencode, claude), or --to <an agent in the room>');
    target = name || `${from}-${path.basename(agent)}`;
    const dir = (ctx.repo && ctx.repo.path) || process.cwd();
    const cmd = [...templates.commandFor({ name: target, agent, args: agentArgs }, member.room)];
    const tmux = launch !== 'print' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
    if (tmux) log(`starting ${target} in tmux: tmux attach -t ${start(cmd, member.room, target, dir)}`);
    else log(`start it in a terminal, in ${dir}:\n  ${cmd.join(' ')}`);
    log(`waiting for ${target} to join…`);
    await templates.waitForTeam(hub, [{ name: target }], member.room, { timeoutMs: timeoutSec * 1000, log });
  }
  const r = await hub.api.agents.send({ to: `${target}@${member.room}`, text: brief, kind: 'command' });
  await hub.api.room.say({ room: member.room, text: `${member.name} handed its task to ${target}${ctx.limit ? ' (plan limit)' : ''}.` });
  log(`${target} has the task${r && r.delivered === false ? ' (queued until it is free)' : ''}. Follow it: metacom ${member.room}`);
  return { target, room: member.room, brief };
};

module.exports = { handoff, contextOf, briefOf };
