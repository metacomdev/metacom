#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const config = require('../lib/config.js');
const { line, tokensTable } = require('../lib/format.js');


const RESERVED = new Set(['connect', 'login', 'history', 'secrets', 'request', 'start', 'token', 'tokens', 'revoke', 'grant', 'ungrant', 'limit', 'agents', 'send', 'say', 'tail', 'rooms', 'read', 'wait', 'seen', 'mcp', 'update', 'hubs', 'archive', 'unarchive', 'template', 'templates', 'usage', 'handoff', 'help', '-h', '--help', 'unsuggest']);

const usage = `metacom – join agents and yourself to metacom (mc is a short alias)

  metacom connect <url> <token> [--room R]   save hub url and token (~/.config/metacom-hub/config.json)
      --agent-token T    token agents on this machine use (role agent); owner token stays for you
      --hub NAME         save it as another hub, beside your default one: the chat's room list
                         shows every saved hub's rooms, and switches hub when you pick one
  metacom hubs [rm NAME | rename NAME NEW]   your saved hubs (the first is the default); forget or rename one
  metacom <room> -n <name> [opts] [-- cmd…]  join the room; with a command, run it (Claude Code: claude) and
                                        type owner instructions into it when it is idle. Without a
                                        command, an interactive chat (--theme dracula, --plain for a bare one,
                                        --hub NAME to open it on another saved hub).
      --repo PATH        repository the agent works in (default: cwd)
      --caps a,b,c       capabilities used for routing, e.g. swift,ios,node
      --rotate never|task|idle:<min>   clear its context by itself, after it writes
                         PROGRESS.md: never (the default; "@all !/clear" in its room does it), when it
                         replies "done" to whoever tasked it or you sign off (task), or after that
                         many idle minutes
      --max-context N    rotate too once its context passes N tokens (default 150000)
                         a model per agent is its own flag: … claude --model <m>
      --no-mcp           do not give claude the hub_* MCP tools
      --worktree         its own git worktree and branch (metacom/<name>, under .metacom/worktrees/),
                         so agents in one repository don't edit the same files; commits it makes are
                         said in the room as "landed …", with the interface lines that changed
  metacom wait <name> [--until a,b] [--timeout S]   block until the agent is waiting/blocked/stopped
  metacom send <name|auto> <text…> [--wait]  instruction to an agent; auto lets the hub pick;
                                             --wait returns when the agent finishes the turn
      --file PATH        attach an image or document (repeatable); the agent gets it as a local path
      !stop  !type text  !/command                control commands: act at once, never typed as text
                                             (owner; !text types "text" in as plain; @all: every agent of the room)
  metacom say <text…> [--room R] [--file P]  post to the room (--suggest "<reply>": the reply you recommend to
                                             the people it names; only they see it, ready to send; it waits 12 h
                                             or --suggest-ttl H, and replaces your older ones to them unless
                                             --keep-older)
  metacom unsuggest <id>                     withdraw the suggestion on your own message (no longer needed)
  metacom secrets [--room R]                  who in the room holds which secrets (names only). Hand one over in
                                             a chat: @agent $NAME=value$ (no @: every agent online in the room);
                                             $NAME=$ takes it back. Kept on each agent's machine; the hub keeps none
  metacom secrets share NAME --to @a[,@b]     (in an agent) hand one of its secrets to other agents: the
                                             value goes from this machine, the agent only types the name
  metacom secrets exec [--only A,B] -- '<cmd>'  (in an agent) run cmd with the room's secrets in its environment;
                                             it writes $NAME, prints show $NAME, the room is told which were used
  metacom secrets put NAME --env F [--as VAR]  (in an agent) set VAR=<the value> in .env file F, keeping its other
                                             lines; --file F writes the bare value. Mode 600; a file git tracks
                                             is refused (--force), one not in .gitignore warned about
  metacom history <id>                       every version of an edited message (id or its first 8 characters)
  metacom tail [--room R]                    follow the room
  metacom rooms [--archived]                 list rooms (--archived: the archived ones)
  metacom archive <room>                     (owner) make a room read-only and put it away; nothing is deleted
  metacom unarchive <room>                   (owner) bring an archived room back
  metacom token <name> --role owner|agent|member   create a token (owner only), prints it once
                         member: a person who is not the owner (a partner)
      --room R           agent or member token usable only in room R (a,b for several)
      --save             store it as this machine's agent token in the config
  metacom tokens                             list tokens (owner only)
  metacom revoke <name|id>                   revoke a token, closing its connections (owner only)
  metacom grant <name> <room,...|all>        let a token into more rooms, or every room (owner only)
  metacom ungrant <name> <room,...>          take rooms from a token; what runs there is closed
  metacom limit <name> <room,...>            set a token's rooms exactly (also limits an unlimited one)
  metacom handoff <agent> --to <other>       an agent at its plan limit passes its task on: the owner's last
                 (or --to <agent>)          instruction, what it said since and its repo's state go to a new
                                             Codex/OpenCode agent in the same folder and room, or one there
      --room R  -n NAME  --agent-args "…"  --print
  metacom request "<action>" [--detail D] [--risk routine|outward|irreversible] [--wait]   ask the hub owner to approve an outward action (push, deploy,
                                             publish, restart); --wait exits 0 approved, 1 declined or expired
  metacom usage --suggest                    per agent: suggested replies accepted as-is, edited, ignored
  metacom usage [--days N] [--all]           tokens and estimated cost per agent per day, from this machine's
                                             Claude Code and Codex logs (--all: sessions outside rooms too),
                                             and the plan limits: who is capped until when, Codex's windows
  metacom template list                      room templates: a team for a kind of job
  metacom template show <name>               its roles, whom each takes instructions from, what each does
  metacom start                              a working team in one command: three questions (your business,
                                             this week's goal, how strict), a company template, the team started
  metacom template use <name> --goal "…" [--rigor light|standard|strict]
                                             start the team in a room: each role in a tmux window (--print
                                             to start them yourself), briefed once all have joined
      --room R  --dir PATH (where they work, default here)  --timeout S (wait to join, default 300)
      --agent-args "…"   added to every role's agent command, e.g. "--permission-mode auto"
      --from metacomdev|URL|FOLDER   list, show or use the shared ones (use asks for --yes)
  metacom template share <name> [--to DIR]   write it to a folder laid out as github.com/metacomdev/templates
                                             (README.md, index.json, templates/<name>.json), for a pull request
  metacom update [--check]                   update this installation (git pull, or npm for a global install)
  --json on any command prints the raw hub reply
`;

const parse = (argv, { command = false } = {}) => {
  const opts = {};
  const rest = [];
  let i = 0;
  let passthrough = false;
  while (i < argv.length) {
    const a = argv[i];
    if (passthrough) {
      rest.push(a);
    } else if (a === '--') {
      passthrough = true;
    } else if (a === '-n' || a === '--name') {
      opts.name = argv[++i];
    } else if (a === '--room') {
      opts.room = argv[++i];
    } else if (a === '--repo') {
      opts.repo = argv[++i];
    } else if (a === '--rotate') {
      opts.rotate = argv[++i];
    } else if (a === '--max-context') {
      opts.maxContext = Number(argv[++i]);
    } else if (a === '--caps') {
      opts.caps = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--accept') {
      // removed (misha, 2026-10-12): every agent takes instructions from whoever reaches it in its
      // room. Still read, so the commands agents were started with keep working.
      i++;
      opts.acceptIgnored = true;
    } else if (a === '--role') {
      opts.role = argv[++i];
    } else if (a === '--agent-token') {
      opts.agentToken = argv[++i];
    } else if (a === '--save') {
      opts.save = true;
    } else if (a === '--check') {
      opts.check = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--wait') {
      opts.wait = true;
    } else if (a === '--detail') {
      opts.detail = argv[++i];
    } else if (a === '--risk') {
      opts.risk = argv[++i];
    } else if (a === '--rigor') {
      opts.rigor = argv[++i];
    } else if (a === '--template') {
      opts.template = argv[++i];
    } else if (a === '--business') {
      opts.business = argv[++i];
    } else if (a === '--file') {
      (opts.files = opts.files || []).push(argv[++i]);
    } else if (a === '--lines') {
      opts.lines = Number(argv[++i]);
    } else if (a === '--until') {
      opts.until = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--timeout') {
      opts.timeout = Number(argv[++i]);
    } else if (a === '--no-mcp') {
      opts.mcp = false;
    } else if (a === '--plain') {
      opts.plain = true;
    } else if (a === '--theme') {
      opts.theme = argv[++i];
    } else if (a === '--hub') {
      opts.hub = argv[++i];
    } else if (a === '--goal') {
      opts.goal = argv[++i];
    } else if (a === '--dir') {
      opts.dir = argv[++i];
    } else if (a === '--launch') {
      opts.launch = argv[++i];
    } else if (a === '--print') {
      opts.launch = 'print';
    } else if (a === '--worktree') {
      opts.worktree = true;
    } else if (a === '--to') {
      opts.to = argv[++i];
    } else if (a === '--suggest') {
      opts.suggest = argv[++i];
    } else if (a === '--suggest-ttl') {
      opts.suggestTtl = Number(argv[++i]);
    } else if (a === '--keep-older') {
      opts.keepOlder = true;
    } else if (a === '--archived') {
      opts.archived = true;
    } else if (a === '--env' || a === '--env-file') {
      // --env: Node itself takes --env-file anywhere on its command line and exits when that file
      // does not exist yet, before metacom runs; so --env-file works only for a file already there
      opts.envFile = argv[++i];
    } else if (a === '--as') {
      opts.as = argv[++i];
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--only') {
      opts.only = (argv[++i] || '').split(',').map((x) => x.trim().replace(/^(?:\$|secret:\/\/)/, '')).filter(Boolean);
    } else if (a === '--from') {
      opts.from = argv[++i];
    } else if (a === '--yes') {
      opts.yes = true;
    } else if (a === '--start') {
      opts.start = argv[++i];
    } else if (a === '--days') {
      opts.days = Number(argv[++i]);
    } else if (a === '--all') {
      opts.all = true;
    } else if (a === '--agent-args') {
      opts.agentArgs = (argv[++i] || '').split(/\s+/).filter(Boolean);
    } else if (a.startsWith('-') && a.length > 1) {
      throw new Error(`unknown option ${a}`);
    } else {
      rest.push(a);
      if (command) passthrough = true;
    }
    i++;
  }
  return { opts, rest };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first || first === 'help' || first === '-h' || first === '--help') {
    process.stdout.write(usage);
    return;
  }
  if (first === 'version' || first === '-v' || first === '--version') {
    const { label } = require('../lib/build.js').build();
    process.stdout.write(`metacom ${label}\n`);
    return;
  }
  // `login` is the old name, kept so scripts and notes that use it go on working
  if (first === 'connect' || first === 'login') {
    const [, url, token] = argv;
    if (!url || !token) throw new Error('usage: metacom connect <url> <token>');
    const { opts } = parse(argv.slice(3));
    if (opts.hub) {
      if (!/^[\w.-]{1,32}$/.test(opts.hub)) throw new Error('a hub name is up to 32 letters, digits, dot, dash or underscore');
      const saved = config.addHub({ name: opts.hub, url, token });
      process.stdout.write(`saved hub ${saved.name} (${saved.url}) in ${config.file}\n`);
      return;
    }
    const saved = config.save({ url, token, room: opts.room, agentToken: opts.agentToken });
    process.stdout.write(`saved ${config.file} (hub ${saved.name}, url ${saved.url}, room ${saved.room})\n`);
    return;
  }
  if (first === 'handoff') {
    const [, from] = argv;
    if (!from || from.startsWith('-')) throw new Error('usage: metacom handoff <agent> --start codex|opencode|claude | --to <agent> [--room R]');
    const { opts } = parse(argv.slice(2));
    const c = config.load();
    const { connect } = require('../lib/client.js');
    const hub = await connect({ url: c.url, token: process.env.MC_HUB_URL ? c.token : c.fileToken || c.token });
    try {
      await require('../lib/handoff.js').handoff({ hub, from, room: opts.room, to: opts.to, agent: opts.start, name: opts.name, agentArgs: opts.agentArgs, launch: opts.launch, timeoutSec: opts.timeout, log: (l) => process.stdout.write(l + '\n') });
    } finally {
      hub.m.close();
    }
    return;
  }
  if (first === 'usage' && argv.includes('--suggest')) {
    // how each agent's suggested replies fared, from the hub (owner): accepted as they were,
    // edited, or ignored (no reply tied to them yet)
    const c = config.load();
    const { connect } = require('../lib/client.js');
    const hub = await connect({ url: c.url, token: process.env.MC_HUB_URL ? c.token : c.fileToken || c.token });
    try {
      const by = await hub.api.room.suggestStats({});
      const names = Object.keys(by).sort();
      if (!names.length) process.stdout.write('no suggested replies yet\n');
      else {
        const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
        process.stdout.write(`${'agent'.padEnd(18)} ${'suggested'.padStart(9)} ${'accepted'.padStart(9)} ${'edited'.padStart(7)} ${'ignored'.padStart(8)}  accepted as-is\n`);
        for (const n of names) {
          const x = by[n];
          process.stdout.write(`${n.padEnd(18)} ${String(x.suggested).padStart(9)} ${String(x.accepted).padStart(9)} ${String(x.edited).padStart(7)} ${String(x.ignored).padStart(8)}  ${pct(x.accepted, x.suggested)}\n`);
        }
        process.stdout.write('ignored: no reply tied to it yet (answered otherwise, or still waiting)\n');
      }
    } finally {
      hub.m.close();
    }
    return;
  }
  if (first === 'usage') {
    // read from this machine's agent logs only; no hub needed
    const { opts } = parse(argv.slice(1));
    const { report, format } = require('../lib/usage.js');
    const { rows, limits } = await report({ days: opts.days > 0 ? opts.days : 7, all: Boolean(opts.all) });
    // and, when the hub answers, each agent's context now and how often it was rotated
    const agents = await (async () => {
      try {
        const cfg = require('../lib/config.js').load();
        if (!cfg.url || !(cfg.token || cfg.fileToken)) return null;
        const hub = await Promise.race([require('../lib/client.js').connect({ url: cfg.url, token: cfg.token || cfg.fileToken }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
        const list = (await hub.api.agents.list({})).filter((m) => m.kind === 'agent' && m.ctx !== undefined);
        hub.m.close();
        return list;
      } catch {
        return null;
      }
    })();
    if (opts.json) return void process.stdout.write(JSON.stringify({ rows, limits, context: agents }, null, 2) + '\n');
    process.stdout.write(format(rows, limits));
    if (agents && agents.length) {
      const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
      process.stdout.write('\ncontext now (each turn reads it again; rotation clears it between tasks)\n');
      for (const a of agents.sort((x, y) => (y.ctx || 0) - (x.ctx || 0))) process.stdout.write(`  ${`${a.name}@${a.room}`.padEnd(26)} ${k(a.ctx || 0).padStart(6)}   ${a.rotations ? `rotated ${a.rotations}×` : 'not rotated yet'}\n`);
    }
    return;
  }
  if (first === 'start') {
    // a working team in one command: three questions, a company template, the team started
    const templates = require('../lib/templates.js');
    const { opts } = parse(argv.slice(1));
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    const rl = tty ? require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout }) : null;
    const ask = async (q, fallback) => {
      if (!rl) return fallback;
      const a = (await rl.question(q)).trim();
      return a || fallback;
    };
    try {
      const business = opts.business || (await ask('1/3 What is your business, in a line? ', ''));
      const suggested = opts.template || templates.suggest(business);
      const names = templates.companies();
      let name = suggested;
      if (rl && !opts.template) {
        process.stdout.write(`    teams: ${names.map((n) => (n === suggested ? `[${n}]` : n)).join('  ')}\n`);
        name = await ask(`    which team? (enter for ${suggested}) `, suggested);
      }
      if (!names.includes(name)) throw new Error(`no company template ${name}: ${names.join(', ')}`);
      const t = templates.load(name);
      const goal = opts.goal || (await ask(`2/3 ${t.goal} `, ''));
      const rigor = opts.rigor || (await ask('3/3 How strict? light / standard / strict (enter for standard) ', 'standard'));
      if (rl) rl.close();
      if (!business || !goal) throw new Error('usage: metacom start --business "what you do" --goal "this week\'s goal" [--template agency|tender-office|content-studio|dev-studio|sales-desk] [--rigor light|standard|strict] [--room R] [--dir PATH]');
      if (!templates.RIGOR[rigor]) throw new Error('how strict: light, standard or strict');
      const c = config.load();
      const { connect } = require('../lib/client.js');
      const hub = await connect({ url: c.url, token: process.env.MC_HUB_URL ? c.token : c.fileToken || c.token });
      try {
        const r = await templates.use({ name, room: opts.room, goal: `${business}. This week: ${goal}`, dir: opts.dir, launch: opts.launch, timeoutSec: opts.timeout, rigor, hub, log: (l) => process.stdout.write(l + '\n') });
        process.stdout.write(`\n✓ Your ${name} team is working in room ${r.room}. Watch and steer it: ${c.http.replace(/\/$/, '')}/${r.room}  (or: metacom ${r.room})\n`);
      } finally {
        hub.m.close();
      }
    } finally {
      if (rl) rl.close();
    }
    return;
  }
  if (first === 'template' || first === 'templates') {
    const templates = require('../lib/templates.js');
    const catalog = require('../lib/catalog.js');
    const [, sub = 'list'] = argv;
    const which = argv[2] && !argv[2].startsWith('-') ? argv[2] : undefined;
    const { opts } = parse(argv.slice(which ? 3 : 2));
    if (sub === 'share') {
      if (!which) throw new Error('usage: metacom template share <name> [--to <folder>]');
      const r = catalog.share(which, opts.to ? path.resolve(opts.to) : catalog.DEFAULT_DIR);
      process.stdout.write(`${r.changed ? 'wrote' : 'unchanged:'} ${r.file}\n${r.dir}: README.md and index.json list ${r.count} template${r.count === 1 ? '' : 's'}\n`);
      return;
    }
    if (opts.from && sub === 'list') {
      const { where, entries } = await catalog.list(opts.from);
      for (const e of entries) process.stdout.write(`${e.name.padEnd(18)} ${(e.roles || []).map((r) => r.name).join(', ').padEnd(34)} ${String(e.summary || '').split(/(?<=\.)\s/)[0]}\n`);
      process.stdout.write(`\n${where}\nmetacom template show <name> --from ${opts.from} · metacom template use <name> --from ${opts.from} --goal "…"\n`);
      return;
    }
    if (sub === 'list') {
      for (const [name] of templates.all()) {
        const t = templates.load(name);
        process.stdout.write(`${name.padEnd(18)} ${t.roles.map((r) => r.name).join(', ').padEnd(34)} ${t.source === 'yours' ? '(yours) ' : ''}${t.summary.split(/(?<=\.)\s/)[0]}\n`);
      }
      process.stdout.write(`\nmetacom template show <name> · metacom template use <name> --goal "…" · your own: ${templates.USER}/<name>.json\n`);
      return;
    }
    if (!which) throw new Error(`usage: metacom template ${sub} <name>`);
    const t = opts.from ? await catalog.get(which, opts.from) : templates.load(which);
    const from = opts.from ? ` --from ${opts.from}` : '';
    // someone else's team runs agents here: look at it before it starts
    if (sub === 'show' || (sub === 'use' && opts.from && !opts.yes)) {
      process.stdout.write(`${t.name}: ${t.summary}\nroom ${t.room} · ${t.file}\n\n`);
      for (const r of t.roles) process.stdout.write(`${r.name}  (${[r.agent, ...(r.args || [])].join(' ')})\n  ${r.instructions}\n\n`);
      if (t.rules.length) process.stdout.write(`rules:\n${t.rules.map((r) => `  - ${r}`).join('\n')}\n\n`);
      if (sub === 'use') {
        process.stdout.write(`${t.file} is a shared template: these agents would start here with what it tells them. Start it with --yes.\n`);
        process.exitCode = 1;
      } else process.stdout.write(`e.g. metacom template use ${t.name}${from} --goal "${t.example || '…'}"\n`);
      return;
    }
    if (sub !== 'use') throw new Error('usage: metacom template list | show <name> | use <name> --goal "…" | share <name> [--to <folder>]  (list, show, use: --from metacomdev|<index url>|<folder>)');
    const c = config.load();
    // each agent starts on a token of its own (the wrapper makes it); the briefing is yours
    const { connect } = require('../lib/client.js');
    // yours, as for the chat; with MC_HUB_URL set, the MC_TOKEN that goes with it
    const hub = await connect({ url: c.url, token: process.env.MC_HUB_URL ? c.token : c.fileToken || c.token });
    try {
      await templates.use({ name: which, template: opts.from ? t : undefined, room: opts.room, goal: opts.goal, dir: opts.dir, launch: opts.launch, agentArgs: opts.agentArgs, timeoutSec: opts.timeout, rigor: opts.rigor, hub, log: (l) => process.stdout.write(l + '\n') });
    } finally {
      hub.m.close();
    }
    return;
  }
  if (first === 'hubs') {
    if (argv[1] === 'rename') {
      const [, , from, to] = argv;
      if (!from || !to) throw new Error('usage: metacom hubs rename <name> <new name>');
      if (!/^[\w.-]{1,32}$/.test(to)) throw new Error('a hub name is up to 32 letters, digits, dot, dash or underscore');
      if (!config.renameHub(from, to)) throw new Error(`no saved hub ${from}; see metacom hubs`);
      process.stdout.write(`renamed hub ${from} to ${to}\n`);
      return;
    }
    if (argv[1] === 'rm') {
      if (!argv[2]) throw new Error('usage: metacom hubs rm <name>');
      if (!config.removeHub(argv[2])) throw new Error(`no saved hub ${argv[2]} (the default hub is replaced with metacom connect)`);
      process.stdout.write(`forgot hub ${argv[2]}\n`);
      return;
    }
    const c = config.load();
    for (const h of [{ name: c.name, http: c.http, def: true }, ...c.hubs]) process.stdout.write(`${h.name.padEnd(16)} ${h.http}${h.def ? '  (default)' : ''}\n`);
    return;
  }
  if (first === 'update') {
    const { opts } = parse(argv.slice(1));
    const r = require('../lib/update.js').update({ check: Boolean(opts.check) });
    if (opts.json) return process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    const where = r.kind === 'git' ? r.repo : 'npm';
    process.stdout.write(`metacom ${r.version} (${where}): ${r.message}\n`);
    if (r.log && r.log.length && r.state !== 'updated') for (const l of r.log) process.stdout.write(`  ${l}\n`);
    if (r.state === 'updated') {
      if (r.head) process.stdout.write(`  now at ${r.head}\n`);
      if (r.installed) process.stdout.write('  dependencies reinstalled\n');
      process.stdout.write('  restart the chat and any agents to pick it up\n');
    }
    if (r.state === 'failed') process.exitCode = 1;
    return;
  }
  if (first === 'mcp') {
    const { serveMcp } = require('../lib/mcp.js');
    await serveMcp(config.load());
    return;
  }

  const cfg = config.load();
  const { connect } = require('../lib/client.js');

  if (!RESERVED.has(first)) {
    const { opts, rest } = parse(argv.slice(1), { command: true });
    const room = first;
    const name = opts.name || os.userInfo().username;
    if (rest.length === 0) {
      const { chat } = require('../lib/chat.js');
      // The chat is you, not an agent: the token saved by `metacom connect` wins over MC_TOKEN,
      // which the wrapper exports into agent sessions and any shell opened from them.
      let hub = { name: cfg.name, url: cfg.url, http: cfg.http, token: cfg.fileToken || cfg.token };
      if (opts.hub) {
        hub = config.hub(opts.hub);
        if (!hub) throw new Error(`no saved hub ${opts.hub}; see metacom hubs`);
      }
      await chat({ name, room, config: { ...cfg, ...hub, room }, plain: opts.plain, theme: opts.theme });
      return;
    }
    if (opts.hub) throw new Error('--hub opens the chat on another hub; agents join the default hub (metacom connect)');
    if (opts.worktree) {
      // its own checkout and branch, so agents in one repository don't edit the same files in place
      const wt = require('../lib/landed.js').worktree(process.cwd(), name);
      process.chdir(wt.dir);
      opts.repo = wt.dir;
      process.stderr.write(`metacom: ${name} works in ${wt.dir} (branch ${wt.branch}${wt.created ? ', new' : ''}); merge it when it is done: git merge ${wt.branch}\n`);
    }
    const { wrap } = require('../lib/wrap.js');
    if (opts.acceptIgnored) process.stderr.write('metacom: --accept was removed and is ignored: an agent takes instructions from whoever reaches it in its room\n');
    if (opts.rotate) require('../lib/rotate.js').parseRotate(opts.rotate); // a wrong value says so now, not later
    await wrap({ name, room, repo: opts.repo, caps: opts.caps || [], command: rest[0], args: rest.slice(1), config: cfg, mcp: opts.mcp !== false, rotate: opts.rotate, maxContext: opts.maxContext });
    return;
  }

  const { opts, rest } = parse(argv.slice(1));
  const hub = await connect({ url: cfg.url, token: cfg.token });
  // run from inside a wrapped agent (codex or opencode saying something through the shell): speak as
  // that agent, so its room is its room, rather than as a bare token that may use no room at all
  // (only with the agent's own key: a shell that merely has MC_AGENT set speaks as its token)
  if (process.env.MC_AGENT && process.env.MC_ROOM) {
    await hub.api.agents.register({ name: process.env.MC_AGENT, room: process.env.MC_ROOM, follow: true, key: process.env.MC_AGENT_KEY }).catch((error) => {
      if (/own processes/.test(error.message)) process.stderr.write(`metacom: not speaking as ${process.env.MC_AGENT}: ${error.message}\n`);
    });
  }
  const done = () => {
    hub.m.close();
    process.stdout.write('', () => process.exit(process.exitCode ?? 0));
  };
  const out = (s) => process.stdout.write(s + '\n');
  const show = (value, render) => out(opts.json ? JSON.stringify(value, null, 2) : render(value));
  const uploads = async () => {
    if (!opts.files || opts.files.length === 0) return undefined;
    const { upload, resolvePath } = require('../lib/media.js');
    const media = [];
    for (const f of opts.files) media.push(await upload({ http: cfg.http, token: cfg.token, file: resolvePath(f) }));
    return media;
  };
  try {
    switch (first) {
      case 'agents':
      case 'read':
      case 'seen':
        // removed in 0.1.0: live mode shows an agent and its screen; kept reserved so the
        // word is never taken for a room name
        throw new Error(`metacom ${first} was removed: open the chat (metacom <room>) and use /live <name>`);
      case 'rooms': {
        if (opts.archived) {
          show(await hub.api.room.list({ archived: true }), (rooms) =>
            rooms.length ? rooms.map((r) => `${r.room.padEnd(16)} archived ${r.archivedAt.slice(0, 10)} by ${r.archivedBy} · ${r.messages} message${r.messages === 1 ? '' : 's'} · last ${r.last.replace('T', ' ').slice(0, 16)}`).join('\n') : 'no archived rooms');
          break;
        }
        const [rooms, archived] = await Promise.all([hub.api.room.list({}), hub.api.room.list({ archived: true }).catch(() => [])]);
        show(rooms, (list) =>
          list.map((r) => `${r.room.padEnd(16)} ${r.online}/${r.agents} online, ${r.working} working, ${r.blocked} blocked, ${r.attention} done`).join('\n') + (archived.length ? `\n${archived.length} archived room${archived.length === 1 ? '' : 's'}` : ''));
        break;
      }
      case 'archive':
      case 'unarchive': {
        // nothing is deleted: an archived room is read-only, its log where it was
        const [which] = rest;
        if (!which) throw new Error(`usage: metacom ${first} <room>`);
        const r = await hub.api.room[first]({ room: which });
        show(r, (x) => (x.unchanged ? `${x.room} is already archived` : x.archived ? `${x.room} archived: read-only, its log kept${x.agents && x.agents.length ? ` · told ${x.agents.join(', ')}` : ''} · metacom unarchive ${x.room} brings it back` : `${x.room} is back from the archive`));
        break;
      }
      case 'wait': {
        const [name] = rest;
        if (!name) throw new Error('usage: metacom wait <name> [--until a,b] [--timeout S]');
        const r = await hub.api.agents.wait({ name, until: opts.until, timeoutMs: (opts.timeout || 600) * 1000 });
        show(r, (x) => (x.timeout ? `timeout, ${x.name} is ${x.status}` : `${x.name} is ${x.status}${x.reason ? ' (' + x.reason + ')' : ''} after ${Math.round(x.elapsedMs / 1000)}s`));
        break;
      }
      case 'send': {
        const [to, ...words] = rest;
        const text = words.join(' ');
        if (!to || (!text && !opts.files)) throw new Error('usage: metacom send <name|auto> <text…> [--file PATH]');
        const wait = opts.wait ? { timeoutMs: (opts.timeout || 600) * 1000 } : null;
        const media = await uploads();
        if (to === 'auto') {
          const r = await hub.api.agents.dispatch({ text, room: opts.room, media });
          show(r, (x) => `→ ${x.agent} (${x.reason})${x.delivered ? '' : ', queued'}`);
        } else {
          const r = await hub.api.agents.send({ to, text, kind: 'command', wait, media, suggest: opts.suggest, suggestTtl: opts.suggestTtl, keepOlder: opts.keepOlder });
          show(r, (x) => `${x.delivered ? 'delivered' : 'queued'} → ${x.to}${x.turn ? (x.turn.stalled ? ', but nothing happened (stalled)' : `, now ${x.turn.status}`) : ''}`);
        }
        break;
      }
      case 'unsuggest': {
        const [mid] = rest;
        if (!mid) throw new Error('usage: metacom unsuggest <message id>');
        await hub.api.room.unsuggest({ id: mid });
        out(`withdrawn the suggestion on ${mid}`);
        break;
      }
      case 'say': {
        const text = rest.join(' ');
        if (!text && !opts.files) throw new Error('usage: metacom say <text…> [--file PATH]');
        // run by an agent: the values it holds never leave in what it says
        const said = process.env.MC_AGENT && process.env.MC_ROOM ? require('../lib/envstore.js').masker(process.env.MC_AGENT, process.env.MC_ROOM)(text) : text;
        const r = await hub.api.room.say({ room: opts.room || cfg.room, text: said, media: await uploads(), suggest: opts.suggest, suggestTtl: opts.suggestTtl, keepOlder: opts.keepOlder });
        if (r && r.handed) out(`🔒 handed to ${r.handed.to.join(', ')}${r.handed.missed.length ? ` (not online: ${r.handed.missed.join(', ')})` : ''}`);
        break;
      }
      case 'request': {
        // ask the hub owner to approve an outward action; --wait: exit 0 approved, 1 declined or expired
        const action = rest.join(' ').trim();
        if (!action) throw new Error('usage: metacom request "<action>" [--detail "<what the owner needs to decide>"] [--wait] [--timeout SECONDS]');
        const masker = process.env.MC_AGENT && process.env.MC_ROOM ? require('../lib/envstore.js').masker(process.env.MC_AGENT, process.env.MC_ROOM) : (t) => t;
        const r = await hub.api.agents.request({ room: opts.room || cfg.room, action: masker(action), detail: opts.detail && masker(opts.detail), risk: opts.risk });
        out(`request ${r.id}: asked the owner`);
        if (!opts.wait) break;
        const until = Date.now() + (opts.timeout || 24 * 3600) * 1000;
        for (;;) {
          const now = await hub.api.agents.requestStatus({ id: r.id });
          if (now.status !== 'open') {
            out(`request ${r.id}: ${now.status}${now.by ? ` by ${now.by}` : ''}`);
            process.exitCode = now.status === 'approved' ? 0 : 1;
            break;
          }
          if (Date.now() > until) {
            out(`request ${r.id}: still open after ${opts.timeout}s`);
            process.exitCode = 2;
            break;
          }
          await new Promise((done) => setTimeout(done, 3000));
        }
        break;
      }
      case 'secrets': {
        const [sub = 'list'] = rest;
        if (sub === 'list') {
          const r = await hub.api.room.secrets({ room: opts.room || process.env.MC_ROOM || cfg.room });
          if (!r.agents.length) out(`no agent in ${r.room} holds a secret · hand one over in a message: @agent $NAME=value$ (no @: every agent in the room)`);
          for (const a of r.agents) out(`${a.agent.padEnd(16)} ${a.names.map((n) => `$${n}`).join(', ')}${a.connected ? '' : '  (offline)'}`);
          break;
        }
        // an agent's secrets are on its own machine; the hub keeps none
        const envstore = require('../lib/envstore.js');
        const me = process.env.MC_AGENT;
        const here = opts.room || process.env.MC_ROOM;
        if (!me || !here) throw new Error(`metacom secrets ${sub} runs inside an agent (its wrapper sets MC_AGENT and MC_ROOM)`);
        const local = envstore.read(me, here);
        if (sub === 'share') {
          // the value goes from this machine to the agents named, never through this agent's model
          const [, which] = rest;
          const to = (opts.to || '').split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
          if (!which || !to.length) throw new Error('usage: metacom secrets share NAME --to @agent[,@agent2]');
          const key = which.replace(/^\$/, '');
          if (!local[key]) throw new Error(`${me} holds no $${key} on this machine`);
          const r = await hub.api.room.say({ room: here, text: `${to.map((t) => `@${t}`).join(' ')} $${key}=${local[key]}$`, share: true });
          out(`$${key} handed to ${(r.handed && r.handed.to.join(', ')) || to.join(', ')}`);
          break;
        }
        if (sub === 'put') {
          // the value goes from this machine's store into the file; this prints the name only
          const secrets = require('../lib/secrets.js');
          const key = secrets.nameOf(rest[1]);
          if (!key) throw new Error('usage: metacom secrets put NAME --env PATH [--as VAR] [--force] | --file PATH   (NAME, $NAME or secret://NAME)');
          if (!local[key]) throw new Error(`${me} holds no $${key} on this machine`);
          const r = secrets.put({ name: key, value: local[key], envFile: opts.envFile, file: (opts.files || [])[0], as: opts.as, force: Boolean(opts.force) });
          for (const w of r.warnings) process.stderr.write(`metacom: warning: ${w}\n`);
          await hub.api.agents.secretsUsed({ names: [key], purpose: 'put', where: r.path }).catch(() => {});
          out(r.said);
          break;
        }
        if (sub !== 'exec' || rest.length < 2) throw new Error("usage: metacom secrets [list] · metacom secrets exec [--only NAME,…] -- '<command using $NAME>' · metacom secrets put NAME --env PATH [--as VAR] · metacom secrets share NAME --to @agent");
        const names = opts.only || Object.keys(local);
        const missing = names.filter((n) => !(n in local));
        if (missing.length) throw new Error(`${me} holds no ${missing.map((n) => `$${n}`).join(', ')} on this machine`);
        const values = Object.fromEntries(names.map((n) => [n, local[n]]));
        // the room is told which names were used; the values stay here
        if (names.length) await hub.api.agents.secretsUsed({ names, purpose: 'exec' }).catch(() => {});
        hub.m.close();
        const code = await require('../lib/secrets.js').run(rest.slice(1), values);
        process.exit(code);
      }
      case 'history': {
        const [which] = rest;
        if (!which) throw new Error('usage: metacom history <message id, or its first 8 characters>');
        const r = await hub.api.room.versions({ id: which });
        show(r, () => r.versions.map((v) => `v${v.rev}  ${v.ts.replace('T', ' ').slice(0, 19)}  ${v.from.name}\n${v.text.replace(/^/gm, '  ')}`).join('\n\n') + `\n\n${r.id} in ${r.room}: ${r.versions.length} version${r.versions.length === 1 ? '' : 's'}, the last one shown in the room`);
        break;
      }
      case 'tail': {
        const room = opts.room || cfg.room;
        await hub.api.room.join({ room });
        const render = (m) => (opts.json ? JSON.stringify(m) : line(m, cfg.http));
        for (const m of await hub.api.room.history({ room, limit: 20 })) out(render(m));
        hub.api.room.on('message', (m) => out(render(m)));
        return;
      }
      case 'token': {
        const [name] = rest;
        if (!name || !opts.role) throw new Error('usage: metacom token <name> --role owner|agent|member [--room R]');
        // --room limits an agent token to that room (a,b for several)
        const rooms = opts.room ? String(opts.room).split(',').filter(Boolean) : undefined;
        const r = await hub.api.admin.createToken({ name, role: opts.role, rooms });
        if (opts.json && !opts.save) {
          out(JSON.stringify({ name: r.record.name, role: r.record.role, rooms: r.record.rooms || null, token: r.token }));
        } else if (opts.save && opts.role === 'agent') {
          config.save({ agentToken: r.token });
          out(`agent token for ${r.record.name} saved to ${config.file}`);
        } else {
          out(`token for ${r.record.name} (${r.record.role}${r.record.rooms ? ', only ' + r.record.rooms.join(', ') : ''}), shown once:\n${r.token}`);
        }
        break;
      }
      case 'tokens': {
        out(tokensTable(await hub.api.admin.tokens({})));
        break;
      }
      case 'revoke': {
        // by name when only one token has it, else by id
        const [which] = rest;
        if (!which) throw new Error('usage: metacom revoke <token name or id>');
        const r = await hub.api.admin.revokeToken({ token: which });
        out(`revoked ${r.name}; ${r.closed || 0} connection${r.closed === 1 ? '' : 's'} closed, and it cannot sign in again`);
        break;
      }
      case 'grant':
      case 'ungrant':
      case 'limit': {
        const [which, where] = rest;
        if (!which || !where) throw new Error(`usage: metacom ${first} <token name or id> <room,room${first === 'grant' ? '|all' : ''}>`);
        const rooms = where.split(',').filter(Boolean);
        const args = first === 'grant' ? (where === 'all' ? { all: true } : { add: rooms }) : first === 'ungrant' ? { remove: rooms } : { set: rooms };
        const r = await hub.api.admin.setRooms({ token: which, ...args });
        out(`${r.name} now works in ${r.rooms ? r.rooms.join(', ') : 'every room'}${r.closed ? `; ${r.closed} connection${r.closed === 1 ? '' : 's'} in other rooms closed` : ''}`);
        break;
      }
      default:
        throw new Error(`unknown command ${first}`);
    }
  } finally {
    if (first !== 'tail') done();
  }
};

main().catch((error) => {
  process.stderr.write(`metacom: ${error.message}\n`);
  process.exit(1);
});
