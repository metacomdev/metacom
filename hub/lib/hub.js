'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ROOM, Store } = require('./store.js');
const { Media } = require('./media.js');
const { REMOVE, NAME: NAME_OF_SECRET, check: checkSecret, outsideCode, checkCode, shares } = require('./secrets.js');
const { route } = require('./router.js');
const { Loops } = require('./loops.js');
const { fail } = require('./errors.js');
const colors = require('./colors.js');

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const STATUSES = new Set(['starting', 'working', 'waiting', 'blocked', 'stopped']);
const READY = new Set(['waiting', 'blocked', 'stopped']);
// Owner-only input the harness acts on itself: keys and dialogs, and `!/command …`, a slash
// command typed into the agent as if at its own terminal.
const CONTROL = /^!(?:(?:stop|type|answer|restart)\b|\/)/;
/// The owner's bare "!hello …" (not !stop, !type, !answer): "hello …" typed into the agent's
/// terminal as plain text, as if typed there (no "[hub misha]" prefix), then Enter.
const PLAIN = /^!(?!(?:stop|type|answer|restart)\b)[^\s/!]/i;
const TURN_START_TIMEOUT = 10_000;
const KINDS = new Set(['agent', 'human']);
const MAX_TEXT = 16 * 1024;
const RATE_WINDOW = 10_000;
const RATE_CALLS = 200;
// A member that drops and is back within this long (a tunnel or laptop cutting the websocket
// every few minutes) never "left": the room hears about a departure only once it lasts.
const LEAVE_GRACE_MS = 120_000;
// edits to one message within this long reach the agents concerned once, as the final version
const EDIT_COALESCE_MS = 20_000;
const EDITABLE = new Set(['say', 'command', 'info']);
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MENTION = /(?:^|[^\w@])@([a-z0-9][a-z0-9._-]{0,31})(?![\w-])/gi;
const mentions = (body) => [...String(body || '').matchAll(MENTION)].map((m) => m[1].replace(/\.+$/, ''));

const now = () => new Date().toISOString();

/// Who may type commands into an agent: 'owner', 'any', or a list of agent names.
const id = () => crypto.randomUUID();

/// A question an agent is blocked on, as its wrapper read it off the screen: { id, text, options }.
const cleanQuestion = (q) => {
  if (!q || typeof q !== 'object' || !/^[0-9a-f]{12}$/.test(String(q.id || ''))) return null;
  const options = (Array.isArray(q.options) ? q.options : []).slice(0, 9).map((o) => ({ label: String((o && o.label) || '').slice(0, 200) })).filter((o) => o.label);
  return { id: q.id, text: String(q.text || '').slice(0, 1000), options };
};
/// Which option a reply picks: its number, its label, or a word only one label starts with ("yes"
/// is option 1 when the others say "Yes, and …"). Null when it picks none.
const pick = (question, reply) => {
  const t = String(reply || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t || !question || !question.options.length) return null;
  const n = /^\d$/.test(t) ? Number(t) : 0;
  if (n) return question.options[n - 1] ? n : null;
  const labels = question.options.map((o) => o.label.toLowerCase());
  const exact = labels.findIndex((l) => l === t || l.replace(/[.,]+$/, '') === t);
  if (exact >= 0) return exact + 1;
  const word = t === 'y' ? 'yes' : t === 'n' ? 'no' : t;
  const starts = labels.map((l, i) => (l === word || new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(l) ? i : -1)).filter((i) => i >= 0);
  const plain = starts.filter((i) => labels[i] === word);
  if (plain.length === 1) return plain[0] + 1;
  return starts.length === 1 ? starts[0] + 1 : null;
};
/// The option that turns the agent down and leaves it waiting for what to do instead ("No", "No, and
/// tell Claude what to do differently"); a reply that is not an option picks it, then goes in as a command.
const declineOf = (question) => {
  const i = question.options.findIndex((o) => /^no\b/i.test(o.label));
  return i >= 0 ? i + 1 : null;
};
/// An agent is its name in its room: cmo in marketing and cmo in sales are two agents, cmo@marketing and
/// cmo@sales. A person is just the name, the same in every room they open.
const keyOf = (kind, name, room) => (kind === 'agent' ? `${name}@${room || 'default'}` : name);

/// Message text; a message that carries files may have none.
const text = (value, what = 'text', withMedia = false) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw fail(400, `${what} must be a string`);
  if (value.trim().length === 0 && !withMedia) throw fail(400, `${what} is required`);
  if (value.length > MAX_TEXT) throw fail(413, `${what} is longer than ${MAX_TEXT} characters`);
  return value;
};

/// Rooms, members and directed messages. A member is an identity (a name) that outlives
/// its process: the wrapper and the MCP bridge of one agent are two connections of one
/// member, and an agent that reconnects from another machine keeps its name and inbox.
/// `events` mirrors what goes to websocket clients ('room/message', 'agents/changed').
/// A room's records as clients show them: each message at its latest version (with rev and when
/// it was edited), and the edit records themselves left out.
/// A suggested reply on a message: a line, or a few (a `- [ ]` checklist with the recommended items
/// ticked), at most 500 characters.
const cleanSuggest = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(400, 'suggest must be a string');
  const lines = value.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const text = lines.join('\n');
  if (text.length > 500) throw fail(400, 'suggest: at most 500 characters');
  return text;
};
/// How a reply compares with the suggestion it answers: the same words, or not.
const sameReply = (a, b) => String(a).replace(/\s+/g, ' ').trim().toLowerCase() === String(b).replace(/\s+/g, ' ').trim().toLowerCase();

const RECORDS = new Set(['edit', 'pin', 'unpin']);

/// How long a scroll back waits for the agent's wrapper.
const LIVE_SCROLL_TIMEOUT = 5000;
/// "@all <text>" from a person: to every agent in the room.
const RISKS = ['routine', 'outward', 'irreversible'];
/// Claude Code's "do you trust this folder?" (and the like): the setup question a delegate may answer.
const isTrustQuestion = (q) => Boolean(q && /trust (this|the) folder|one you trust\?|trust the files in this folder/i.test(`${q.text}\n${(q.options || []).map((o) => o.label).join('\n')}`));
const ALL_PEOPLE = /^@all\s+(?=\S)/;
/// The owner's "@all !/<command>": to every agent in the room.
const ALL_CONTROL = /^@all\s+!(?:\/|(?!(?:stop|type|answer)\b)[^\s/!])/i;
/// How long "@all !/clear" waits for busy agents before the room hears how it went.
const CLEAR_ALL_TIMEOUT = 2 * 60 * 60 * 1000;
/// A suggestion stops waiting after this many hours, unless its message says otherwise (suggestTtl).
const SUGGEST_TTL_HOURS = 12;
const cleanTtl = (value) => {
  if (value === undefined || value === null) return undefined;
  const h = Number(value);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) throw fail(400, 'suggestTtl: hours, more than 0 and at most 720');
  return h;
};
/// Until when a message's suggestion waits: from when it was set (sent, or the edit that set it).
const suggestUntil = (m) => Date.parse(m.suggestAt || m.ts) + (m.suggestTtl || SUGGEST_TTL_HOURS) * 3600_000;
/// Dismissed suggestions kept per person and room: the newest.
const DISMISSED_MAX = 1000;
/// The most waiting suggestions room/suggestions returns: the newest of them.
const SUGGESTIONS_MAX = 100;

const foldEdits = (records, pinned = null) => {
  const at = new Map(records.map((r, i) => [r.id, i]));
  const out = records.slice();
  for (const r of records) {
    if (r.kind !== 'edit' || !at.has(r.target)) continue;
    const i = at.get(r.target);
    out[i] = { ...out[i], text: r.text, rev: r.rev, edited: r.ts };
    if (r.suggest !== undefined) Object.assign(out[i], { suggest: r.suggest || undefined, suggestAt: r.ts, suggestTtl: r.suggestTtl });
  }
  return out.filter((r) => !RECORDS.has(r.kind)).map((r) => (pinned && pinned.has(r.id) ? { ...r, pinned: true } : r));
};

class Hub {
  constructor({ dataDir, auth, console, leaveGraceMs = LEAVE_GRACE_MS, editCoalesceMs = EDIT_COALESCE_MS, loops = {}, sessionStartMs = 60_000 }) {
    this.leaveGraceMs = leaveGraceMs;
    this.editCoalesceMs = editCoalesceMs;
    this.pendingEdits = new Map(); // message id -> the edits not told to the agents concerned yet
    this.pinned = new Map(); // room -> Map(message id -> the pin record), read from the log once
    this.leaving = new Map(); // member key -> timer of a "left" not said yet
    this.console = console;
    this.events = new EventEmitter();
    this.auth = auth;
    this.store = new Store(dataDir);
    this.archived = new Map(Object.entries(this.store.loadJson('archived.json', {}))); // room -> { at, by }
    this.media = new Media(dataDir);
    this.members = new Map();
    for (const m of this.store.loadJson('members.json', [])) {
      const key = keyOf(m.kind, m.name, m.room);
      this.members.set(key, { ...m, key, connected: false, status: 'stopped' });
    }
    // everyone gets a colour of their own once, and keeps it
    if (colors.assignAll(this.members.values())) this.saveMembers();
    // inboxes kept by bare name before agents were per room go to the agent of that name
    this.inbox = new Map();
    for (const [key, list] of Object.entries(this.store.loadJson('inbox.json', {}))) {
      const agent = key.includes('@') || this.members.has(key) ? null : this.named(key)[0];
      this.inbox.set(agent ? agent.key : key, list);
    }
    // When each person last had each room open: messages to them after that are unread. Rooms
    // never opened since this was kept count from `since`, not from the start of their logs.
    this.readMarks = this.store.loadJson('reads.json', null) || { since: now(), marks: {} };
    // "@all !/clear" in progress: the room line waits for every agent's outcome
    this.clears = new Map();
    // live mode's scrolling back: request id -> the viewer waiting for that screenful
    this.scrolls = new Map();
    // suggestions each person put away for good (Esc): person -> room -> [message ids]
    this.dismissed = this.store.loadJson('dismissed.json', null) || {};
    // suggestions withdrawn by their senders, or superseded by a newer one to the same person
    this.withdrawn = new Set(this.store.loadJson('withdrawn.json', null) || []);
    if (!this.store.loadJson('reads.json', null)) this.store.saveJson('reads.json', this.readMarks);
    this.conns = new Map();
    this.byName = new Map();
    this.waiters = new Map();
    /// Live mode (docs/direct.md): member key → the owner connections watching its screen.
    this.watchers = new Map();
    /// The room's scheduled instructions (lib/loops.js), kept by the hub whatever the agents' sessions do.
    this.loops = new Loops(this, loops);
    /// each room's lead agent (/lead): a person's message there that names nobody goes to it
    this.leads = this.store.loadJson('leads.json', null) || {};
    /// the hub's own defaults for every web chat (/preview off hub): what a device has not chosen
    this.prefs = this.store.loadJson('prefs.json', null) || {};
    /// owner approvals: an agent's request for an outward action, decided by the hub owner alone
    this.approvals = new Map(Object.entries(this.store.loadJson('approvals.json', null) || {}));
    /// the spend guard: a daily budget per agent (member key → dollars), $30 unless set; what a
    /// paused agent is sent waits here (member key → messages) until it is resumed
    this.budgetFor = new Map(Object.entries(this.store.loadJson('budgets.json', null) || {}));
    this.defaultBudget = Number(process.env.HUB_DEFAULT_BUDGET) > 0 ? Number(process.env.HUB_DEFAULT_BUDGET) : 30;
    this.held = new Map();
    /// a session uninvited while saving its notes: its token narrows for the live connections once it is gone
    this.rescopeLater = new Map();
    /// sessions a wrapper was told to start: member key -> the timer that says it did not
    this.starting = new Map();
    this.sessionStartMs = sessionStartMs;
    // sessions invited before they had a place in their room's list get one
    const before = this.members.size;
    for (const m of [...this.members.values()]) for (const room of m.sessions || []) this.placeSession(m, room);
    if (this.members.size !== before) this.saveMembers();
  }

  // MARK: connections

  bind(client, record, ip) {
    const conn = { client, record, ip, name: null, room: record.role === 'owner' ? '*' : null, calls: [] };
    this.conns.set(client, conn);
    client.on('close', () => this.unbind(client));
    return conn;
  }

  unbind(client) {
    const conn = this.conns.get(client);
    if (!conn) return;
    this.conns.delete(client);
    for (const key of [...this.watchers.keys()]) this.unwatch(conn, key);
    if (!conn.key || conn.follow) return;
    const set = this.byName.get(conn.key);
    if (set) {
      set.delete(client);
      if (set.size > 0) return;
      this.byName.delete(conn.key);
    }
    const member = this.members.get(conn.key);
    // its screen went with it: whoever was watching is told, and leaves live mode
    for (const viewer of this.watchers.get(conn.key) || []) this.emit(viewer.client, 'agents/liveEnd', { name: member ? member.name : conn.name, reason: 'disconnected' });
    this.watchers.delete(conn.key);
    if (member && member.connected) {
      member.connected = false;
      member.status = 'stopped';
      member.reason = 'disconnected';
      member.lastSeen = now();
      this.console.log(`hub: ${member.name} disconnected`);
      this.saveMembers();
      const room = member.room;
      clearTimeout(this.leaving.get(member.key));
      this.leaving.set(
        member.key,
        setTimeout(() => {
          this.leaving.delete(member.key);
          this.system(room, `${member.name} left`);
        }, this.leaveGraceMs).unref(),
      );
      this.settle(member);
      this.changed();
      // an uninvited session that has now gone: off its room's list
      const home = member.home ? this.members.get(keyOf('agent', member.name, member.home)) : null;
      if (home && !(home.sessions || []).includes(member.room)) {
        this.members.delete(member.key);
        this.saveMembers();
        this.changed();
      }
      const narrowed = this.rescopeLater.get(member.key);
      if (narrowed) {
        this.rescopeLater.delete(member.key);
        try {
          this.rescope(narrowed, this.auth.find(narrowed).rooms || null);
        } catch {
          // the token went meanwhile
        }
      }
    }
  }

  /// The connection behind a call. Websocket callers signed in earlier; HTTP callers
  /// pass their token with every call and get an ephemeral connection.
  identify(context, args = {}) {
    const bound = this.conns.get(context.client);
    if (bound) {
      this.tick(bound);
      return bound;
    }
    // a call with its token: in its arguments, or over HTTP as "Authorization: Bearer <token>"
    const token = args && typeof args.token === 'string' ? args.token : context.client.bearer;
    if (typeof token === 'string') {
      const ip = context.client.source;
      if (this.auth.blocked(ip)) throw fail(429, 'Too many failed sign-ins, try later');
      const record = this.auth.verify(token);
      if (!record) {
        this.auth.recordFailure(ip);
        throw fail(401, 'Bad token');
      }
      return { client: context.client, record, ip, name: null, room: '*', ephemeral: true, calls: [] };
    }
    throw fail(401, 'Sign in first');
  }

  tick(conn) {
    const t = Date.now();
    conn.calls = conn.calls.filter((x) => t - x < RATE_WINDOW);
    conn.calls.push(t);
    if (conn.calls.length > RATE_CALLS) throw fail(429, 'Too many calls');
  }

  owner(conn) {
    if (conn.record.role !== 'owner') throw fail(403, 'Owners only');
  }

  /// Whether the caller steers this agent: the owner, or a member whose token says `steer` and
  /// whose rooms include the agent's room. Steering is answering its questions and driving it live;
  /// secrets, tokens, invites and control commands stay with the owner.
  /// `live`: driving it live as well, which a token made with steer "answer" does not get, except on
  /// the agents it owns (a user's own agents).
  steerer(conn, member, live = false) {
    if (conn.record.role === 'owner') return;
    const steer = conn.record.role === 'member' ? conn.record.steer : null;
    const may = steer === true || (steer === 'answer' && !live);
    if (!member) {
      // before the agent is looked up: anyone who could not steer any agent is told so first
      if (!may && !(live && conn.record.bringsAgents)) throw fail(403, live && steer ? 'Direct view is not open to this token' : 'Owners only');
      return;
    }
    if (live && this.owns(conn, member)) return;
    // a token for every room (no rooms) steers in all of them
    if (may && (!conn.record.rooms || conn.record.rooms.includes(member.room))) return;
    if (live && conn.record.bringsAgents) throw fail(403, `${member.name} isn't yours: ask its owner`);
    throw fail(403, live && steer ? 'Direct view is not open to this token' : 'Owners only');
  }

  /// An agent belongs to the token that started it: a user's own agents are theirs; every agent is
  /// the hub owner's to control.
  owns(conn, member) {
    if (conn.record.role === 'owner') return true;
    return Boolean(member && member.kind === 'agent' && conn.record.role === 'member' && conn.record.bringsAgents && member.tokenId === conn.record.id);
  }

  /// Stopping, restarting, its own slash commands, live mode: the hub owner on any agent, a user on
  /// the agents it owns.
  controller(conn, member) {
    if (this.owns(conn, member)) return;
    if (conn.record.role === 'member' && conn.record.bringsAgents) throw fail(403, `${member.name} isn't yours: ask its owner`);
    throw fail(403, 'Owners only');
  }

  /// Who an agent belongs to, as the room shows it ("alenclaude · alen"): a user token's name, or the
  /// person an agent's own token was made for; null for the hub's own agents.
  ownerName(member) {
    if (!member || member.kind !== 'agent') return null;
    const t = this.auth.tokens.find((x) => x.id === member.tokenId);
    if (!t) return null;
    if (t.role === 'member' && t.bringsAgents) return t.name;
    if (t.role === 'agent' && t.createdBy) return t.createdBy;
    return null;
  }

  /// Stops an agent for good: its notes first, then its process ends (the wrapper's !retire).
  kill(conn, ref) {
    const member = this.resolve(conn, ref);
    if (member.kind !== 'agent') throw fail(400, `${member.name} is not an agent`);
    this.controller(conn, member);
    if (!member.connected) throw fail(409, `${member.name} is not running`);
    const msg = { id: id(), ts: now(), room: member.room, kind: 'control', from: this.from(conn), to: member.name, text: '!retire', steered: conn.record.role !== 'owner' };
    this.pushInbox(member.key, msg);
    for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
    this.system(member.room, `${this.from(conn).name} stopped ${member.name} (notes first)`);
    return { name: member.name, room: member.room };
  }

  /// What a token is doing now: its open connections and the members online through it.
  tokenUse(tokenId) {
    const connections = [...this.conns.values()].filter((c) => c.record.id === tokenId).length;
    const online = [...this.members.values()].filter((m) => m.tokenId === tokenId && m.connected);
    return {
      connections,
      agents: online.filter((m) => m.kind === 'agent').map((m) => m.key),
      people: online.filter((m) => m.kind === 'human').map((m) => m.name),
    };
  }

  /// A token's rooms changed: its live connections follow at once, and those now in a room it
  /// no longer has are closed. Returns how many were closed.
  rescope(tokenId, rooms) {
    let closed = 0;
    for (const c of [...this.conns.values()]) {
      if (c.record.id !== tokenId) continue;
      if (rooms) c.record.rooms = rooms;
      else delete c.record.rooms;
      if (!rooms || !c.room || rooms.includes(c.room)) continue;
      this.unbind(c.client);
      try {
        c.client.close();
      } catch {
        // already gone
      }
      closed++;
    }
    this.changed();
    return closed;
  }

  /// Closes every connection signed in with this token (revoked). Returns how many.
  cut(tokenId) {
    const doomed = [...this.conns.values()].filter((c) => c.record.id === tokenId);
    for (const c of doomed) {
      this.unbind(c.client);
      try {
        c.client.close();
      } catch {
        // already gone
      }
    }
    return doomed.length;
  }

  /// Whether a token limited to rooms may act in this one. Unlimited tokens may anywhere.
  inScope(conn, room) {
    const rooms = conn.record.rooms;
    return !rooms || rooms.includes(room);
  }

  scope(conn, room) {
    if (!this.inScope(conn, room)) throw fail(403, `This token is only for ${conn.record.rooms.join(', ')}`);
  }

  // MARK: what an agent may reach

  /// The rooms this caller may read and write, or null for any. An owner: any. An agent: its own
  /// room and the rooms the owner invited it to, never more than its token allows. A connection
  /// with an agent token that has not registered as an agent yet: only the rooms its token names.
  /// A person with a member token: what the token allows, as before.
  roomsOf(conn) {
    if (conn.record.role === 'owner') return null;
    const scope = conn.record.rooms || null;
    const member = conn.key ? this.members.get(conn.key) : null;
    if (member && member.kind === 'agent') {
      const mine = [member.room, ...(member.invited || [])];
      return scope ? mine.filter((r) => scope.includes(r)) : mine;
    }
    if (conn.record.role === 'agent') return scope || [];
    return scope;
  }

  /// The rooms whose members this caller may message and see: exactly the rooms it is in (its own
  /// and those it is a guest of). There is no one-way channel to other rooms any more (misha,
  /// 2026-10-14): an agent reaches another room only by being invited into it, which the owner
  /// can take back (/uninvite). A `sendTo` an agent had from before is ignored.
  reachOf(conn) {
    return this.roomsOf(conn);
  }

  mayUse(conn, room) {
    const rooms = this.roomsOf(conn);
    return !rooms || rooms.includes(room);
  }

  use(conn, room) {
    if (this.mayUse(conn, room)) return;
    const rooms = this.roomsOf(conn);
    throw fail(403, rooms.length ? `${conn.name || 'this connection'} is not in ${room} (it is in ${rooms.join(', ')})` : 'Register as an agent first');
  }

  /// Whether this caller sees a member: one whose room it reaches, or a guest invited into one.
  sees(conn, m) {
    if (!conn) return true;
    if (!this.inScope(conn, m.room) && !(m.invited || []).some((r) => this.inScope(conn, r))) return false;
    const reach = this.reachOf(conn);
    return !reach || reach.includes(m.room) || (m.invited || []).some((r) => reach.includes(r));
  }

  from(conn) {
    const member = conn.key ? this.members.get(conn.key) : null;
    // a member token that may run agents is a user: what the chats show
    const who = { name: conn.name || conn.record.name, role: conn.record.role === 'member' && conn.record.bringsAgents ? 'user' : conn.record.role, kind: member ? member.kind : 'human' };
    if (conn.record.rooms) who.rooms = conn.record.rooms;
    return who;
  }

  // MARK: members

  register(conn, info = {}) {
    if (conn.ephemeral) throw fail(400, 'Register over a websocket connection');
    const name = String(info.name || '');
    if (!NAME.test(name)) throw fail(400, 'name: letters, digits, dot, dash, underscore, up to 32');
    if (info.follow) return this.follow(conn, name, info.room, info.key);
    const kind = info.kind || 'agent';
    if (!KINDS.has(kind)) throw fail(400, 'kind must be agent or human');
    if (kind === 'human' && conn.record.role === 'agent') throw fail(403, 'Agent tokens join as agents');
    if (kind === 'agent' && conn.record.role === 'member' && !conn.record.bringsAgents) throw fail(403, 'Member tokens are for people; join as human');
    if (info.room !== undefined && !ROOM.test(String(info.room))) throw fail(400, 'room: letters, digits, dot, dash, underscore, up to 64');
    // an agent registering without a room keeps the one it had, if its name is in just one
    const named = kind === 'agent' ? this.named(name) : [];
    const room = info.room !== undefined ? String(info.room) : kind === 'agent' ? (named.length === 1 ? named[0].room : 'default') : undefined;
    if (room !== undefined) this.scope(conn, room);
    const key = keyOf(kind, name, room);
    let member = this.members.get(key);
    // a name held by a token that no longer exists (revoked) goes to the token registering it now
    if (member && member.tokenId !== conn.record.id && conn.record.role !== 'owner' && this.auth.tokens.some((t) => t.id === member.tokenId)) {
      throw fail(403, `"${name}" belongs to another token`);
    }
    if (member && member.tokenId !== conn.record.id && conn.record.role !== 'owner') member.tokenId = conn.record.id;
    if (!member) {
      member = { key, name, kind, tokenId: conn.record.id, since: now(), status: 'starting' };
      this.members.set(key, member);
    }
    if (room !== undefined) member.room = room;
    if (!member.room) member.room = 'default';
    // a new name gets a colour nobody it can meet has; one that moved into a room where its
    // colour is taken gets another
    const color = colors.pick(member, [...this.members.values()]);
    if (color !== member.color) {
      member.color = color;
      this.saveMembers();
    }
    if (info.repo !== undefined) member.repo = info.repo ? String(info.repo).slice(0, 512) : null;
    if (Array.isArray(info.caps)) member.caps = info.caps.map((c) => String(c).slice(0, 32)).slice(0, 32);
    if (info.host !== undefined) member.host = String(info.host).slice(0, 128);
    if (info.command !== undefined) member.command = String(info.command).slice(0, 256);
    if (typeof info.notes === 'string' && info.notes) member.notes = info.notes.slice(0, 512);
    // the hash of a key only this agent's own processes hold (its wrapper made it and put it in
    // their environment): following the agent, to speak as it, takes that key. Kept in memory.
    if (typeof info.followHash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(info.followHash)) member.followHash = info.followHash;
    const wasConnected = member.connected;
    if (!member.connected) member.status = kind === 'agent' ? 'starting' : 'waiting';
    member.connected = true;
    member.attention = false;
    member.reason = null;
    member.lastSeen = now();
    if (conn.key && conn.key !== key) this.unbind(conn.client);
    conn.name = name;
    conn.key = key;
    conn.room = member.room;
    if (!this.byName.has(key)) this.byName.set(key, new Set());
    this.byName.get(key).add(conn.client);
    this.console.log(`hub: ${name} (${kind}) joined room ${member.room} from ${conn.ip}`);
    // a room session (docs/sessions.md): the agent of that name whose sessions include this room;
    // it is not a guest there any more, it lives there
    const homeOf = kind === 'agent' ? this.named(name).find((m) => m !== member && m.tokenId === member.tokenId && (m.sessions || []).includes(member.room)) : null;
    if (homeOf) {
      // its first time here: what it is and where its work is
      if (!member.welcomed) {
        member.welcomed = true;
        const welcome = { id: id(), ts: now(), room: member.room, kind: 'command', from: { name: 'hub', role: 'system', kind: 'system' }, to: name,
          text: `You are ${name}'s session for room ${member.room}, started fresh; ${name} in ${homeOf.room} keeps its own work. Your work is this room's: read its history first (hub_read), then the notes about ${member.room} in your PROGRESS files, and carry on from there. Your own notes are PROGRESS-${name}@${member.room}.md. You share this folder with ${name} of ${homeOf.room}: commit only your own files, and pull before you commit.\n${this.notesList(homeOf)}` };
        this.pushInbox(member.key, welcome);
        this.store.appendRoom(member.room, welcome);
        this.broadcastMessage('room/message', welcome, member.room);
      }
      const first = !member.toldSiblings;
      member.toldSiblings = true;
      member.home = homeOf.room;
      if ((homeOf.invited || []).includes(member.room)) homeOf.invited = homeOf.invited.filter((r) => r !== member.room);
      if (first) this.tellSiblings(homeOf, member);
      clearTimeout(this.starting.get(member.key));
      if (this.starting.delete(member.key) || first) this.system(member.room, `${name}'s session here is up (from ${homeOf.room}, on ${member.host || homeOf.host || 'its machine'})`);
    }
    this.saveMembers();
    // back within the grace: it never left, so there is nothing to say
    const back = this.leaving.has(key);
    if (back) {
      clearTimeout(this.leaving.get(key));
      this.leaving.delete(key);
    }
    if (!wasConnected && !back) this.system(member.room, `${name} joined${member.host ? ' from ' + member.host : ''}`);
    this.changed();
    // an archived room takes no messages: the wrapper says so rather than sounding broken
    if (this.archived.has(member.room)) return { ...this.publicMember(member), archived: true };
    // the wrapper starts the room sessions not running yet (an invite made while it was away too)
    if (member.sessions && member.sessions.length) {
      const startSessions = this.pendingSessions(member);
      for (const r of startSessions) if (!this.starting.has(keyOf('agent', member.name, r))) this.expectSession(member, r);
      return { ...this.publicMember(member), startSessions };
    }
    return this.publicMember(member);
  }

  /// Agents of this name, in whatever room.
  named(name) {
    return [...this.members.values()].filter((m) => m.kind === 'agent' && m.name === name);
  }

  /// The member a name means to this caller: "cmo@marketing" exactly; a bare "cmo" is the cmo in the
  /// caller's room, else a person called so, else the one agent of that name anywhere. Two or
  /// more elsewhere and none here is a question only the caller can answer.
  /// An agent's connection: its token's role, or the member it registered as.
  isAgent(conn) {
    return conn.record.role === 'agent' || Boolean(conn.key && this.members.get(conn.key)?.kind === 'agent');
  }

  resolve(conn, ref) {
    ref = String(ref || '');
    if (ref.includes('@')) {
      // an agent addressing another room is told it is not in it (whoever is there)
      if (conn && this.isAgent(conn)) this.use(conn, ref.slice(ref.lastIndexOf('@') + 1));
      const exact = this.members.get(ref);
      if (!exact || (conn && !this.sees(conn, exact))) throw fail(404, `No agent ${ref}`);
      return exact;
    }
    const own = conn && conn.key ? this.members.get(conn.key) : null;
    const room = conn && conn.room && conn.room !== '*' ? conn.room : own ? own.room : null;
    const here = room && this.members.get(keyOf('agent', ref, room));
    if (here && (!conn || this.sees(conn, here))) return here;
    const person = this.members.get(ref);
    if (person) return person;
    const all = this.named(ref).filter((m) => !conn || this.sees(conn, m));
    if (all.length === 1) return all[0];
    if (all.length > 1) throw fail(409, `"${ref}" is an agent in ${all.map((m) => m.room).join(' and ')}; say which: ${all.map((m) => m.key).join(' or ')}`);
    throw fail(404, `No agent named "${ref}"`);
  }

  /// A companion connection (the MCP bridge inside the agent) speaks as a member its wrapper
  /// registered, but never counts for presence: the member is online while the wrapper is, and a
  /// bridge a background process kept alive after the wrapper exited cannot hold it online.
  /// A process of an agent's (its MCP bridge, `metacom` in its shell) speaks as the agent. That takes
  /// the agent's key, which only its own processes hold: agents of one machine share a token, so
  /// the token alone would let any of them, or any shell with MC_AGENT set, speak as another.
  follow(conn, name, room, key = null) {
    const named = this.named(name);
    const member = room !== undefined ? this.members.get(keyOf('agent', name, room)) : named.length === 1 ? named[0] : null;
    if (!member) throw fail(404, `No agent named "${name}"${room !== undefined ? ' in ' + room : ''}; its wrapper registers it`);
    this.scope(conn, member.room);
    if (member.tokenId !== conn.record.id && conn.record.role !== 'owner') {
      throw fail(403, `"${name}" belongs to another token`);
    }
    // registered by a wrapper from before keys: as before, until it restarts
    if (member.followHash && crypto.createHash('sha256').update(String(key || '')).digest('base64url') !== member.followHash) {
      throw fail(403, `only ${name}'s own processes speak as ${name} (no MC_AGENT_KEY for it here)`);
    }
    if (conn.key && conn.key !== member.key) this.unbind(conn.client);
    conn.name = name;
    conn.key = member.key;
    conn.room = member.room;
    conn.follow = true;
    return this.publicMember(member);
  }

  /// An agent's context size, as its wrapper reads it after each turn (lib/rotate.js).
  contextReport(conn, tokens) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || member.kind !== 'agent') throw fail(400, 'Register first');
    member.ctx = Math.max(0, Math.round(Number(tokens) || 0));
    member.ctxAt = now();
    return { ctx: member.ctx };
  }

  /// Its wrapper cleared its context between tasks: one quiet line in the room, and the count.
  rotated(conn, before, after, batch = null, skipped = null) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || member.kind !== 'agent') throw fail(400, 'Register first');
    // one of an "@all !/clear": counted there, and the room gets one line when all are done
    const b = batch ? this.clears.get(String(batch)) : null;
    if (b && b.waiting.has(member.key)) {
      b.waiting.delete(member.key);
      if (skipped) b.kept.push({ name: member.name, reason: String(skipped).slice(0, 120) });
      else {
        b.cleared.push({ name: member.name, before });
        member.rotations = (member.rotations || 0) + 1;
        member.rotatedAt = now();
        if (Number.isFinite(Number(after)) && after !== null) member.ctx = Math.round(Number(after));
      }
      if (!b.waiting.size) this.clearDone(String(batch));
      return { rotations: member.rotations || 0 };
    }
    if (skipped) return { rotations: member.rotations || 0 };
    const k = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Number(n) >= 1000 ? `${Math.round(Number(n) / 1000)}k` : String(Math.round(Number(n))));
    member.rotations = (member.rotations || 0) + 1;
    member.rotatedAt = now();
    if (k(after) !== null) member.ctx = Math.round(Number(after));
    this.system(member.room, `rotated ${member.name} (ctx ${k(before) ?? '?'} → ${k(after) ?? 'fresh'})`);
    return { rotations: member.rotations };
  }

  setStatus(conn, status, reason = null, question = null) {
    if (!conn.name) throw fail(400, 'Register first');
    if (!STATUSES.has(status)) throw fail(400, `status must be one of ${[...STATUSES].join(', ')}`);
    const member = this.members.get(conn.key);
    member.reason = reason ? String(reason).slice(0, 120) : null;
    const asked = status === 'blocked' ? cleanQuestion(question) : null;
    const fresh = asked && (!member.question || member.question.id !== asked.id);
    member.question = asked;
    if (fresh) this.ask(member);
    if (fresh) this.alert('blocked', member);
    if (member.status === status) {
      if (fresh) this.changed();
      return this.publicMember(member);
    }
    const before = member.status;
    member.status = status;
    member.lastSeen = now();
    this.console.log(`hub: ${member.name} ${before} -> ${status}${member.reason ? ' (' + member.reason + ')' : ''}`);
    // herdr's "done": finished a turn the owner asked for and nobody has looked yet. Blocked always needs a look.
    if (status === 'blocked') member.attention = true;
    else if (before === 'working' && status === 'waiting' && member.turnPending) {
      member.attention = true;
      member.turnPending = false;
      this.alert('done', member);
    }
    this.settle(member);
    if (status === 'waiting') this.loops.idle(member);
    this.changed();
    return this.publicMember(member);
  }

  /// The question an agent is blocked on, posted to its room as a message from it: what the dialog
  /// says and its options, numbered. The owner answers by replying (answerFrom), from any client.
  ask(member) {
    const q = member.question;
    const lines = [`needs you:`, q.text, ...q.options.map((o, i) => `${i + 1}. ${o.label}`)];
    const others = [...this.members.values()].filter((m) => m !== member && m.room === member.room && m.connected && m.status === 'blocked' && m.question);
    const at = others.length ? `@${member.name} ` : '';
    if (q.options.length) {
      const range = q.options.length === 1 ? '1' : `1-${q.options.length}`;
      lines.push(`Reply ${at}${range}${declineOf(q) ? ', or say what to do instead' : ''}.`);
    } else lines.push(`Answer it on its screen: /direct ${member.name}.`);
    if (this.archived.has(member.room)) return;
    const msg = { id: id(), ts: now(), room: member.room, kind: 'say', from: { name: member.name, role: 'agent', kind: 'agent' }, text: lines.join('\n'), question: { id: q.id, agent: member.name, options: q.options.length } };
    this.store.appendRoom(member.room, msg);
    this.broadcast('room/message', msg, member.room);
  }

  /// The owner's "@all !/<command>" in a room: to every agent of the room (not guests from other
  /// rooms), each on its wrapper. "!/clear" is the safe clear (lib/rotate.js): its notes first,
  /// then /clear (Codex: /new), then they are read again, each when it is idle; one room line says
  /// how it went when all are done. Any other command is typed into each as it is.
  toAll(conn, room, line) {
    this.owner(conn);
    const command = line.replace(/^@all\s+/, '');
    const said = { id: id(), ts: now(), room, kind: 'say', from: this.from(conn), by: this.author(conn), text: line };
    this.store.appendRoom(room, said);
    this.broadcastMessage('room/message', said, room);
    const agents = [...this.members.values()].filter((m) => m.kind === 'agent' && m.room === room && m.connected);
    const clear = /^!\/clear\s*$/.test(command);
    if (clear && agents.length) {
      const batch = { room, by: this.from(conn).name, waiting: new Set(agents.map((m) => m.key)), cleared: [], kept: [] };
      batch.timer = setTimeout(() => this.clearDone(said.id), CLEAR_ALL_TIMEOUT);
      if (batch.timer.unref) batch.timer.unref();
      this.clears.set(said.id, batch);
    }
    this.fanOut(conn, room, 'control', command, said.id, null, PLAIN.test(command));
    return { ...said, all: agents.map((m) => m.name) };
  }

  /// One message to every agent online in the room (not guests from other rooms), on its wrapper:
  /// no line each in the room, the "@all" line is the room's record. Says who got it.
  fanOut(conn, room, kind, body, batch, files = null, plain = false) {
    const agents = [...this.members.values()].filter((m) => m.kind === 'agent' && m.room === room && m.connected);
    for (const member of agents) {
      const msg = { id: id(), ts: now(), room, kind, from: this.from(conn), to: member.name, text: body, batch };
      if (files) msg.media = files;
      if (plain) msg.plain = true;
      this.pushInbox(member.key, msg);
      for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
      if (kind === 'command' && conn.record.role === 'owner') member.turnPending = true;
    }
    if (!agents.length) this.system(room, `no agent online in ${room} for that @all`);
    return agents.map((m) => m.name);
  }

  /// "@all !/clear" done (or given up on): one line for the room.
  clearDone(batchId) {
    const b = this.clears.get(batchId);
    if (!b) return;
    clearTimeout(b.timer);
    this.clears.delete(batchId);
    const k = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '?' : Number(n) >= 1000 ? `${Math.round(Number(n) / 1000)}k` : String(Math.round(Number(n))));
    const n = b.cleared.length;
    const parts = [n ? `${b.by} cleared ${n} agent${n === 1 ? '' : 's'} (ctx ${b.cleared.map((c) => k(c.before)).join('+')} → fresh)` : `${b.by}'s !/clear: no agent cleared`];
    if (b.kept.length) parts.push(`not cleared: ${b.kept.map((c) => `${c.name} (${c.reason})`).join(', ')}`);
    const late = [...b.waiting].map((key) => this.members.get(key)?.name || key);
    if (late.length) parts.push(`not idle yet: ${late.join(', ')}`);
    this.system(b.room, parts.join('; '));
  }

  /// The owner's reply to a blocked agent's question: option n. The wrapper moves the cursor there
  /// and presses Enter, only if that question is still on screen. Logged in the room as one line.
  answer(conn, member, n) {
    // an agent the owner named (/delegate answers <agent>) may answer a folder-trust question, the
    // one setup question that otherwise waits on the owner; nothing else (tool permissions, logins)
    if (this.isAgent(conn) && this.delegated(conn, 'answers') && isTrustQuestion(member.question)) {
      // allowed
    } else this.steerer(conn, member);
    const q = member.question;
    const option = q.options[n - 1];
    const msg = { id: id(), ts: now(), room: member.room, kind: 'control', from: this.from(conn), to: member.name, text: `!answer ${q.id} ${n}` };
    this.pushInbox(member.key, msg);
    for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
    // kept until the screen moves on: if the dialog did not take the keys, a second reply can
    member.attention = false;
    this.system(member.room, `${this.from(conn).name} answered ${member.name}: ${n}. ${option.label}`);
    this.changed();
    return { id: msg.id, to: member.name, room: member.room, kind: 'answer', option: n, label: option.label, delivered: true };
  }

  /// A push alert to the owner's devices (lib/push.js), when the hub has them: stuck, or done; done
  /// says whether the agent left a message for a person (sent to them or @naming them) that they
  /// have not read yet. Never in the way of the status.
  alert(kind, member) {
    if (!this.push) return;
    let unread = false;
    if (kind === 'done') {
      const people = new Set([...this.members.values()].filter((x) => x.kind === 'human').map((x) => x.name));
      const toPerson = (x) => (x.to && people.has(x.to) ? x.to : mentions(x.text).find((n) => people.has(n)) || null);
      const said = foldEdits(this.store.tailRoom(member.room, 60)).filter((m) => m.from && m.from.name === member.name && ['say', 'info', 'command'].includes(m.kind) && !m.question);
      const lastTo = said.filter(toPerson).at(-1);
      if (lastTo) {
        const person = toPerson(lastTo);
        const since = (this.readMarks.marks[person] || {})[member.room] || this.readMarks.since;
        unread = foldEdits(this.store.tailRoom(member.room, 1000, since)).some((x) => x.from && x.from.name === member.name && x.kind !== 'system' && (x.to === person || mentions(x.text).includes(person)));
      }
    }
    this.push.alert(kind, member, unread).catch((error) => this.console.warn(`push: ${error.message}`));
  }

  /// A one-tap answer from an alert: the capability names the question, and it must still be the one
  /// on screen. It answers as the owner the alert went to.
  answerByCap(cap, n) {
    const c = this.push && this.push.redeem(cap);
    if (!c) return { ok: false, text: 'This alert has expired or was already answered.' };
    const member = this.members.get(c.key);
    if (!member || !member.connected || member.status !== 'blocked' || !member.question || member.question.id !== c.qid) return { ok: false, text: 'That question is no longer asked.' };
    if (!member.question.options[n - 1]) return { ok: false, text: `There is no option ${n}.` };
    const r = this.answer({ record: { role: 'owner', name: c.by || 'owner' }, name: c.by || 'owner' }, member, n);
    return { ok: true, text: `${member.name}: ${n}. ${r.label}` };
  }

  /// Agents of a room waiting on a question, for a reply posted to the room.
  asking(room) {
    return [...this.members.values()].filter((m) => m.kind === 'agent' && m.room === room && m.connected && m.status === 'blocked' && m.question && m.question.options.length);
  }

  /// Server-owned wait for an agent to reach one of the given statuses (herdr's agent wait).
  wait(conn, name, until = [...READY], timeoutMs = 60_000) {
    const member = name && typeof name === 'object' ? name : this.resolve(conn, name);
    const wanted = new Set((Array.isArray(until) ? until : [until]).filter((s) => STATUSES.has(s)));
    if (wanted.size === 0) throw fail(400, 'until: list of statuses');
    const started = Date.now();
    const current = member.connected ? member.status : 'stopped';
    if (wanted.has(current)) return Promise.resolve({ name: member.name, status: current, reason: member.reason, elapsedMs: 0 });
    const limit = Math.min(Math.max(Number(timeoutMs) || 60_000, 1_000), 600_000);
    return new Promise((resolve) => {
      const list = this.waiters.get(member.key) || [];
      const entry = { wanted, resolve: null, timer: null };
      entry.resolve = (status) => {
        clearTimeout(entry.timer);
        const remaining = (this.waiters.get(member.key) || []).filter((w) => w !== entry);
        this.waiters.set(member.key, remaining);
        resolve({ name: member.name, status, reason: member.reason, elapsedMs: Date.now() - started, timeout: status === null });
      };
      entry.timer = setTimeout(() => entry.resolve(null), limit);
      list.push(entry);
      this.waiters.set(member.key, list);
    });
  }

  settle(member) {
    const status = member.connected ? member.status : 'stopped';
    for (const w of [...(this.waiters.get(member.key) || [])]) if (w.wanted.has(status)) w.resolve(status);
  }

  /// The agent's screen, asked from its wrapper (herdr's agent read). Owner only: screens hold secrets.
  // MARK: live mode. The owner watches an agent's screen as it changes and types into it
  // (docs/direct.md). The wrapper sends frames (changed rows, cursor, size) only while someone
  // watches; the hub relays them, and relays the owner's keys back. Keys are not logged.

  live(conn, name, on = true) {
    this.steerer(conn, null, true);
    const member = this.resolve(conn, name);
    this.steerer(conn, member, true);
    if (!on) return this.unwatch(conn, member.key);
    const clients = this.byName.get(member.key);
    if (!member.connected || !clients || clients.size === 0) throw fail(409, `${member.name} is offline`);
    const set = this.watchers.get(member.key) || new Set();
    const first = !set.has(conn);
    set.add(conn);
    this.watchers.set(member.key, set);
    // every new viewer gets a whole frame: the wrapper sends one on each start
    for (const client of clients) this.emit(client, 'agents/liveStart', {});
    if (first) this.system(member.room, `${this.from(conn).name} is in ${member.name}'s terminal (direct)`);
    // looking at it is what clears its "done" / "needs you" badge
    if (member.attention) {
      member.attention = false;
      this.changed();
    }
    return { name: member.name, live: true };
  }

  unwatch(conn, key) {
    const set = this.watchers.get(key);
    if (!set || !set.has(conn)) return { live: false };
    set.delete(conn);
    const member = this.members.get(key);
    if (member) this.system(member.room, `${this.from(conn).name} left ${member.name}'s terminal (direct)`);
    if (set.size === 0) {
      this.watchers.delete(key);
      for (const client of this.byName.get(key) || []) this.emit(client, 'agents/liveStop', {});
    }
    return { name: member ? member.name : null, live: false };
  }

  liveFrame(conn, frame) {
    if (!conn.key) throw fail(400, 'Register first');
    const viewers = this.watchers.get(conn.key);
    if (!viewers || viewers.size === 0) return { watched: false };
    const member = this.members.get(conn.key);
    const f = frame && typeof frame === 'object' ? frame : {};
    const out = { name: member.name, cols: Number(f.cols) || 0, rows: Number(f.rows) || 0, cursor: Array.isArray(f.cursor) ? f.cursor.slice(0, 2).map(Number) : null, full: Boolean(f.full), lines: {} };
    for (const [i, line] of Object.entries(f.lines || {})) if (Number(i) >= 0 && Number(i) < 500) out.lines[i] = String(line).slice(0, 20_000);
    for (const viewer of viewers) this.emit(viewer.client, 'agents/liveFrame', out);
    return { watched: true };
  }

  /// Scrolled back while live: the screenful `offset` rows above the live one, asked from the
  /// agent's wrapper (its scrollback) and answered to the viewer alone; nothing goes to the agent.
  async liveScroll(conn, name, offset) {
    this.steerer(conn, null, true);
    const member = this.resolve(conn, name);
    this.steerer(conn, member, true);
    if (!(this.watchers.get(member.key) || new Set()).has(conn)) throw fail(409, `Not watching ${member.name}: /direct ${member.name} first`);
    const clients = [...(this.byName.get(member.key) || [])];
    if (!clients.length) throw fail(409, `${member.name} is offline`);
    const req = id();
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.scrolls.delete(req);
        reject(fail(504, `${member.name}'s wrapper did not answer: restart it to scroll back`));
      }, LIVE_SCROLL_TIMEOUT);
      this.scrolls.set(req, { key: member.key, resolve: (frame) => (clearTimeout(timer), resolve(frame)) });
    });
    // to each of its connections (the wrapper answers; its MCP bridge does not listen)
    for (const client of clients) this.emit(client, 'agents/liveScroll', { req, offset: Math.max(0, Math.floor(Number(offset)) || 0) });
    const f = await answer;
    const lines = (Array.isArray(f.lines) ? f.lines : []).slice(0, 500).map((l) => String(l).slice(0, 20_000));
    return { name: member.name, cols: Number(f.cols) || 0, rows: Number(f.rows) || 0, offset: Number(f.offset) || 0, max: Number(f.max) || 0, lines };
  }

  liveHistory(conn, req, frame) {
    const pending = this.scrolls.get(String(req || ''));
    if (!pending || pending.key !== conn.key) return { taken: false };
    this.scrolls.delete(String(req));
    pending.resolve(frame && typeof frame === 'object' ? frame : {});
    return { taken: true };
  }

  liveKeys(conn, name, data) {
    this.steerer(conn, null, true);
    const member = this.resolve(conn, name);
    this.steerer(conn, member, true);
    if (!(this.watchers.get(member.key) || new Set()).has(conn)) throw fail(409, `Not watching ${member.name}: /direct ${member.name} first`);
    const keys = String(data || '').slice(0, 4096);
    if (!keys) return { sent: 0 };
    for (const client of this.byName.get(member.key) || []) this.emit(client, 'agents/liveKeys', { data: keys });
    return { sent: keys.length };
  }

  list(conn, room) {
    const all = [...this.members.values()].filter((m) => this.sees(conn, m)).map((m) => this.publicMember(m));
    const scope = room || (conn.room === '*' ? null : conn.room);
    // a room's members are the ones who live there and the guests invited into it
    return scope ? all.filter((m) => m.room === scope || (m.invited || []).includes(scope)) : all;
  }

  publicMember(m) {
    const { key, name, kind, room, repo, caps = [], host, command, status, connected, since, lastSeen, attention, reason, color, invited, sessions, home } = m;
    return {
      id: key, name, kind, room, repo, caps, host, command, status, connected: Boolean(connected), since, lastSeen, attention: Boolean(attention), reason: reason || null,
      asking: m.question ? m.question.id : undefined,
      ctx: m.ctx, rotations: m.rotations || undefined,
      color,
      invited: invited && invited.length ? invited : undefined,
      sessions: sessions && sessions.length ? sessions : undefined, // rooms it has a session of its own in
      home: home || undefined, // a room session: the room of the agent it is a session of
      owner: this.ownerName(m) || undefined, // whose agent it is: a user, or the person its token was made for
      spend: m.kind === 'agent' && m.spend ? { day: m.spend.day, cost: m.spend.cost, budget: this.budgetOf(m) } : undefined,
      paused: this.isPaused(m) ? 'budget' : undefined,
    };
  }

  saveMembers() {
    const list = [...this.members.values()].map(({ name, kind, tokenId, room, repo, caps, host, command, since, lastSeen, color, invited, askedIn, sessions, home, notes, welcomed, toldSiblings }) => ({
      name, kind, tokenId, room, repo, caps, host, command, since, lastSeen, color, invited, askedIn, sessions, home, notes, welcomed, toldSiblings,
    }));
    this.store.saveJson('members.json', list);
  }

  // MARK: messages

  join(conn, room) {
    if (conn.ephemeral) throw fail(400, 'Join over a websocket connection');
    conn.room = String(room || '') || '*';
    if (conn.room !== '*' && !ROOM.test(conn.room)) throw fail(400, 'room: letters, digits, dot, dash, underscore, up to 64');
    if (conn.record.rooms && conn.room === '*') throw fail(403, `This token is only for ${conn.record.rooms.join(', ')}`);
    if (conn.room !== '*') this.scope(conn, conn.room);
    if (conn.room === '*' ? this.roomsOf(conn) : !this.mayUse(conn, conn.room)) {
      const asked = conn.room;
      conn.room = null;
      if (asked === '*') throw fail(403, 'Only an owner listens to every room');
      this.use(conn, asked);
    }
    return { room: conn.room, ...(this.archived.has(conn.room) ? { archived: true } : {}) };
  }

  say(conn, room, body, media = null, extra = {}) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.scope(conn, target);
    this.writable(target);
    this.use(conn, target);
    if (!media && ALL_CONTROL.test(String(body || '').trim()) && conn.record.role === 'owner') return this.toAll(conn, target, String(body).trim());
    if (!media && /^@all\s+!\//.test(String(body || '').trim())) this.owner(conn);
    const files = this.media.attachments(media);
    const handed = this.inlineSecrets(conn, target, text(body, 'text', Boolean(files)), null, extra.share);
    const gave = this.handOver(conn, target, handed);
    // only secrets, nothing else to say: the room's line about who has them is the message
    if (handed.quiet && !files) return { id: null, room: target, handed: gave };
    const msg = { id: id(), ts: now(), room: target, kind: 'say', from: this.from(conn), by: this.author(conn), text: handed.body };
    this.extras(msg, extra);
    // a newer suggestion to the same person stops the sender's older ones, unless asked to keep them
    if (msg.suggest && !extra.keepOlder) this.supersede(msg);
    if (gave) msg.handed = gave;
    if (files) msg.media = files;
    this.store.appendRoom(target, msg);
    this.broadcastMessage('room/message', msg, target);
    // "@all <text>" from a person: the room line, and typed into every agent of the room as an
    // instruction (an agent's "@all" is only text: one agent waking all the others costs them all)
    if (ALL_PEOPLE.test(handed.body) && !this.isAgent(conn)) {
      return { ...msg, all: this.fanOut(conn, target, 'command', handed.body.replace(ALL_PEOPLE, ''), msg.id, files) };
    }
    // the owner replying in the room to the one agent there that is asking: "2", "yes"
    if (conn.record.role === 'owner' && !files) {
      const waiting = this.asking(target);
      const picks = waiting.map((m) => pick(m.question, handed.body));
      if (waiting.length === 1 && picks[0]) msg.answered = this.answer(conn, waiting[0], picks[0]);
      else if (waiting.length > 1 && picks.some(Boolean)) this.system(target, `${waiting.map((m) => m.name).join(' and ')} are both asking: reply @name with the number`);
    }
    // a person's message that names nobody: to the room's lead agent too, as an instruction
    if (!msg.answered && !this.isAgent(conn)) this.toLead(conn, target, msg);
    return msg;
  }

  // MARK: the room's lead (/lead)

  /// Owner: an agent becomes the room's lead (or none): every message from a person there that
  /// names no one in particular (no @name of a member, not an @all) also goes to it as an
  /// instruction, so nothing said to the room in general is missed.
  /// Pictures and videos in every web chat's feed, or only their links (owner): the default for
  /// everyone; a device's own /preview choice still wins on that device.
  setPreviews(conn, on) {
    this.owner(conn);
    this.prefs.previews = Boolean(on);
    this.store.saveJson('prefs.json', this.prefs);
    this.broadcast('hub/prefs', { previews: this.prefs.previews });
    return { previews: this.prefs.previews };
  }

  // MARK: delegation

  /// A room's managers (owner): agents that may set, toggle and delete loops for any agent of that
  /// room. An empty list takes it back.
  manage(conn, room, names = []) {
    this.owner(conn);
    if (this.isAgent(conn)) throw fail(403, 'Owners only');
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    const list = [...new Set((Array.isArray(names) ? names : [names]).map((n) => String(n).replace(/^@/, '').trim()).filter(Boolean))];
    const managers = { ...(this.prefs.managers || {}) };
    if (list.length) managers[room] = list;
    else delete managers[room];
    this.prefs.managers = managers;
    this.store.saveJson('prefs.json', this.prefs);
    this.system(room, list.length ? `${this.from(conn).name} made ${list.join(', ')} the manager of ${room}: they set loops for the room's agents` : `${room} has no manager now`);
    return { room, managers: list };
  }

  manages(name, room) {
    return Boolean(name && ((this.prefs.managers || {})[room] || []).includes(name));
  }

  /// The owner names the agents that may act for it in one narrow thing: "answers" lets them answer
  /// other agents' folder-trust questions. An empty list takes it back.
  delegate(conn, what, names = []) {
    this.owner(conn);
    if (this.isAgent(conn)) throw fail(403, 'Owners only');
    if (what !== 'answers') throw fail(400, 'what can be delegated: answers (other agents\' folder-trust questions)');
    const list = [...new Set((Array.isArray(names) ? names : [names]).map((n) => String(n).replace(/^@/, '').trim()).filter(Boolean))];
    this.prefs.delegates = { ...(this.prefs.delegates || {}), [what]: list };
    this.store.saveJson('prefs.json', this.prefs);
    const room = conn.room && conn.room !== '*' ? conn.room : null;
    if (room) this.system(room, list.length ? `${this.from(conn).name} lets ${list.join(', ')} answer agents' folder-trust questions` : `${this.from(conn).name} answers agents' folder-trust questions again`);
    return { [what]: list };
  }

  delegated(conn, what) {
    const me = this.from(conn).name;
    return Boolean(me && ((this.prefs.delegates || {})[what] || []).includes(me));
  }

  // MARK: the spend guard

  budgetOf(member) {
    return Number(this.budgetFor.get(member.key)) || this.defaultBudget;
  }

  isPaused(member) {
    return Boolean(member && member.paused && member.spend && member.paused.day === member.spend.day);
  }

  /// An agent's wrapper reports what the agent cost today (by its machine's calendar day): the room
  /// hears at 80% of its budget, and at 100% it is paused until the owner resumes it, raises its
  /// budget, or the day turns.
  spend(conn, { day, cost, tokens } = {}) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || member.kind !== 'agent') throw fail(403, 'Only an agent reports its own spend');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw fail(400, 'day is YYYY-MM-DD');
    cost = Number(cost);
    if (!Number.isFinite(cost) || cost < 0) throw fail(400, 'cost is dollars, 0 or more');
    const before = member.spend;
    if (!before || before.day !== day) {
      if (this.isPaused(member)) this.release(member);
      member.paused = null;
      member.alerted = null;
      member.resumedDay = null;
    }
    member.spend = { day, cost, tokens: Number(tokens) || undefined, at: now() };
    const budget = this.budgetOf(member);
    const money = (n) => `$${n.toFixed(2)}`;
    if (cost >= budget && !member.paused && member.resumedDay !== day) {
      member.paused = { day, reason: 'budget' };
      member.alerted = day;
      this.system(member.room, `${member.name} reached its $${budget} budget for today (${money(cost)}): paused. /resume ${member.name}, or /budget ${member.name} $<more>`);
      this.changed();
    } else if (cost >= budget * 0.8 && member.alerted !== day && cost < budget) {
      member.alerted = day;
      this.system(member.room, `${member.name} has spent ${money(cost)} of its $${budget} today (80%)`);
      this.changed();
    } else if (!before || before.cost !== cost) this.changed();
    return { budget, paused: this.isPaused(member) };
  }

  /// What a paused agent was sent goes in now, in order.
  release(member) {
    const held = this.held.get(member.key) || [];
    this.held.delete(member.key);
    for (const msg of held) {
      this.pushInbox(member.key, msg);
      for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
    }
    return held.length;
  }

  /// The owner lifts a budget pause for the rest of the day.
  resume(conn, ref) {
    this.owner(conn);
    const member = this.resolve(conn, String(ref || '').replace(/^@/, ''));
    if (!this.isPaused(member)) throw fail(409, `${member.name} is not paused`);
    member.paused = null;
    member.resumedDay = member.spend.day;
    const n = this.release(member);
    this.system(member.room, `${this.from(conn).name} resumed ${member.name} for today${n ? `: ${n} held message${n === 1 ? '' : 's'} go in` : ''}`);
    this.changed();
    return { name: member.name, released: n };
  }

  /// An agent's daily budget, in dollars (owner); a pause lifts when the new budget is above today's spend.
  setBudget(conn, ref, dollars) {
    this.owner(conn);
    const member = this.resolve(conn, String(ref || '').replace(/^@/, ''));
    dollars = Number(String(dollars).replace(/^\$/, ''));
    if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000) throw fail(400, 'a budget is dollars a day, above 0');
    this.budgetFor.set(member.key, dollars);
    this.store.saveJson('budgets.json', Object.fromEntries(this.budgetFor));
    let note = '';
    if (this.isPaused(member) && member.spend.cost < dollars) {
      member.paused = null;
      const n = this.release(member);
      note = `; no longer paused${n ? `, ${n} held message${n === 1 ? '' : 's'} go in` : ''}`;
    }
    this.system(member.room, `${this.from(conn).name} set ${member.name}'s budget to $${dollars} a day${note}`);
    this.changed();
    return { name: member.name, budget: dollars };
  }

  /// Every agent's budget and what it spent on its last reported day (owner).
  budgets(conn) {
    this.owner(conn);
    return [...this.members.values()]
      .filter((m) => m.kind === 'agent')
      .map((m) => ({ name: m.name, room: m.room, budget: this.budgetOf(m), cost: m.spend ? m.spend.cost : 0, day: m.spend ? m.spend.day : null, paused: this.isPaused(m) }))
      .sort((a, b) => b.cost - a.cost);
  }

  // MARK: owner approvals

  /// An agent asks the owner for an outward action ("push main", "restart the hub"): posted in the
  /// room with its id, open for a day. Only the hub owner decides it (decide).
  request(conn, room, action, detail = '', risk = 'outward') {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.scope(conn, target);
    this.writable(target);
    this.use(conn, target);
    action = String(action || '').trim();
    detail = String(detail || '').trim();
    if (!action) throw fail(400, 'say what you ask for: the action');
    if (action.length > 200) throw fail(400, 'the action is at most 200 characters; the rest goes in the detail');
    if (detail.length > 2000) throw fail(400, 'the detail is at most 2,000 characters');
    // routine: safe to approve in a batch; outward: reaches beyond the room; irreversible: can't be undone
    if (!RISKS.includes(risk || 'outward')) throw fail(400, `risk is one of ${RISKS.join(', ')}`);
    risk = risk || 'outward';
    const from = this.from(conn);
    const rid = crypto.randomBytes(4).toString('hex');
    const record = { id: rid, agent: from.name, room: target, action, detail, risk, status: 'open', ts: now() };
    this.approvals.set(rid, record);
    this.saveApprovals();
    const msg = { id: id(), ts: record.ts, room: target, kind: 'request', from, by: this.author(conn), text: `asks the owner${risk === 'outward' ? '' : ` (${risk})`}: ${action}${detail ? ` (${detail})` : ''}`, request: record };
    this.store.appendRoom(target, msg);
    this.broadcastMessage('room/message', msg, target);
    return { id: rid, status: 'open' };
  }

  /// A request as it stands: expired once a day has passed undecided.
  requestNow(rid) {
    const r = this.approvals.get(rid);
    if (!r) return null;
    if (r.status === 'open' && Date.now() - Date.parse(r.ts) > 24 * 3600e3) return { ...r, status: 'expired' };
    return r;
  }

  /// One request, for the agent that asked (or anyone who can read its room): waiting on it.
  requestStatus(conn, rid) {
    const r = this.requestNow(String(rid || ''));
    if (!r) throw fail(404, `no request ${rid}`);
    this.scope(conn, r.room);
    return r;
  }

  /// The open requests in a room.
  requests(conn, room) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.scope(conn, target);
    return [...this.approvals.keys()].map((k) => this.requestNow(k)).filter((r) => r.room === target && r.status === 'open');
  }

  /// The owner's decision on a request: recorded in the room and typed into the agent that asked,
  /// as the owner's own word ("APPROVED <id>: <action>"). No other token can decide.
  decide(conn, rid, approve) {
    if (conn.record.role !== 'owner' || this.isAgent(conn)) throw fail(403, 'Only the hub owner approves or declines');
    const r = this.requestNow(String(rid || ''));
    if (!r) throw fail(404, `no request ${rid}`);
    if (r.status === 'expired') throw fail(410, `request ${r.id} expired (a day undecided): the agent asks again if it still needs it`);
    if (r.status !== 'open') throw fail(409, `request ${r.id} is ${r.status} already`);
    const who = this.from(conn).name;
    const status = approve ? 'approved' : 'declined';
    const done = { ...r, status, by: who, decidedAt: now() };
    this.approvals.set(r.id, done);
    this.saveApprovals();
    this.system(r.room, `${who} ${status} "${r.action}" (request ${r.id})`);
    this.broadcast('room/request', done, r.room);
    const member = this.members.get(keyOf('agent', r.agent, r.room));
    if (member) {
      const msg = { id: id(), ts: now(), room: r.room, kind: 'command', from: this.from(conn), to: member.name, text: `${approve ? 'APPROVED' : 'DECLINED'} ${r.id}: ${r.action}`, approval: { id: r.id, status } };
      this.pushInbox(member.key, msg);
      for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
    }
    return done;
  }

  /// Every routine request open in a room, decided at once (owner): the batch that keeps the owner
  /// from approving one small thing at a time. Outward and irreversible ones stay one by one.
  decideAll(conn, room, approve) {
    if (conn.record.role !== 'owner' || this.isAgent(conn)) throw fail(403, 'Only the hub owner approves or declines');
    const ids = [...this.approvals.keys()].map((k) => this.requestNow(k)).filter((r) => r.room === room && r.status === 'open' && r.risk === 'routine').map((r) => r.id);
    for (const rid of ids) this.decide(conn, rid, approve);
    return { decided: ids };
  }

  /// Every open request on the hub, for the owner: what waits for a decision, room by room.
  pendingApprovals(conn) {
    if (conn.record.role !== 'owner' || this.isAgent(conn)) throw fail(403, 'Owners only');
    return [...this.approvals.keys()].map((k) => this.requestNow(k)).filter((r) => r.status === 'open').sort((a, b) => a.room.localeCompare(b.room) || a.ts.localeCompare(b.ts));
  }

  saveApprovals() {
    // the decided ones are kept a week, for the record; the room log keeps them for good
    const week = Date.now() - 7 * 24 * 3600e3;
    for (const [k, r] of this.approvals) if (Date.parse(r.decidedAt || r.ts) < week) this.approvals.delete(k);
    this.store.saveJson('approvals.json', Object.fromEntries(this.approvals));
  }

  setLead(conn, room, ref) {
    this.owner(conn);
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    if (!ref || ref === 'off') {
      const was = this.leads[room];
      delete this.leads[room];
      this.store.saveJson('leads.json', this.leads);
      if (was) this.system(room, `${this.from(conn).name} took the lead from ${was}: messages to nobody in particular stay with the room`);
      return { room, lead: null };
    }
    const name = String(ref).replace(/^@/, '');
    const member = this.members.get(keyOf('agent', name, room));
    if (!member) throw fail(404, `no agent ${name} in ${room}`);
    this.leads[room] = member.name;
    this.store.saveJson('leads.json', this.leads);
    this.system(room, `${this.from(conn).name} made ${member.name} the lead here: messages to nobody in particular go to ${member.name}`);
    return { room, lead: member.name };
  }

  toLead(conn, room, msg) {
    const lead = this.leads[room];
    if (!lead || ALL_PEOPLE.test(msg.text || '')) return;
    const member = this.members.get(keyOf('agent', lead, room));
    if (!member) return;
    // addressed to someone here (an @name of a member): theirs, not the lead's
    if (mentions(msg.text).some((n) => [...this.members.values()].some((m) => m.name.toLowerCase() === n.toLowerCase() && (m.room === room || (m.invited || []).includes(room))))) return;
    const cmd = { id: id(), ts: now(), room, kind: 'command', from: this.from(conn), by: this.author(conn), to: member.name, text: msg.text, lead: true, replyTo: msg.id };
    if (msg.media) cmd.media = msg.media;
    this.pushInbox(member.key, cmd);
    for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', cmd);
    msg.lead = member.name;
  }

  async send(conn, to, body, kind = 'command', wait = null, media = null, extra = {}) {
    const member = this.resolve(conn, to);
    if (!['command', 'info'].includes(kind)) throw fail(400, 'kind must be command or info');
    const files = this.media.attachments(media);
    body = text(body, 'text', Boolean(files));
    const handed = this.inlineSecrets(conn, member.room || null, body, member);
    body = handed.body;
    const plain = kind === 'command' && member.kind === 'agent' && this.owns(conn, member) && PLAIN.test(body);
    if (plain) kind = 'control';
    if (kind === 'command' && CONTROL.test(body)) {
      this.controller(conn, member);
      kind = 'control';
    }
    if (kind === 'command' && member.connected && member.status === 'blocked') {
      // a reply to the question it is asking: an option, or (with a "No" option) what to do instead,
      // which turns the question down and then goes in as the command
      const q = member.question;
      const chosen = q && !files && pick(q, body);
      if (chosen) return this.answer(conn, member, chosen);
      const decline = q && declineOf(q);
      if (!decline) {
        const options = q && q.options.length ? `: reply with 1-${q.options.length}` : `; answer it on its screen: /direct ${member.name}`;
        throw fail(409, `${member.name} is blocked on a question${options}`);
      }
      this.answer(conn, member, decline);
    }
    // A directed message lives where the agent is: one to an agent in the agent's room, one from
    // an agent to a person in the agent's room too — not in whatever room that person has open,
    // which would scatter a project's conversation over other rooms' logs.
    const sender = conn.key ? this.members.get(conn.key) : null;
    const senderRoom = sender && sender.room && ROOM.test(sender.room) ? sender.room : null;
    const own = conn.record.rooms ? (senderRoom && this.inScope(conn, senderRoom) ? senderRoom : conn.record.rooms[0]) : senderRoom;
    // an agent reaches agents of its own rooms, guests invited into them, and rooms the owner
    // granted it; nobody else (and so nobody it was granted to can answer it)
    const mine = this.roomsOf(conn);
    const reach = this.reachOf(conn);
    const shared = mine ? (member.invited || []).filter((r) => mine.includes(r)) : [];
    if (reach && member.kind === 'agent' && !reach.includes(member.room) && !shared.length) {
      throw fail(403, `${conn.name || 'This connection'} cannot message agents in ${member.room}`);
    }
    // where it lives: with the agent; a guest is talked to in the room it shares with the sender
    let room = member.kind === 'agent' ? member.room : own || member.room;
    if (member.kind === 'agent' && mine && !mine.includes(member.room) && shared.length) room = shared.includes(senderRoom) ? senderRoom : shared[0];
    // a guest talked to from a room it is invited into (the one the sender has open) is talked to
    // there, the owner too: its home room only when the sender is in no room they share
    const open = conn.room && conn.room !== '*' ? conn.room : senderRoom;
    if (member.kind === 'agent' && open && open !== member.room && (member.invited || []).includes(open) && this.inScope(conn, open) && this.mayUse(conn, open)) room = open;
    // and its answer to a person goes where that person last talked to it
    const asked = sender && sender.kind === 'agent' && member.kind !== 'agent' && (sender.askedIn || {})[member.name];
    if (asked && (sender.invited || []).includes(asked)) room = asked;
    this.scope(conn, room);
    if (this.isAgent(conn)) this.use(conn, room);
    this.writable(room);
    const msg = { id: id(), ts: now(), room, kind, from: this.from(conn), by: this.author(conn), to: member.name, text: body };
    // a control its wrapper takes from someone other than the hub owner: the agent's own user
    if (kind === 'control' && conn.record.role !== 'owner') msg.steered = true;
    if (plain) msg.plain = true;
    // from another room: say so, so the room sees where it came from
    if (sender && sender.kind === 'agent' && senderRoom && senderRoom !== room) msg.from.room = senderRoom;
    if (files) msg.media = files;
    this.extras(msg, extra);
    // a newer suggestion to the same person stops the sender's older ones, unless asked to keep them
    if (msg.suggest && !extra.keepOlder) this.supersede(msg);
    const gave = this.handOver(conn, room, handed);
    if (handed.quiet && !files) return { id: null, to: member.name, room, kind: 'secret', handed: gave };
    // an agent never gets a suggested reply: that is for the person the message is to
    // a guest remembers where each person last talked to it, so its answers go back there
    if (member.kind === 'agent' && !this.isAgent(conn)) {
      const who = this.from(conn).name;
      const before = (member.askedIn || {})[who];
      if ((room !== member.room ? room : undefined) !== before) {
        member.askedIn = { ...(member.askedIn || {}) };
        if (room !== member.room) member.askedIn[who] = room;
        else delete member.askedIn[who];
        this.saveMembers();
      }
    }
    const forTarget = member.kind === 'agent' ? this.withoutSuggest(msg) : msg;
    // paused on its budget: held (in the room, not lost) until resumed; control commands still act
    if (member.kind === 'agent' && kind !== 'control' && this.isPaused(member)) {
      this.held.set(member.key, [...(this.held.get(member.key) || []), forTarget]);
      this.store.appendRoom(room, msg);
      this.broadcastMessage('room/message', msg, room);
      return { id: msg.id, to: member.name, room, kind, delivered: false, queued: true, paused: true, person: false };
    }
    this.pushInbox(member.key, forTarget);
    this.store.appendRoom(room, msg);
    this.broadcastMessage('room/message', msg, room);
    const clients = this.byName.get(member.key) || new Set();
    for (const client of clients) this.emit(client, 'agents/message', forTarget);
    if (kind === 'command' && conn.record.role === 'owner') {
      member.turnPending = true;
      // the owner is on it: a new instruction clears the badge of the turn before
      if (member.attention) {
        member.attention = false;
        this.changed();
      }
    }
    const result = { id: msg.id, to: member.name, room, kind, delivered: clients.size > 0, queued: !clients.size, person: member.kind !== 'agent' };
    if (gave) result.handed = gave;
    if (wait && result.delivered && kind === 'command') result.turn = await this.observeTurn(member, wait);
    return result;
  }

  /// After a command: expect the agent to start working within a few seconds, then settle
  /// (herdr's prompt --wait, including its "stalled" outcome when nothing happened).
  async observeTurn(member, wait) {
    const until = Array.isArray(wait.until) && wait.until.length ? wait.until : [...READY];
    const timeoutMs = Number(wait.timeoutMs) || 120_000;
    if (member.status === 'starting') {
      const ready = await this.wait(null, member, ['waiting', 'working', 'blocked', 'stopped'], 60_000);
      if (ready.timeout) return { status: member.status, stalled: true };
    }
    if (member.status !== 'working') {
      const started = await this.wait(null, member, ['working', 'blocked', 'stopped'], TURN_START_TIMEOUT);
      if (started.timeout) return { status: member.status, stalled: true };
      if (started.status !== 'working') return { status: started.status, stalled: false };
    }
    const done = await this.wait(null, member, until, timeoutMs);
    return { status: done.timeout ? member.status : done.status, stalled: false, timeout: Boolean(done.timeout) };
  }

  system(room, body, { evenArchived = false } = {}) {
    if (this.archived.has(room) && !evenArchived) return;
    const msg = { id: id(), ts: now(), room, kind: 'system', from: { name: 'hub', role: 'system', kind: 'system' }, text: body };
    this.store.appendRoom(room, msg);
    this.broadcast('room/message', msg, room);
  }

  async dispatch(conn, body, room, media = null) {
    this.owner(conn);
    const files = this.media.attachments(media);
    body = text(body, 'text', Boolean(files));
    const members = this.list(conn, room);
    const pick = await route(body || (files ? files.map((f) => f.name).join(' ') : ''), members);
    if (!pick) throw fail(404, 'No agent is connected');
    const picked = members.find((m) => m.kind === 'agent' && m.name === pick.agent);
    const result = await this.send(conn, picked ? picked.id : pick.agent, body, 'command', null, media);
    this.console.log(`hub: dispatch -> ${pick.agent} (${pick.reason})`);
    return { ...result, agent: pick.agent, reason: pick.reason, candidates: pick.candidates || [] };
  }

  pushInbox(name, msg) {
    const list = this.inbox.get(name) || [];
    list.push(msg);
    this.inbox.set(name, list.slice(-500));
    this.saveInbox();
  }

  inboxFor(conn, since) {
    if (!conn.key) throw fail(400, 'Register first');
    const list = this.inbox.get(conn.key) || [];
    return since ? list.filter((m) => m.ts > since) : list;
  }

  ack(conn, ids) {
    if (!conn.key) throw fail(400, 'Register first');
    const drop = new Set(Array.isArray(ids) ? ids : [ids]);
    const list = (this.inbox.get(conn.key) || []).filter((m) => !drop.has(m.id));
    this.inbox.set(conn.key, list);
    this.saveInbox();
    return { pending: list.length };
  }

  saveInbox() {
    this.store.saveJson('inbox.json', Object.fromEntries(this.inbox));
  }

  /// `from`: a message's id instead of a limit; the room from just before it to now, however far
  /// back it is (a jump to an old pin or suggestion).
  history(conn, room, limit = 50, since = null, from = null, before = null) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.readable(conn, target);
    // a page further back ("load more"): the `limit` messages just before that one
    if (before) {
      const all = foldEdits(this.store.tailRoom(target, Infinity), this.pinsOf(target));
      const at = all.findIndex((m) => m.id === String(before));
      if (at < 0) throw fail(404, 'No such message in this room');
      return all.slice(Math.max(0, at - Math.min(Number(limit) || 50, 500)), at).map((m) => this.forReader(m, conn));
    }
    if (from) {
      const all = foldEdits(this.store.tailRoom(target, Infinity), this.pinsOf(target));
      const at = all.findIndex((m) => m.id === String(from));
      if (at < 0) throw fail(404, 'No such message in this room');
      return all.slice(Math.max(0, at - 2)).map((m) => this.forReader(m, conn));
    }
    return foldEdits(this.store.tailRoom(target, Math.min(Number(limit) || 50, 500), since), this.pinsOf(target)).map((m) => this.forReader(m, conn));
  }

  /// One message by id, as it stands now (its latest version, pinned or not): a pin or a
  /// suggestion older than what a client shows is fetched alone, not with all that came after it.
  message(conn, room, id) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    if (!MESSAGE_ID.test(String(id || ''))) throw fail(400, 'id: the id of a message');
    this.readable(conn, target);
    const found = foldEdits(this.store.tailRoom(target, Infinity), this.pinsOf(target)).find((m) => m.id === String(id));
    if (!found) throw fail(404, 'No such message in this room');
    return this.forReader(found, conn);
  }

  readable(conn, room) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (member && member.kind === 'agent') this.use(conn, room);
    // a call that carries its token (over HTTP) has no room it joined: its token's rooms decide
    else if (conn.record.role !== 'owner' && conn.room !== room && !conn.ephemeral) throw fail(403, 'Not your room');
    this.scope(conn, room);
  }

  // MARK: suggested replies

  /// A message's own extras: the reply it suggests to the people it is to, and the message it answers.
  extras(msg, { suggest, replyTo, suggestTtl } = {}) {
    const sg = cleanSuggest(suggest);
    if (sg) msg.suggest = sg;
    const ttl = cleanTtl(suggestTtl);
    if (sg && ttl) msg.suggestTtl = ttl;
    if (replyTo !== undefined && replyTo !== null) {
      if (!MESSAGE_ID.test(String(replyTo))) throw fail(400, 'replyTo: the id of a message');
      msg.replyTo = String(replyTo);
    }
  }

  withoutSuggest(msg) {
    if (!msg || msg.suggest === undefined) return msg;
    const { suggest, ...rest } = msg;
    return rest;
  }

  /// A suggested reply is shown only to the people a message is to: sent to them, or @named in it.
  /// Agents and everyone else get the message without it.
  forReader(msg, conn) {
    // a request shows as it stands now: open, approved, declined or expired
    if (msg && msg.request) msg = { ...msg, request: this.requestNow(msg.request.id) || msg.request };
    if (!msg || !msg.suggest) return msg;
    const member = conn.key ? this.members.get(conn.key) : null;
    if ((member && member.kind === 'agent') || conn.record.role === 'agent') return this.withoutSuggest(msg);
    const me = this.from(conn).name;
    const named = msg.to === me || mentions(msg.text).includes(me);
    if (!named || this.isDismissed(me, msg) || !this.suggestOpen(msg)) return this.withoutSuggest(msg);
    return { ...msg, suggestUntil: new Date(suggestUntil(msg)).toISOString() };
  }

  /// Still waiting: not withdrawn (or superseded), not expired.
  suggestOpen(msg) {
    return Boolean(msg.suggest) && !this.withdrawn.has(msg.id) && Date.now() < suggestUntil(msg);
  }

  /// The sender takes its suggestion back (the decision is no longer needed); the message stays.
  unsuggest(conn, target) {
    if (!MESSAGE_ID.test(String(target || ''))) throw fail(400, 'id: the id of a message');
    const found = this.store.thread(target);
    if (!found) throw fail(404, `No message ${target}`);
    if (!found.original.by || found.original.by !== this.author(conn)) throw fail(403, 'Only its sender can withdraw a suggestion');
    this.scope(conn, found.room);
    if (this.isAgent(conn)) this.use(conn, found.room);
    this.withdraw(found.room, [String(target)]);
    return { id: String(target), room: found.room, withdrawn: true };
  }

  withdraw(room, ids) {
    const fresh = ids.filter((i) => !this.withdrawn.has(i));
    if (!fresh.length) return;
    for (const i of fresh) this.withdrawn.add(i);
    this.store.saveJson('withdrawn.json', [...this.withdrawn].slice(-20000));
    this.broadcast('room/withdrawn', { room, ids: fresh }, room);
  }

  /// A newer suggestion from the same sender to the same person: the older ones waiting stop.
  supersede(msg) {
    const people = new Set([msg.to, ...mentions(msg.text)].filter(Boolean));
    if (!people.size) return;
    const older = foldEdits(this.store.tailRoom(msg.room, 2000)).filter(
      (m) => m.id !== msg.id && m.by === msg.by && this.suggestOpen(m) && [m.to, ...mentions(m.text)].some((p) => people.has(p)),
    );
    this.withdraw(msg.room, older.map((m) => m.id));
  }

  isDismissed(me, msg) {
    return Boolean(((this.dismissed[me] || {})[msg.room] || []).includes(msg.id));
  }

  /// Esc on a suggestion: put away for good, for this person, on all their devices. The message
  /// stays; it comes to them without its suggestion from now on.
  dismiss(conn, room, target) {
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    if (!MESSAGE_ID.test(String(target || ''))) throw fail(400, 'id: the id of a message');
    this.readable(conn, room);
    const me = this.from(conn).name;
    const rooms = this.dismissed[me] || (this.dismissed[me] = {});
    const ids = rooms[room] || (rooms[room] = []);
    if (!ids.includes(target)) {
      ids.push(String(target));
      // the newest ones are enough: older suggestions are past what anyone is offered
      if (ids.length > DISMISSED_MAX) ids.splice(0, ids.length - DISMISSED_MAX);
      this.store.saveJson('dismissed.json', this.dismissed);
    }
    for (const c of this.conns.values()) if (c.client && this.from(c).name === me) this.emit(c.client, 'room/dismissed', { room, id: String(target) });
    return { room, id: String(target) };
  }

  /// broadcast() for a message: each reader gets it as forReader shows it to them.
  broadcastMessage(event, msg, room) {
    this.events.emit(event, msg);
    for (const conn of this.conns.values()) {
      if (!conn.name && conn.room !== '*') continue;
      if (room && conn.room !== '*' && conn.room !== room && !(conn.key && (this.members.get(conn.key)?.invited || []).includes(room))) continue;
      this.emit(conn.client, event, this.forReader(msg, conn));
    }
  }

  /// The suggested replies to you still waiting in a room, from all of its history, oldest first:
  /// to you (sent to you, or @naming you), not answered by a reply to it, nor by a later message
  /// from you to its sender that answers no message in particular. The clients add what arrives
  /// after this to it, by the same rule. People only: an agent is never offered one.
  suggestions(conn, room) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.readable(conn, target);
    const member = conn.key ? this.members.get(conn.key) : null;
    if ((member && member.kind === 'agent') || conn.record.role === 'agent') return { room: target, suggestions: [] };
    const me = this.from(conn).name;
    const records = foldEdits(this.store.tailRoom(target, Infinity));
    const replied = new Set();
    const lastPlain = {};
    records.forEach((m, i) => {
      if (!m.from || m.from.name !== me) return;
      if (m.replyTo) return void replied.add(m.replyTo);
      const to = m.to || (/^@(\S+)/.exec(m.text || '') || [])[1];
      if (to) lastPlain[to] = i;
    });
    const waiting = records.filter(
      (m, i) => m.suggest && m.from && m.from.name !== me && (m.to === me || mentions(m.text).includes(me)) && !replied.has(m.id) && !(lastPlain[m.from.name] > i) && !this.isDismissed(me, { room: target, id: m.id }) && this.suggestOpen(m),
    );
    return { room: target, suggestions: waiting.slice(-SUGGESTIONS_MAX).map((m) => ({ ...m, suggestUntil: new Date(suggestUntil(m)).toISOString() })) };
  }

  /// How each agent's suggestions fared, from the rooms' logs: the reply tied to one (replyTo) was
  /// the suggestion as it stood (accepted) or other words (edited); none yet: ignored or pending.
  suggestStats(conn) {
    this.owner(conn);
    const by = {};
    for (const room of this.store.rooms()) {
      const records = foldEdits(this.store.tailRoom(room, Infinity));
      const replies = new Map(records.filter((m) => m.replyTo).map((m) => [m.replyTo, m]));
      for (const m of records) {
        if (!m.suggest || !m.from) continue;
        const s = (by[m.from.name] = by[m.from.name] || { suggested: 0, accepted: 0, edited: 0, ignored: 0 });
        s.suggested++;
        const reply = replies.get(m.id);
        if (!reply) s.ignored++;
        else if (sameReply(reply.text.replace(/^@\S+\s+/, ''), m.suggest)) s.accepted++;
        else s.edited++;
      }
    }
    return by;
  }

  // MARK: edits

  /// Who wrote a message, as only the hub can tell: the token it came with, and for an agent its
  /// place (agents of one machine share a token), else the name. Kept hashed on the message.
  author(conn) {
    const member = conn.key ? this.members.get(conn.key) : null;
    const who = member && member.kind === 'agent' ? member.key : this.from(conn).name;
    return crypto.createHash('sha256').update(`${conn.record.id}\n${who}`).digest('base64url').slice(0, 22);
  }

  /// The author changes a message: a new record in the room's log (the earlier text stays there),
  /// the room is shown the new version, and the agents concerned are told (see tellEdit).
  edit(conn, target, body, suggest) {
    if (!MESSAGE_ID.test(String(target || ''))) throw fail(400, 'id: the id of a message');
    const found = this.store.thread(target);
    if (!found) throw fail(404, `No message ${target}`);
    const { room, original, edits } = found;
    if (!EDITABLE.has(original.kind)) throw fail(400, `A ${original.kind} message cannot be edited`);
    if (!original.by || original.by !== this.author(conn)) throw fail(403, 'Only its author can edit a message');
    this.scope(conn, room);
    // an agent edits only in a room it is in (its own message in a room it was a guest of: no more)
    if (this.isAgent(conn)) this.use(conn, room);
    this.writable(room);
    body = text(body, 'text', Boolean(original.media));
    if (shares(body).matches.length || (!this.isAgent(conn) && outsideCode(body, REMOVE).matches.length)) throw fail(400, 'A secret is handed over in a new message, not in an edit');
    try {
      checkCode(body);
    } catch (error) {
      throw fail(400, error.message);
    }
    const before = edits.length ? edits[edits.length - 1].text : original.text;
    const rev = edits.length + 2;
    if (body === before && suggest === undefined) return { id: target, rev: rev - 1, room, unchanged: true };
    const rec = { id: id(), ts: now(), room, kind: 'edit', target, rev, from: this.from(conn), text: body };
    const nextSuggest = cleanSuggest(suggest);
    if (nextSuggest !== undefined) rec.suggest = nextSuggest;
    this.store.appendRoom(room, rec);
    // the latest suggestion: this edit's, else the one the message had at its last version
    const lastSuggest = nextSuggest !== undefined ? nextSuggest || undefined : [original, ...edits].reduce((sg, r) => (r.suggest !== undefined ? r.suggest || undefined : sg), undefined);
    const message = { ...original, text: body, rev, edited: rec.ts, suggest: lastSuggest };
    if (!message.suggest) delete message.suggest;
    this.events.emit('room/edit', { edit: rec, message });
    for (const c of this.conns.values()) {
      if (!c.name && c.room !== '*') continue;
      if (c.room !== '*' && c.room !== room && !(c.key && (this.members.get(c.key)?.invited || []).includes(room))) continue;
      this.emit(c.client, 'room/edit', { edit: this.withoutSuggest(rec), message: this.forReader(message, c) });
    }
    this.queueEditNote(conn, message, before);
    return { id: target, rev, room, edit: rec.id };
  }

  /// Every version of a message, the first one first.
  versions(conn, target) {
    target = String(target || '').toLowerCase();
    if (!MESSAGE_ID.test(target) && !/^[0-9a-f]{8}(-?[0-9a-f-]{0,27})$/.test(target)) throw fail(400, 'id: the id of a message, or its first 8 characters');
    const found = this.store.thread(target);
    if (!found) throw fail(404, `No message ${target}`);
    this.readable(conn, found.room);
    const { original, edits } = found;
    return {
      id: original.id,
      room: found.room,
      versions: [{ rev: 1, ts: original.ts, from: original.from, text: original.text }, ...edits.map((e) => ({ rev: e.rev, ts: e.ts, from: e.from, text: e.text }))],
    };
  }

  // MARK: secrets

  /// `$NAME=value$` (or `$NAME=$`, to take one back) inside a message. The agents it @names, and
  /// the one it is sent to, get it on their wrappers; with nobody named, every agent in the room
  /// that is online now does. The message carries `$NAME`, and the hub keeps nothing. Refused when
  /// a named agent is offline: a value is never kept for later.
  inlineSecrets(conn, room, body, to = null, share = false) {
    // written in code (`…` or a ``` block) it is an example of the syntax: left as it is, unless
    // it looks like a real value, which is refused rather than posted in the clear
    try {
      checkCode(String(body));
    } catch (error) {
      throw fail(400, error.message);
    }
    const handedIn = shares(String(body));
    // only people hand secrets over in a message; an agent writing the syntax is talking about it
    // (its text goes as it is), and one with a real value is refused, never posted in the clear.
    // An agent hands one over with `metacom secrets share`, which says so (share: true)
    if (this.isAgent(conn) && !share) {
      if (handedIn.matches.length) throw fail(400, `An agent hands a secret over with \`metacom secrets share ${handedIn.matches[0][1]} --to @agent\`, not in a message: nothing was sent`);
      return { body, recipients: [], secrets: [], removed: [], missed: [] };
    }
    const secrets = handedIn.matches.map((m) => ({ name: m[1], value: m[2].trim() }));
    const removed = outsideCode(String(body), REMOVE).matches.map((m) => m[1]);
    if (!secrets.length && !removed.length) return { body, recipients: [], secrets: [], removed: [], missed: [] };
    for (const s of secrets) {
      try {
        checkSecret(s.name, s.value);
      } catch (error) {
        throw fail(400, error.message);
      }
    }
    const masked = handedIn.replace((_, name) => `$${name}`);
    const clean = outsideCode(masked, REMOVE).replace((_, name) => `$${name}`);
    const sender = conn.key ? this.members.get(conn.key) : null;
    const reachable = (m) => m.connected && (this.byName.get(m.key) || new Set()).size > 0;
    let recipients = [];
    let missed = [];
    if (to && to.kind === 'agent') recipients.push(to);
    for (const n of mentions(body)) {
      const m = room && this.members.get(keyOf('agent', n, room));
      if (m && m.kind === 'agent' && !recipients.includes(m)) recipients.push(m);
    }
    if (recipients.length) {
      const away = recipients.filter((m) => !reachable(m));
      if (away.length) throw fail(409, `${away.map((m) => m.name).join(', ')} ${away.length === 1 ? 'is' : 'are'} offline: a secret is only handed to an agent that is connected, never kept for later. Send it when ${away.length === 1 ? 'it is' : 'they are'} back`);
    } else {
      // nobody named: the agents of the room, the ones online now
      const inRoom = [...this.members.values()].filter((m) => m.kind === 'agent' && m.room === room && (!sender || m.key !== sender.key));
      recipients = inRoom.filter(reachable);
      missed = inRoom.filter((m) => !reachable(m)).map((m) => m.name).sort();
      if (!recipients.length) throw fail(409, `No agent in ${room} is online to receive it${missed.length ? ` (${missed.join(', ')} ${missed.length === 1 ? 'is' : 'are'} offline)` : ''}: nothing was sent`);
    }
    // a message that is only secrets is not posted: the room gets the line saying who has what
    const quiet = !clean.replace(/\$[A-Z][A-Z0-9_]*/g, '').trim();
    return { body: clean, recipients, secrets, removed, missed, quiet };
  }

  /// To each recipient's wrapper (never its MCP bridge, which the model reads), before the message
  /// goes in; then the room's line, by name. Returns who has it, for the sender.
  handOver(conn, room, handed) {
    if (!handed.recipients.length) return null;
    const from = this.from(conn).name;
    for (const m of handed.recipients) {
      for (const client of this.byName.get(m.key) || new Set()) this.emit(client, 'agents/secret', { room: m.room, agent: m.name, from, secrets: handed.secrets, removed: handed.removed });
    }
    const to = handed.recipients.map((m) => m.name).sort();
    const list = (names) => [...new Set(names)].map((n) => `$${n}`).join(', ');
    const what = [handed.secrets.length && `shared ${list(handed.secrets.map((s) => s.name))} with`, handed.removed.length && `took ${list(handed.removed)} back from`].filter(Boolean).join(' and ');
    this.system(room, `🔒 ${from} ${what} ${to.join(', ')}${handed.missed.length ? ` (not online: ${handed.missed.join(', ')})` : ''}`);
    return { to, missed: handed.missed, names: [...handed.secrets.map((s) => s.name), ...handed.removed] };
  }

  /// A wrapper says which secrets its agent holds on its machine: names only, kept in memory.
  reportSecretNames(conn, names) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || member.kind !== 'agent') throw fail(400, 'Register first');
    member.secretNames = (Array.isArray(names) ? names : []).map(String).filter((n) => NAME_OF_SECRET.test(n)).slice(0, 200).sort();
    return { names: member.secretNames };
  }

  /// Who in the room holds which secrets, as their wrappers report them (names only).
  listSecrets(conn, room) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.readable(conn, target);
    const agents = [...this.members.values()]
      .filter((m) => m.kind === 'agent' && m.room === target && (m.secretNames || []).length)
      .map((m) => ({ agent: m.name, names: m.secretNames, connected: Boolean(m.connected) }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
    return { room: target, agents };
  }

  /// An agent ran something with its secrets, or put one into a file (`where`: its path): said in
  /// the room by name and path, never a value. Starting with them is not (it would be said on every
  /// restart); hub_room and /secrets list what each agent holds.
  secretsUsed(conn, names, purpose = 'exec', where = null) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || member.kind !== 'agent') throw fail(400, 'Register first');
    const list = (Array.isArray(names) ? names : []).map(String).filter((n) => NAME_OF_SECRET.test(n));
    const said = list.map((n) => `$${n}`).join(', ');
    const path = String(where || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (list.length && purpose === 'put' && path) this.system(member.room, `${member.name} put ${said} into ${path}`);
    else if (list.length && purpose !== 'spawn') this.system(member.room, `${member.name} used ${said}`);
    return { names: list };
  }

  // MARK: pins

  /// The room's pinned messages, as its log says: each pin or unpin is a record there.
  pinsOf(room) {
    if (!this.pinned.has(room)) {
      const state = new Map();
      for (const r of this.store.tailRoom(room, Infinity)) {
        if (r.kind === 'pin') state.set(r.target, r);
        else if (r.kind === 'unpin') state.delete(r.target);
      }
      this.pinned.set(room, state);
    }
    return this.pinned.get(room);
  }

  /// Anyone who can read the room pins a message in it, or unpins it. No message in the room:
  /// the clients there are told the new list (room/pins) and nobody is notified.
  pin(conn, target, on = true) {
    if (!MESSAGE_ID.test(String(target || ''))) throw fail(400, 'id: the id of a message');
    const found = this.store.thread(target);
    if (!found) throw fail(404, `No message ${target}`);
    const { room, original } = found;
    if (!EDITABLE.has(original.kind)) throw fail(400, `A ${original.kind} message cannot be pinned`);
    this.readable(conn, room);
    this.writable(room);
    const pins = this.pinsOf(room);
    if (pins.has(target) === Boolean(on)) return { id: target, room, pinned: Boolean(on), count: pins.size, unchanged: true };
    const rec = { id: id(), ts: now(), room, kind: on ? 'pin' : 'unpin', target, from: this.from(conn) };
    this.store.appendRoom(room, rec);
    if (on) pins.set(target, rec);
    else pins.delete(target);
    this.broadcast('room/pins', { room, pins: this.pinList(room) }, room);
    return { id: target, room, pinned: Boolean(on), count: pins.size };
  }

  /// The pinned messages of a room, each at its latest version, the latest pinned first.
  pins(conn, room) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    this.readable(conn, target);
    return { room: target, pins: this.pinList(target).map((m) => this.forReader(m, conn)) };
  }

  pinList(room) {
    const pins = this.pinsOf(room);
    if (!pins.size) return [];
    const byId = new Map();
    for (const r of this.store.tailRoom(room, Infinity)) {
      if (pins.has(r.id)) byId.set(r.id, { ...r });
      else if (r.kind === 'edit' && byId.has(r.target)) Object.assign(byId.get(r.target), { text: r.text, rev: r.rev, edited: r.ts });
    }
    return [...pins.values()]
      .reverse()
      .filter((p) => byId.has(p.target))
      .map((p) => ({ ...byId.get(p.target), pinned: true, pinnedBy: p.from.name, pinnedAt: p.ts }));
  }

  /// Edits in a row are told once, ~20 s after the last, as the final version; who is told is
  /// worked out then, from the text before the first of them and the final one.
  queueEditNote(conn, message, before) {
    const pending = this.pendingEdits.get(message.id) || { before, conn };
    clearTimeout(pending.timer);
    pending.message = message;
    pending.conn = conn;
    pending.timer = setTimeout(() => this.tellEdit(message.id), this.editCoalesceMs);
    if (pending.timer.unref) pending.timer.unref();
    this.pendingEdits.set(message.id, pending);
  }

  /// The agents concerned get the whole new message, typed in as a directed message would be:
  /// the one it was sent to, and every agent @named in the earlier or the new text. Not the editor.
  tellEdit(target) {
    const pending = this.pendingEdits.get(target);
    if (!pending) return [];
    this.pendingEdits.delete(target);
    const { message, before, conn } = pending;
    const editor = conn.key ? this.members.get(conn.key) : null;
    const names = new Set([...mentions(before), ...mentions(message.text)]);
    if (message.to && message.kind !== 'say') names.add(message.to);
    const told = [];
    for (const name of names) {
      const member = this.members.get(keyOf('agent', name, message.room)) || (message.to === name ? this.named(name).find((m) => m.room === message.room) : null);
      if (!member || member.kind !== 'agent') continue;
      if (editor && member.key === editor.key) continue;
      const direct = message.to === name && message.kind !== 'say';
      const kind = direct ? message.kind : 'command';
      const note = {
        id: id(),
        ts: now(),
        room: message.room,
        kind,
        from: message.from,
        to: member.name,
        text: `[edited v${message.rev} of ${message.id}] ${message.text}`,
        edit: { target: message.id, rev: message.rev },
      };
      if (message.media) note.media = message.media;
      this.pushInbox(member.key, note);
      for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', note);
      told.push(member.name);
    }
    if (told.length) this.console.log(`hub: edit v${message.rev} of ${message.id} told to ${told.join(', ')}`);
    return told;
  }

  // MARK: archive

  /// An archived room is read-only: its log stays where it is, nothing new goes in.
  writable(room) {
    if (this.archived.has(room)) throw fail(423, `${room} is archived: read-only. The owner can bring it back: metacom unarchive ${room}`);
  }

  /// Owner only. Nothing is deleted: the room is marked archived and becomes read-only, its log
  /// where it was. The room says so, and each agent still registered there is told (its posts are
  /// refused from now on, with that reason). Not default.
  archiveRoom(conn, room) {
    this.owner(conn);
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    if (room === 'default') throw fail(400, 'default cannot be archived');
    const here = [...this.members.values()].filter((m) => m.room === room);
    if (!this.store.rooms().includes(room) && !here.length) throw fail(404, `No room named "${room}"`);
    if (this.archived.has(room)) return { room, archived: true, unchanged: true };
    const by = this.from(conn).name;
    this.system(room, `🗄 ${by} archived ${room}: it is read-only now`);
    this.archived.set(room, { at: now(), by });
    this.store.saveJson('archived.json', Object.fromEntries(this.archived));
    const told = [];
    for (const m of here.filter((x) => x.kind === 'agent')) {
      const note = { id: id(), ts: now(), room, kind: 'info', from: { name: by, role: 'owner', kind: 'human' }, to: m.name, text: `${room} is archived: read-only. Nothing you post there goes through; stop work for this room unless you are told it is back.` };
      this.pushInbox(m.key, note);
      for (const client of this.byName.get(m.key) || new Set()) this.emit(client, 'agents/message', note);
      told.push(m.name);
    }
    this.console.log(`hub: room ${room} archived by ${by}${told.length ? ', told: ' + told.join(', ') : ''}`);
    this.broadcast('room/archived', { room, by, archived: true });
    this.changed();
    return { room, archived: true, agents: told };
  }

  unarchiveRoom(conn, room) {
    this.owner(conn);
    room = String(room || '');
    if (!this.archived.has(room)) throw fail(404, `${room || 'That room'} is not archived`);
    const by = this.from(conn).name;
    this.archived.delete(room);
    this.store.saveJson('archived.json', Object.fromEntries(this.archived));
    this.system(room, `${by} brought ${room} back from the archive`);
    this.console.log(`hub: room ${room} unarchived by ${by}`);
    this.broadcast('room/archived', { room, by, archived: false });
    this.changed();
    return { room, archived: false };
  }

  /// Archived rooms with what the list shows of them: last activity, how many messages.
  archivedRooms(conn) {
    return [...this.archived.entries()]
      .filter(([room]) => !conn || (this.inScope(conn, room) && this.mayUse(conn, room)))
      .map(([room, a]) => {
        const all = foldEdits(this.store.tailRoom(room, Infinity));
        const said = all.filter((m) => m.kind !== 'system');
        return { room, archived: true, archivedAt: a.at, archivedBy: a.by, messages: said.length, last: (all.at(-1) || {}).ts || a.at };
      })
      .sort((a, b) => a.room.localeCompare(b.room));
  }

  // MARK: guests and grants (owner)

  /// A room the member's token does not cover cannot be opened to it by an invitation or a grant:
  /// the token is the harder limit (an agent in a container gets one for its room only). Say how
  /// to widen the token instead of quietly doing nothing.
  tokenCovers(member, rooms) {
    let record = null;
    try {
      record = this.auth.find(member.tokenId);
    } catch {
      return; // a seeded or vanished token: nothing to check against
    }
    const outside = record.rooms ? rooms.filter((r) => r === '*' || !record.rooms.includes(r)) : [];
    if (outside.length) {
      throw fail(409, `${member.name}'s token "${record.name}" is only for ${record.rooms.join(', ')}; widen it first: metacom grant ${record.name} ${outside.filter((r) => r !== '*').join(',') || 'all'}`);
    }
  }

  /// Owner: an agent gets a session of its own in another room (docs/sessions.md): a fresh process
  /// on its own machine, same command, repo and token, by the same name, with its own context. The
  /// hub cannot start processes: the agent's wrapper does, told now, or when it next connects.
  /// The session is welcomed with where its work is; the agent at home is told it moved there.
  invite(conn, ref, room) {
    this.owner(conn);
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    const member = this.homeAgent(conn, ref);
    if (member.kind !== 'agent') throw fail(400, `${member.name} is a person; people open any room their token allows`);
    if (member.room === room) throw fail(400, `${member.name} already lives in ${room}`);
    if ((member.sessions || []).includes(room)) throw fail(409, `${member.name} already has a session in ${room}${this.sessionIn(member, room)?.connected ? '' : ' (it starts when its machine is back)'}`);
    // its token gets the room too (misha: no separate grant)
    const token = this.widenToken(member, room);
    member.sessions = [...new Set([...(member.sessions || []), room])];
    this.placeSession(member, room);
    this.saveMembers();
    const by = this.from(conn).name;
    const online = this.tellSession(member, room, true);
    this.system(room, `${by} invited ${member.name} (from ${member.room}): its session here is ${online ? 'starting…' : `waiting for ${member.host || 'its machine'} to be back`}${token && token.added ? ` · ${token.name} token now covers ${room}` : ''}`);
    if (online) this.expectSession(member, room);
    // the agent at home: that room's work moves to the session
    this.direct(conn, member, `${room} now has a session of you of its own (by the same name, a fresh context, in this same folder). Work for ${room} lives there now: stop it here, leave your notes about it in your PROGRESS file for the session to read, and keep your ${member.room} work. You share the folder with it: commit only your own files, and pull before you commit.\n${this.notesList(member)}`);
    this.changed();
    return { ...this.publicMember(member), starting: online, token };
  }

  /// Owner: the agent's session in that room stops: its notes first, then it exits.
  uninvite(conn, ref, room) {
    this.owner(conn);
    room = String(room || '');
    const member = this.homeAgent(conn, ref);
    const session = (member.sessions || []).includes(room);
    const guest = (member.invited || []).includes(room);
    if (!session && !guest) throw fail(404, `${member.name} has no session in ${room}`);
    member.sessions = (member.sessions || []).filter((r) => r !== room);
    member.invited = (member.invited || []).filter((r) => r !== room);
    this.saveMembers();
    const running = this.sessionIn(member, room);
    if (running && running.connected) {
      const msg = { id: id(), ts: now(), room, kind: 'control', from: this.from(conn), to: member.name, text: '!retire' };
      this.pushInbox(running.key, msg);
      for (const client of this.byName.get(running.key) || new Set()) this.emit(client, 'agents/message', msg);
    }
    this.tellSession(member, room, false, Boolean(running && running.connected));
    this.tellSiblings(member, running);
    // off the room's list: now if it is not running, else once it has gone
    if (running && !running.connected) this.members.delete(running.key);
    this.saveMembers();
    // the room off its token, unless another member on that token still lives or works there
    const token = this.narrowToken(member, room, running && running.connected ? running : null);
    const tokenLine = !token ? '' : token.removed ? ` · ${token.name} token no longer covers ${room}` : token.keptFor.length ? ` · ${token.name} token keeps ${room}: ${token.keptFor.join(', ')} ${token.keptFor.length === 1 ? 'is' : 'are'} still here` : '';
    this.system(room, `${session ? `${member.name}'s session here is stopping (notes first)` : `${member.name} is no longer a guest here`}${tokenLine}`);
    this.changed();
    return { ...this.publicMember(member), token };
  }

  /// The agent an invite is about: the one at home, also when its name means a session of it
  /// (valuesdev, valuesdev@trade and valuesdev@values all mean valuesdev of values).
  homeAgent(conn, ref) {
    const r = String(ref || '');
    const homes = r.includes('@') ? [] : this.named(r).filter((m) => !m.home && this.sees(conn, m));
    const member = homes.length === 1 ? homes[0] : this.resolve(conn, r);
    return member.home ? this.members.get(keyOf('agent', member.name, member.home)) || member : member;
  }

  /// Where each session of an agent keeps its notes, for the others to read (never write): the one
  /// at home, then one per invited room (its file as its wrapper said, or where it will be).
  notesList(home) {
    const folder = home.repo || '.';
    const at = (m, room) => (m && m.notes) || (room === home.room ? `${folder}/PROGRESS.md` : `${folder}/PROGRESS-${home.name}@${room}.md`);
    const lines = [home.room, ...(home.sessions || [])].map((room) => `- ${home.name}@${room}: ${at(room === home.room ? home : this.sessionIn(home, room), room)}`);
    return `Notes of ${home.name}'s sessions (read the others' when you need to; never write them):\n${lines.join('\n')}`;
  }

  /// The sessions of an agent hear when one is added or removed: where each keeps its notes now.
  tellSiblings(home, except = null) {
    const list = this.notesList(home);
    for (const m of [home, ...(home.sessions || []).map((r) => this.sessionIn(home, r))]) {
      if (!m || m === except || !m.connected) continue;
      const msg = { id: id(), ts: now(), room: m.room, kind: 'info', from: { name: 'hub', role: 'system', kind: 'system' }, to: m.name, text: list };
      this.pushInbox(m.key, msg);
      for (const client of this.byName.get(m.key) || new Set()) this.emit(client, 'agents/message', msg);
    }
  }

  /// /invite: the room added to the agent's token when the token is limited to rooms. What changed,
  /// or null for a token without a room limit (or one the hub cannot find: seeded from the env).
  widenToken(member, room) {
    let record = null;
    try {
      record = this.auth.find(member.tokenId);
    } catch {
      return null;
    }
    if (!record.rooms) return null;
    if (record.rooms.includes(room)) return { name: record.name, added: false };
    const updated = this.auth.setRooms(record.id, [...record.rooms, room]);
    this.rescope(record.id, updated.rooms);
    this.console.log(`hub: token "${record.name}" now covers ${room} (invite of ${member.name})`);
    return { name: record.name, added: true };
  }

  /// /uninvite: the room taken off the agent's token, unless another member on that token lives
  /// there, has a session there or is a guest there (a token is shared: valuesbox runs valuesdev
  /// and chief, who lives in trade). Never its own room. A session still saving its notes keeps
  /// its connection until it goes; new connections in the room are refused at once.
  narrowToken(member, room, leaving = null) {
    let record = null;
    try {
      record = this.auth.find(member.tokenId);
    } catch {
      return null;
    }
    if (!record.rooms || !record.rooms.includes(room) || member.room === room) return null;
    const keptFor = [...this.members.values()]
      .filter((m) => m.tokenId === record.id && m !== member && m.key !== keyOf('agent', member.name, room))
      .filter((m) => m.room === room || (m.sessions || []).includes(room) || (m.invited || []).includes(room))
      .map((m) => m.name);
    if (keptFor.length) return { name: record.name, removed: false, keptFor: [...new Set(keptFor)] };
    const left = record.rooms.filter((r) => r !== room);
    if (!left.length) return { name: record.name, removed: false, keptFor: [] };
    const updated = this.auth.setRooms(record.id, left);
    if (leaving) this.rescopeLater.set(leaving.key, record.id);
    else this.rescope(record.id, updated.rooms);
    this.console.log(`hub: token "${record.name}" no longer covers ${room} (uninvite of ${member.name})`);
    return { name: record.name, removed: true, keptFor: [] };
  }

  /// The session's place in the room's list: listed from the invite on, offline until the session
  /// starts and registers into this place.
  placeSession(member, room) {
    const key = keyOf('agent', member.name, room);
    if (this.members.has(key)) return;
    const place = { key, name: member.name, kind: 'agent', tokenId: member.tokenId, room, home: member.room, repo: member.repo, host: member.host, command: member.command, caps: member.caps, since: now(), status: 'stopped', connected: false, reason: 'not started yet' };
    place.color = colors.pick(place, [...this.members.values()]);
    this.members.set(key, place);
  }

  /// A session its wrapper was told to start: said in the room when it is up, or why not after a
  /// minute (a wrapper from before sessions ignores the request; one that tried says what failed).
  expectSession(member, room, ms = this.sessionStartMs) {
    const key = keyOf('agent', member.name, room);
    clearTimeout(this.starting.get(key));
    const timer = setTimeout(() => {
      this.starting.delete(key);
      if (!(member.sessions || []).includes(room) || this.sessionIn(member, room)?.connected) return;
      this.system(room, `${member.name}'s session here did not start within a minute: its wrapper on ${member.host || 'its machine'} may run a metacom from before sessions; restart ${member.name} there, and it starts the session itself`);
    }, ms);
    if (timer.unref) timer.unref();
    this.starting.set(key, timer);
  }

  /// The wrapper's word on a session it was told to start: started (the hub then waits for it to
  /// register), or failed and why.
  sessionReport(conn, room, ok, error) {
    const member = conn.key ? this.members.get(conn.key) : null;
    if (!member || !(member.sessions || []).includes(String(room))) throw fail(404, 'no such session');
    if (ok) return { ok: true };
    clearTimeout(this.starting.get(keyOf('agent', member.name, room)));
    this.starting.delete(keyOf('agent', member.name, room));
    this.system(String(room), `${member.name}'s session here could not start on ${member.host || 'its machine'}: ${String(error || 'no reason given').slice(0, 300)}`);
    return { ok: true };
  }

  /// The agent's session in a room, once it has registered there.
  sessionIn(member, room) {
    const s = this.members.get(keyOf('agent', member.name, room));
    return s && s.tokenId === member.tokenId ? s : null;
  }

  /// The rooms whose session is not online: for the wrapper to start.
  pendingSessions(member) {
    return (member.sessions || []).filter((r) => !this.sessionIn(member, r)?.connected && !this.archived.has(r));
  }

  /// Tells the agent's wrapper to start (or, when its session cannot stop itself, end) a room's
  /// session. Whether the wrapper is online to hear it now.
  tellSession(member, room, on, selfStops = false) {
    const clients = this.byName.get(member.key) || new Set();
    for (const client of clients) this.emit(client, 'agents/session', { name: member.name, room, on, selfStops });
    return clients.size > 0;
  }

  /// A command typed into an agent, from whoever is calling: in its own room, as a send would be.
  direct(conn, member, text) {
    const msg = { id: id(), ts: now(), room: member.room, kind: 'command', from: this.from(conn), by: this.author(conn), to: member.name, text };
    this.pushInbox(member.key, msg);
    this.store.appendRoom(member.room, msg);
    this.broadcastMessage('room/message', msg, member.room);
    for (const client of this.byName.get(member.key) || new Set()) this.emit(client, 'agents/message', msg);
  }

  /// One-way sending to other rooms is gone: an agent reaches a room only as its member or guest.
  grant(conn) {
    this.owner(conn);
    throw fail(410, 'one-way sending to other rooms was removed: invite the agent into the room (/invite), /uninvite takes it back');
  }

  // MARK: unread

  reader(conn) {
    return conn.name || conn.record.name;
  }

  /// The caller has the room open: everything in it so far is read.
  markRead(conn, room) {
    room = String(room || '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    this.scope(conn, room);
    const who = this.reader(conn);
    const marks = this.readMarks.marks[who] || (this.readMarks.marks[who] = {});
    marks[room] = now();
    this.store.saveJson('reads.json', this.readMarks);
    return { room, read: marks[room] };
  }

  /// Messages in the room addressed to the caller by someone else, after they last had it open.
  unread(conn, room) {
    const who = this.reader(conn);
    const since = (this.readMarks.marks[who] || {})[room] || this.readMarks.since;
    return this.store.tailRoom(room, 1000, since).filter((m) => m.to === who && m.from && m.from.name !== who).length;
  }

  /// Rooms with herdr-style rollups: how many agents are working, blocked, or done unseen, and
  /// for the caller, how many messages to them there they have not read.
  rooms(conn = null, { archived = false } = {}) {
    if (archived) return this.archivedRooms(conn);
    const empty = (room) => ({ room, agents: 0, online: 0, working: 0, blocked: 0, attention: 0, unread: 0 });
    // every room with a log or a member, so one a human just opened is listed before anyone speaks
    const summary = new Map(['default', ...this.store.rooms()].map((room) => [room, empty(room)]));
    for (const m of this.members.values()) {
      if (!m.room || !ROOM.test(m.room)) continue; // "*" and names from before they were checked
      const s = summary.get(m.room) || empty(m.room);
      summary.set(m.room, s);
      if (m.kind !== 'agent') continue;
      s.agents++;
      if (m.connected) s.online++;
      if (m.connected && m.status === 'working') s.working++;
      if (m.connected && m.status === 'blocked') s.blocked++;
      if (m.attention) s.attention++;
      summary.set(m.room, s);
    }
    if (conn) for (const s of summary.values()) s.unread = this.unread(conn, s.room);
    return [...summary.values()].filter((s) => !this.archived.has(s.room) && (!conn || (this.inScope(conn, s.room) && this.mayUse(conn, s.room)))).sort((a, b) => a.room.localeCompare(b.room));
  }

  // MARK: fan-out

  emit(client, event, data) {
    try {
      client.emit(event, data);
    } catch (error) {
      this.console.warn(`hub: event ${event} failed: ${error.message}`);
    }
  }

  broadcast(event, data, room = null) {
    this.events.emit(event, data);
    for (const conn of this.conns.values()) {
      if (!conn.name && conn.room !== '*') continue;
      // guests invited into the room hear it too
      if (room && conn.room !== '*' && conn.room !== room && !(conn.key && (this.members.get(conn.key)?.invited || []).includes(room))) continue;
      this.emit(conn.client, event, data);
    }
  }

  changed() {
    const all = [...this.members.values()];
    this.events.emit('agents/changed', { members: all.map((m) => this.publicMember(m)) });
    for (const conn of this.conns.values()) {
      if (!conn.name && conn.room !== '*') continue;
      // everyone hears only about the members they can see
      this.emit(conn.client, 'agents/changed', { members: all.filter((m) => this.sees(conn, m)).map((m) => this.publicMember(m)) });
    }
  }
}

module.exports = { Hub, MAX_TEXT, NAME };
