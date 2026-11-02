'use strict';

const crypto = require('node:crypto');
const { fail } = require('./errors.js');

// Loops: the hub's own scheduled instructions to the agents of a room (docs/loops.md). They live
// in the hub, not in an agent's session, so an agent cleared, rotated or restarted keeps them.
// `/loop @leader catch up with the team every 2h` fires every two hours, as a command from whoever
// made the loop, marked as the loop's. The wrapper already types a command in only when its agent
// is idle, so a busy target gets it when it goes idle; a fire still waiting in the target's inbox
// (not typed in yet) makes the next one skip, so they never stack.

const MIN_EVERY = 60_000;
const UNITS = { m: 60_000, min: 60_000, h: 3600_000, d: 86_400_000, w: 7 * 86_400_000 };
const EVERY = /^(\d{1,4})\s*(m|min|h|d|w)$/i;
const MAX_PROMPT = 2000;
const MAX_PER_ROOM = 20;
const MAX_PER_AGENT = 3;
const JITTER_MAX = 60_000;
const TICK_MS = 15_000;
// a cron field: [min, max] and the names it takes
const FIELDS = [
  { lo: 0, hi: 59 },
  { lo: 0, hi: 23 },
  { lo: 1, hi: 31 },
  { lo: 1, hi: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
  { lo: 0, hi: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
];
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const validTz = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/// One cron field ("*", "*/15", "1-5", "mon-fri", "0,30") as the set of values it matches;
/// `star` when it is "*" (for the day-of-month / day-of-week rule).
const cronField = (text, { lo, hi, names, base }) => {
  const value = (s) => {
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    const n = i >= 0 ? i + base : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`"${s}" is out of ${lo}-${hi}`);
    return n;
  };
  const set = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let from = lo;
    let to = hi;
    if (range !== '*') {
      const [a, b] = range.split('-');
      from = value(a);
      to = b === undefined ? (stepText === undefined ? from : hi) : value(b);
    }
    if (from > to) throw new Error(`"${part}" runs backwards`);
    for (let v = from; v <= to; v += step) set.add(v);
  }
  return { set, star: text === '*' || text.startsWith('*/') };
};

const parseCron = (text) => {
  const parts = String(text).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a cron schedule has 5 fields: minute hour day month weekday');
  const [minute, hour, day, month, weekday] = parts.map((p, i) => cronField(p, FIELDS[i]));
  if (weekday.set.has(7)) weekday.set.add(0);
  return { minute, hour, day, month, weekday };
};

const formatters = new Map();
/// The wall clock in a time zone: { month, day, weekday, hour, minute }.
const wall = (t, tz) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { month: Number(p.month), day: Number(p.day), weekday: WEEKDAY[p.weekday], hour: Number(p.hour) % 24, minute: Number(p.minute) };
};

/// The first minute after `after` that a cron schedule matches, on the wall clock of `tz`. Jumps a
/// day or an hour at a time where those do not match, so a yearly schedule is found in a few
/// thousand steps.
const nextCron = (cron, tz, after) => {
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = after + 5 * 366 * 86_400_000;
  while (t < limit) {
    const w = wall(t, tz);
    // as cron has it: with both day fields given, either one matching is enough
    const dayOk = cron.day.star || cron.weekday.star ? cron.day.set.has(w.day) && cron.weekday.set.has(w.weekday) : cron.day.set.has(w.day) || cron.weekday.set.has(w.weekday);
    if (!cron.month.set.has(w.month) || !dayOk) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000;
      continue;
    }
    if (!cron.hour.set.has(w.hour)) {
      t += (60 - w.minute) * 60_000;
      continue;
    }
    if (!cron.minute.set.has(w.minute)) {
      t += 60_000;
      continue;
    }
    return t;
  }
  return null;
};

/// "15m", "2h", "1d", or a 5-field cron: what the schedule is, and its shortest gap. Throws with a
/// reason people can act on.
const parseEvery = (text, tz = 'UTC') => {
  const every = String(text || '').trim();
  const m = EVERY.exec(every);
  if (m) {
    const ms = Number(m[1]) * UNITS[m[2].toLowerCase()];
    if (ms < MIN_EVERY) throw fail(400, 'a loop runs every minute at the most');
    return { every: `${Number(m[1])}${m[2].toLowerCase() === 'min' ? 'm' : m[2].toLowerCase()}`, ms };
  }
  let cron;
  try {
    cron = parseCron(every);
  } catch (error) {
    throw fail(400, `"${every}": not 15m / 2h / 1d, nor a cron schedule (${error.message})`);
  }
  // the shortest gap over the next runs: a cron that fires more often than every minute is refused
  let t = Date.now();
  let shortest = Infinity;
  for (let i = 0, prev = null; i < 40; i++) {
    t = nextCron(cron, tz, t);
    if (t === null) break;
    if (prev !== null) shortest = Math.min(shortest, t - prev);
    prev = t;
  }
  if (t === null && shortest === Infinity) throw fail(400, `"${every}" never runs`);
  if (shortest < MIN_EVERY) throw fail(400, 'a loop runs every minute at the most');
  return { every: every.split(/\s+/).join(' '), cron, ms: shortest };
};

const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45 };
const UNIT_WORDS = [
  [/^(?:m|mins?|minutes?)$/i, 'm'],
  [/^(?:h|hrs?|hours?)$/i, 'h'],
  [/^(?:d|days?)$/i, 'd'],
  [/^(?:w|weeks?)$/i, 'w'],
];
const DAYS = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };
const DAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?';
const AT = '(?:\\s+at\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?)';
const NUM = `(\\d{1,4}|${Object.keys(NUMBERS).join('|')})`;

const hourOf = (h, m, ampm) => {
  let hour = Number(h);
  if (ampm && ampm.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (ampm && ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
  const minute = m ? Number(m) : 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
};

/// The schedule people write into a prompt, and the prompt without it: "send me a report every
/// minute" is every 1m, "send me a report". Understands every minute / every 15 minutes / every 2h
/// / hourly / every half hour / daily / weekly / every day at 9 / every weekday at 9:30 / every
/// monday at 10am / at 6pm (every day) / a 5-field cron in quotes. Null when there is none.
const scheduleOf = (text) => {
  const s = String(text || '');
  const found = (re, make) => {
    const m = re.exec(s);
    if (!m) return null;
    const every = make(m);
    if (!every) return null;
    const prompt = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').replace(/\s+(?:and|,)$/i, '').trim();
    return { every, prompt };
  };
  const at = (h, m, ampm, dow) => {
    const t = hourOf(h, m, ampm);
    return t ? `${t.minute} ${t.hour} * * ${dow}` : null;
  };
  return (
    found(/(["'])((?:\S+\s+){4}\S+)\1/, (m) => m[2].trim()) ||
    found(new RegExp(`\\b(?:every|each|on)\\s+(?:weekday|work\\s*day)s?${AT}?`, 'i'), (m) => at(m[1] || 9, m[2], m[3], 'mon-fri')) ||
    found(new RegExp(`\\b(?:on\\s+)?weekdays${AT}?`, 'i'), (m) => at(m[1] || 9, m[2], m[3], 'mon-fri')) ||
    found(new RegExp(`\\b(?:every|each|on)\\s+${DAY}${AT}?`, 'i'), (m) => at(m[2] || 9, m[3], m[4], DAYS[m[1].toLowerCase()])) ||
    found(new RegExp(`\\b(?:every\\s+day|each\\s+day|daily|every\\s+morning|each\\s+morning)${AT}`, 'i'), (m) => at(m[1], m[2], m[3], '*')) ||
    found(new RegExp(`\\bevery\\s+evening${AT}?`, 'i'), (m) => at(m[1] || 18, m[2], m[3], '*')) ||
    found(/\b(?:every|each)\s+morning\b/i, () => '0 9 * * *') ||
    found(/\bevery\s+half\s+(?:an\s+)?hour\b/i, () => '30m') ||
    found(new RegExp(`\\b(?:every|each)\\s+(?:${NUM}\\s*)?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)\\b`, 'i'), (m) => {
      const n = m[1] === undefined ? 1 : /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1].toLowerCase()];
      const unit = UNIT_WORDS.find(([re]) => re.test(m[2]))[1];
      return n ? `${n}${unit}` : null;
    }) ||
    found(/\bhourly\b/i, () => '1h') ||
    found(/\bdaily\b/i, () => '1d') ||
    found(/\bweekly\b/i, () => '1w') ||
    found(new RegExp(`\\bat\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)\\b|\\bat\\s+(\\d{1,2})[:.](\\d{2})\\b`, 'i'), (m) => (m[1] ? at(m[1], m[2], m[3], '*') : at(m[4], m[5], null, '*')))
  );
};

/// What the asker is offered when a /loop names no schedule.
const CHOICES = [
  { every: '15m', label: 'every 15m' },
  { every: '1h', label: 'every 1h' },
  { every: '0 9 * * *', label: 'every day at 09:00' },
];

/// `/loop @all send me a report every minute`: the target first, then the prompt, the schedule
/// in its words. Also an explicit schedule before the prompt (`@leader 2h …`, `@x "17 * * * *" …`)
/// and the first form (`2h @leader …`). `every` null: none found.
const parseLine = (line) => {
  const s = String(line || '').trim();
  const usage = 'usage: /loop @<agent|all|any> <prompt, with when: "every 2h", "every day at 9", "hourly">';
  const lead = /^(?:(["'])(.+?)\1|(\S+))\s+(?=@)/.exec(s);
  if (lead && !s.startsWith('@')) {
    const target = /^@([a-z0-9][a-z0-9._-]{0,31})\s+/i.exec(s.slice(lead[0].length));
    if (!target) throw fail(400, usage);
    return { every: lead[2] || lead[3], target: target[1], prompt: s.slice(lead[0].length + target[0].length).trim() };
  }
  const target = /^@([a-z0-9][a-z0-9._-]{0,31})(?:\s+|$)/i.exec(s);
  if (!target) throw fail(400, usage);
  let rest = s.slice(target[0].length).trim();
  // an explicit schedule right after the target
  const explicit = /^(?:(["'])((?:\S+\s+){4}\S+)\1|(\d{1,4}\s*(?:m|min|h|d|w)))(?:\s+|$)/i.exec(rest);
  if (explicit) return { every: (explicit[2] || explicit[3]).replace(/\s+/g, explicit[2] ? ' ' : ''), target: target[1], prompt: rest.slice(explicit[0].length).trim() };
  const said = scheduleOf(rest);
  if (said) return { every: said.every, target: target[1], prompt: said.prompt };
  return { every: null, target: target[1], prompt: rest };
};

const DOW_LABEL = { '*': 'every day', 'mon-fri': 'weekdays', sun: 'Sundays', mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays' };
/// How a schedule reads: "every 2h", "every day at 09:00", "weekdays at 09:30", "cron 17 */2 * * *".
const labelOf = (every) => {
  const simple = /^(\d{1,2}) (\d{1,2}) \* \* (\*|mon-fri|sun|mon|tue|wed|thu|fri|sat)$/.exec(every);
  if (simple) return `${DOW_LABEL[simple[3]]} at ${simple[2].padStart(2, '0')}:${simple[1].padStart(2, '0')}`;
  return /\s/.test(every) ? `cron ${every}` : `every ${every}`;
};

const now = () => Date.now();

class Loops {
  /// `clock` and `random` are for tests; `tickMs` 0 runs no timer (tests call tick()).
  constructor(hub, { clock = now, random = Math.random, tickMs = TICK_MS } = {}) {
    this.hub = hub;
    this.clock = clock;
    this.random = random;
    const saved = hub.store.loadJson('loops.json', null) || {};
    this.ownerTz = saved.ownerTz || null;
    this.loops = Array.isArray(saved.loops) ? saved.loops : [];
    for (const loop of this.loops) this.compile(loop);
    if (tickMs) {
      this.timer = setInterval(() => this.tick(), tickMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  save() {
    this.hub.store.saveJson('loops.json', { ownerTz: this.ownerTz, loops: this.loops.map(({ schedule, ...rest }) => rest) });
  }

  /// The parsed schedule of a loop, kept beside it in memory (not saved).
  compile(loop) {
    try {
      Object.defineProperty(loop, 'schedule', { value: parseEvery(loop.every, loop.tz), enumerable: false, configurable: true, writable: true });
    } catch {
      loop.on = false;
    }
    return loop;
  }

  /// The run after `after` on the loop's schedule (without its jitter).
  following(loop, after) {
    const s = loop.schedule;
    if (!s) return null;
    if (s.cron) return nextCron(s.cron, loop.tz, after);
    let t = loop.base || after + s.ms;
    if (t <= after) t += Math.ceil((after - t + 1) / s.ms) * s.ms;
    return t;
  }

  /// A little jitter, so a room's loops do not all land at once: up to a minute, never more than 5% of the gap.
  jitter(loop) {
    return Math.floor(this.random() * Math.min(JITTER_MAX, (loop.schedule ? loop.schedule.ms : MIN_EVERY) * 0.05));
  }

  plan(loop, after) {
    const base = this.following(loop, after);
    loop.base = base;
    loop.next = base === null ? null : new Date(base + this.jitter(loop)).toISOString();
  }

  // MARK: who may

  /// The agent behind a connection, when it is one.
  agentOf(conn) {
    const member = conn.key ? this.hub.members.get(conn.key) : null;
    return member && member.kind === 'agent' ? member : null;
  }

  /// The owner may touch any loop; an agent only the loops it made, in its own room.
  mayChange(conn, loop) {
    if (conn.record.role === 'owner') return;
    const me = this.agentOf(conn);
    // a manager of the room (/manage) changes any of the room's loops but the owner's
    if (me && loop.room === me.room && loop.by.role !== 'owner' && this.hub.manages(me.name, loop.room)) return;
    if (!me || loop.by.name !== me.name || loop.by.role === 'owner' || loop.room !== me.room) throw fail(403, `only the owner or ${loop.by.name} can change that loop`);
  }

  /// The room a call is about: the one asked for, else the caller's own.
  roomFor(conn, room) {
    const me = this.agentOf(conn);
    const r = room || (me ? me.room : conn.room && conn.room !== '*' ? conn.room : null);
    if (!r) throw fail(400, 'room is required');
    this.hub.scope(conn, r);
    this.hub.use(conn, r);
    return r;
  }

  find(conn, ref) {
    const r = String(ref || '');
    const hits = this.loops.filter((l) => l.id === r || (r.length >= 4 && l.id.startsWith(r)));
    if (hits.length !== 1) throw fail(404, hits.length ? `"${r}" matches ${hits.length} loops` : `no loop ${r}`);
    const loop = hits[0];
    if (conn.record.role !== 'owner') this.hub.use(conn, loop.room);
    return loop;
  }

  // MARK: the calls

  create(conn, { room, line, every, target, prompt, tz } = {}) {
    if (conn.record.role === 'member') throw fail(403, 'loops are for the owner and the agents');
    const r = this.roomFor(conn, room);
    this.hub.writable(r);
    if (line) {
      const parsed = parseLine(line);
      ({ target, prompt } = parsed);
      // an explicit `every` is the answer to "how often?" (or a tool's argument): it wins
      if (!every) every = parsed.every;
    } else if (!every) {
      // a tool's prompt with its schedule in the words
      const said = scheduleOf(prompt);
      if (said) ({ every, prompt } = said);
    }
    target = String(target || '').replace(/^@/, '');
    prompt = String(prompt || '').trim();
    if (!target) throw fail(400, 'a loop needs a target: @agent, @all or @any');
    if (!prompt) throw fail(400, 'a loop needs a prompt: what to tell the agent each time');
    if (prompt.length > MAX_PROMPT) throw fail(400, `the prompt is ${prompt.length} characters; ${MAX_PROMPT} at the most`);
    if (prompt.startsWith('!')) throw fail(400, 'a loop sends an instruction; "!" commands (!/clear, !stop) are not looped');
    const owner = conn.record.role === 'owner';
    const me = this.agentOf(conn);
    if (!owner && !me) throw fail(403, 'register as an agent first');
    if (owner && tz && validTz(tz)) this.ownerTz = tz;
    const zone = owner && tz && validTz(tz) ? tz : this.ownerTz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const lower = target.toLowerCase();
    if (lower !== 'all' && lower !== 'any') {
      const agent = this.agentIn(r, target);
      if (!agent) throw fail(404, `no agent ${target} in ${r}`);
      target = agent.name;
    } else target = lower;
    if (!owner && r === me.room && this.hub.manages(me.name, r)) {
      // a manager of the room (/manage, the owner's call) loops to any agent of it, @all and @any too;
      // the cap is per agent looped to
      const aimed = (l) => l.room === r && l.target === target && l.by.role !== 'owner';
      if (target !== 'all' && target !== 'any' && this.loops.filter(aimed).length >= MAX_PER_AGENT) throw fail(429, `${target} has ${MAX_PER_AGENT} loops already; delete one first`);
    } else if (!owner) {
      // an agent wakes itself or one idle agent; waking the whole room on a timer is the owner's call
      if (target === 'all' || (target !== 'any' && target !== me.name)) throw fail(403, 'an agent loops only to itself or @any; ask the owner, or the room\'s manager, for anything wider');
      if (r !== me.room) throw fail(403, `an agent makes loops in its own room (${me.room})`);
      if (this.loops.filter((l) => l.by.name === me.name && l.by.role !== 'owner' && l.room === r).length >= MAX_PER_AGENT) throw fail(429, `${me.name} has ${MAX_PER_AGENT} loops already; delete one first`);
    }
    if (this.loops.filter((l) => l.room === r).length >= MAX_PER_ROOM) throw fail(429, `${r} has ${MAX_PER_ROOM} loops already`);
    // no schedule in the words: asked once, with numbered choices; the answer comes back as `every`
    if (!every) return { ask: { text: `how often should @${target} get "${short(prompt)}"?`, options: CHOICES.map((c) => ({ ...c })), target, prompt } };
    const schedule = parseEvery(every, zone);
    const from = this.hub.from(conn);
    const loop = this.compile({
      id: crypto.randomUUID().slice(0, 8),
      room: r,
      target,
      every: schedule.every,
      prompt,
      tz: zone,
      by: { name: from.name, role: from.role, kind: from.kind },
      on: true,
      created: new Date(this.clock()).toISOString(),
      next: null,
      last: null,
      fires: 0,
      skips: 0,
    });
    this.plan(loop, this.clock());
    this.loops.push(loop);
    this.save();
    this.hub.system(r, `${loop.by.name} set a loop: ${labelOf(loop.every)} → @${loop.target}: ${short(prompt)} (/loops)`);
    this.changed(r);
    return this.view(loop);
  }

  list(conn, room, all = false) {
    if (all) {
      this.hub.owner(conn);
      return this.loops.map((l) => this.view(l));
    }
    const r = this.roomFor(conn, room);
    return this.loops.filter((l) => l.room === r).map((l) => this.view(l));
  }

  toggle(conn, ref, on) {
    const loop = this.find(conn, ref);
    this.mayChange(conn, loop);
    loop.on = on === undefined ? !loop.on : Boolean(on);
    if (loop.on) {
      if (!loop.schedule) throw fail(400, `the schedule "${loop.every}" no longer parses; delete the loop and make it again`);
      loop.base = null;
      this.plan(loop, this.clock());
    }
    loop.due = null;
    this.save();
    this.hub.system(loop.room, `${this.hub.from(conn).name} turned ${loop.on ? 'on' : 'off'} the loop ${labelOf(loop.every)} → @${loop.target}`);
    this.changed(loop.room);
    return this.view(loop);
  }

  /// Fires it now, by the same rules (never stacked, offline skipped); its schedule stays as it was.
  run(conn, ref) {
    const loop = this.find(conn, ref);
    this.mayChange(conn, loop);
    this.fire(loop);
    this.save();
    return this.view(loop);
  }

  remove(conn, ref) {
    const loop = this.find(conn, ref);
    this.mayChange(conn, loop);
    this.loops = this.loops.filter((l) => l !== loop);
    this.save();
    this.hub.system(loop.room, `${this.hub.from(conn).name} deleted the loop ${labelOf(loop.every)} → @${loop.target}: ${short(loop.prompt)}`);
    this.changed(loop.room);
    return { deleted: loop.id };
  }

  view(loop) {
    const { id, room, target, every, prompt, tz, by, on, created, next, last, fires, skips, due } = loop;
    return { id, room, target, every, label: labelOf(every), prompt, tz, by, on, created, next: on ? next : null, last, fires, skips, waiting: Boolean(due) };
  }

  changed(room) {
    this.hub.broadcast('room/loops', { room, loops: this.loops.filter((l) => l.room === room).map((l) => this.view(l)) }, room);
  }

  // MARK: firing

  /// An agent of the room by name: its own agent, or a guest invited into it.
  agentIn(room, name) {
    const lower = String(name).toLowerCase();
    const all = [...this.hub.members.values()].filter((m) => m.kind === 'agent' && m.name.toLowerCase() === lower);
    return all.find((m) => m.room === room) || all.find((m) => (m.invited || []).includes(room)) || null;
  }

  /// Agents of the room online now, in the order they joined.
  online(room) {
    // a paused agent (its budget for today spent) gets no fires until it is resumed
    return [...this.hub.members.values()].filter((m) => m.kind === 'agent' && m.room === room && m.connected && !(this.hub.isPaused && this.hub.isPaused(m)));
  }

  /// Whether this loop's previous fire to that agent is still in its inbox, not typed in yet.
  stacked(loop, member) {
    const sent = (loop.sent || {})[member.key];
    return Boolean(sent && (this.hub.inbox.get(member.key) || []).some((m) => m.id === sent));
  }

  /// Every loop that is due now fires; a loop to @any still waiting for an idle agent tries again.
  tick() {
    const t = this.clock();
    let dirty = false;
    for (const loop of this.loops) {
      if (!loop.on) continue;
      if (loop.due && this.deliverAny(loop)) dirty = true;
      if (!loop.next || Date.parse(loop.next) > t) continue;
      this.fire(loop);
      this.plan(loop, t);
      dirty = true;
    }
    if (dirty) this.save();
  }

  /// An agent went idle: a loop to @any waiting for one is delivered to it.
  idle(member) {
    let dirty = false;
    for (const loop of this.loops) if (loop.on && loop.due && loop.room === member.room && this.deliverAny(loop)) dirty = true;
    if (dirty) this.save();
  }

  record(loop, outcome, to = [], why = null) {
    loop.last = { at: new Date(this.clock()).toISOString(), outcome, to, why };
    if (outcome === 'sent') loop.fires = (loop.fires || 0) + 1;
    if (outcome === 'skipped') loop.skips = (loop.skips || 0) + 1;
    this.changed(loop.room);
  }

  fire(loop) {
    if (this.hub.archived.has(loop.room)) return this.record(loop, 'skipped', [], `${loop.room} is archived`);
    if (loop.target === 'any') {
      if (loop.due) return this.record(loop, 'skipped', [], 'the last one is still waiting for an idle agent');
      const stacked = this.online(loop.room).find((m) => this.stacked(loop, m));
      if (stacked) return this.record(loop, 'skipped', [stacked.name], `${stacked.name} has not picked up the last one`);
      if (!this.online(loop.room).length) return this.record(loop, 'skipped', [], `no agent online in ${loop.room}`);
      loop.due = new Date(this.clock()).toISOString();
      if (!this.deliverAny(loop)) this.record(loop, 'waiting', [], 'every agent is busy; the first to go idle gets it');
      return;
    }
    if (loop.target === 'all') {
      const agents = this.online(loop.room);
      if (!agents.length) return this.record(loop, 'skipped', [], `no agent online in ${loop.room}`);
      const ready = agents.filter((m) => !this.stacked(loop, m));
      const held = agents.filter((m) => this.stacked(loop, m)).map((m) => m.name);
      if (!ready.length) return this.record(loop, 'skipped', held, 'none has picked up the last one');
      const batch = crypto.randomUUID();
      const line = { id: crypto.randomUUID(), ts: new Date(this.clock()).toISOString(), room: loop.room, kind: 'say', from: { ...loop.by }, text: `@all ${loop.prompt}`, loop: this.mark(loop) };
      this.hub.store.appendRoom(loop.room, line);
      this.hub.broadcastMessage('room/message', line, loop.room);
      for (const m of ready) this.deliver(loop, m, batch, false);
      return this.record(loop, 'sent', ready.map((m) => m.name), held.length ? `skipped ${held.join(', ')}: the last one not picked up yet` : null);
    }
    const member = this.agentIn(loop.room, loop.target);
    if (!member || !member.connected) return this.record(loop, 'skipped', [loop.target], `${loop.target} is offline`);
    if (this.hub.isPaused && this.hub.isPaused(member)) return this.record(loop, 'skipped', [member.name], `${member.name} is paused: its budget for today is spent`);
    if (this.stacked(loop, member)) return this.record(loop, 'skipped', [member.name], `${member.name} has not picked up the last one`);
    this.deliver(loop, member);
    this.record(loop, 'sent', [member.name], member.status === 'waiting' ? null : `${member.name} is ${member.status}: typed in when idle`);
  }

  /// A fire to @any: to the first idle agent of the room, if there is one now.
  deliverAny(loop) {
    const idle = this.online(loop.room).find((m) => m.status === 'waiting');
    if (!idle) return false;
    loop.due = null;
    this.deliver(loop, idle);
    this.record(loop, 'sent', [idle.name]);
    return true;
  }

  mark(loop) {
    return { id: loop.id, every: loop.every, label: labelOf(loop.every) };
  }

  /// The loop's prompt as a command from whoever made the loop, marked as the loop's. Not the
  /// owner's turn: a loop's turn ending does not alert the owner as "done".
  deliver(loop, member, batch = null, log = true) {
    const hub = this.hub;
    const msg = { id: crypto.randomUUID(), ts: new Date(this.clock()).toISOString(), room: loop.room, kind: 'command', from: { ...loop.by }, to: member.name, text: loop.prompt, loop: this.mark(loop) };
    if (batch) msg.batch = batch;
    hub.pushInbox(member.key, msg);
    if (log) {
      hub.store.appendRoom(loop.room, msg);
      hub.broadcastMessage('room/message', msg, loop.room);
    }
    for (const client of hub.byName.get(member.key) || new Set()) hub.emit(client, 'agents/message', msg);
    loop.sent = { ...(loop.sent || {}), [member.key]: msg.id };
  }

  stop() {
    clearInterval(this.timer);
  }
}

const short = (text) => {
  const one = String(text).replace(/\s+/g, ' ');
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
};

module.exports = { Loops, parseEvery, parseLine, scheduleOf, parseCron, nextCron, labelOf, CHOICES, MIN_EVERY };
