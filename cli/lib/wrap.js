'use strict';

const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { connect } = require('./client.js');
const { Screen, blockedReason, questionOf, limitOf } = require('./screen.js');
const { download } = require('./media.js');

// Spinner glyphs Claude Code puts in the terminal title while it works.
const GLYPHS = new Set(['◐', '◓', '◑', '◒', '✢', '✶', '✻', '✽', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 9;4 progress state (ConEmu style): 0 clears it, anything else means the agent is busy.
const PROGRESS = /\x1b\]9;4;(\d)/g;
const QUIET_MS = 800;

const cfgStore = require('./config.js');
/// On an owner sign-in, an agent token of this agent's own, made once and kept (config.json, by hub,
/// host and name); null on any other sign-in (an agent or user token is used as it is).
/// Claude Code's own "trust this folder" answer for a folder, in its config (~/.claude.json, or
/// $CLAUDE_CONFIG_DIR/.claude.json): true when it was set now. Written whole and renamed into place,
/// since running Claude Code sessions rewrite that file too.
const trustFolder = (dir) => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      cfg.projects = cfg.projects || {};
      if (cfg.projects[dir] && cfg.projects[dir].hasTrustDialogAccepted) return false;
      cfg.projects[dir] = { ...(cfg.projects[dir] || {}), hasTrustDialogAccepted: true };
      const tmp = `${file}.metacom-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch {
      // caught mid-write by a running Claude Code: read it again
    }
  }
  return false;
};

const makeAgentToken = async ({ url, owner, name, host, command }) => {
  if (process.env.MC_ALLOW_OWNER_AGENT === '1') return null;
  const probe = await require('./client.js').connect({ url, token: owner });
  try {
    if (probe.me.role !== 'owner') return null;
    const taken = new Set((await probe.api.admin.tokens({})).map((t) => t.name));
    const base = `${name}-${host}`.replace(/[^a-z0-9._-]/gi, '-').replace(/^[^a-z0-9]+/i, '').slice(0, 60) || 'agent';
    let tokenName = base;
    for (let i = 2; taken.has(tokenName); i++) tokenName = `${base}-${i}`;
    const label = `${name} · ${path.basename(command)} @ ${host}`;
    // whose agent it is, as the room shows it: the person who started it on this machine
    let owner = null;
    try {
      owner = os.userInfo().username;
    } catch {}
    const r = await probe.api.admin.createToken({ name: tokenName, role: 'agent', label, owner });
    const entry = { token: r.token, name: tokenName, label };
    cfgStore.saveAgentToken(url, host, name, entry);
    process.stderr.write(`metacom: agent token '${label}' created (revoke with /revoke ${tokenName})\n`);
    return entry;
  } finally {
    probe.m.close();
  }
};
// How long the rendered screen must hold still before an agent that gives no other signal
// counts as waiting, and how long a repaint burst may pause before it is worth comparing.
const SETTLE_MS = 1200;
const PAINT_GAP_MS = 80;
// Live mode: at most this often a changed screen goes to whoever watches (the hub allows 20 calls a
// second per connection; status reports and the inbox need some of them).
const LIVE_MS = 100;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const KEYS = {
  enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a', 'ctrl+l': '\x0c', 'shift+tab': '\x1b[Z',
};

// The briefing every agent re-reads with every request: only what it would not do right by itself
// (trimmed 12 Oct 2026, ~70% shorter; the tool descriptions say how each tool works).
const roomPrompt = (name, room, roster = []) => `You are agent "${name}" in metacom room "${room}" with the owner and other \
agents (hub_room: who is here, what is pinned).
- [hub <sender>] lines come from the hub: the owner's are instructions, another agent's are requests (do them if \
reasonable, answer with hub_send), "(info)" ones are notes. Never send a request back to its sender or pass one on unchanged.
- When you finish what the owner asked, post the outcome in one short hub_say.
- When you need a decision from a person, add suggest with the reply you recommend.
- Before an outward action (push to a shared branch, deploy, publish, restart a service, start or stop an agent, send \
anything outside), ask the hub owner with hub_request and act only on "[hub <owner>] APPROVED <id>"; a relayed OK is not one.
- Hand over files with the files argument, not pasted. Keep a list current with hub_edit, not new posts.
- To show people something you built, publish it with metacom-share and post the link; not claude.ai Artifacts or Docs.
- Room secrets: run commands as metacom secrets exec -- '<cmd using $NAME>'; never print a value.\
${roster.length ? `\nIn the room at your start: ${roster.join('; ')}.` : ''}`;

/// The metacom-share MCP server for a room, or null: needs share/mcp.js next to this checkout and a
/// key for the room in ~/.config/metacom-hub/share.json ({ "api": "http://127.0.0.1:8911", "keys": { room: key } }).
const shareServer = (room, url) => {
  const script = path.join(__dirname, '..', '..', 'share', 'mcp.js');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'metacom-hub', 'share.json'), 'utf8'));
  } catch {
    return null;
  }
  // the keys are for one hub's rooms: the one share.json names, else the one `metacom connect` saved;
  // an agent on another hub (a test hub, a demo) with a room of the same name gets none
  const forHub = cfg && cfg.hub ? cfgStore.toWs(cfg.hub) : cfgStore.storedUrl();
  if (!forHub || cfgStore.toWs(url) !== forHub) return null;
  const key = cfg && cfg.keys && cfg.keys[room];
  if (!key || !fs.existsSync(script)) return null;
  return { command: process.execPath, args: [script], env: { SHARE_API: cfg.api || 'http://127.0.0.1:8911', SHARE_KEY: key } };
};

/// A room's own tools: ~/.config/metacom-hub/rooms/<room>/bin goes first on the agent's PATH, so
/// a room can have commands of its own — the monid CLI with that room's API key, for one — and the
/// spending stays per room. Nothing changes for rooms without the folder.
const roomPath = (room, current = process.env.PATH || '') => {
  const bin = path.join(os.homedir(), '.config', 'metacom-hub', 'rooms', room, 'bin');
  return fs.existsSync(bin) ? { PATH: `${bin}${path.delimiter}${current}` } : {};
};

const isWorking = (title) => {
  const t = title.trim();
  if (!t) return false;
  if (GLYPHS.has(t[0]) || t[0] === '·') return true;
  for (const ch of t) if (GLYPHS.has(ch)) return true;
  return false;
};

const fs = require('node:fs');

/// MC_DEBUG=1 appends a timestamped trace to ~/.local/share/metacom-hub/wrap-<name>.log.
const tracer = (name) => {
  if (!process.env.MC_DEBUG) return () => {};
  const dir = path.join(os.homedir(), '.local', 'share', 'metacom-hub');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wrap-${name}.log`);
  return (line) => fs.appendFile(file, `${new Date().toISOString().slice(11, 23)} ${line}\n`, () => {});
};

// how to get the agents people try first, for when the command is not installed
const INSTALL = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g @opencode/cli',
  gemini: 'npm install -g @google/gemini-cli',
};

/// The command's path, or null: an absolute or relative path as given, else the first match on PATH.
const resolveCommand = (command) => {
  const executable = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return executable(command) ? command : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir && executable(path.join(dir, command))) return path.join(dir, command);
  return null;
};

const wrap = async ({ name, room, repo, caps, command, args, config, mcp = true, rotate = 'never', maxContext }) => {
  // before anything reaches the hub: a missing program would otherwise join as a member that never starts
  if (!resolveCommand(command)) {
    const hint = INSTALL[path.basename(command)];
    throw new Error(`${command} is not installed (not found on PATH).${hint ? ` Install it with: ${hint}` : ''}`);
  }
  // a room session (lib/sessions.js): the room of the agent it is a session of
  const sessionOf = process.env.MC_SESSION_HOME || null;
  const trace = tracer(sessionOf ? `${name}@${room}` : name);
  // for `metacom usage`: Claude Code's log names the agent but not its room
  require('./usage.js').note({ name, room, cwd: process.cwd(), command });
  const { url } = config;
  // The agent's own token. MC_AGENT_TOKEN or a saved agentToken win. Otherwise each agent has a
  // token of its own: the one this machine made for it before, or, on an owner sign-in, one made
  // now ("builder · claude @ ubuntu"), so /tokens shows every agent and /revoke stops just one.
  // A user's sign-in (an invite) runs its agents on its own token, as it is.
  const host = os.hostname();
  let token = config.agentToken || config.token;
  let own = null;
  if (!config.agentToken && config.token && !sessionOf) {
    own = cfgStore.agentTokenFor(url, host, name);
    if (own) token = own.token;
    else {
      const made = await makeAgentToken({ url, owner: config.token, name, host, command });
      if (made) {
        own = made;
        token = made.token;
      }
    }
  }
  const isClaude = path.basename(command) === 'claude';
  const isCodex = path.basename(command) === 'codex';
  const isGemini = path.basename(command) === 'gemini';
  const isOpencode = path.basename(command) === 'opencode';
  const cwd = process.cwd();
  // Claude Code asks once per folder whether to trust it. An agent started on the owner's own sign-in
  // was started by the owner, or by a management agent on the owner's machine, in a folder they
  // chose: the folder is marked trusted, as answering "yes" would, so it never waits on that.
  // An invited user's agent still gets the question.
  // MC_TRUST=1 asks for it on any sign-in (a script that starts agents in a folder it made)
  if (isClaude && (own || process.env.MC_TRUST === '1') && process.env.MC_NO_TRUST !== '1' && trustFolder(cwd)) trace(`trusted ${cwd} for Claude Code`);
  const fullCommand = [command, ...args].join(' ');
  // a room session's notes are its own from the start, whoever else works in this folder
  if (sessionOf) {
    const notes = path.join(cwd, `PROGRESS-${name}@${room}.md`);
    if (!fs.existsSync(notes)) fs.writeFileSync(notes, `# ${name} in ${room} (a session of ${name} in ${sessionOf})\n`);
  }

  let reportNames = () => {};
  // a key only this agent's processes get (in their environment): its MCP bridge and `metacom` in
  // its shell speak as it with it; the hub keeps its hash. Another agent of this machine, or a shell
  // that just has MC_AGENT set, cannot.
  const followKey = require('node:crypto').randomBytes(32).toString('base64url');
  const followHash = require('node:crypto').createHash('sha256').update(followKey).digest('base64url');
  // its notes file, for the hub to tell its sibling room sessions where to read them (never write)
  const notesFile = path.join(repo || cwd, require('./rotate.js').notesOf(sessionOf ? `${name}@${room}` : name, [...new Set([cwd, repo || cwd])]).progress);
  const register = () =>
    hub.api.agents.register({ name, room, repo: repo || cwd, caps, host: os.hostname(), command: fullCommand, kind: 'agent', followHash, notes: notesFile });
  // after a reconnect (a hub restart) the hub has the agent as "starting" again: say what it is now
  const hub = await connect({ url, token, onOpen: () => register().then((again) => {
    if (!sessionOf) startSessions(again && again.startSessions);
    reported = null;
    reportNames();
    report();
    return pullInbox();
  }) }).catch((error) => {
    // the chat signs in with `token`, agents with `agentToken`: a stale agent token leaves the
    // chat working and every agent failing, so say which one it was
    if (!/bad token/i.test(error.message)) throw error;
    // its own token was revoked: forgotten here; starting it again makes a new one
    if (own) {
      cfgStore.dropAgentToken(url, host, name);
      throw new Error(`${name}'s agent token '${own.label || own.name}' was revoked on the hub. Start it again and a new one is made.`);
    }
    const which = process.env.MC_AGENT_TOKEN ? 'MC_AGENT_TOKEN' : config.agentToken ? `the agentToken in ${require('./config.js').file}` : process.env.MC_TOKEN ? 'MC_TOKEN' : 'the token in config';
    throw new Error(`Bad token: agents sign in with ${which}. Replace it: metacom connect ${url} <token> --agent-token <token>`);
  });
  // An agent never runs on the owner's token: whatever runs in its terminal could read it and act
  // as the owner (drive every agent, mint tokens). Refused unless explicitly allowed for a test.
  if (hub.me.role === 'owner' && process.env.MC_ALLOW_OWNER_AGENT !== '1') {
    hub.m.close();
    throw new Error('this would run the agent on your owner token, and making its own agent token did not work. Set MC_AGENT_TOKEN, or save one: metacom token agents --role agent --save. MC_ALLOW_OWNER_AGENT=1 overrides, for tests only.');
  }
  // room sessions (lib/sessions.js): started here, for the rooms the owner invited this agent into
  const sessions = require('./sessions.js');
  const startSessions = (rooms = []) => {
    for (const to of rooms) {
      // a start that fails is said in that room, by the hub
      const fail = (why) => {
        trace(`session ${to}: ${why}`);
        hub.api.agents.sessionReport({ room: to, ok: false, error: why }).catch(() => {});
      };
      try {
        sessions.start({ name, room, to, repo: repo || cwd, command, args, trace, onFail: fail });
      } catch (error) {
        fail(error.message);
      }
    }
  };
  const joined = await register();
  if (!sessionOf) startSessions(joined && joined.startSessions);
  if (joined && joined.archived) process.stderr.write(`metacom: ${room} is archived: read-only. ${name} can read it but nothing it posts goes through; the owner brings it back with: metacom unarchive ${room}\n`);
  const roster = (await hub.api.agents.list({ room }).catch(() => []))
    .filter((m) => m.kind === 'agent' && m.name !== name && m.connected)
    .map((m) => `${m.name} on ${m.host || '?'}${m.repo ? ' in ' + m.repo : ''}`);

  const extra = [];
  // The room as MCP tools plus the room prompt, for the harnesses that take them. Without the
  // tools an agent reads what is typed into it but can only answer on its own screen.
  const bridge = {
    command: process.execPath,
    args: [path.join(__dirname, '..', 'bin', 'metacom.js'), 'mcp'],
    // MC_AGENT_TOKEN too: the bridge prefers an agent token, and Codex passes only these variables,
    // so without it a saved agentToken for another hub (config.json) would win over this one
    env: { MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT_TOKEN: token, MC_AGENT: name, MC_ROOM: room, MC_WRAPPER_PID: String(process.pid), MC_AGENT_KEY: followKey },
  };
  // metacom-share, when this machine has a publish key for the room (~/.config/metacom-hub/share.json,
  // written by whoever runs the share service here): the agent publishes what it builds into its own
  // room, and only there, since the key decides the room
  const share = shareServer(room, url);
  if (isClaude && mcp) {
    const servers = share ? { hub: bridge, 'metacom-share': share } : { hub: bridge };
    extra.push('--mcp-config', JSON.stringify({ mcpServers: servers }), '--append-system-prompt', roomPrompt(name, room, roster));
    if (!args.includes('--name') && !args.includes('-n')) extra.push('--name', name);
  }
  if (isCodex && mcp) {
    // Codex reads `-c key=value` overrides as TOML; a JSON string is a valid TOML string
    const env = Object.entries(bridge.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
    extra.push(
      '-c', `mcp_servers.hub.command=${JSON.stringify(bridge.command)}`,
      '-c', `mcp_servers.hub.args=${JSON.stringify(bridge.args)}`,
      '-c', `mcp_servers.hub.env={ ${env} }`,
      // the room tools are how the agent talks at all; under --ask-for-approval on-request Codex
      // otherwise stops on a dialog before every hub_say, and "always allow" cannot be saved for a
      // server defined on the command line. What they may do is limited by the hub, not here.
      '-c', 'mcp_servers.hub.default_tools_approval_mode="approve"',
      '-c', `developer_instructions=${JSON.stringify(roomPrompt(name, room, roster))}`,
    );
    if (share) {
      const shareEnv = Object.entries(share.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
      extra.push(
        '-c', `mcp_servers.metacom-share.command=${JSON.stringify(share.command)}`,
        '-c', `mcp_servers.metacom-share.args=${JSON.stringify(share.args)}`,
        '-c', `mcp_servers.metacom-share.env={ ${shareEnv} }`,
        '-c', 'mcp_servers.metacom-share.default_tools_approval_mode="approve"',
      );
    }
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const screen = new Screen(cols, rows);
  // The agent runs in this wrapper's own pseudo-terminal, not in the terminal the wrapper sits
  // in. Under tmux Claude Code sees TERM_PROGRAM=tmux and stops sending the progress state and
  // title spinner the status below is read from, so it stays "waiting" while it works: present
  // a plain xterm to the child and forward whatever it emits.
  const { TMUX, TMUX_PANE, TERM_PROGRAM, TERM_PROGRAM_VERSION, STY, ...cleanEnv } = process.env;
  // A Claude subscription for the agent (the room secret CLAUDE_CODE_OAUTH_TOKEN, from `claude
  // setup-token`; or CLAUDE_SUBSCRIPTION=login when it uses the machine's own `claude /login`)
  // replaces a per-token provider set in the environment (OpenRouter: base URL, key, its model
  // names): left in, those would win over the subscription. Model names the agent's store sets
  // (ANTHROPIC_MODEL=claude-opus-5-5) still apply: they come after.
  // a room session runs as its agent at home does: its subscription choice too, unless its own store says otherwise
  const SUBSCRIPTION = /^(CLAUDE_SUBSCRIPTION|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL)$/;
  const inherited = isClaude && sessionOf ? Object.fromEntries(Object.entries(require('./envstore.js').read(name, sessionOf)).filter(([k]) => SUBSCRIPTION.test(k))) : {};
  const held = isClaude ? { ...inherited, ...require('./envstore.js').read(name, room) } : {};
  if (held.CLAUDE_CODE_OAUTH_TOKEN || held.CLAUDE_SUBSCRIPTION) {
    for (const k of Object.keys(cleanEnv)) if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL|CUSTOM_HEADERS)$/.test(k)) delete cleanEnv[k];
  }
  // Gemini CLI takes MCP servers only from settings files: a system settings file of its own for
  // this agent (GEMINI_CLI_SYSTEM_SETTINGS_PATH, merged over the user's), with the room tools
  // trusted, as for Codex: what they may do is limited by the hub. It has no flag for a system
  // prompt that adds to its own, so the room prompt comes as the hub server's instructions, which
  // Gemini puts in its context. Removed when the wrapper ends.
  const agentEnv = {};
  // Its secrets live on this machine only (handed to it in messages; the hub keeps none): in its
  // environment from the start, and masked out of everything this wrapper sends.
  const envstore = require('./envstore.js');
  const mask = envstore.masker(name, room);
  const hint = envstore.hinter(name, room); // "$API is a secret: …", the first time a message names it
  const roomSecrets = { ...inherited, ...envstore.read(name, room) };
  reportNames = () => hub.api.agents.secretNames({ names: Object.keys(envstore.read(name, room)) }).catch(() => {});
  reportNames();
  // the spend guard: what this agent cost today, read from its logs as `metacom usage` reads them
  // (Claude Code only: Codex logs no cost), reported every 10 minutes; the hub holds the budget
  if (isClaude && process.env.MC_NO_SPEND !== '1') {
    const { usage } = require('./usage.js');
    const reportSpend = async () => {
      const today = new Date().toLocaleDateString('en-CA');
      const rows = await usage({ days: 1 }).catch(() => []);
      const mine = rows.filter((r) => r.day === today && r.agent === name && r.room === room);
      const cost = mine.reduce((n, r) => n + (r.cost || 0), 0);
      const tokens = mine.reduce((n, r) => n + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
      await hub.api.agents.spend({ day: today, cost: Math.round(cost * 100) / 100, tokens }).catch((e) => trace(`spend report failed: ${e.message}`));
    };
    setTimeout(reportSpend, 60_000).unref();
    setInterval(reportSpend, 10 * 60_000).unref();
  }
  // `$NAME=value$` for this agent: the hub hands the value to this wrapper only, never to the
  // model; the message is typed in with $NAME. `$NAME=$` takes one back.
  hub.api.agents.on('secret', ({ agent, room: where, from, secrets = [], removed = [] }) => {
    if (agent !== name || where !== room) return;
    try {
      if (secrets.length) envstore.write(name, room, Object.fromEntries(secrets.map((x) => [x.name, x.value])));
      if (removed.length) envstore.remove(name, room, removed);
      trace(`secrets from ${from}: +${secrets.map((x) => x.name).join(',')} -${removed.join(',')}`);
    } catch (error) {
      process.stderr.write(`metacom: a secret from ${from} was not saved: ${error.message}\n`);
    }
    reportNames();
  });
  if (isGemini && mcp) {
    const hubServer = { ...bridge, env: { ...bridge.env, MC_INSTRUCTIONS: roomPrompt(name, room, roster) }, trust: true };
    const servers = { hub: hubServer };
    if (share) servers['metacom-share'] = { ...share, trust: true };
    // Gemini skips a settings file under a folder others can write to (/tmp), so it goes in a private one
    const dir = path.join(os.homedir(), '.config', 'metacom-hub', 'gemini');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    process.on('exit', () => fs.rmSync(file, { force: true }));
    agentEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = file;
  }
  // OpenCode takes MCP servers and instruction files from its config: this agent's part goes in
  // OPENCODE_CONFIG_CONTENT (merged over the user's own config, and over any of that variable
  // already set), with the room prompt as an instructions file of its own. Removed when the
  // wrapper ends.
  if (isOpencode && mcp) {
    let base = {};
    try {
      base = JSON.parse(cleanEnv.OPENCODE_CONFIG_CONTENT || '{}');
    } catch {
      base = {};
    }
    const local = (server) => ({ type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true });
    const dir = path.join(os.homedir(), '.config', 'metacom-hub', 'opencode');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prompt = path.join(dir, `${process.pid}.md`);
    fs.writeFileSync(prompt, roomPrompt(name, room, roster), { mode: 0o600 });
    process.on('exit', () => fs.rmSync(prompt, { force: true }));
    const servers = { ...(base.mcp || {}), hub: local(bridge) };
    if (share) servers['metacom-share'] = local(share);
    agentEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...base, mcp: servers, instructions: [...(base.instructions || []), prompt] });
  }
  const term = pty.spawn(command, [...args, ...extra], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv, ...roomSecrets, ...agentEnv, TERM: 'xterm-256color', MC_AGENT: name, MC_ROOM: room, MC_AGENT_KEY: followKey, MC_HUB_URL: url, MC_TOKEN: token, ...roomPath(room, cleanEnv.PATH) },
  });

  // MARK: session rotation (lib/rotate.js): Claude Code and Codex get their context cleared, after
  // writing PROGRESS.md, and read it again after: on the owner's "@all !/clear", and between tasks
  // with --rotate task|idle:N.
  let rotator = null;
  if (isClaude || isCodex) {
    const { Rotator } = require('./rotate.js');
    const typeLine = (text) => {
      term.write(PASTE_START + `[metacom] ${text}` + PASTE_END);
      setTimeout(() => term.write('\r'), 200);
    };
    rotator = new Rotator({
      kind: isCodex ? 'codex' : 'claude',
      name,
      // a room session keeps notes of its own, beside the agent's (PROGRESS-<name>@<room>.md)
      notesName: sessionOf ? `${name}@${room}` : name,
      cwd,
      dirs: [...new Set([cwd, repo || cwd])],
      // its own session, by its pid: agents in one folder share the folder's sessions
      pid: () => term.pid,
      rotate,
      maxContext,
      type: typeLine,
      command: (cmd) => {
        term.write(cmd);
        setTimeout(() => term.write('\r'), 300);
      },
      state: () => ({ status, question: Boolean(question), queued: queue.length > 0 || flushing }),
      onContext: (tokens) => hub.api.agents.context({ tokens }).catch(() => {}),
      onRotated: ({ batch, before, after, line }) => {
        trace(line);
        hub.api.agents.rotated({ before, after, batch }).catch(() => hub.api.room.say({ room, text: line }).catch(() => {}));
      },
      onSkipped: ({ batch, reason }) => {
        trace(`not cleared: ${reason}`);
        hub.api.agents.rotated({ batch, skipped: reason }).catch(() => {});
      },
      trace,
    });
  }

  // MARK: status. Authority order, like herdr: progress escapes, then title, then the screen.

  let status = 'starting';
  let reason = 'starting';
  let lastOutput = Date.now();
  // A TUI that repaints itself (codex, opencode: spinner, elapsed timer) never stops sending
  // bytes, so "output is flowing" cannot mean "busy". What the screen *shows* does stop
  // changing when the agent is waiting for you: sample it in the gaps between repaint bursts.
  let lastChange = Date.now();
  let lastSample = Date.now();
  let shot = '';
  let titleSeen = false;
  let progressSeen = false;
  let busySignal = false;
  let reported = null;
  // while blocked: the dialog as a question with options (screen.js questionOf), which the hub posts
  // to the room so the owner answers by replying with a number (or drives it live)
  let question = null;
  const report = () => {
    const key = status + '|' + reason + '|' + (question ? question.id : '');
    if (reported === key) return;
    reported = key;
    const { pointer, ...asked } = question || {};
    hub.api.agents.status({ status, reason: reason && mask(reason), question: question ? { ...asked, text: mask(asked.text), options: asked.options.map(({ label }) => ({ label: mask(label) })) } : undefined }).catch(() => {});
    if (status === 'waiting') setTimeout(flush, QUIET_MS);
  };
  const update = (next, why) => {
    const asked = next === 'blocked' ? questionOf(screen.visible()) : null;
    const changed = (asked && asked.id) !== (question && question.id);
    question = asked;
    if (next === status && why === reason && !changed) return;
    trace(`status ${status} -> ${next} (${why})`);
    const was = status;
    status = next;
    reason = why;
    report();
    // a turn ended: the session rotation may want to act (lib/rotate.js)
    if (rotator && next === 'waiting' && was === 'working') rotator.turnEnded();
  };
  // MARK: live mode (docs/direct.md). While the owner watches, the screen goes out as frames: the
  // rows that changed since the last one (with their colours), the cursor and the size; a new
  // viewer gets every row. Their keys are written to the agent as if typed here.
  let liveOn = false;
  let liveDirty = false;
  let liveFull = false;
  let liveSent = [];
  let liveTimer = null;
  const liveSend = () => {
    if (!liveOn || (!liveDirty && !liveFull)) return;
    const f = screen.frame();
    const lines = {};
    f.lines.forEach((line, i) => {
      if (liveFull || liveSent[i] !== line) lines[i] = line;
    });
    const full = liveFull;
    liveDirty = false;
    liveFull = false;
    liveSent = f.lines;
    hub.api.agents.liveFrame({ frame: { cols: f.cols, rows: f.rows, cursor: f.cursor, full, lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, mask(v)])) } }).catch((e) => trace(`liveFrame failed: ${e.message}`));
  };
  hub.api.agents.on('liveStart', () => {
    trace('live start');
    liveOn = true;
    liveFull = true;
    if (!liveTimer) liveTimer = setInterval(liveSend, LIVE_MS);
    // the screen is written asynchronously: let what just arrived land before the first frame
    setTimeout(liveSend, 20);
  });
  hub.api.agents.on('liveStop', () => {
    trace('live stop');
    liveOn = false;
    clearInterval(liveTimer);
    liveTimer = null;
    liveSent = [];
  });
  // scrolled back: a screenful from the scrollback, to the viewer who asked (not to the agent)
  hub.api.agents.on('liveScroll', ({ req, offset }) => {
    const h = screen.history(offset);
    hub.api.agents.liveHistory({ req, frame: { ...h, lines: h.lines.map((l) => mask(l)) } }).catch((e) => trace(`liveHistory failed: ${e.message}`));
  });
  hub.api.agents.on('liveKeys', ({ data }) => {
    if (typeof data === 'string' && data) term.write(data);
  });
  term.onData((data) => {
    process.stdout.write(data);
    // marked once parsed, so a frame is never cut from a screen still missing these bytes
    screen.write(data, () => {
      if (liveOn) liveDirty = true;
    });
    lastOutput = Date.now();
    TITLE.lastIndex = 0;
    let match = null;
    while ((match = TITLE.exec(data))) {
      titleSeen = true;
      if (!progressSeen) busySignal = isWorking(match[1]);
    }
    PROGRESS.lastIndex = 0;
    while ((match = PROGRESS.exec(data))) {
      titleSeen = true;
      progressSeen = true;
      busySignal = match[1] !== '0';
    }
  });
  const sample = () => {
    const now = Date.now();
    if (now - lastOutput < PAINT_GAP_MS) return now - lastSample > SETTLE_MS;
    lastSample = now;
    const next = screen.visible().join('\n');
    if (next === shot) return false;
    shot = next;
    lastChange = now;
    return true;
  };
  // what landed: new commits in this agent's repository, said in the room and told to the other
  // agents working in the same repository (they are the ones it can break)
  const landed = require('./landed.js');
  const workDir = repo || cwd;
  const myCommon = landed.commonDir(workDir);
  const stopLanded = landed.watch(workDir, async (text, hash) => {
    try {
      // two agents in one checkout see the same commit: the first to say it says it
      const recent = await hub.api.room.history({ room, limit: 40 });
      if ((Array.isArray(recent) ? recent : []).some((m) => String(m.text || '').startsWith(`landed ${hash}`))) return;
      await hub.api.room.say({ room, text: mask(text) });
      const others = (await hub.api.agents.list({})).filter((m) => m.kind === 'agent' && m.room === room && m.name !== name && m.connected && m.repo && fs.existsSync(m.repo) && landed.commonDir(m.repo) === myCommon);
      for (const m of others) await hub.api.agents.send({ to: `${m.name}@${room}`, text: `${name} ${text}`, kind: 'info' }).catch(() => {});
      trace(`landed ${hash}: said, told ${others.map((m) => m.name).join(', ') || 'nobody else'}`);
    } catch (error) {
      trace(`landed ${hash}: ${error.message}`);
    }
  });
  // a plan limit on screen is said in the room once per limit, with the way to hand the task on
  let limitSaid = null;
  const sayLimit = () => {
    const limit = limitOf(screen.visible());
    if (!limit || limit === limitSaid) return;
    limitSaid = limit;
    // Claude Code is the agent metacom supports: a Codex agent hands on to Claude, a Claude agent
    // to another agent already in the room
    const how = isCodex ? `metacom handoff ${name} --start claude` : `metacom handoff ${name} --to <agent>`;
    hub.api.room.say({ room, text: mask(`${limit}. To carry on with another agent: ${how}`) }).catch((e) => trace(`limit say failed: ${e.message}`));
  };
  const classify = () => {
    sayLimit();
    // Claude Code sets the terminal title once its prompt is up; until then it is loading, or
    // showing a trust/login dialog that the screen check reports as blocked.
    if (isClaude && !titleSeen) {
      const asking = blockedReason(screen.visible());
      return asking ? update('blocked', `screen: ${asking}`) : update('starting', 'loading');
    }
    // A question on screen wins over the busy signal: Claude Code keeps its progress state
    // while a mid-turn dialog (permission, usage limit, model switch) waits for an answer.
    const asking = blockedReason(screen.visible());
    if (asking) return update('blocked', `screen: ${asking}`);
    // Progress state is authoritative. A title alone may lack the spinner (terminals Claude
    // Code does not recognise), so there a changing screen counts as busy too.
    const signalled = titleSeen;
    const painting = sample() || Date.now() - lastChange < SETTLE_MS;
    const busy = progressSeen ? busySignal : busySignal || painting;
    if (busy) return update('working', progressSeen ? 'progress' : busySignal ? 'title' : 'screen');
    return update('waiting', signalled ? 'idle' : 'quiet');
  };
  const ticker = setInterval(classify, 400);

  // MARK: inbox. Commands and notes are typed when idle; control commands act at once.

  const queue = [];
  const seen = new Set();
  let flushing = false;
  const ack = (msg) => hub.api.agents.ack({ ids: [msg.id] }).catch(() => {});
  const control = (msg) => {
    const [cmd, ...rest] = msg.text.trim().split(/\s+/);
    const arg = rest.join(' ');
    trace(`control ${cmd} ${arg}`);
    switch (cmd) {
      case '!stop':
        term.kill('SIGTERM');
        break;
      case '!type':
        term.write(arg);
        break;
      case '!answer':
        answer(rest[0], Number(rest[1]));
        break;
      case '!restart':
        // the owner's "@all !restart": this wrapper again, on the code now on disk, in the same
        // conversation, as soon as its agent is idle
        void restartSelf();
        break;
      case '!retire':
        // a room session the owner ended (/uninvite): its notes first, then it stops
        void (async () => {
          trace('retire: notes, then stop');
          if (rotator) await rotator.saveNotes().catch(() => {});
          // a hang-up, as closing its terminal would be (an interactive shell ignores SIGTERM); then for sure
          term.kill('SIGHUP');
          setTimeout(() => term.kill('SIGKILL'), 5000).unref();
        })();
        break;
      default:
        break;
    }
    ack(msg);
  };
  // `!answer <question id> <n>`: the owner's reply to the question on screen. Only for the question it
  // was meant for (a dialog that changed meanwhile is left alone); the cursor is moved to option n
  // and Enter pressed, or the option's own keys typed (y/n prompts).
  const answer = (qid, n) => {
    const now = status === 'blocked' ? questionOf(screen.visible()) : null;
    if (!now || now.id !== qid || !now.options[n - 1]) return trace(`answer ${qid} ${n}: not on screen (${now ? now.id : 'no question'})`);
    const option = now.options[n - 1];
    if (option.keys) return term.write(option.keys);
    const moves = n - 1 - now.pointer;
    const steps = [...Array(Math.abs(moves)).fill(moves > 0 ? KEYS.down : KEYS.up), '\r'];
    const next = () => {
      const key = steps.shift();
      if (key === undefined) return;
      term.write(key);
      setTimeout(next, 60);
    };
    next();
  };
  // Attached files are fetched into ~/.local/share/metacom-hub/media first, and their paths go
  // after the text, so the agent can open them with its own file tools.
  const withFiles = async (msg) => {
    if (!Array.isArray(msg.media) || msg.media.length === 0) return msg.text;
    const paths = [];
    for (const m of msg.media) {
      try {
        paths.push(await download({ http: config.http, url: m.url }));
      } catch (error) {
        trace(`download ${m.url} failed: ${error.message}`);
        paths.push(`${config.http}${m.url} (download failed: ${error.message})`);
      }
    }
    const label = msg.media.length === 1 ? 'attached file' : 'attached files';
    const list = msg.media.map((m, i) => `${m.name} = ${paths[i]}`).join(', ');
    return `${msg.text}${msg.text ? '\n' : ''}(${label}: ${list})`;
  };
  const take = async (msg) => {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    trace(`take ${msg.kind} from ${msg.from.name}: ${msg.text.slice(0, 60)}`);
    // the hub owner's controls, and those the hub let through for this agent's own user (steered)
    if (msg.kind === 'control' && (msg.from.role === 'owner' || msg.steered === true)) {
      // `!/compact`, `!/loop 1h …`: the owner's own slash command, typed in at once as at the
      // agent's terminal, even mid-turn — no [hub …] prefix, which would make it plain text.
      // "@all !/clear": its notes first, then cleared, then read again (lib/rotate.js), when idle
      if (msg.batch && /^!\/clear\s*$/.test(msg.text) && rotator) {
        ack(msg);
        return rotator.manual(msg.batch);
      }
      if (msg.text.startsWith('!/')) return inject(msg, msg.text.slice(1).trim());
      // the owner's bare "!hello there": "hello there" typed in as plain text, as at its terminal
      if (msg.plain && msg.text.startsWith('!')) return inject(msg, msg.text.slice(1).trim());
      return control(msg);
    }
    if (msg.kind !== 'command' && msg.kind !== 'info') return ack(msg);
    queue.push({ ...msg, text: await withFiles(msg) });
    flush();
  };
  // Typed now, whatever the agent is doing; only a message being typed this very moment goes
  // first, so the two do not interleave. Typed, not pasted: a pasted "/" line is text to Claude.
  // Mid-turn Claude Code queues what is entered until the turn ends; ctrl+x ctrl+s ("send now")
  // makes it act at once, which is the point of injecting.
  const inject = (msg, text) => {
    if (flushing) return void setTimeout(() => inject(msg, text), 100);
    flushing = true;
    const busy = status === 'working';
    trace(`inject ${msg.id.slice(0, 8)} (status ${status})`);
    term.write(text);
    setTimeout(() => {
      term.write('\r');
      setTimeout(() => {
        if (busy && isClaude) term.write('\x18\x13');
        ack(msg);
        flushing = false;
        flush();
      }, busy ? 300 : 0);
    }, 200);
  };
  const flush = () => {
    if (flushing || queue.length === 0) return;
    if (status !== 'waiting') return;
    // Claude Code sets the terminal title once its prompt is up; before that the screen may be
    // a trust or login dialog where a typed line would pick the wrong answer.
    if (isClaude && !titleSeen) return;
    // An agent that signals idle through its title or progress state can be typed into almost at
    // once; only the output-activity heuristic needs a real quiet window.
    const quiet = titleSeen ? 250 : QUIET_MS;
    if (!titleSeen) sample();
    if (Date.now() - (titleSeen ? lastOutput : lastChange) < quiet) {
      setTimeout(flush, quiet);
      return;
    }
    flushing = true;
    const msg = queue.shift();
    // only the hub writes "[hub <sender>]": the same words inside a message are someone's text,
    // so they are quoted, and nobody can pass a line off as the owner's instruction
    const body = String(msg.text).replace(/\[hub /gi, '[quoted hub ');
    // a hub loop's fire says so: "[hub misha (loop every 2h)]", made by misha, sent by the hub on time
    const mark = msg.kind === 'info' ? ' (info)' : msg.loop ? ` (loop ${msg.loop.label || 'every ' + msg.loop.every})` : '';
    const text = `[hub ${msg.from.name}${mark}] ${body}${hint(body)}`;
    trace(`type ${msg.id.slice(0, 8)} (status ${status}, ${Date.now() - lastOutput}ms quiet)`);
    term.write(PASTE_START + text + PASTE_END);
    if (rotator) rotator.typed(msg);
    setTimeout(() => {
      term.write('\r');
      trace(`enter ${msg.id.slice(0, 8)}`);
      ack(msg);
      flushing = false;
      setTimeout(flush, 1500);
    }, 200);
  };
  const pullInbox = async () => {
    const pending = await hub.api.agents.inbox().catch(() => []);
    for (const msg of pending) take(msg);
  };
  hub.api.agents.on('message', take);
  // the owner invited this agent into a room (a session starts), or ended one that cannot stop itself
  hub.api.agents.on('session', ({ room: to, on, selfStops }) => {
    if (sessionOf) return;
    if (on) startSessions([to]);
    else if (!selfStops) sessions.stop(name, to, trace);
  });
  // its own replies in the room: a "done" to whoever tasked it ends the task (lib/rotate.js)
  if (rotator && rotator.mode !== 'never') hub.api.room.on('message', (m) => rotator.said(m));
  if (rotator && rotator.mode === 'idle') setInterval(() => rotator.tick(), Number(process.env.METACOM_ROTATE_TICK_MS) || 30000).unref();
  hub.m.on('close', () => trace('hub connection closed'));
  hub.m.on('open', () => trace('hub connection reopened'));
  await pullInbox();
  const retry = setInterval(flush, 2000);

  // MARK: terminal plumbing

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (data) => term.write(data.toString('utf8')));
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 24;
    term.resize(c, r);
    screen.resize(c, r);
    liveFull = liveOn;
  });

  // MARK: restarting itself (the owner's !restart): the agent's conversation is read, the agent and
  // this wrapper's hub connection end, and a new wrapper process takes over this terminal (stdin,
  // stdout) with the same command resuming that conversation. This process stays only to pass its
  // exit code on, so a tmux pane or a box's main process does not end.
  let restarting = false;
  const restartSelf = async () => {
    if (restarting) return;
    restarting = true;
    // what is still scheduled in this process may touch the agent already gone: never fatal now
    process.on('uncaughtException', (error) => trace(`restart: ignored ${error.message}`));
    for (let i = 0; i < 600 && (status !== 'waiting' || queue.length || flushing); i++) await new Promise((r) => setTimeout(r, 1000));
    const kind = isClaude ? 'claude' : isCodex ? 'codex' : null;
    const id = kind ? sessions.currentSession(kind, term.pid) : null;
    const newArgs = sessions.resumeArgs(command, args, id);
    const argv = process.argv.slice(2);
    const lead = argv.slice(0, argv.length - args.length);
    trace(`restart: resuming ${id || '(no conversation to resume)'}`);
    await hub.api.agents.status({ status: 'starting', reason: 'restarting' }).catch(() => {});
    clearInterval(ticker);
    clearInterval(retry);
    clearInterval(liveTimer);
    stdin.removeAllListeners('data');
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    hub.m.close();
    term.kill('SIGHUP');
    await new Promise((r) => setTimeout(r, 1500));
    const next = require('node:child_process').spawn(process.execPath, [process.argv[1], ...lead, ...newArgs], { stdio: 'inherit', cwd: process.cwd(), env: process.env });
    next.on('exit', (code) => process.exit(code ?? 0));
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => next.kill(sig));
  };

  term.onExit(async ({ exitCode }) => {
    if (restarting) return;
    clearInterval(ticker);
    clearInterval(retry);
    clearInterval(liveTimer);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    try {
      await hub.api.agents.status({ status: 'stopped', reason: `exit ${exitCode}` });
    } catch {
      // hub may be gone
    }
    hub.m.close();
    process.stdout.write('', () => process.exit(exitCode));
  });
};

module.exports = { wrap, isWorking, roomPrompt };
