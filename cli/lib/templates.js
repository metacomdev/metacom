'use strict';

// Room templates (docs in templates/README.md): a team for a kind of job, as roles with their agent,
// and what each does. `metacom template use <name> --goal "…"`
// starts every role in its own terminal (tmux, or the commands printed), waits for them to join,
// gives each its part, and posts the kickoff in the room.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BUNDLED = path.join(__dirname, '..', 'templates');
const USER = path.join(os.homedir(), '.config', 'metacom-hub', 'templates');
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ROOM = /^[A-Za-z0-9._-]{1,64}$/;

/// Every template by name: yours (~/.config/metacom-hub/templates) over the bundled ones.
const all = () => {
  const found = new Map();
  for (const [dir, source] of [[BUNDLED, 'bundled'], [USER, 'yours']]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of names) found.set(f.slice(0, -5), { file: path.join(dir, f), source });
  }
  return found;
};

/// A template, read and checked: what is wrong is said with the file it is in.
const load = (name) => {
  const entry = all().get(name);
  if (!entry) throw new Error(`no template ${name}; see metacom template list`);
  let t;
  try {
    t = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch (error) {
    throw new Error(`${entry.file}: ${error.message}`);
  }
  return { ...check(t, name, entry.file), source: entry.source, file: entry.file };
};

/// The rules a template keeps, wherever it comes from (a file here, or a shared index).
const check = (t, name, where) => {
  const bad = (what) => {
    throw new Error(`${where}: ${what}`);
  };
  if (!t || typeof t !== 'object') bad('not a template');
  if (t.name !== name) bad(`"name" must be "${name}", the file's name`);
  if (!t.summary) bad('"summary" is missing');
  if (!ROOM.test(t.room || '')) bad('"room": letters, digits, dot, dash or underscore');
  if (!Array.isArray(t.roles) || !t.roles.length) bad('"roles": at least one');
  if (t.rules && !Array.isArray(t.rules)) bad('"rules": a list of lines');
  const names = t.roles.map((r) => r.name);
  for (const r of t.roles) {
    if (!NAME.test(r.name || '')) bad(`role "${r.name}": a name is lowercase letters, digits and dashes`);
    if (names.filter((n) => n === r.name).length > 1) bad(`role "${r.name}" twice`);
    if (!r.agent) bad(`role ${r.name}: "agent" (claude, codex, …) is missing`);
    if (r.args && !Array.isArray(r.args)) bad(`role ${r.name}: "args" is a list`);
    if (!r.instructions) bad(`role ${r.name}: "instructions" are missing`);
    if (r.budget !== undefined && !(Number(r.budget) > 0)) bad(`role ${r.name}: "budget" is dollars a day, above 0`);
  }
  // a company template: a lead, its loops, budgets, a review step, what the owner approves
  if (t.lead !== undefined && !names.includes(t.lead)) bad(`"lead": "${t.lead}" is not one of the roles`);
  if (t.goal !== undefined && typeof t.goal !== 'string') bad('"goal": the question that asks for this week\'s goal');
  if (t.approve !== undefined && (!Array.isArray(t.approve) || !t.approve.every((a) => typeof a === 'string'))) bad('"approve": a list of what the owner signs off');
  if (t.review !== undefined && (!t.review || !names.includes(t.review.by) || !t.review.checks)) bad('"review": { "by": a role, "checks": what it verifies }');
  if (t.loops !== undefined) {
    if (!Array.isArray(t.loops)) bad('"loops": a list of { target, every, prompt }');
    for (const l of t.loops) {
      if (!l || !(names.includes(l.target) || l.target === 'any' || l.target === 'all')) bad(`loop target "${l && l.target}": a role, any or all`);
      if (!l.every || !l.prompt) bad(`loop for ${l.target}: "every" and "prompt" are needed`);
      if (t.lead === undefined) bad('"loops" need a "lead": the lead sets them');
    }
  }
  return { ...t, rules: t.rules || [] };
};

/// How strict the team is: light, standard (as the template says) or strict. It scales the budgets
/// and adds rules: strict makes every outward step a request and the review a must.
const RIGOR = {
  light: { budget: 1.5, rules: ['Small, reversible steps inside this folder need no approval; ask with hub_request (risk: routine) only for what leaves it.'] },
  standard: { budget: 1, rules: [] },
  strict: { budget: 0.7, rules: ['Every step that leaves this folder (a message, a publish, a push, a payment) is asked for with hub_request first, risk outward or irreversible.', 'Nothing reaches the owner as done before the review step has passed it, with what was checked.'] },
};
const withRigor = (t, rigor = 'standard') => {
  const r = RIGOR[rigor];
  if (!r) throw new Error('rigor is light, standard or strict');
  const review = t.review ? [`Review: before work reaches the owner as done, ${t.review.by} checks ${t.review.checks}, and says what it checked.`] : [];
  return { ...t, rigor, rules: [...t.rules, ...review, ...r.rules], roles: t.roles.map((x) => (x.budget ? { ...x, budget: Math.round(x.budget * r.budget) } : x)) };
};

/// The template's section for a README or a catalog page: what the team does, its roles, what you approve.
const readme = (t) => {
  const lines = [`### ${t.name}`, '', t.summary, ''];
  lines.push('**Roles**', '');
  for (const r of t.roles) lines.push(`- **${r.name}**${t.lead === r.name ? ' (lead)' : ''}: ${r.does || r.instructions.split(/(?<=\.)\s/)[0]}`);
  if (t.approve && t.approve.length) lines.push('', '**What you approve**', '', ...t.approve.map((a) => `- ${a}`));
  if (t.review) lines.push('', `**Review:** ${t.review.by} checks ${t.review.checks}.`);
  lines.push('', `Start it: \`metacom start --template ${t.name}\``);
  return lines.join('\n') + '\n';
};

/// What a role is told when the team starts: who it is, the team, the goal, its part, the rules.
const briefFor = (t, role, room, goal) => {
  const team = t.roles.map((r) => `- ${r.name}${r.name === role.name ? ' (you)' : ''}: ${r.does || r.instructions.split(/(?<=\.)\s/)[0]}`).join('\n');
  const rules = t.rules.length ? `\nRules:\n${t.rules.map((r) => `- ${r}`).join('\n')}` : '';
  return [
    `You are ${role.name} in room ${room}, a team started from the "${t.name}" template.`,
    `Goal: ${goal}`,
    `The team:\n${team}`,
    `Your part: ${role.instructions}`,
    rules.trim(),
    t.lead === role.name ? 'You lead this team: you manage its loops (hub_loop on any role) and you post the first plan in the room before anyone starts.' : t.lead ? `${t.lead} leads this team: ask it, not the owner, for loops and priorities.` : '',
    'Hand work on with hub_send to the teammate by name; post short progress lines with hub_say; ask the owner only about what the rules say needs them.',
  ]
    .filter(Boolean)
    .join('\n\n');
};

/// A shell word: plain when safe, else in single quotes.
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/// The command that starts a role, as words.
const commandFor = (role, room) => {
  const metacom = [process.execPath, path.join(__dirname, '..', 'bin', 'metacom.js')];
  return [...metacom, room, '-n', role.name, role.agent, ...(role.args || [])];
};

const hasTmux = () => spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/// One tmux session for the room, a window per role, each in `dir`. The hub address and agent token
/// travel with -e: a tmux server that is already running would otherwise give the windows its own.
const launchTmux = (session, roles, room, dir) => {
  const env = ['MC_HUB_URL', 'MC_AGENT_TOKEN', 'MC_TOKEN', 'MC_TRUST', 'MC_NO_TRUST', 'MC_NO_SPEND'].filter((k) => process.env[k]).flatMap((k) => ['-e', `${k}=${process.env[k]}`]);
  if (spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0) throw new Error(`tmux session ${session} already exists (tmux attach -t ${session}, or tmux kill-session -t ${session})`);
  roles.forEach((role, i) => {
    const cmd = commandFor(role, room).map(sh).join(' ');
    const args = i === 0 ? ['new-session', '-d', '-s', session, '-n', role.name, '-c', dir, ...env, cmd] : ['new-window', '-t', session, '-n', role.name, '-c', dir, ...env, cmd];
    const r = spawnSync('tmux', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tmux ${args[0]} failed: ${(r.stderr || '').trim()}`);
  });
};

/// Wait until every role is in the room and ready for its part. A role stuck on a question (a
/// folder-trust dialog, say) is shown once: the owner answers it in the chat, and the wait goes on.
const waitForTeam = async (hub, roles, room, { timeoutMs, log }) => {
  const shown = new Set();
  const end = Date.now() + timeoutMs;
  for (;;) {
    const members = (await hub.api.agents.list({})).filter((m) => m.room === room);
    const ready = roles.filter((r) => members.some((m) => m.name === r.name && m.connected && ['waiting', 'idle', 'done'].includes(m.status)));
    for (const m of members) {
      if (m.status === 'blocked' && roles.some((r) => r.name === m.name) && !shown.has(m.name)) {
        shown.add(m.name);
        log(`  ${m.name} needs you first: answer it in the chat (metacom ${room}), then this goes on`);
      }
      if (m.status !== 'blocked') shown.delete(m.name);
    }
    if (ready.length === roles.length) return;
    if (Date.now() > end) {
      const missing = roles.filter((r) => !ready.includes(r)).map((r) => r.name);
      throw new Error(`not ready after ${Math.round(timeoutMs / 1000)} s: ${missing.join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
};

/// Start a team: launch (tmux) or print the commands, wait for every role, brief each, post the kickoff.
const use = async ({ name, template, room, goal, dir, launch, agentArgs = [], timeoutSec, hub, log, rigor = 'standard' }) => {
  const loaded = withRigor(template || load(name), rigor);
  const t = agentArgs.length ? { ...loaded, roles: loaded.roles.map((r) => ({ ...r, args: [...(r.args || []), ...agentArgs] })) } : loaded;
  room = room || t.room;
  if (!ROOM.test(room)) throw new Error('a room name is letters, digits, dot, dash or underscore');
  if (!goal) throw new Error(`what is the goal? metacom template use ${name} --goal "${t.example || '…'}"`);
  dir = path.resolve(dir || process.cwd());
  const session = `metacom-${room}`.replace(/[.:]/g, '-');
  log(`${t.name}: ${t.roles.length} roles in room ${room}, working in ${dir}`);
  const mode = launch || (hasTmux() ? 'tmux' : 'print');
  if (mode === 'tmux') {
    launchTmux(session, t.roles, room, dir);
    log(`  started in tmux: tmux attach -t ${session}`);
  } else {
    log('  start each in its own terminal, in that folder:');
    // `metacom …` as a person types it, when metacom is on the PATH; the full path otherwise
    const onPath = spawnSync('sh', ['-c', 'command -v metacom'], { encoding: 'utf8' }).status === 0;
    for (const role of t.roles) log(`    ${(onPath ? ['metacom', ...commandFor(role, room).slice(2)] : commandFor(role, room)).map(sh).join(' ')}`);
  }
  log(`  waiting for ${t.roles.map((r) => r.name).join(', ')} to join…`);
  await waitForTeam(hub, t.roles, room, { timeoutMs: (timeoutSec || 300) * 1000, log });
  // a company template: its lead manages the room's loops, each role its budget, the loops set
  const tell = (what) => (error) => log(`  ${what} not set: ${error.message}`);
  if (t.lead) await hub.api.room.manage({ room, names: [t.lead] }).then(() => log(`  ${t.lead} leads ${room}`), tell('the lead'));
  for (const role of t.roles.filter((r) => r.budget)) await hub.api.agents.budget({ name: `${role.name}@${room}`, dollars: role.budget }).catch(tell(`${role.name}'s budget`));
  if (t.roles.some((r) => r.budget)) log(`  budgets: ${t.roles.filter((r) => r.budget).map((r) => `${r.name} $${r.budget}`).join(', ')} a day (${t.rigor})`);
  for (const l of t.loops || []) await hub.api.loops.create({ room, every: l.every, target: l.target, prompt: l.prompt }).then(() => log(`  loop: @${l.target} ${l.every}`), tell(`the loop for ${l.target}`));
  for (const role of t.roles) await hub.api.agents.send({ to: `${role.name}@${room}`, text: briefFor(t, role, room, goal), kind: 'command' });
  await hub.api.room.say({ room, text: `Team "${t.name}" started. Goal: ${goal}\n${t.roles.map((r) => `- ${r.name}: ${r.does || r.instructions.split(/(?<=\.)\s/)[0]}`).join('\n')}` });
  log(`  briefed. Follow it: metacom ${room}`);
  return { room, roles: t.roles.map((r) => r.name), session: mode === 'tmux' ? session : null };
};

/// The company template a business sounds like, from its own words; dev-studio when nothing matches.
const KEYWORDS = [
  ['tender-office', /\b(tenders?|grants?|bids?|procurement|rfps?|calls? for)\b/i],
  ['sales-desk', /\b(sales?|sell|selling|leads?|outreach|prospects?|pipeline|b2b)\b/i],
  ['agency', /\b(agency|campaigns?|clients?|marketing|brand(ing)?|creative|ads?)\b/i],
  ['content-studio', /\b(content|blog|newsletter|social|posts?|videos?|podcast|media|publish)\b/i],
  ['dev-studio', /\b(software|apps?|code|saas|website|api|repo|developers?|engineering)\b/i],
];
const suggest = (business) => (KEYWORDS.find(([, re]) => re.test(String(business || ''))) || ['dev-studio'])[0];
const companies = () => [...all().keys()].filter((n) => {
  try {
    return Boolean(load(n).lead);
  } catch {
    return false;
  }
});

module.exports = { all, load, check, NAME, use, briefFor, commandFor, waitForTeam, withRigor, readme, suggest, companies, RIGOR, BUNDLED, USER };
