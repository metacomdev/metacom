'use strict';

// `metacom usage`: tokens and cost per agent per day, read from the agents' own local logs, the way
// ccusage reads Claude Code's. Nothing is sent anywhere.
//   Claude Code: ~/.claude/projects/<project>/<session>.jsonl (and its subagents/), where each reply
//     carries its token usage and the wrapper's `--name` is recorded (custom-title, agent-name). Its
//     "cost-state" lines keep Claude Code's own running cost per model (API list prices) but only now
//     and then, so cost is estimated: each model's rate is pooled from all those lines on this machine,
//     with the standard ratios (output 5x input, cache read 0.1x, cache write 1.25x), and applied to
//     each day's tokens.
//   Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, with cumulative token counts; the room prompt
//     the wrapper gives it names the agent and its room. Codex logs no cost, so only tokens.
// Claude's log has no room: the wrapper notes name, room and folder in ~/.local/share/metacom/agents.jsonl
// when it starts one, and a session takes the room of the latest note for its name and folder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude', 'projects');
const CODEX = path.join(HOME, '.codex', 'sessions');
const REGISTRY = path.join(HOME, '.local', 'share', 'metacom', 'agents.jsonl');

/// The wrapper's note when it starts an agent: what usage needs to give a Claude session its room.
const note = ({ name, room, cwd, command }) => {
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    fs.appendFileSync(REGISTRY, JSON.stringify({ at: new Date().toISOString(), name, room, cwd, command }) + '\n');
  } catch {
    // usage only loses the room; the agent runs regardless
  }
};

const registry = () => {
  try {
    return fs
      .readFileSync(REGISTRY, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const day = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

/// Every .jsonl under dir changed since `since` (ms), walking at most `depth` levels.
const files = (dir, since, depth) => {
  const out = [];
  const walk = (d, left) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(p).mtimeMs >= since) out.push(p);
        } catch {}
      }
    }
  };
  walk(dir, depth);
  return out;
};

const lines = async function* (file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
};

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, models: new Set(), weighted: new Map() });

// a metacom name: what the wrapper passes as --name. Claude Code's own session titles have spaces.
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
const baseModel = (m) => String(m).replace(/\[.*\]$/, '');
// a reply's tokens in input-token units, at the standard price ratios
const weigh = (u) => u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheWrite;

/// $ per input token for each Claude model, pooled from every cost-state line on this machine.
const claudeRates = async () => {
  const cost = new Map();
  const tokens = new Map();
  for (const file of files(CLAUDE, 0, 1)) {
    for await (const line of lines(file)) {
      if (!line.includes('"cost-state"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      for (const [model, u] of Object.entries(o.modelUsage || {})) {
        const w = weigh({ input: u.inputTokens || 0, output: u.outputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, cacheWrite: u.cacheCreationInputTokens || 0 });
        const c = (u.costUSD || 0) - 0.01 * (u.webSearchRequests || 0); // web searches are $10 per 1000
        if (w <= 0 || c <= 0) continue;
        const m = baseModel(model);
        cost.set(m, (cost.get(m) || 0) + c);
        tokens.set(m, (tokens.get(m) || 0) + w);
      }
    }
  }
  return new Map([...cost].map(([m, c]) => [m, c / tokens.get(m)]));
};

/// Claude Code sessions: { session -> { agent, cwd, days: { day -> totals } } }.
const readClaude = async ({ since, tz }) => {
  const sessions = new Map();
  const of = (id) => {
    if (!sessions.has(id)) sessions.set(id, { tool: 'claude', agent: null, cwd: null, days: new Map() });
    return sessions.get(id);
  };
  for (const file of files(CLAUDE, since, 3)) {
    // a subagent's log belongs to the session whose folder it is in
    const parts = file.split(path.sep);
    const sub = parts.includes('subagents');
    const id = sub ? parts[parts.indexOf('subagents') - 1] : path.basename(file, '.jsonl');
    const s = of(id);
    const seen = new Set();
    for await (const line of lines(file)) {
      // only the lines that matter are parsed: replies with usage, the agent's name, the running cost
      const usage = line.includes('"usage"');
      const named = line.includes('"agent-name"') || line.includes('"custom-title"');
      if (!usage && !named) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!s.cwd && o.cwd) s.cwd = o.cwd;
      const title = o.type === 'custom-title' ? o.customTitle : o.type === 'agent-name' ? o.agentName : null;
      if (title && !sub && AGENT.test(title)) s.agent = title;
      // Claude Code logs its plan limit only when one is hit: which (five_hour, seven_day) and when it resets
      const q = o.quotaLimits;
      if (q && q.status === 'rejected' && q.resetsAt) s.cap = { type: q.rateLimitType, resetsAt: q.resetsAt * 1000, at: o.timestamp };
      const msg = o.message;
      if (o.type !== 'assistant' || !msg || !msg.usage || !o.timestamp) continue;
      if (Date.parse(o.timestamp) < since) continue;
      // a reply is written once per content block, each with the same usage: count it once
      const key = `${msg.id}:${o.requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = day(o.timestamp, tz);
      if (!s.days.has(d)) s.days.set(d, blank());
      const t = s.days.get(d);
      const u = msg.usage;
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
      if (msg.model && msg.model !== '<synthetic>') {
        const m = baseModel(msg.model);
        t.models.add(m);
        const w = weigh({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
        t.weighted.set(m, (t.weighted.get(m) || 0) + w);
      }
    }
  }
  return [...sessions.values()];
};

// the room prompt's first words, before and after it was trimmed (12 Oct 2026)
const ROOM_PROMPT = /(?:connected to metacom as agent|You are agent) \\?"([^"\\]+)\\?" in (?:metacom )?room \\?"([^"\\]+)/;

/// Codex sessions, named from the room prompt the wrapper gave them.
const readCodex = async ({ since, tz }) => {
  const out = [];
  for (const file of files(CODEX, since, 3)) {
    const s = { tool: 'codex', agent: null, room: null, cwd: null, days: new Map() };
    let prev = null;
    let model = null;
    for await (const line of lines(file)) {
      if (!s.agent) {
        const m = line.match(ROOM_PROMPT);
        if (m) [s.agent, s.room] = [m[1], m[2]];
      }
      const counts = line.includes('"token_count"');
      if (!counts && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const p = o.payload || {};
      if (p.type === 'token_count' && p.rate_limits && o.timestamp) s.limits = { ...p.rate_limits, at: o.timestamp };
      if (o.type === 'session_meta' && p.cwd) s.cwd = p.cwd;
      if (o.type === 'turn_context' && p.model) model = p.model;
      if (p.type !== 'token_count' || !p.info || !p.info.total_token_usage || !o.timestamp) continue;
      // cumulative totals, repeated on every event: count what each adds
      const tot = p.info.total_token_usage;
      const add = (k) => Math.max(0, (tot[k] || 0) - ((prev && prev[k]) || 0));
      const d = day(o.timestamp, tz);
      if (Date.parse(o.timestamp) >= since) {
        if (!s.days.has(d)) s.days.set(d, blank());
        const t = s.days.get(d);
        const cached = add('cached_input_tokens');
        t.input += add('input_tokens') - cached;
        t.cacheRead += cached;
        t.output += add('output_tokens');
        if (model) t.models.add(model);
      }
      prev = tot;
    }
    out.push(s);
  }
  return out;
};

/// Rows of { day, agent, room, tool, models, input, output, cacheRead, cacheWrite, cost, costKnown },
/// and the plan limits: Claude agents capped now (until when), and Codex's latest windows.
const report = async (opts = {}) => {
  const limits = { claude: [], codex: null };
  const rows = await usage({ ...opts, limits });
  return { rows, limits };
};

const usage = async ({ limits = null, days = 7, all = false, tz = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) => {
  // today and the days before it, by the calendar: files are opened from a day earlier, for time zones
  const first = day(new Date(Date.now() - (days - 1) * 86_400_000).toISOString(), tz);
  const since = Date.now() - (days + 1) * 86_400_000;
  const notes = registry();
  const roomOf = (agent, cwd) => {
    const hit = notes.filter((n) => n.name === agent && (!cwd || n.cwd === cwd)).pop();
    return hit ? hit.room : null;
  };
  const sessions = [...(await readClaude({ since, tz })), ...(await readCodex({ since, tz }))];
  if (limits) {
    for (const s of sessions) {
      if (s.tool === 'claude' && s.cap && s.cap.resetsAt > Date.now() && s.agent) limits.claude.push({ agent: s.agent, type: s.cap.type, resetsAt: s.cap.resetsAt });
      // one Codex account: its newest reading wins
      if (s.tool === 'codex' && s.limits && (!limits.codex || s.limits.at > limits.codex.at)) limits.codex = s.limits;
    }
  }
  const rates = await claudeRates();
  // a day's cost: each model's tokens at its rate; unknown when a model has no rate here
  for (const s of sessions) {
    for (const t of s.days.values()) {
      if (s.tool !== 'claude' || !t.weighted.size) continue;
      const known = [...t.weighted.keys()].every((m) => rates.has(m));
      t.cost = [...t.weighted].reduce((n, [m, w]) => n + (rates.get(m) || 0) * w, 0);
      t.costKnown = known;
    }
  }
  const rows = new Map();
  for (const s of sessions) {
    const agent = s.agent;
    if (!agent && !all) continue;
    const room = s.room || (agent ? roomOf(agent, s.cwd) : null);
    const who = agent || `(you) ${s.cwd ? path.basename(s.cwd) : ''}`.trim();
    for (const [d, t] of s.days) {
      const key = `${d}|${who}|${room || ''}|${s.tool}`;
      if (!rows.has(key)) rows.set(key, { day: d, agent: who, room, tool: s.tool, ...blank() });
      const r = rows.get(key);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) r[k] += t[k];
      r.costKnown = r.costKnown || t.costKnown;
      for (const m of t.models) r.models.add(m);
    }
  }
  return [...rows.values()]
    .filter((r) => r.day >= first && (r.input + r.output + r.cacheRead + r.cacheWrite > 0 || r.cost > 0))
    .map((r) => ({ ...r, models: [...r.models].sort() }))
    .sort((a, b) => b.day.localeCompare(a.day) || b.cost - a.cost || b.output - a.output);
};

const short = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/// The table: a block per day, an agent per line, the day's total under it.
const WINDOW = { five_hour: '5-hour', seven_day: 'weekly', 300: '5-hour', 10080: 'weekly' };
const when = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/// The limits under the table: who is capped until when, and how far into its windows Codex is.
const formatLimits = (limits) => {
  const out = ['limits'];
  if (limits.claude.length) {
    for (const c of limits.claude) out.push(`  ${c.agent} (claude): hit the ${WINDOW[c.type] || c.type} limit, resets ${when(c.resetsAt)} · metacom handoff ${c.agent} --start codex`);
  } else out.push('  claude: no agent is at its limit now (Claude Code logs a limit only once it is hit)');
  const x = limits.codex;
  if (x) {
    const windows = [x.primary, x.secondary].filter(Boolean).map((w) => `${WINDOW[w.window_minutes] || `${w.window_minutes}-minute`} ${Math.round(w.used_percent)}% used, resets ${when(w.resets_at * 1000)}`);
    out.push(`  codex${x.plan_type ? ` (${x.plan_type})` : ''}: ${windows.join(' · ') || 'no window reported'}${x.rate_limit_reached_type ? ` · LIMIT REACHED (${x.rate_limit_reached_type})` : ''}`);
  }
  return out.join('\n') + '\n';
};

const format = (rows, limits = null) => {
  if (limits) return formatRows(rows) + '\n' + formatLimits(limits);
  return formatRows(rows);
};

const formatRows = (rows) => {
  if (!rows.length) return 'no agent usage in these days (metacom usage --all also counts sessions outside rooms)\n';
  const head = ['agent', 'tool', 'input', 'output', 'cache read', 'cache write', 'cost'];
  const line = (cells) => cells.map((c, i) => (i < 2 ? String(c).padEnd(i ? 7 : 26) : String(c).padStart(11))).join(' ');
  const out = [];
  for (const d of [...new Set(rows.map((r) => r.day))]) {
    const of = rows.filter((r) => r.day === d);
    out.push(d, line(head));
    for (const r of of) out.push(line([r.room ? `${r.agent}@${r.room}` : r.agent, r.tool, short(r.input), short(r.output), short(r.cacheRead), short(r.cacheWrite), r.costKnown ? `≈$${r.cost.toFixed(2)}` : '—']));
    const sum = (k) => of.reduce((n, r) => n + r[k], 0);
    out.push(line(['total', '', short(sum('input')), short(sum('output')), short(sum('cacheRead')), short(sum('cacheWrite')), `≈$${sum('cost').toFixed(2)}${of.some((r) => !r.costKnown) ? '+' : ''}`]), '');
  }
  out.push('cost: an estimate at API list prices, from the rates in Claude Code\'s own cost records on this machine; on a subscription you pay the plan, not this. Codex logs no cost (—), so a total with + leaves it out.');
  return out.join('\n') + '\n';
};

module.exports = { usage, report, format, note, REGISTRY };
