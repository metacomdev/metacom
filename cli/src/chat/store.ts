import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setColors } from "@/chat/palette";

const require = createRequire(import.meta.url);
const { connect } = require("../../lib/client.js") as { connect: (o: object) => Promise<Hub> };
const { tokensTable } = require("../../lib/format.js") as { tokensTable: (list: object[]) => string };
const media = require("../../lib/media.js") as {
  attachment: (file: string) => Omit<Attachment, "token">;
  attachable: (text: string) => string | null;
  attachables: (text: string) => string[] | null;
  clipboardImage: () => string | null;
  clipboardFiles: () => string[];
  typeOf: (file: string) => string | null;
  copyText: (text: string) => boolean;
  clipboardText: () => string;
  resolvePath: (raw: string) => string;
  upload: (o: { http: string; token: string | null; file: string }) => Promise<Media>;
  saveAs: (o: { http: string; media: Media; dir?: string }) => Promise<string>;
  openFile: (file: string) => boolean;
  openUrl: (url: string) => Promise<boolean>;
};

export type Media = { url: string; type: string; size: number; name: string };
export type Attachment = { file: string; name: string; type: string; size: number; token: string };

export type Kind = "agent" | "human" | "system" | "route" | "all";
export type Member = {
  name: string;
  kind: Kind;
  room: string;
  repo?: string;
  caps?: string[];
  host?: string;
  command?: string;
  status: string;
  connected: boolean;
  attention: boolean;
  reason: string | null;
  /// set while it is blocked on a question the hub posted to the room as its message (options to reply with)
  asking?: string;
  lastSeen?: string; // when the server last heard from it: the status line puts the freshest first
  color?: number; // the hub's colour for the name, an index into the chat's palette
  invited?: string[]; // rooms the owner let this agent into as a guest
  owner?: string; // whose agent it is (a user, or the person its token was made for)
};
export type Message = {
  id: string;
  loop?: { id: string; every: string; label?: string }; // sent by a hub loop (/loops)
  ts: string;
  room: string;
  kind: "say" | "command" | "info" | "control" | "system";
  from: { name: string; role: string; kind: Kind; room?: string }; // room: an agent writing in from another room
  to?: string;
  text: string;
  media?: Media[];
  rev?: number; // edited: the version shown, and when it was last edited
  edited?: string;
  suggest?: string; // the reply its sender recommends: only on a message to you
  suggestUntil?: string; // until when it waits for your reply (12 h unless its sender said otherwise)
  replyTo?: string; // the message this one answers
};
/// A suggested reply as the input offers it: the whole text, and what the placeholder shows (a
/// checklist: its first line and how many items follow).
export type Suggestion = { id: string; to: string; text: string; shown: string };
export const suggestionOf = (m: Message, who: string): Suggestion => {
  const text = `@${who} ${m.suggest}`;
  const lines = text.split("\n");
  return { id: m.id, to: who, text, shown: lines.length > 1 ? `${lines[0]} (+${lines.length - 1} item${lines.length === 2 ? "" : "s"})` : text };
};
export type RoomSummary = { room: string; agents: number; online: number; working: number; blocked: number; attention: number; unread?: number; archived?: boolean; messages?: number; last?: string; archivedAt?: string; archivedBy?: string };
export type Tone = "dim" | "ok" | "warn" | "error" | "plain";
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
export type Entry =
  | { id: string; type: "banner" }
  | { id: string; type: "message"; msg: Message; grouped: boolean; card?: CardKind }
  | { id: string; type: "note"; tone: Tone; text: string; ts: string }
  | { id: string; type: "screen"; name: string; text: string; label?: string }
  | { id: string; type: "rooms"; rooms: RoomSummary[] }
  | { id: string; type: "help" }
  | { id: string; type: "rule"; text: string }
  | { id: string; type: "more"; start: boolean };

/// Why an older message is shown alone at the end of the conversation: a pin, or a suggestion.
export type CardKind = "pin" | "reply";

export type State = {
  me: { name: string; role: string };
  room: string;
  url: string;
  hub: { name: string; http: string }; // the hub this chat is on, named for the room list
  members: Map<string, Member>;
  log: Entry[];
  more: string | null; // the message whose ⋯ is open
  editing: Message | null; // your message being edited in the input
  pins: Message[];
  pinIds: Set<string>;
  jump: string | null; // a message to scroll to (from a pin); the app does it and clears this
  ghost: Suggestion | null; // one ↩ reply asked for; else the oldest one waiting shows
  skipped: string[]; // suggestions passed over with Esc: the next one waiting is offered
  picked: string | null; // the suggestion Tab last switched to, offered while it waits
  archived: boolean; // the room open here is archived: read-only
  cards: { msg: Message; kind: CardKind }[]; // messages older than the conversation, fetched alone, shown at its top (oldest first)
  waiting: Message[]; // the hub's list of suggestions waiting for you here, from all of the history
  replyTo: { id: string; to: string } | null; // the message ↩ reply answers, and who wrote it
  busy: string | null;
  status: { text: string; tone: Tone } | null; // the line under the input: what just happened,
  // or what the chat is waiting for. Short-lived, and never worth a place in the conversation.
  attachments: Attachment[]; // files whose tokens may be in the draft
  mouse: boolean; // the chat holds the mouse: it draws the selection and handles clicks
  live: Live | null; // live mode: an agent's screen in place of the conversation (docs/direct.md)
  loops: LoopsView | null; // /loops: the room's loops in place of the conversation
};

/// A loop the hub keeps for a room (hub/lib/loops.js): its prompt sent to the target on a schedule.
export type Loop = { id: string; room: string; target: string; every: string; label?: string; prompt: string; tz: string; by: { name: string; role: string }; on: boolean; next: string | null; last: { at: string; outcome: "sent" | "skipped" | "waiting"; to: string[]; why: string | null } | null; fires: number; skips: number; waiting: boolean };
/// /loops open: the list, the chosen row, the loop whose actions are shown (as the archived folder
/// is opened in the room list), and whether its deletion is being confirmed.
export type LoopsView = { list: Loop[]; index: number; open: string | null; confirm: boolean };
/// An agent's screen as live mode shows it: its rows (with their colours), cursor and size.
export type Live = { name: string; cols: number; rows: number; cursor: [number, number] | null; lines: string[]; ready: boolean; scroll?: LiveScroll | null };
/// Scrolled back while live: a screenful `offset` rows above the live one (of `max`), from the
/// agent's scrollback.
export type LiveScroll = { offset: number; max: number; rows: number; cols: number; lines: string[] };

type Api = Record<string, Record<string, (args?: object) => Promise<any>> & { on: (event: string, fn: (data: any) => void) => void }>;
type Hub = { m: { close: () => void; on: (e: string, fn: () => void) => void }; api: Api; me: { name: string; role: string; rooms?: string[]; url?: string } };

/// A hub saved in the config: the default one (`metacom connect`) and others (`--hub NAME`).
export type HubEntry = { name: string; url: string; http: string; token: string | null };
export type Config = { name?: string; url: string; http: string; token: string | null; agentToken?: string | null; room: string; hubs?: HubEntry[] };
/// Another saved hub's rooms for the room list, or why there are none.
export type HubRooms = { hub: HubEntry; rooms: RoomSummary[] | null; error?: string; url?: string }; // url: the address the hub says it is reached at

/// Commands whose first argument is a member's name.
const NAMED = new Set(["direct", "live", "wait", "kill"]);
/// The history fetched on opening a room (30 shown), and each "load more" page after.
const HISTORY_PAGE = 300;
const MORE_PAGE = 50;
/// How long live mode waits for an agent's first frame before saying why there is none.
const LIVE_FIRST_FRAME_MS = 4000;

export const COMMANDS = [
  { name: "wait", args: "<name>", help: "block until the agent is idle or needs you" },
  { name: "direct", args: "<agent>", help: "an agent's own terminal here: its screen, your keys to it; esc or the yellow button leaves, ctrl+esc sends esc to it (the hub owner, or the agent's owner) · also @agent /direct" },
  { name: "loop", args: "@<agent|all|any> <prompt + when>", help: "the hub sends the prompt on a schedule, whatever the agent's session does; when is in the words: every minute, every 2h, hourly, every day at 9, every weekday at 9:30; @any = the first idle agent" },
  { name: "loops", args: "", help: "the room's loops, in the room list's place: type to filter, ↑↓ enter opens one (on/off, run now, delete), esc back" },
  { name: "secrets", args: "", help: "who holds which secrets, by name (hand one over: @agent $NAME=value$; no @: every agent online here)" },
  { name: "pins", args: "[n]", help: "the room's pinned messages, numbered; /pins 2 goes to the second (or click a pin above the input)" },
  { name: "history", args: "<id>", help: "every version of an edited message (its id is next to \"edited\")" },
  { name: "say", args: "<text>", help: "post to the room even if it starts with @ or /" },
  { name: "attach", args: "<path> [path…]", help: "put files into the message (or drop or paste them, or cmd+v an image)" },
  { name: "save", args: "[n] [dir]", help: "save the latest file sent in the room (n = 2 is the one before) to ~/Downloads" },
  { name: "open", args: "[n]", help: "save the latest file and open it" },
  { name: "rooms", args: "", help: "all rooms with counts (or ← on an empty line)" },
  { name: "room", args: "<name>", help: "open another room, creating it if it is new" },
  { name: "invite", args: "<label> [all | room, room | + room]", help: "a link that lets people (and their own agents) into this room, or those rooms; copied for you to send (owner)" },
  { name: "kill", args: "<agent>", help: "stop an agent for good, its notes first (the hub owner: any agent; a user: its own)" },
  { name: "lead", args: "<agent>|off", help: "the room's lead: every message from a person here that names no one goes to that agent too (owner)" },
  { name: "archive", args: "[room]", help: "archive a room (owner): read-only and out of the list; nothing is deleted" },
  { name: "unarchive", args: "[room]", help: "bring an archived room back (owner)" },
  { name: "tokens", args: "", help: "every token: role, rooms, online now, agents running (owner)" },
  { name: "token", args: "<name> agent|member [room,..]", help: "issue a raw token, shown once (owner); to invite people: /invite" },
  { name: "revoke", args: "<name>", help: "revoke a token and close its connections (owner)" },
  { name: "manage", args: "<agent>|off", help: "this room's manager: an agent that may set, pause and delete loops for any agent here (owner)" },
  { name: "delegate", args: "answers <agent>|off", help: "let named agents answer other agents' folder-trust questions for you, nothing else (owner)" },
  { name: "budget", args: "[agent $/day]", help: "each agent's spend today and its daily budget ($30 unless set); at 100% it pauses until /resume (owner)" },
  { name: "resume", args: "<agent>", help: "lift a budget pause for the rest of the day (owner)" },
  { name: "start", args: "", help: "a working team in this room: how to start one with metacom start (three questions)" },
  { name: "approvals", args: "", help: "every request waiting for your approval, in every room (owner)" },
  { name: "approve", args: "[id|all]", help: "approve an agent's request for an outward action: typed into the agent as your word (owner); no id lists the open ones" },
  { name: "decline", args: "[id]", help: "decline an agent's request (owner)" },
  { name: "grant", args: "<name> <room,..|all>", help: "let a token into more rooms, or every room (owner)" },
  { name: "ungrant", args: "<name> <room,..>", help: "take rooms from a token (owner)" },
  { name: "limit", args: "<name> <room,..>", help: "set a token's rooms exactly (owner)" },
  { name: "alerts", args: "[on|off|stuck|done|all]", help: "phone alerts for this room: stuck (the default), done, all or off (the phone itself: /alerts on in the web app)" },
  { name: "theme", args: "[name]", help: "switch the colour theme" },
  { name: "clear", args: "", help: "clear the screen" },
  { name: "help", args: "", help: "keys and commands" },
  { name: "quit", args: "", help: "leave the chat" },
] as const;

export const CONTROL = /^!(?:(?:stop|type)\b|\/)/;
/// A loop's next or last run as people read it: "14:00", "tomorrow 09:00", "Mon 09:00".
export const when = (iso: string | null | undefined): string => {
  if (!iso) return "-";
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
};
/// What the hub takes as a room name.
export const ROOM = /^[\w][\w.-]{0,63}$/;

/// One-word state for a member as humans think of it, not the raw hub status.
/// Three words for what a member is: here and busy, here and not, or gone. The server knows
/// more (starting, blocked, a finished turn nobody looked at), and the room's own messages
/// carry that when it matters; the line above the input does not need it.
export const stateOf = (m: Member): "online" | "working" | "offline" => {
  if (!m.connected) return "offline";
  return m.status === "working" ? "working" : "online";
};

/// History without reconnect noise: an "X left" followed by "X joined" within ten minutes is a
/// dropped connection, not a departure, and both lines go. Logs written before the hub waited
/// out short drops are full of them.
const JOIN_LEFT = /^(\S+) (left|joined)(?: from .*)?$/;
/// A room's history in the order the feed shows it, reconnect noise folded: an edited message
/// stands where it was last edited, not where it was first posted.
const ordered = (list: Message[]): Message[] => {
  const when = (m: Message) => m.edited ?? m.ts;
  return foldReconnects(list)
    .map((m, i) => [m, i] as const)
    .sort((a, b) => (when(a[0]) < when(b[0]) ? -1 : when(a[0]) > when(b[0]) ? 1 : a[1] - b[1]))
    .map(([m]) => m);
};

export const foldReconnects = (list: Message[]): Message[] => {
  const drop = new Set<string>();
  const open = new Map<string, Message>(); // name -> its unanswered "left"
  for (const m of list) {
    if (m.kind !== "system") continue;
    const hit = JOIN_LEFT.exec(m.text);
    if (!hit) continue;
    const [, who, what] = hit;
    const left = open.get(who!);
    if (what === "left") open.set(who!, m);
    else if (left && Date.parse(m.ts) - Date.parse(left.ts) < 600_000) {
      drop.add(left.id);
      drop.add(m.id);
      open.delete(who!);
    }
  }
  // what is left of a night of drops comes in runs between real messages: of each run only the
  // last joined or left of each person stays, which is where they are now
  const out: Message[] = [];
  let run: Message[] = [];
  const flush = () => {
    const lastOf = new Map(run.map((m) => [JOIN_LEFT.exec(m.text)![1], m]));
    out.push(...run.filter((m) => lastOf.get(JOIN_LEFT.exec(m.text)![1]!) === m));
    run = [];
  };
  for (const m of list) {
    if (drop.has(m.id)) continue;
    if (m.kind === "system" && JOIN_LEFT.test(m.text)) run.push(m);
    else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
};

let seq = 0;
const id = () => `e${++seq}`;

/// Everything about the room that is not rendering: the hub connection, members, the log
/// of what is on screen, and the actions the composer triggers. React subscribes to it.
export class Store {
  state: State;
  hub: Hub | null = null;
  private listeners = new Set<() => void>();
  private lastMessage: { name: string; ts: number; to?: string } | null = null;
  private states = new Map<string, string>();
  private marks = new Map<string, string>(); // what was last announced about an agent
  onBell: () => void = () => {};
  onQuit: () => void = () => {};
  onTheme: (name: string) => string | null = () => null;
  private imageSeq = 0;
  config: Config;

  constructor({ name, room, config }: { name: string; room: string; config: Config }) {
    this.config = config;
    this.state = { me: { name, role: "?" }, room, url: config.url, hub: { name: config.name ?? "hub", http: config.http }, members: new Map(), log: [], busy: null, status: null, attachments: [], mouse: process.env["MC_MOUSE"] !== "0", live: null, loops: null, more: null, editing: null, pins: [], pinIds: new Set(), jump: null, ghost: null, skipped: [], picked: null, archived: false, cards: [], waiting: [], replyTo: null };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): State => this.state;

  // MARK: live mode

  private liveKeysBuffer = "";
  private liveKeysTimer: ReturnType<typeof setTimeout> | null = null;

  async startLive(name: string): Promise<void> {
    const member = this.state.members.get(name);
    if (member && member.kind !== "agent") return this.note(`${name} is a person; direct view is for agents`, "warn");
    this.set({ live: { name, cols: 0, rows: 0, cursor: null, lines: [], ready: false } });
    try {
      await this.hub!.api.agents.live({ name, on: true });
    } catch (error) {
      this.set({ live: null });
      throw error;
    }
    // an agent whose wrapper predates live mode never sends a frame: say so rather than show nothing
    setTimeout(() => {
      const live = this.state.live;
      if (!live || live.name !== name || live.ready) return;
      void this.stopLive().then(() => this.note(`no screen from ${name}: its wrapper is older than direct view. Restart it (metacom update, then start it again) to open it directly.`, "warn"));
    }, LIVE_FIRST_FRAME_MS);
  }

  /// Leaves live mode: the conversation comes back as it was. The hub hears it too, unless it
  /// was the hub that ended it.
  async stopLive(): Promise<void> {
    const live = this.state.live;
    if (!live) return;
    this.flushLiveKeys();
    this.set({ live: null });
    await this.hub!.api.agents.live({ name: live.name, on: false }).catch(() => {});
  }

  private endLive(text: string): void {
    this.set({ live: null });
    this.note(text, "warn");
  }

  private onLiveFrame(f: { name: string; cols: number; rows: number; cursor: [number, number] | null; full: boolean; lines: Record<string, string> }): void {
    const live = this.state.live;
    if (!live || live.name !== f.name) return;
    const lines = f.full ? new Array<string>(f.rows).fill("") : live.lines.slice(0, f.rows);
    while (lines.length < f.rows) lines.push("");
    for (const [i, line] of Object.entries(f.lines)) lines[Number(i)] = line;
    this.set({ live: { name: live.name, cols: f.cols, rows: f.rows, cursor: f.cursor, lines, ready: live.ready || f.full, scroll: live.scroll ?? null } });
  }

  // Scrolling back while live: shift+↑↓ a row, shift+PgUp/PgDn a page, the wheel. A screenful
  // from the agent's scrollback, asked from its wrapper; nothing goes to the agent. Any key that
  // does is back at the bottom first.
  private scrollWant: number | null = null;
  private scrollBusy = false;
  private scrollGen = 0;

  liveScrollBy(rows: number): void {
    void this.liveScrollTo((this.state.live?.scroll?.offset ?? 0) + rows);
  }

  async liveScrollTo(offset: number): Promise<void> {
    const live = this.state.live;
    if (!live) return;
    const max = live.scroll ? live.scroll.max : Infinity;
    offset = Math.max(0, Math.min(max, Math.round(offset)));
    if (offset === 0) return this.liveBottom();
    this.scrollWant = offset;
    if (this.scrollBusy) return;
    this.scrollBusy = true;
    const gen = this.scrollGen;
    try {
      while (this.scrollWant !== null) {
        const want = this.scrollWant;
        this.scrollWant = null;
        const r = await this.hub!.api.agents.liveScroll({ name: live.name, offset: want });
        const now = this.state.live;
        if (!now || now.name !== r.name || gen !== this.scrollGen) break;
        this.set({ live: { ...now, scroll: r.offset ? r : null } });
      }
    } catch (error) {
      this.setStatus(`scrolling back: ${(error as Error).message}`, "warn", 4000);
    } finally {
      this.scrollBusy = false;
      this.scrollWant = null;
    }
  }

  liveBottom(): void {
    this.scrollGen++;
    this.scrollWant = null;
    const live = this.state.live;
    if (live && live.scroll) this.set({ live: { ...live, scroll: null } });
  }

  /// Keys for the agent, as the terminal sends them; batched briefly, so typing fast or pasting
  /// is a few calls rather than one per key.
  liveKeys(data: string): void {
    if (!this.state.live || !data) return;
    // what goes to the agent brings the live screen back first
    this.liveBottom();
    this.liveKeysBuffer += data;
    if (!this.liveKeysTimer) this.liveKeysTimer = setTimeout(() => this.flushLiveKeys(), 25);
  }

  private flushLiveKeys(): void {
    if (this.liveKeysTimer) clearTimeout(this.liveKeysTimer);
    this.liveKeysTimer = null;
    const data = this.liveKeysBuffer;
    this.liveKeysBuffer = "";
    const live = this.state.live;
    if (!data || !live) return;
    void this.hub!.api.agents.liveKeys({ name: live.name, data }).catch((error: Error) => this.endLive(`direct view ended: ${error.message}`));
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  push(entry: Distribute<Entry>): void {
    const log = [...this.state.log, { ...entry, id: id() } as Entry];
    this.set({ log: log.length > 3000 ? log.slice(-2500) : log });
  }

  // MARK: further back. Shift+↑ with nothing typed goes to the oldest message loaded, and again
  // there (or the "↑ load more" row) loads the page before it: first what was fetched and not
  // shown, then from the hub. Nothing older: "start of room".
  private back: { hidden: Message[]; oldest: string | null; start: boolean } | null = null;
  private loadingMore = false;

  /// The page before the oldest message shown, put above it; says how many came. The entries
  /// already drawn keep their grouping (and so their height): the reader's place stays put.
  async loadMore(): Promise<number> {
    const b = this.back;
    if (this.loadingMore || !b) return 0;
    let older: Message[];
    if (b.hidden.length) {
      older = b.hidden.slice(-MORE_PAGE);
      this.back = { ...b, hidden: b.hidden.slice(0, b.hidden.length - older.length) };
    } else if (!b.start && b.oldest) {
      this.loadingMore = true;
      try {
        const page: Message[] = await this.hub!.api.room.history({ room: this.state.room, before: b.oldest, limit: MORE_PAGE });
        older = ordered(page);
        this.back = { hidden: [], oldest: page[0]?.id ?? b.oldest, start: page.length < MORE_PAGE };
      } finally {
        this.loadingMore = false;
      }
    } else return 0;
    const { log } = this.state;
    const have = new Set(log.flatMap((e) => (e.type === "message" ? [e.msg.id] : [])));
    older = older.filter((m) => !have.has(m.id));
    const kept = this.lastMessage;
    this.lastMessage = null;
    const entries = older.map((m) => ({ type: "message", msg: m, grouped: this.group(m), id: id() }) as Entry);
    this.lastMessage = kept;
    const head = log[0]?.type === "banner" ? [log[0]] : [];
    const ids = new Set(older.map((m) => m.id));
    this.set({ log: [...head, ...entries, ...log.slice(head.length)], cards: this.state.cards.filter((c) => !ids.has(c.msg.id)) });
    return entries.length;
  }

  /// Nothing older to load.
  atStart(): boolean {
    return Boolean(this.back) && !this.back!.hidden.length && this.back!.start;
  }

  /// The chat's own word. A result or a hint is said under the input for a moment and gone;
  /// only what needs the reader (a warning, an error, an agent stuck on a question) stays in
  /// the conversation, drawn like "ada joined".
  note(text: string, tone: Tone = "dim"): void {
    if (tone !== "warn" && tone !== "error") return this.setStatus(text, tone === "dim" ? "plain" : tone, 4000);
    this.lastMessage = null;
    this.push({ type: "note", tone, text, ts: new Date().toISOString() });
  }

  setBusy(busy: string | null): void {
    this.set({ busy });
  }

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /// Say something under the input. `ms` clears it again; without it the line stays until
  /// something else replaces it, which is what a mode like forwarding wants.
  setStatus(text: string | null, tone: Tone = "ok", ms = 0): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.set({ status: text ? { text, tone } : null });
    if (text && ms) this.statusTimer = setTimeout(() => this.set({ status: null }), ms);
  }

  async start(): Promise<void> {
    const hub: Hub = await connect({ url: this.config.url, token: this.config.token, onOpen: () => (this.hub === hub ? this.join(true) : undefined) });
    await this.adopt(hub);
  }

  /// Sign in to `hub` and make it this chat's: join the room, follow its events, load history.
  private async adopt(hub: Hub): Promise<void> {
    const { room } = this.state;
    const name = this.state.me.name;
    this.hub = hub;
    // the hub's public address (HUB_PUBLIC_URL, e.g. its tunnel) over the one this chat dialled
    this.set({ me: { name, role: hub.me.role }, hub: { name: this.state.hub.name, http: hub.me.url ?? this.config.http } });
    // a token for some rooms only opens one of them, whatever room was asked for
    const rooms: string[] | undefined = hub.me.rooms;
    if (rooms && !rooms.includes(room)) this.set({ room: rooms[0] });
    try {
      await this.join(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/belongs to another token/.test(msg)) {
        const env = process.env["MC_TOKEN"] ? " MC_TOKEN is set in this shell and points at an agent token; unset it or run metacom connect again." : "";
        throw new Error(`${msg}. You signed in with a ${hub.me.role} token, and only an owner token can take a name over.${env} Otherwise pick another name with -n.`);
      }
      throw error;
    }
    hub.api.room.on("message", (m: Message) => this.onMessage(m));
    hub.api.room.on("edit", ({ message }: { message: Message }) => this.onEdit(message));
    hub.api.room.on("withdrawn", ({ room, ids }: { room: string; ids: string[] }) => room === this.state.room && ids.forEach((i) => this.forgetSuggestion(i)));
    hub.api.room.on("dismissed", ({ room, id }: { room: string; id: string }) => room === this.state.room && this.forgetSuggestion(id));
    hub.api.room.on("loops", ({ room, loops }: { room: string; loops: Loop[] }) => {
      const v = this.state.loops;
      if (v && room === this.state.room) this.set({ loops: { ...v, list: loops, open: v.open && loops.some((l) => l.id === v.open) ? v.open : null } });
    });
    hub.api.room.on("pins", ({ room, pins }: { room: string; pins: Message[] }) => room === this.state.room && this.setPins(pins));
    hub.api.room.on("archived", ({ room, archived }: { room: string; archived: boolean }) => room === this.state.room && this.set({ archived }));
    hub.api.agents.on("changed", ({ members }: { members: Member[] }) => this.onMembers(members));
    hub.api.room.on("deleted", ({ room, by }: { room: string; by: string }) => {
      if (room !== this.state.room) return;
      void this.switchRoom("default").then(() => this.note(`${room} was deleted by ${by}`, "warn"));
    });
    hub.api.agents.on("message", (m: Message) => {
      // one for me from another room stays in that room, unannounced: the owner reads it there
      if (m.room && m.room !== this.state.room) return;
      if (m.from && m.from.name !== name) this.onBell();
    });
    hub.api.agents.on("liveFrame", (f: { name: string; cols: number; rows: number; cursor: [number, number] | null; full: boolean; lines: Record<string, string> }) => this.onLiveFrame(f));
    hub.api.agents.on("liveEnd", ({ name: who, reason }: { name: string; reason: string }) => {
      if (this.state.live && this.state.live.name === who) this.endLive(`${who}'s direct view ended (${reason})`);
    });
    hub.m.on("close", () => {
      if (this.hub !== hub) return; // a hub this chat moved away from
      if (this.state.live) this.endLive("direct view ended: the connection to the hub dropped");
      this.setBusy("reconnecting…");
    });
    hub.m.on("open", () => (this.hub === hub ? this.setBusy(null) : undefined));
    this.push({ type: "banner" });
    await this.load();
  }

  /// The room's recent history and its members, into an empty log.
  private async load(): Promise<void> {
    const hub = this.hub!;
    // more than is shown, so the last 30 are real messages and not a night of reconnects; the rest
    // waits for "load more"
    const raw: Message[] = await hub.api.room.history({ room: this.state.room, limit: HISTORY_PAGE });
    const all = ordered(raw);
    const history = all.slice(-30);
    this.back = { hidden: all.slice(0, all.length - history.length), oldest: raw[0]?.id ?? null, start: raw.length < HISTORY_PAGE };
    this.onMembers(await hub.api.agents.list({}));
    for (const m of history) this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (history.length) this.push({ type: "rule", text: "now" });
    this.set({ more: null, editing: null, cards: [] });
    void this.loadPins();
    void this.loadWaiting();
    this.markRead();
  }

  /// The hub's list of suggestions waiting for you in this room, from all of its history.
  async loadWaiting(): Promise<void> {
    const room = this.state.room;
    try {
      const r = await this.hub!.api.room.suggestions({ room });
      if (room === this.state.room) this.set({ waiting: r.suggestions });
    } catch {
      if (room === this.state.room) this.set({ waiting: [] });
    }
  }

  /// A message by id: in the conversation, or a waiting suggestion's older than it.
  messageOf(id: string): Message | null {
    const e = this.state.log.find((x) => x.type === "message" && x.msg.id === id);
    if (e && e.type === "message") return e.msg;
    const card = this.state.cards.find((c) => c.msg.id === id);
    if (card) return card.msg;
    return this.state.waiting.find((m) => m.id === id) ?? null;
  }

  // MARK: ⋯ under a message: edit and pin

  async showVersions(id: string): Promise<void> {
    this.set({ more: null });
    const r = await this.hub!.api.room.versions({ id });
    const text = r.versions.map((v: { rev: number; ts: string; from: { name: string }; text: string }) => `v${v.rev}${v.rev === r.versions.length ? " (shown)" : ""} · ${new Date(v.ts).toLocaleString()} · ${v.from.name}: ${v.text}`).join("\n\n");
    this.lastMessage = null;
    this.push({ type: "screen", name: r.id, label: `versions of ${r.id.slice(0, 8)}`, text });
  }

  private jumps = 0; // jumps asked for: one that loads history gives way to a later one

  /// Scroll the conversation to a message (a pin, a suggestion); the app finds where it is drawn
  /// now. One older than what is shown is fetched alone (room/message) and put at the top of the
  /// conversation, as its oldest message, with a "…" line under it for the history skipped (see
  /// shown()); it stays until the room is opened again, and the history between is never loaded.
  async jumpTo(target: string, kind: CardKind = "pin"): Promise<void> {
    const mine = ++this.jumps;
    if (this.state.log.some((e) => e.type === "message" && e.msg.id === target) || this.state.cards.some((c) => c.msg.id === target)) {
      this.set({ jump: target });
      return;
    }
    let msg: Message;
    try {
      msg = await this.hub!.api.room.message({ room: this.state.room, id: target });
    } catch {
      return this.note("that message is no longer in the room", "warn");
    }
    if (mine !== this.jumps) return; // a later jump was asked for while this one fetched
    const cards = [...this.state.cards, { msg, kind }].sort((a, b) => a.msg.ts.localeCompare(b.msg.ts));
    this.set({ cards, jump: target });
  }

  /// The conversation as drawn: the older messages fetched alone first (under the banner, oldest
  /// first), a "…" line for the history skipped, then the log. They are messages like any other
  /// (a pin: ⚑ before its sender), and old ones: not in the log, so no "now" line, count, bell or
  /// suggestion queue takes them for the newest.
  shown(): Entry[] {
    const { cards, log } = this.state;
    const head = log[0]?.type === "banner" ? [log[0]] : [];
    // "↑ load more" (or "start of room") at the top of the loaded history
    const more: Entry[] = log.some((e) => e.type === "message") ? [{ id: "more", type: "more", start: this.atStart() }] : [];
    if (!cards.length) return [...head, ...more, ...log.slice(head.length)];
    const old: Entry[] = cards.map((c) => ({ id: `card-${c.msg.id}`, type: "message", msg: c.msg, grouped: false, card: c.kind }));
    return [...head, ...old, { id: "gap", type: "rule", text: "…" }, ...more, ...log.slice(head.length)];
  }

  doneJump(): void {
    this.set({ jump: null });
  }

  // MARK: suggested replies: ↩ reply on a message to you that suggests one shows it as ghost text
  // in the empty input; Tab takes it, typing or Esc sends it away, Enter never sends a ghost.

  /// Every suggestion to you still waiting for a reply, oldest first: not answered by a reply to it,
  /// nor by a later message from you to its sender that answers no message in particular.
  pendingSuggestions(): Suggestion[] {
    const me = this.state.me.name;
    const replied = new Set<string>();
    const lastPlain: Record<string, number> = {};
    // the hub's list (all of the room's history) for what is older than the conversation, then it
    const shown = this.state.log.flatMap((e) => (e.type === "message" ? [e.msg] : []));
    const inLog = new Set(shown.map((m) => m.id));
    const msgs = [...this.state.waiting.filter((m) => !inLog.has(m.id)), ...shown];
    msgs.forEach((m, i) => {
      if (m.from?.name !== me) return;
      if (m.replyTo) return void replied.add(m.replyTo);
      const to = m.to ?? /^@(\S+)/.exec(m.text || "")?.[1];
      if (to) lastPlain[to] = i;
    });
    return msgs
      .map((m, i) => [m, i] as const)
      .filter(([m, i]) => m.suggest && !(m.suggestUntil && Date.parse(m.suggestUntil) <= Date.now()) && m.from && m.from.name !== me && !replied.has(m.id) && !((lastPlain[m.from.name] ?? -1) > i))
      .map(([m]) => suggestionOf(m, m.from.name));
  }

  /// The one offered now: the one Tab last switched to, else the oldest waiting one not skipped (Esc).
  pendingSuggestion(): Suggestion | null {
    const all = this.pendingSuggestions();
    return all.find((g) => g.id === this.state.picked) ?? all.find((g) => !this.state.skipped.includes(g.id)) ?? null;
  }

  /// The suggestion Tab put in the input, while its text is as it was taken: Tab may replace it.
  takenUnchanged(text: string): Suggestion | null {
    const r = this.state.replyTo;
    if (!r || !text) return null;
    return this.pendingSuggestions().find((g) => g.id === r.id && g.text === text) ?? null;
  }

  /// A click on "n/N waiting": the next one waiting (round the end). One taken and unchanged gives
  /// way to it, filled in (returns its text for the input); else it is offered, as the ghost.
  stepSuggestion(text: string): string | null {
    const all = this.pendingSuggestions();
    if (!all.length) return null;
    if (this.takenUnchanged(text)) return this.takeNext(1);
    const cur = this.state.ghost ?? this.pendingSuggestion();
    const at = cur ? all.findIndex((g) => g.id === cur.id) : -1;
    const next = all[(at + 1) % all.length]!;
    this.set({ ghost: null, picked: next.id, skipped: this.state.skipped.filter((id) => id !== next.id) });
    void this.jumpTo(next.id, "reply");
    return null;
  }

  /// Tab again on a suggestion taken and unchanged: the next one waiting (shift+tab: the previous,
  /// round the ends) in its place, its message scrolled to. Returns the text for the input.
  takeNext(dir: 1 | -1): string {
    const all = this.pendingSuggestions();
    const at = all.findIndex((g) => g.id === this.state.replyTo?.id);
    const next = all[(at + dir + all.length) % all.length]!;
    this.set({ ghost: null, picked: next.id, replyTo: { id: next.id, to: next.to } });
    void this.jumpTo(next.id, "reply");
    return next.text;
  }

  /// The ghost in the input now (the input empty): one ↩ reply asked for, else the oldest waiting.
  ghostNow(text: string): Suggestion | null {
    if (text || this.state.editing) return null;
    return this.state.ghost ?? this.pendingSuggestion();
  }

  startReply(msg: Message, who: string): boolean {
    this.set({ replyTo: { id: msg.id, to: who }, ghost: msg.suggest ? suggestionOf(msg, who) : null });
    if (msg.suggest) this.setStatus("tab takes the suggestion · esc dismisses it", "ok", 4000);
    return Boolean(msg.suggest);
  }

  /// Tab: the ghost becomes your text, a reply to its message.
  takeGhost(): string | null {
    const g = this.ghostNow("");
    if (!g) return null;
    this.set({ ghost: null, replyTo: { id: g.id, to: g.to } });
    return g.text;
  }

  /// A suggestion put away here: its message stays, without it, and it leaves the queue. A reply
  /// it started is no longer one.
  forgetSuggestion(id: string): void {
    const strip = (m: Message): Message => (m.id === id && m.suggest ? { ...m, suggest: undefined } : m);
    const replying = this.state.replyTo?.id === id;
    this.set({
      log: this.state.log.map((e) => (e.type === "message" && e.msg.id === id && e.msg.suggest ? { ...e, msg: strip(e.msg) } : e)),
      waiting: this.state.waiting.filter((m) => m.id !== id),
      cards: this.state.cards.map((c) => (c.msg.id === id && c.msg.suggest ? { ...c, msg: strip(c.msg) } : c)),
      ghost: this.state.ghost?.id === id ? null : this.state.ghost,
      picked: this.state.picked === id ? null : this.state.picked,
      replyTo: replying ? null : this.state.replyTo,
    });
  }

  /// Esc (or ✕ cancel) on a suggestion: put away for good, on the hub, so it stays gone after a
  /// restart and on your other devices. The next waiting one is offered.
  dismissSuggestion(id: string): void {
    this.forgetSuggestion(id);
    this.hub?.api.room.dismiss({ room: this.state.room, id }).catch((e: Error) => this.setStatus(`not dismissed: ${e.message}`, "warn", 3000));
  }

  /// The suggestion a reply was started from, while it is still waiting.
  replyingToSuggestion(): Suggestion | null {
    const r = this.state.replyTo;
    return r ? this.pendingSuggestions().find((g) => g.id === r.id) ?? null : null;
  }

  /// Esc on the one offered: dismissed, and the next waiting one is offered.
  clearGhost(): boolean {
    const g = this.ghostNow("");
    if (g) this.dismissSuggestion(g.id);
    return Boolean(g);
  }

  /// ✕ cancel reply (or Esc): no reply target. A suggestion it was taken from is dismissed for good;
  /// any other is not offered again at once. Says whether the input holds that suggestion as taken,
  /// unchanged: the app clears it; what you typed stays.
  cancelReply(text: string): { clear: boolean } {
    const id = this.state.replyTo?.id;
    const clear = Boolean(this.takenUnchanged(text));
    const taken = this.replyingToSuggestion();
    if (taken) {
      this.dismissSuggestion(taken.id);
      this.setStatus("suggestion dismissed", "ok", 1500);
      return { clear };
    }
    this.set({ replyTo: null, ghost: null, picked: null, skipped: id && !this.state.skipped.includes(id) ? [...this.state.skipped, id] : this.state.skipped });
    this.setStatus("reply cancelled", "ok", 1500);
    return { clear };
  }

  clearReply(): void {
    this.set({ replyTo: null, ghost: null });
  }

  toggleMore(id: string): void {
    this.set({ more: this.state.more === id ? null : id });
  }

  startEdit(msg: Message): void {
    this.set({ editing: msg, more: null });
    this.setStatus("editing your message · enter saves it · esc cancels", "ok");
  }

  cancelEdit(): void {
    this.set({ editing: null });
    this.setStatus("editing cancelled", "warn", 1500);
  }

  setPins(pins: Message[]): void {
    this.set({ pins, pinIds: new Set(pins.map((m) => m.id)) });
  }

  async loadPins(): Promise<void> {
    try {
      this.setPins((await this.hub!.api.room.pins({ room: this.state.room })).pins);
    } catch {
      this.setPins([]);
    }
  }

  async pin(msg: Message, on: boolean): Promise<void> {
    this.set({ more: null });
    try {
      const r = await this.hub!.api.room.pin({ id: msg.id, on });
      this.setStatus(`${on ? "pinned" : "unpinned"} · ${r.count} pinned · /pins lists them`, "ok", 2500);
    } catch (error) {
      this.note(error instanceof Error ? error.message : String(error), "error");
    }
  }

  /// Every room on the hub, for the room list (← on an empty line).
  async rooms(): Promise<RoomSummary[]> {
    return this.hub ? this.hub.api.room.list({}) : [];
  }

  /// The archived rooms (read-only, out of the list): the room list's folder.
  async archivedRooms(): Promise<RoomSummary[]> {
    return this.hub ? this.hub.api.room.list({ archived: true }).catch(() => []) : [];
  }

  /// Every other saved hub's rooms, each signed in to briefly with its own token. A hub that
  /// does not answer within a few seconds is listed as unreachable.
  async otherRooms(): Promise<HubRooms[]> {
    const others = (this.config.hubs ?? []).filter((h) => h.url !== this.config.url);
    return Promise.all(
      others.map(async (h): Promise<HubRooms> => {
        const pending = connect({ url: h.url, token: h.token, callTimeout: 5_000 });
        const late = new Promise<null>((ok) => setTimeout(() => ok(null), 4_000));
        try {
          const hub = await Promise.race([pending, late]);
          if (!hub) {
            void pending.then((x) => x.m.close()).catch(() => {});
            return { hub: h, rooms: null, error: "unreachable" };
          }
          try {
            return { hub: h, rooms: await hub.api.room.list({}), ...(hub.me.url ? { url: hub.me.url } : {}) };
          } finally {
            hub.m.close();
          }
        } catch (error) {
          return { hub: h, rooms: null, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  /// Move this chat to another saved hub and into one of its rooms. The new hub is signed in to
  /// first: if that fails the chat stays where it was.
  async switchHub(name: string, room: string): Promise<boolean> {
    const all: HubEntry[] = [{ name: this.config.name ?? "hub", url: this.config.url, http: this.config.http, token: this.config.token }, ...(this.config.hubs ?? [])];
    const target = all.find((h) => h.name === name);
    if (!target) return false;
    if (target.url === this.config.url) return this.switchRoom(room);
    this.setBusy(`connecting to ${name}…`);
    let hub: Hub;
    try {
      hub = await connect({ url: target.url, token: target.token, onOpen: () => (this.hub === hub ? this.join(true) : undefined) });
    } catch (error) {
      this.setBusy(null);
      this.note(`could not connect to ${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    if (this.state.live) this.endLive(`direct view ended: you moved to ${name}`);
    const old = this.hub;
    // the hub we leave becomes one of the others; the one we join leaves that list
    const current: HubEntry = { name: this.config.name ?? "hub", url: this.config.url, http: this.config.http, token: this.config.token };
    this.config = { ...this.config, name: target.name, url: target.url, http: target.http, token: target.token, hubs: [current, ...(this.config.hubs ?? []).filter((h) => h.url !== target.url)] };
    this.lastMessage = null;
    this.states.clear();
    this.marks.clear();
    this.set({ room, url: target.url, hub: { name: target.name, http: target.http }, log: [], members: new Map(), me: { name: this.state.me.name, role: hub.me.role } });
    this.hub = hub;
    old?.m.close();
    try {
      await this.adopt(hub);
    } catch (error) {
      this.note(`connected to ${name}, but could not open ${room}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    } finally {
      this.setBusy(null);
    }
    return true;
  }

  /// Move to another room, creating it if nobody has used the name yet: the member follows,
  /// the conversation is replaced by that room's.
  async switchRoom(room: string): Promise<boolean> {
    if (!this.hub || room === this.state.room) return true;
    if (!ROOM.test(room)) {
      this.note("a room name is letters, digits, dot, dash or underscore", "warn");
      return false;
    }
    const was = this.state.room;
    this.set({ room, log: [], members: new Map(), waiting: [], cards: [] });
    this.lastMessage = null;
    this.states.clear();
    this.marks.clear();
    try {
      await this.join(false);
      await this.load();
      return true;
    } catch (error) {
      this.set({ room: was, log: [] });
      await this.join(false).catch(() => {});
      await this.load().catch(() => {});
      this.note(`could not open ${room}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  private async join(again: boolean): Promise<void> {
    const hub = this.hub!;
    const { room } = this.state;
    const name = this.state.me.name;
    const kind = hub.me.role === "agent" ? "agent" : "human";
    await hub.api.agents.register({ name, room, kind, host: os.hostname() });
    if (kind === "human") this.set({ archived: Boolean((await hub.api.room.join({ room }))?.archived) });
    await hub.api.agents.status({ status: "waiting" });
    // back after a drop: what was said here while away, and what was answered or asked, elsewhere too
    if (again && kind === "human") {
      void this.catchUp();
      void this.loadWaiting();
    }
  }

  /// The messages of this room since the newest one shown (said while the connection was down),
  /// in order, none twice.
  async catchUp(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const room = this.state.room;
    const shown = this.state.log.filter((e): e is Extract<Entry, { type: "message" }> => e.type === "message");
    const newest = shown.reduce((t, e) => (e.msg.ts > t ? e.msg.ts : t), "");
    if (!newest) return;
    const have = new Set(shown.map((e) => e.msg.id));
    const missed: Message[] = await hub.api.room.history({ room, since: newest, limit: 500 }).catch(() => []);
    if (this.state.room !== room) return;
    for (const m of ordered(missed)) if (!have.has(m.id)) this.onMessage(m);
  }

  /// Consecutive messages from one sender within two minutes drop the repeated time and name.
  private group(m: Message): boolean {
    if (m.kind === "system") {
      this.lastMessage = null;
      return false;
    }
    const from = m.from?.name ?? "?";
    const ts = Date.parse(m.ts);
    const grouped = Boolean(this.lastMessage && !m.edited && this.lastMessage.name === from && !m.to && !this.lastMessage.to && ts - this.lastMessage.ts < 120_000);
    this.lastMessage = { name: from, ts, to: m.to };
    return grouped;
  }

  /// The open room is read: messages to me here stop counting as unread in the room list. At
  /// most once a second; an older hub without it is fine.
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private markRead(): void {
    if (this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.hub?.api.room.read?.({ room: this.state.room }).catch(() => {});
    }, 1000);
  }

  private onMessage(m: Message): void {
    const { room, me } = this.state;
    if (m.room && m.room !== room) return;
    this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (m.to === me.name) this.markRead();
    if (m.from && m.from.name !== me.name && m.kind === "say" && new RegExp(`@${me.name}\\b`, "i").test(m.text)) this.onBell();
  }

  /// An author changed a message: the new version takes the old one's place.
  private onEdit(m: Message): void {
    if (m.room && m.room !== this.state.room) return;
    // the latest version moves to the bottom; its old place goes (the hub's log keeps both)
    this.lastMessage = null;
    const log = this.state.log
      .filter((e) => !(e.type === "message" && e.msg.id === m.id))
      .map((e) => {
        if (e.type === "message") return { ...e, grouped: this.group(e.msg) };
        if (e.type === "note" || e.type === "screen") this.lastMessage = null;
        return e;
      });
    this.set({ log, cards: this.state.cards.filter((c) => c.msg.id !== m.id) });
    this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (this.state.pinIds.has(m.id)) void this.loadPins();
  }

  private onMembers(list: Member[]): void {
    const { room } = this.state;
    // the room's own last, so its cmo's colour wins over a cmo in another room
    setColors([...list.filter((m) => m.room !== room), ...list.filter((m) => m.room === room)]);
    const members = new Map<string, Member>();
    // the room's own members, and agents from elsewhere the owner invited in as guests
    for (const m of list) if (m.room === room || (m.invited || []).includes(room)) members.set(m.name, m);
    const before = new Map(this.states);
    this.set({ members });
    for (const m of members.values()) {
      const state = stateOf(m);
      const was = before.get(m.name);
      this.states.set(m.name, state);
      if (m.kind !== "agent") continue;
      // The line above the input says only online, working or offline. An agent stuck on a
      // question still has to reach the reader, so that arrives in the conversation instead.
      const stuck = m.status === "blocked";
      if (stuck && this.marks.get(m.name) !== "blocked") {
        // a question with options already arrived as its message: only the bell then
        if (!m.asking) this.note(`${m.name} needs you${m.reason ? ": " + m.reason : ""}`, "warn");
        this.onBell();
      }
      this.marks.set(m.name, stuck ? "blocked" : "");
      if (!was || was === state) continue;
    }
  }

  get working(): boolean {
    return Boolean(this.state.busy) || [...this.state.members.values()].some((m) => m.kind === "agent" && stateOf(m) === "working");
  }

  // MARK: attachments

  /// Attach a file to the draft: it gets a `[image 2.png]`-style token that the caller puts
  /// into the input text; the file is sent only if the token is still there on enter.
  /// Sources: cmd+v or ctrl+v (the clipboard image), a pasted file path, /attach <path>.
  attach(file: string, label?: string): string | null {
    try {
      const a = media.attachment(media.resolvePath(file));
      const known = this.state.attachments.find((x) => x.file === a.file);
      if (known) return known.token;
      if (this.state.attachments.length >= 8) {
        this.note("at most 8 files per message", "warn");
        return null;
      }
      const name = label ?? a.name;
      const token = `[${name}]`;
      this.set({ attachments: [...this.state.attachments, { ...a, name, token }] });
      return token;
    } catch (error) {
      this.failure(error);
      return null;
    }
  }

  /// A pasted line of paths to sendable files (one, or several dropped at once) becomes their
  /// attachments instead of text: the tokens, space-separated.
  attachPasted(text: string): string | null {
    const files = media.attachables(text);
    if (!files) return null;
    const tokens = files.map((f) => this.attach(f)).filter((t): t is string => Boolean(t));
    return tokens.length ? tokens.join(" ") : null;
  }

  /// Files copied in a file manager, as tokens; one we can't send is said so. Null when none.
  attachCopied(files: string[]): string | null {
    if (!files.length) return null;
    const sendable = files.filter((f) => media.typeOf(f));
    const refused = files.filter((f) => !media.typeOf(f)).map((f) => path.basename(f));
    if (refused.length) this.note(`can't send ${refused.join(", ")}: not a type the hub takes (images, video, pdf, text, csv, json, zip)`, "warn");
    const tokens = sendable.map((f) => this.attach(f)).filter((t): t is string => Boolean(t));
    return tokens.length ? tokens.join(" ") : refused.length ? "" : null;
  }

  /// A paste of just file names ("report.pdf"): what a terminal pastes for files copied in Finder.
  /// The files themselves are still on the clipboard; those with these names become tokens.
  attachNamed(text: string): string | null {
    const names = String(text || "").trim().split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
    if (!names.length || names.length > 8 || !names.every((n) => !n.includes("/") && /\.[A-Za-z0-9]{1,5}$/.test(n))) return null;
    const files = media.clipboardFiles().filter((f) => names.includes(path.basename(f)));
    return files.length ? this.attachCopied(files) : null;
  }

  /// Whatever is on the clipboard, as the text to put into the input: an image becomes an
  /// attachment token, a path becomes one too, anything else is pasted as it is.
  pasteClipboard(): string | null {
    // files copied in Finder (or a file manager) first: the clipboard also holds their icon as an image
    const copied = this.attachCopied(media.clipboardFiles());
    if (copied) return copied + " ";
    const file = media.clipboardImage();
    if (file) {
      const token = this.attach(file, `image ${++this.imageSeq}.png`);
      return token ? token + " " : null;
    }
    const text = media.clipboardText();
    if (!text) {
      this.note("nothing on the clipboard · /attach <path> sends a file", "warn");
      return null;
    }
    const token = this.attachPasted(text.trim()) || this.attachNamed(text);
    return token ? token + " " : text.replace(/\r\n?/g, "\n");
  }

  /// The attachments whose tokens are in the text, in text order.
  pending(text: string): Attachment[] {
    return this.state.attachments.filter((a) => text.includes(a.token)).sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));
  }

  /// Forget attachments whose tokens are gone from the text (all of them after a send).
  prune(text = ""): void {
    const keep = this.state.attachments.filter((a) => text.includes(a.token));
    if (keep.length !== this.state.attachments.length) this.set({ attachments: keep });
  }

  private async uploadAll(text: string): Promise<Media[] | undefined> {
    const list = this.pending(text);
    if (list.length === 0) return undefined;
    const out: Media[] = [];
    for (const a of list) {
      this.setBusy(`uploading ${a.name}…`);
      out.push({ ...(await media.upload({ http: this.config.http, token: this.config.token, file: a.file })), name: a.name });
    }
    return out;
  }

  // MARK: actions

  /// False when the hub refused it, so the app can give the draft back.
  async submit(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) {
      this.prune();
      return true;
    }
    // the answer to "how often?" after a /loop with no schedule in it: asked once, so anything
    // else drops the question and goes as typed
    const asked = this.loopAsk;
    this.loopAsk = null;
    const choice = asked && /^[1-9]$/.test(t) ? asked.options[Number(t) - 1] : undefined;
    if (asked && choice) {
      try {
        await this.makeLoop(asked.line, choice.every);
      } catch (error) {
        this.note(error instanceof Error ? error.message : String(error), "warn");
      }
      return true;
    }
    // an archived room is read-only: commands still run (/unarchive, /live, …), messages do not go
    if (this.state.archived && !t.startsWith("/")) {
      this.setStatus(`${this.state.room} is archived: read-only${this.state.me.role === "owner" ? " · /unarchive brings it back" : ""}`, "warn", 3000);
      return false;
    }
    // `$NAME=value$` as the whole input: a room secret, stored by the hub and never posted
    const secret = /^\s*\$([A-Z][A-Z0-9_]*)=([\s\S]*)\$\s*$/.exec(text);
    if (secret && !this.state.editing) {
      // only a secret: every agent online here gets it (the hub keeps none); say who did
      const [, name, value] = secret;
      try {
        const r = await this.hub!.api.room.say({ room: this.state.room, text });
        const h = r.handed ?? { to: [], missed: [] };
        this.setStatus(`🔒 $${name} ${value ? "handed to" : "taken back from"} ${h.to.join(", ") || "nobody"}${h.missed.length ? ` · not online: ${h.missed.join(", ")}` : ""}`, "ok", 6000);
        return true;
      } catch (error) {
        this.note(error instanceof Error ? error.message : String(error), "error");
        return true; // the draft is not given back: it holds the value
      }
    }
    this.setBusy("sending…");
    try {
      // in reply mode, words without an @ go to the one you are answering
      if (this.state.replyTo && !/^[@/>]/.test(t)) {
        await this.directed(`@${this.state.replyTo.to} ${t}`);
        this.clearReply();
        return true;
      }
      const editing = this.state.editing;
      if (editing) {
        const r = await this.hub!.api.room.edit({ id: editing.id, text });
        this.set({ editing: null });
        this.setStatus(r.unchanged ? "no change" : `saved as v${r.rev}`, "ok", 2000);
        return true;
      }
      if (t.startsWith("/")) await this.command(t);
      else if (this.mentioned(t)) await this.directed(t);
      else if (t.startsWith(">")) await this.dispatch(t.slice(1).trim());
      else if (CONTROL.test(t)) this.note("control commands go to an agent, e.g. @Alex !/compact", "warn");
      else await this.hub!.api.room.say({ room: this.state.room, text: t, media: await this.uploadAll(t) });
      this.prune();
      return true;
    } catch (error) {
      this.failure(error);
      return false;
    } finally {
      this.setBusy(null);
    }
  }

  private failure(error: unknown): void {
    let msg = error instanceof Error ? error.message : String(error);
    const blocked = msg.match(/^(\S+) is blocked on a question/);
    if (blocked) msg = `${blocked[1]} is blocked on a question · reply with its option number, or /direct ${blocked[1]} to answer it on its screen`;
    if (/^Owners only/.test(msg)) msg = "owners only · your token has the agent role";
    this.note(msg, "error");
  }

  /// Put text on the clipboard, and say so. Where no clipboard tool exists — a server over
  /// ssh — ask the terminal itself with OSC 52, which carries the text back to the machine
  /// you are sitting at.
  copy(text: string): void {
    if (!media.copyText(text)) {
      const payload = Buffer.from(text, "utf8").toString("base64");
      process.stdout.write(`\u001b]52;c;${payload}\u0007`);
    }
    const lines = text.split("\n").length;
    this.setStatus(`copied ${lines} line${lines === 1 ? "" : "s"}`, "ok", 2500);
  }

  /// Clicking on or off. `say` tells the reader what changed; the silent form is the one the
  /// chat uses when it takes the mouse back after a keystroke.
  setMouse(on: boolean, say: boolean): void {
    if (this.state.mouse === on) return;
    this.set({ mouse: on });
    if (!say) return;
    this.note(
      on
        ? "mouse on · drag to select and copy, click names and the ↩ reply / ⋯ row"
        : "mouse off · the terminal handles the mouse again, as in any other program",
      "ok"
    );
  }


  /// Pass a message on to someone else, under your own name, saying where it came from.
  private forwarded(msg: Message, note: string): string {
    const from = msg.from?.name ?? "?";
    return `[forwarded from ${from}${msg.to ? ` → ${msg.to}` : ""}] ${msg.text}${note ? `\n${note}` : ""}`;
  }

  /// Send a held message on to a member: one of this room's by name, or `member` when it was
  /// picked from another room's list.
  async forward(msg: Message, to: string, note: string, picked?: Member): Promise<void> {
    const body = this.forwarded(msg, note);
    try {
      const member = picked ?? this.state.members.get(to);
      if (!member) return this.setStatus(`nobody called ${to} is here`, "warn", 2500);
      const kind = member.kind === "agent" ? "command" : "info";
      // a member picked from another room's list is addressed in full (valuesdev@trade): a bare
      // name means the one in the room you are in, which is another agent when both rooms have
      // one of that name (an agent with a session in each)
      const address = picked && picked.kind === "agent" && picked.room ? `${picked.name}@${picked.room}` : to;
      const r = await this.hub!.api.agents.send({ to: address, text: body, kind, media: msg.media });
      this.setStatus(r.delivered ? `forwarded to ${to}` : `${to} is offline, queued`, "ok", 2500);
    } catch (error) {
      this.failure(error);
    }
  }

  /// Post a held message into another room, for everyone there.
  async forwardToRoom(msg: Message, room: string): Promise<void> {
    try {
      await this.hub!.api.room.say({ room, text: this.forwarded(msg, ""), media: msg.media });
      this.setStatus(`forwarded to ${room}`, "ok", 2500);
    } catch (error) {
      this.failure(error);
    }
  }

  /// The members of any room, for forwarding into it.
  async membersOf(room: string): Promise<Member[]> {
    if (!this.hub) return [];
    const list: Member[] = await this.hub.api.agents.list({ room });
    return list.filter((m) => m.name !== this.state.me.name);
  }

  /// The member a message is for: the first @name in it, wherever it stands. A leading
  /// mention is the address and comes off the text; one in the middle of a sentence is part
  /// of what you wrote, so the whole line travels.
  private mentioned(t: string): string | null {
    for (const m of t.matchAll(/(^|\s)@([^\s]+)/g)) {
      const name = m[2]!.replace(/[.,:;!?]+$/, "");
      if (this.state.members.has(name)) return name;
    }
    return t.startsWith("@") ? t.slice(1).split(/\s/)[0]! : null;
  }

  private async directed(t: string): Promise<void> {
    // "@alenclaude /direct", "@alenclaude /kill": the command, on that agent
    const after = /^@([^\s]+)\s+\/(direct|live|kill|wait)\s*$/.exec(t.trim());
    if (after) return this.command(`/${after[2]} ${after[1]}`);
    const to = this.mentioned(t)!;
    const lead = t.match(new RegExp(`^@${to.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*([\\s\\S]*)$`));
    const body = lead ? lead[1]!.trim() : t;
    if (to === "auto") return this.dispatch(body);
    // every agent here: the hub types it into each (a !/command from the owner: as at its terminal)
    if (to === "all" && !this.state.members.has("all")) {
      if (!body) return this.note("say something after @all", "warn");
      const r = await this.hub!.api.room.say({ room: this.state.room, text: t, media: await this.uploadAll(t) });
      if (r.all) this.note(r.all.length ? `to every agent here: ${r.all.join(", ")}` : `no agent is online in ${this.state.room}`, r.all.length ? undefined : "warn");
      return;
    }
    const member = this.state.members.get(to);
    if (!member) {
      await this.hub!.api.room.say({ room: this.state.room, text: t });
      this.note(`posted to the room as text (nobody called ${to} is here)`);
      return;
    }
    // "@alenclaude" and nothing else: its terminal, as /direct (the hub says "isn't yours" when it is not)
    if (!body && member.kind === "agent") return this.command(`/direct ${to}`);
    if (!body) return this.note(`say something after @${to}`, "warn");
    const kind = member.kind === "agent" ? "command" : "info";
    const replyTo = this.state.replyTo && this.state.replyTo.to === to ? this.state.replyTo.id : undefined;
    const r = await this.hub!.api.agents.send({ to, text: body, kind, media: await this.uploadAll(body), replyTo });
    if (this.state.replyTo && this.state.replyTo.to === to) this.clearReply();
    if (!r.delivered) this.note(`${to} is offline, queued until it is back`);
  }

  private async dispatch(body: string): Promise<void> {
    if (!body) return this.note("say what to do after @auto", "warn");
    const r = await this.hub!.api.agents.dispatch({ text: body, room: this.state.room, media: await this.uploadAll(body) });
    this.note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? "" : ", queued"}`);
  }

  // MARK: loops

  /// A /loop waiting for its answer to "how often?": the line, and the numbered choices.
  private loopAsk: { line: string; options: { every: string; label: string }[] } | null = null;

  /// `/loop @all send me a report every minute`: made, and the schedule shown back as the hub read
  /// it; with no schedule in the words, the hub's question with its numbered choices.
  async makeLoop(line: string, every?: string): Promise<void> {
    const r = await this.hub!.api.loops.create({ room: this.state.room, line, every, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (r.ask) {
      this.loopAsk = { line, options: r.ask.options };
      this.note(`${r.ask.text}\n${r.ask.options.map((o: { label: string }, i: number) => `${i + 1}. ${o.label}`).join("\n")}\nreply 1-${r.ask.options.length}, or put when in the line: "every 2h", "every day at 9", "hourly"`, "warn");
      return;
    }
    const l = r as Loop;
    this.setStatus(`loop set: ${l.label ?? `every ${l.every}`} → @${l.target}: ${l.prompt} · next ${when(l.next)} · /loops lists them`, "ok", 6000);
  }

  /// /loops: the room's loops in the room list's place (components/loops.tsx). Typing filters them.
  async openLoops(): Promise<void> {
    const api = this.hub!.api;
    if (!api.loops) return this.note("this hub has no loops yet: it needs a restart on the new version", "warn");
    const list: Loop[] = await api.loops.list({ room: this.state.room });
    this.set({ loops: { list, index: 0, open: null, confirm: false } });
  }

  closeLoops(): void {
    this.set({ loops: null });
  }

  /// The chosen row, as the list shows it now.
  setLoopsView(patch: Partial<LoopsView>): void {
    const v = this.state.loops;
    if (v) this.set({ loops: { ...v, ...patch } });
  }

  private replaceLoop(r: Loop): void {
    const v = this.state.loops;
    if (v) this.set({ loops: { ...v, confirm: false, list: v.list.map((x) => (x.id === r.id ? r : x)) } });
  }

  /// Inside a loop: on/off, run now, delete (the first enter asks, the second deletes).
  async loopAction(id: string, action: "toggle" | "run" | "delete"): Promise<void> {
    const v = this.state.loops;
    const l = v?.list.find((x) => x.id === id);
    if (!v || !l) return;
    const api = this.hub!.api;
    try {
      if (action === "toggle") {
        this.replaceLoop(await api.loops.toggle({ id, on: !l.on }));
        this.setStatus(`${l.on ? "off" : "on"}: ${l.label ?? `every ${l.every}`} → @${l.target}`, "ok", 2500);
      } else if (action === "run") {
        const r: Loop = await api.loops.run({ id });
        this.replaceLoop(r);
        this.setStatus(r.last?.outcome === "sent" ? `sent to ${r.last.to.join(", ")}` : `not sent: ${r.last?.why ?? r.last?.outcome}`, r.last?.outcome === "sent" ? "ok" : "warn", 3000);
      } else if (!v.confirm) {
        this.setLoopsView({ confirm: true });
      } else {
        await api.loops.delete({ id });
        const list = v.list.filter((x) => x.id !== id);
        this.set({ loops: { list, index: Math.max(0, Math.min(v.list.indexOf(l), list.length - 1)), open: null, confirm: false } });
        this.setStatus(`deleted: ${l.label ?? `every ${l.every}`} → @${l.target}`, "ok", 2500);
      }
    } catch (error) {
      this.setLoopsView({ confirm: false });
      this.setStatus((error as Error).message, "warn", 4000);
    }
  }

  /// `/name args`, also reachable from a key binding.
  async command(t: string): Promise<void> {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    // an agent's name may be written as a mention: /direct @builder
    if (NAMED.has(cmd ?? "") && rest[0]) rest[0] = rest[0].replace(/^@/, "");
    const arg = rest.join(" ");
    const api = this.hub!.api;
    switch (cmd) {
      case "help":
        this.push({ type: "help" });
        break;
      // /live: the old name, kept working
      case "live":
      case "direct": {
        const [name] = rest;
        if (!name) return this.note("usage: /direct <agent> · or @agent /direct", "warn");
        await this.startLive(name);
        break;
      }
      case "wait": {
        const [name] = rest;
        if (!name) return this.note("usage: /wait <name>", "warn");
        this.setBusy(`waiting for ${name}…`);
        const r = await api.agents.wait({ name, timeoutMs: 600_000 });
        this.note(r.timeout ? `still waiting, ${name} is ${r.status}` : `${name} is ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`, r.status === "blocked" ? "warn" : "ok");
        break;
      }
      case "alerts": {
        const [choice] = rest;
        if (choice && !["on", "off", "stuck", "done", "all"].includes(choice)) return this.note("usage: /alerts [on|off|stuck|done|all] for this room", "warn");
        if (!api.push) return this.note("this hub has no phone alerts yet", "warn");
        const r = await api.push.room({ room: this.state.room, choice });
        const word = (ev: string[]) => (!ev.length ? "off" : ev.length === 2 ? "stuck + done" : ev[0] === "done" ? "done only" : "stuck");
        const others = Object.entries(r.others as Record<string, string[]>);
        this.note(`alerts in ${r.room}: ${word(r.events)}${others.length ? ` · elsewhere: ${others.map(([room, ev]) => `${room} ${word(ev)}`).join(", ")}` : ""} · other rooms: stuck · ${r.devices} device${r.devices === 1 ? "" : "s"}${r.devices ? "" : " (turn one on: /alerts on in the web app on your phone)"}`, "ok");
        break;
      }
      case "loop": {
        if (!arg) return this.note('usage: /loop @<agent|all|any> <prompt, with when: "every 2h", "every day at 9", "hourly">', "warn");
        if (!api.loops) return this.note("this hub has no loops yet: it needs a restart on the new version", "warn");
        await this.makeLoop(arg);
        break;
      }
      case "loops":
        await this.openLoops();
        break;
      case "secrets": {
        const r = await api.room.secrets({ room: this.state.room });
        if (!r.agents.length) return this.note(`no agent in ${r.room} holds a secret · hand one over: @agent $NAME=value$ (no @: every agent online here)`, "warn");
        this.lastMessage = null;
        this.push({ type: "screen", name: "secrets", label: `🔒 secrets in ${r.room}, by name`, text: r.agents.map((a: { agent: string; names: string[]; connected: boolean }) => `${a.agent}: ${a.names.map((n) => `$${n}`).join(", ")}${a.connected ? "" : "  (offline)"}`).join("\n") });
        break;
      }
      case "pins": {
        await this.loadPins();
        const { pins } = this.state;
        if (!pins.length) return this.note(`nothing is pinned in ${this.state.room}`);
        const [n] = rest;
        if (n) {
          const m = pins[Number(n) - 1];
          if (!m) return this.note(`there are ${pins.length} pins: /pins 1-${pins.length}`, "warn");
          return this.jumpTo(m.id);
        }
        this.lastMessage = null;
        this.push({ type: "screen", name: "pins", label: `⚑ ${pins.length} pinned in ${this.state.room} · /pins <n> goes to one`, text: pins.map((m, i) => `${i + 1}. ${m.from.name} ${new Date(m.ts).toLocaleString()}${m.edited ? " · edited" : ""}\n${m.text}`).join("\n\n") });
        break;
      }
      case "history": {
        const [which] = rest;
        if (!which) return this.note("usage: /history <id>", "warn");
        await this.showVersions(which);
        break;
      }
      case "say":
        if (!arg) return this.note("usage: /say <text>", "warn");
        await api.room.say({ room: this.state.room, text: arg, media: await this.uploadAll(arg) });
        break;
      case "attach":
        // handled in the app: the token has to land in the input
        this.note("usage: /attach <path> · or paste a path, or cmd+v an image from the clipboard", "warn");
        break;
      case "save":
      case "open": {
        // `/save 2 ~/tmp`, `/save ~/tmp` or `/open`: files counted from the newest message back
        const n = /^\d+$/.test(rest[0] || "") ? Number(rest.shift()) : 1;
        const all = this.state.log.flatMap((e) => (e.type === "message" && e.msg.media ? e.msg.media : [])).reverse();
        const m = all[n - 1];
        if (!m) return this.note(all.length ? `only ${all.length} file${all.length === 1 ? "" : "s"} in view` : "no files in the room yet", "warn");
        if (cmd === "open") return this.openMedia(m);
        this.note(`saved ${await media.saveAs({ http: this.config.http, media: m, dir: rest.join(" ") || undefined })}`, "ok");
        break;
      }
      case "room":
        if (!arg) return this.note("usage: /room <name> · or ← on an empty line for the list", "warn");
        await this.switchRoom(arg);
        break;
      case "manage": {
        const names = rest.join(" ").split(/[\s,]+/).filter((n) => n && n !== "off").map((n) => n.replace(/^@/, ""));
        if (!rest.length) return this.note("usage: /manage <agent>[, <agent>] · /manage off", "warn");
        const r = await api.room.manage({ room: this.state.room, names });
        this.note(r.managers.length ? `${r.managers.join(", ")} manage ${r.room}: loops for its agents` : `${r.room} has no manager`, "ok");
        break;
      }
      case "delegate": {
        const [what, ...who] = rest;
        if (what !== "answers") return this.note("usage: /delegate answers <agent>[, <agent>] · /delegate answers off", "warn");
        const names = who.join(" ").split(/[\s,]+/).filter((n) => n && n !== "off");
        const r = await api.agents.delegate({ what, names });
        this.note(r.answers.length ? `${r.answers.join(", ")} may answer agents' folder-trust questions (nothing else)` : "only you answer agents' folder-trust questions now", "ok");
        break;
      }
      case "budget": {
        const [who, amount] = rest;
        if (!who) {
          const list: { name: string; room: string; cost: number; budget: number; paused: boolean }[] = await api.agents.budgets({});
          return this.note(list.length ? list.map((b) => `${b.name}@${b.room}  $${b.cost.toFixed(2)} of $${b.budget}${b.paused ? "  · paused" : ""}`).join("\n") + "\n/budget <agent> $<per day> · /resume <agent>" : "no agents yet", "ok");
        }
        if (!amount) return this.note("usage: /budget <agent> $<dollars a day>", "warn");
        const r = await api.agents.budget({ name: who.replace(/^@/, ""), dollars: amount });
        this.note(`${r.name}: $${r.budget} a day`, "ok");
        break;
      }
      case "resume": {
        if (!arg) return this.note("usage: /resume <agent>", "warn");
        const r = await api.agents.resume({ name: arg.replace(/^@/, "") });
        this.note(`${r.name} resumed for today${r.released ? `, ${r.released} held message(s) sent in` : ""}`, "ok");
        break;
      }
      case "start":
        return this.note(`a working team in ${this.state.room}: in another terminal, where the agents should work, run\n  metacom start --room ${this.state.room}\nit asks three questions (your business, this week's goal, how strict) and starts the team`, "ok");
      case "approvals": {
        const open: { room: string; id: string; agent: string; action: string; risk?: string }[] = await api.agents.approvals({});
        return this.note(open.length ? open.map((r) => `${r.room} · ${r.id} · ${r.agent}${r.risk && r.risk !== "outward" ? ` (${r.risk})` : ""}: ${r.action}`).join("\n") + "\n/approve <id> · /decline <id> · /approve all (a room's routine ones)" : "nothing waits for your approval", "ok");
      }
      case "approve":
      case "decline": {
        const rid = (rest[0] || "").trim();
        if (rid === "all") {
          const r = await api.agents.decideAll({ room: this.state.room, approve: cmd === "approve" });
          return this.note(r.decided.length ? `${cmd === "approve" ? "approved" : "declined"} ${r.decided.length} routine request(s) in ${this.state.room}` : `no routine requests open in ${this.state.room}`, "ok");
        }
        if (!rid) {
          const open: { id: string; agent: string; action: string }[] = await api.agents.requests({ room: this.state.room });
          return this.note(open.length ? open.map((r) => `${r.id} · ${r.agent}: ${r.action}`).join("\n") + `\n/${cmd} <id>` : `no open requests in ${this.state.room}`, "ok");
        }
        const r = await api.agents.decide({ id: rid, approve: cmd === "approve" });
        this.note(`${r.status} "${r.action}" for ${r.agent}`, "ok");
        break;
      }
      case "kill": {
        if (!arg) return this.note("usage: /kill <agent> · stops it for good, its notes first", "warn");
        const r = await api.agents.kill({ name: arg.replace(/^@/, "") });
        this.setStatus(`${r.name} is stopping: notes first, then it ends`, "ok", 6000);
        break;
      }
      case "lead": {
        if (!arg) return this.note("usage: /lead <agent> · or /lead off", "warn");
        const r = await api.room.lead({ room: this.state.room, name: arg.replace(/^@/, "") });
        this.setStatus(r.lead ? `${r.lead} is the lead here: messages to nobody in particular go to it` : "no lead here", "ok", 5000);
        break;
      }
      case "rooms":
        this.push({ type: "rooms", rooms: await api.room.list({}) });
        break;
      case "tokens":
        this.push({ type: "screen", name: "tokens", text: tokensTable(await api.admin.tokens({})) });
        break;
      case "token": {
        const [name, role, where] = rest;
        if (!name || !["agent", "member"].includes(role || "")) return this.note("usage: /token <name> agent|member [room,room] · no rooms: every room · to invite people: /invite <label>", "warn");
        const rooms = where ? where.split(",").filter(Boolean) : undefined;
        const r = await api.admin.createToken({ name, role, rooms });
        const room = r.record.rooms ? r.record.rooms[0] : "default";
        const how =
          role === "member"
            ? `give it to them with ${this.config.http.replace(/\/$/, "")}/${room} : they open it and sign in with the token and a name`
            : `on the agent's machine or container: MC_HUB_URL=${this.config.url} MC_TOKEN=<token> metacom ${room} -n <agent> claude`;
        this.push({ type: "screen", name: `token ${r.record.name}`, label: `token ${r.record.name} · only you see this`, text: `${r.token}\n\n${role}, ${r.record.rooms ? "only " + r.record.rooms.join(", ") : "every room"}. Shown once, copy it now.\n${how}` });
        break;
      }
      case "invite": {
        // /invite <label> [all | room, room | + room]: a user token (a person, and their own agents, in
        // those rooms) and its invite link, shown and copied
        const name = rest[0];
        if (!name) return this.note("usage: /invite <label> [all | room, room] · /invite <label> + room adds a room · /tokens lists them", "warn");
        const after = rest.slice(1).join(" ").trim();
        const roomsIn = (t: string) => t.split(/[\s,]+/).filter(Boolean);
        if (after.startsWith("+")) {
          const r = await api.admin.setRooms({ token: name, add: roomsIn(after.slice(1)) });
          return this.note(`${r.name} now works in ${r.rooms ? r.rooms.join(", ") : "every room"}`, "ok");
        }
        const rooms = after === "all" ? undefined : after ? roomsIn(after) : [this.state.room];
        const r = await api.admin.createToken({ name, role: "member", rooms, steer: "answer", agents: true });
        const link = `${this.state.hub.http.replace(/\/$/, "")}/${rooms ? rooms[0] : this.state.room}/invite/${r.token}`;
        // shown with the token masked (screen shares); the clipboard gets the whole link
        const shown = `${link.slice(0, link.length - r.token.length)}${r.token.slice(0, 6)}…••••…${r.token.slice(-4)}`;
        this.push({ type: "screen", name: `invite ${r.record.name}`, label: `invite ${r.record.name} · only you see this`, text: `${shown}\n\n${rooms ? rooms.join(", ") : "every room"} · a user: joins as a person, may run their own agents there · several people can share it, each under their own name.\n/tokens lists them · /revoke ${r.record.name} ends it for everyone using it` });
        this.copy(link);
        this.setStatus("Invite link copied", "ok", 4000);
        break;
      }
      case "revoke": {
        if (!arg) return this.note("usage: /revoke <token name>", "warn");
        const r = await api.admin.revokeToken({ token: arg });
        this.note(`revoked ${r.name}; ${r.closed} connection${r.closed === 1 ? "" : "s"} closed`, "ok");
        break;
      }
      case "grant":
      case "ungrant":
      case "limit": {
        const [name, where] = rest;
        if (!name || !where) return this.note(`usage: /${cmd} <token name> <room,room${cmd === "grant" ? "|all" : ""}>`, "warn");
        const rooms = where.split(",").filter(Boolean);
        const args = cmd === "grant" ? (where === "all" ? { all: true } : { add: rooms }) : cmd === "ungrant" ? { remove: rooms } : { set: rooms };
        const r = await api.admin.setRooms({ token: name, ...args });
        this.note(`${r.name} now works in ${r.rooms ? r.rooms.join(", ") : "every room"}${r.closed ? `; closed ${r.closed} connection${r.closed === 1 ? "" : "s"} elsewhere` : ""}`, "ok");
        break;
      }
      case "archive":
      case "unarchive": {
        // nothing is deleted: an archived room is read-only, its log where it was
        const room = arg || this.state.room;
        const r = await api.room[cmd]({ room });
        if (cmd === "archive") this.note(r.unchanged ? `${room} is already archived` : `archived ${room}: read-only, its log kept${r.agents?.length ? ` · told ${r.agents.join(", ")}` : ""} · /unarchive ${room} brings it back`, "ok");
        else this.note(`${room} is back from the archive`, "ok");
        break;
      }
      case "theme": {
        const result = this.onTheme(arg);
        if (result) this.note(result, arg ? "ok" : "dim");
        break;
      }
      case "clear":
        this.set({ log: [] });
        break;
      case "quit":
      case "q":
      case "exit":
        this.quit();
        break;
      default:
        this.note(`unknown command /${cmd} · /help lists them`, "warn");
    }
  }


  /// A web address from a message, opened in the browser.
  async openLink(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) return;
    if (await media.openUrl(url)) this.setStatus(`opened ${url}`, "ok", 2500);
    else {
      this.copy(url);
      this.setStatus(`no browser here · ${url} copied`, "warn", 3500);
    }
  }

  /// An attached file, saved to ~/Downloads and opened with the desktop's default app. Used by
  /// /open and by clicking the file's button under a message.
  async openMedia(m: Media): Promise<void> {
    try {
      const file = await media.saveAs({ http: this.config.http, media: m });
      if (media.openFile(file)) this.note(`opened ${file}`, "ok");
      else this.note(`saved ${file}, but could not open it here`, "warn");
    } catch (err) {
      this.note(`${m.name}: ${(err as Error).message}`, "warn");
    }
  }

  quit(): void {
    try {
      this.hub?.m.close();
    } catch {
      // already closed
    }
    this.onQuit();
  }
}
