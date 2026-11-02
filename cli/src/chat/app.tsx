import fs from "node:fs";
import { Box, type DOMElement, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ThemeProvider } from "@/providers/theme-provider";
import { useAnimation } from "@/hooks/use-animation";
import { terminalWidth } from "@/lib/terminal-text";
import type { Theme } from "@/components/ui/types";
import { Banner, Help, Rooms, Screen } from "@/chat/components/blocks";
import { Composer, INPUT_ROWS, layout, taskLineAt, toggleTaskLine } from "@/chat/components/composer";
import { CANCEL_REPLY, Footer, UNARCHIVE } from "@/chat/components/footer";
import { SPIN_INTERVAL } from "@/chat/components/glyph";
import { MessageLine, actionAt, bodyOf, type Action, type Menu, PinnedLines, shownPins } from "@/chat/components/message";
import { type Selection, isEmpty, textOf } from "@/chat/selection";
import { bodyTextLines, linkAt } from "@/chat/markdown";
import { MoreRow, Note, Rule } from "@/chat/components/note";
import { MemberPicker, RoomPicker, allItems, memberItems, pickerItems, type PickerItem } from "@/chat/components/rooms";
import { Popup, type PopupItem, type PopupState } from "@/chat/components/popup";
import { StatusBar, segments } from "@/chat/components/status-bar";
import { LIVE_LEAVE_BUTTON, LiveBar, LiveView } from "@/chat/components/live";
import { LoopPicker, loopItems } from "@/chat/components/loops";
import { liveInput, liveScrollOf } from "@/chat/live";
import { Editor } from "@/chat/editor";
import { COMMANDS, type Entry, type HubRooms, type Media, type Member, type Message, type RoomSummary, type Store } from "@/chat/store";
import { themeByName, themeNames } from "@/chat/themes";

/// Rank a candidate against what the user typed: prefix, then substring, then subsequence.
const match = (candidate: string, query: string): number => {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (c.startsWith(q)) return 1;
  if (c.includes(q)) return 2;
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
};

const EMPTY_POPUP: PopupState = { kind: null, items: [], index: 0, query: "" };

/// Enter with a modifier, in the forms that carry the modifier: the kitty protocol's CSI u and
/// xterm's modifyOtherKeys, which ink does not recognise and would type out. The number is
/// 1 + the modifier bits, shift being 1. Read from the raw bytes before ink sees them.
const MODIFIED_ENTER = /\u001b\[(?:13|10);(\d+)(?::\d+)?u|\u001b\[27;(\d+);(?:13|10)~/;

/// SGR mouse reporting (button press only) and the cursor-position report used to find where
/// the status line is on screen. Both are written by the terminal, never typed by a person.
const ALT_ON = "\u001b[?1049h\u001b[H";
const ALT_OFF = "\u001b[?1049l";
const WHEEL_LINES = 3;
/// Button presses and movement while a button is down (1002), in the SGR encoding (1006):
/// enough to follow a drag, without a report for every idle twitch of the pointer.
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";
const MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
/// Everything written by the terminal rather than typed, so ink does not put it in the message.
const REPORTS = /\u001b\[<\d+;\d+;\d+[Mm]/g;

/// Where a laid-out node sits on the screen: yoga positions are relative to the parent, so
/// add them up to the root. Zero-based.
const screenAt = (node: DOMElement | null | undefined): { left: number; top: number } => {
  let left = 0;
  let top = 0;
  for (let n = node; n?.yogaNode; n = n.parentNode) {
    left += n.yogaNode.getComputedLeft();
    top += n.yogaNode.getComputedTop();
  }
  return { left, top };
};

/// What the popup should show for the token at the cursor: members after `@`, commands
/// after a leading `/`. The selection survives while the list stays the same.
const computePopup = (editor: Editor, members: Map<string, Member>, me: string, previous: PopupState): PopupState => {
  const { start, text } = editor.token();
  let kind: PopupState["kind"] = null;
  let items: PopupItem[] = [];
  let query = "";
  if (text.startsWith("@") && !text.includes("@", 1)) {
    kind = "mention";
    query = text.slice(1);
    const all = [...members.values()].filter((m) => m.name !== me);
    items = all
      .map((m) => ({ m, rank: match(m.name, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || (a.m.connected === b.m.connected ? 0 : a.m.connected ? -1 : 1) || a.m.name.localeCompare(b.m.name))
      .map((x) => ({ label: x.m.name, insert: `@${x.m.name} `, member: x.m }));
    // "@all" at the start: every agent here, at the bottom, below everyone (enter takes the
    // highlighted one: the first name, unless you move to @all or type it in full)
    if (start === 0 && "all".startsWith(query.toLowerCase()) && !members.has("all")) items.push({ label: "all", insert: "@all ", member: { name: "all", kind: "all", room: "", connected: true } as Member });
  } else if (start > 0 && /^\/(direct|live|kill|wait)\s+$/.test(editor.text.slice(0, start)) && !text.startsWith("@")) {
    // "/direct al": the agents here, for the command's argument (no @ needed)
    kind = "mention";
    query = text;
    items = [...members.values()]
      .filter((m) => m.kind === "agent")
      .map((m) => ({ m, rank: match(m.name, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || (a.m.connected === b.m.connected ? 0 : a.m.connected ? -1 : 1) || a.m.name.localeCompare(b.m.name))
      .map((x) => ({ label: x.m.name, insert: `${x.m.name} `, member: x.m }));
  } else if (start === 0 && text.startsWith("/")) {
    kind = "command";
    query = text.slice(1);
    items = COMMANDS.map((c) => ({ c, rank: match(c.name, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((x) => ({ label: x.c.name, insert: `/${x.c.name} `, command: x.c }));
  }
  const dismissed = previous.dismissed !== undefined && previous.dismissed === text ? previous.dismissed : undefined;
  // a command typed out in full needs no list: enter should run it; so does a command's argument
  // that names an agent in full (/direct @builder)
  const exact = (kind === "command" || (kind === "mention" && editor.text.startsWith("/"))) && items.length > 0 && items[0]!.label.toLowerCase() === query.toLowerCase();
  if (!kind || items.length === 0 || dismissed !== undefined || exact) return { ...EMPTY_POPUP, dismissed };
  const same = previous.kind === kind && previous.items.map((i) => i.label).join() === items.map((i) => i.label).join();
  return { kind, items, index: same ? previous.index : 0, query };
};

/// A joined/left line. They come in runs, and a run reads as one notice, so they sit tight
/// against each other and only the last of them takes the line of air.
const isSystem = (entry?: Entry): boolean => entry?.type === "note" || (entry?.type === "message" && entry.msg.kind === "system");

/// The first line of the message a reply answers, as plain text.

/// ⋯ under this message, if it is the one open: what it offers.
/// The message you reply to or forward shows only "↩ replying" / "↪ forwarding", which cancels it.
const menuOf = (state: Store["state"], msg: Message, forwarding: string | null = null): Menu =>
  state.replyTo?.id === msg.id ? "replying" : forwarding === msg.id ? "forwarding" : state.more === msg.id ? { mine: msg.from?.name === state.me.name && msg.kind !== "control", pinned: state.pinIds.has(msg.id), edited: Boolean(msg.edited) } : null;

/// The chat keeps a gutter down its left, so nothing starts hard against the terminal edge.
const GUTTER = 2;

const EntryView = ({ entry, members, nameW, state, width, body, selection, flash, forwarding = null }: { entry: Entry; members: Map<string, Member>; nameW: number; state: Store["state"]; width: number; body: { top: number; left: number }; selection: Selection | null; flash?: string | null; forwarding?: string | null }) => {
  switch (entry.type) {
    case "banner":
      return <Banner room={state.room} url={state.url} me={state.me.name} role={state.me.role} />;
    case "message":
      return <MessageLine msg={entry.msg} grouped={entry.grouped} members={members} nameW={nameW} width={width} top={body.top} left={body.left} selection={selection} menu={menuOf(state, entry.msg, forwarding)} pinned={state.pinIds.has(entry.msg.id)} flash={flash === entry.msg.id} flagFirst={entry.card === "pin"} />;
    case "note":
      return <Note text={entry.text} tone={entry.tone} ts={entry.ts} />;
    case "rule":
      return <Rule text={entry.text} />;
    case "more":
      return <MoreRow start={entry.start} />;
    case "screen":
      return <Screen name={entry.name} text={entry.text} label={entry.label} />;
    case "rooms":
      return <Rooms rooms={entry.rooms} current={state.room} />;
    case "help":
      return <Help />;
  }
};

const Chat = ({ store, setTheme }: { store: Store; setTheme: (t: Theme) => void }) => {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { columns, rows } = useWindowSize();
  const { stdout } = useStdout();
  const { exit } = useApp();
  const editor = useRef(new Editor()).current;
  const [, bump] = useState(0);
  const redraw = useCallback(() => bump((n) => n + 1), []);
  const [popup, setPopup] = useState<PopupState>(EMPTY_POPUP);
  // The room list, in place of the conversation: ← on an empty line opens it, the input
  // filters it or names a new room, ↑↓ choose, enter or → open, esc or ← go back. While a
  // message is held for forwarding, choosing a room goes on to its members (`room` and
  // `members` set): who there gets it, or everyone.
  // `others`: the other saved hubs' rooms, listed below this hub's (not while forwarding)
  type Picker = { rooms: RoomSummary[]; others?: HubRooms[]; index: number; forward?: boolean; room?: string; members?: Member[] | null; archived?: RoomSummary[]; folder?: boolean };
  const [picker, setPicker] = useState<Picker | null>(null);
  const pickerRef = useRef(picker);
  // the input box on screen and its width, for a click on a task box in it
  const composerRef = useRef(null);
  const pinsRef = useRef<DOMElement | null>(null);
  const waitingRef = useRef<DOMElement | null>(null);
  // "2/3 waiting for reply", on the right of the line under the input: where the one offered is
  // in the queue of suggestions waiting, and how many
  const waitingText = (): string | undefined => {
    const all = store.pendingSuggestions();
    if (!all.length) return undefined;
    const s = store.state;
    const cur = s.ghost ?? (s.replyTo ? all.find((g) => g.id === s.replyTo!.id) : undefined) ?? store.pendingSuggestion();
    const at = cur ? all.findIndex((g) => g.id === cur.id) : -1;
    return `${at >= 0 ? `${at + 1}/${all.length}` : all.length} waiting for reply`;
  };
  const cancelRef = useRef<DOMElement | null>(null);
  const composerWidth = useRef(80);
  pickerRef.current = picker;
  const lastEsc = useRef(0);
  const firstSize = useRef(true);

  useEffect(() => {
    store.onBell = () => stdout.write("\u0007");
    store.onQuit = () => exit();
    store.onTheme = (name) => {
      if (!name) return `themes: ${themeNames().join(", ")}`;
      const t = themeByName(name);
      if (!t) return `no theme called ${name} · ${themeNames().join(", ")}`;
      setTheme(t);
      return `theme: ${t.name}`;
    };
  }, [store, stdout, exit, setTheme]);

  // A resize reflows the scrollback unpredictably; clear and draw the recent log again.
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    // the window re-wraps itself; just clear what the old size left behind
    stdout.write("\u001B[2J\u001B[H");
    redraw();
  }, [columns, rows, stdout, redraw]);

  const refresh = useCallback(() => {
    // in the room list the input is a room name, not a message: no @ or / popup
    setPopup((p) => (pickerRef.current || store.state.loops ? EMPTY_POPUP : computePopup(editor, store.state.members, store.state.me.name, p)));
    redraw();
  }, [editor, store, redraw]);

  const submit = useCallback(() => {
    // a message held for forwarding: the line names who it goes to, the rest rides along
    const held = forwardRef.current;
    if (held) {
      const m = editor.text.trim().match(/^@?([^\s]+)\s*([\s\S]*)$/);
      if (!m) return;
      setForward(null);
      forwardRef.current = null;
      store.setStatus(null);
      void store.forward(held, m[1]!, m[2]!.trim());
      editor.set("");
      setPopup(EMPTY_POPUP);
      toBottom();
      return redraw();
    }
    // /attach <path> [path…] puts the files' tokens into the input instead of sending anything
    const attach = editor.text.match(/^\/attach\s+(.+)$/s);
    if (attach) {
      const token = store.attachPasted(attach[1]!.trim()) ?? store.attach(attach[1]!.trim());
      editor.set(token ? token + " " : "");
      setPopup(EMPTY_POPUP);
      return refresh();
    }
    const text = editor.submit();
    setPopup(EMPTY_POPUP);
    toBottom();
    redraw();
    void store.submit(text).then((ok) => {
      // a refused message with files comes back into the input, so the tokens are not lost
      if (ok || editor.text || store.pending(text).length === 0) return;
      editor.set(text);
      refresh();
    });
  }, [editor, store, redraw, refresh]);

  // shift+enter inserts a newline instead of sending; cmd+enter and the rest send. The raw
  // listener runs before ink's, so `handled` tells the key handler below to let that Enter be.
  const handledEnter = useRef(false);
  // what ink will type out of a sequence it does not recognise (xterm's modifyOtherKeys), to
  // be dropped instead of landing in the message
  const swallow = useRef("");
  const popupOpen = useRef(false);
  popupOpen.current = popup.kind !== null;
  // Clicking a name on the status line or in a message header puts @name into the input.
  const mouse = state.mouse;
  const mouseRef = useRef(mouse);
  mouseRef.current = mouse;
  const clickState = useRef<{ room: string; members: Map<string, Member>; me: string; log: Entry[]; width: number }>({ room: "", members: new Map(), me: "", log: [], width: 80 });
  const shownLog = store.shown();
  clickState.current = { room: state.room, members: state.members, me: state.me.name, log: shownLog, width: columns - GUTTER };

  // MARK: the scrollback. The conversation lives in a window this draws, not in the terminal's
  // own scrollback, so the input stays pinned at the bottom while the wheel moves the history.
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  offsetRef.current = offset;
  const follow = useRef(true);
  const contentRef = useRef<DOMElement>(null);
  const viewRef = useRef<DOMElement>(null);
  const content = useBoxMetrics(contentRef);
  const view = useBoxMetrics(viewRef);
  const contentH = content.hasMeasured ? content.height : 0;
  const viewH = view.hasMeasured ? view.height : 0;
  const maxOffset = Math.max(0, contentH - viewH);
  const maxRef = useRef(0);
  maxRef.current = maxOffset;
  const scrollBy = useCallback((lines: number) => {
    setOffset((o) => {
      const next = Math.max(0, Math.min(maxRef.current, o + lines));
      follow.current = next >= maxRef.current;
      return next;
    });
  }, []);
  const toBottom = useCallback(() => {
    follow.current = true;
    setOffset(maxRef.current);
  }, []);
  // A pin clicked (or /pins n): the conversation scrolls so that message is in the middle of the
  // view, wherever it is drawn now (an edited one has moved), and its time lights up a moment.
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const id = state.jump;
    if (!id) return;
    store.doneJump();
    const i = clickState.current.log.findIndex((e) => e.type === "message" && e.msg.id === id);
    const node = contentRef.current?.childNodes[i] as DOMElement | undefined;
    const y = node?.yogaNode;
    if (i < 0 || !y) return;
    const top = y.getComputedTop();
    const h = y.getComputedHeight();
    const target = Math.max(0, Math.min(maxRef.current, Math.round(top - (viewH - h) / 2)));
    follow.current = target >= maxRef.current;
    setOffset(target);
    setFlash(id);
    // one timer: an earlier jump's, to the same message, must not put this light out early
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }, [state.jump]);
  // new lines arrive: stay at the bottom unless the reader has scrolled away from it; older ones
  // put above (load more): the reader's place kept, the offset moved by what came in
  const prevMax = useRef(maxOffset);
  const keepPlace = useRef(false);
  useEffect(() => {
    const grown = maxOffset - prevMax.current;
    prevMax.current = maxOffset;
    if (keepPlace.current) {
      keepPlace.current = false;
      if (grown > 0) setOffset((o) => o + grown);
      return;
    }
    if (follow.current) setOffset(maxOffset);
  }, [maxOffset]);
  /// The page before the oldest message shown, above it, where the reader is.
  const loadMore = useCallback(() => {
    follow.current = false;
    keepPlace.current = true;
    void store.loadMore().then((n) => {
      if (!n) keepPlace.current = false;
    });
  }, []);
  /// shift+↑: the oldest message loaded; there, more. shift+↓: the newest.
  const feedTop = useCallback(() => {
    if (offsetRef.current <= 0) return loadMore();
    follow.current = false;
    setOffset(0);
  }, [loadMore]);
  useEffect(() => {
    stdout.write(ALT_ON);
    return () => {
      stdout.write(ALT_OFF);
    };
  }, [stdout]);
  const liveRef = useRef<DOMElement>(null);
  const live = useBoxMetrics(liveRef);
  useEffect(() => {
    if (!mouse) return;
    stdout.write(MOUSE_ON);
    return () => {
      stdout.write(MOUSE_OFF);
    };
  }, [mouse, stdout]);

  // A message waiting for someone to forward it to: the next name picked is the recipient.
  const [forward, setForward] = useState<Message | null>(null);
  const forwardRef = useRef<Message | null>(null);
  forwardRef.current = forward;
  // Put @name at the start of the input, replacing whoever was addressed there.
  const address = useCallback(
    (name: string) => {
      editor.set(editor.text.replace(/^@\S*\s*/, ""));
      editor.home();
      editor.insert(`@${name} `);
      editor.end();
      refresh();
    },
    [editor, refresh]
  );

  /// Every body line on screen: its row, its left edge and its text. Read from the laid-out
  /// tree, so it is what the reader can actually see and therefore select.
  const feedLines = useCallback((): { row: number; left: number; text: string }[] => {
    const { log, width } = clickState.current;
    const content = contentRef.current;
    const out: { row: number; left: number; text: string }[] = [];
    if (!content) return out;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const body = kids[kids.length - 2];
      if (!body?.yogaNode) continue;
      const at = screenAt(body);
      bodyTextLines(bodyOf(entry.msg.text), width).forEach((text, n) => out.push({ row: at.top + n + 1, left: at.left, text }));
    }
    return out;
  }, []);

  /// Where each message's body starts on screen, so the lines can draw their own selection.
  const [bodyTops, setBodyTops] = useState<Record<string, { top: number; left: number }>>({});
  useEffect(() => {
    const content = contentRef.current;
    if (!content || pickerRef.current) return;
    const next: Record<string, { top: number; left: number }> = {};
    for (const [i, child] of content.childNodes.entries()) {
      const entry = clickState.current.log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const body = kids[kids.length - 2];
      if (body?.yogaNode) {
        const at = screenAt(body);
        next[entry.id] = { top: at.top + 1, left: at.left };
      }
    }
    setBodyTops((prev) => (Object.keys(next).every((k) => prev[k]?.top === next[k]!.top && prev[k]?.left === next[k]!.left) && Object.keys(prev).length === Object.keys(next).length ? prev : next));
  });

  /// The message whose action row was clicked, and which action. The entry's last child is
  /// that row, so the laid-out tree answers both without measuring text.
  const feedAction = useCallback((row: number, col: number): { msg: Message; action: Action; file?: Media } | undefined => {
    const { log } = clickState.current;
    const content = contentRef.current;
    if (!content) return;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      // each entry sits in its own wrapper box; the message box inside it ends with the actions
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const actions = kids[kids.length - 1];
      if (!actions?.yogaNode) continue;
      const at = screenAt(actions);
      if (at.top !== row - 1) continue;
      const hit = actionAt(col - 1 - at.left, entry.msg.media, menuOf(store.state, entry.msg, forwardRef.current?.id ?? null));
      if (hit) return { msg: entry.msg, ...hit };
    }
    return;
  }, []);

  /// A link, file or name under a click in a message body.
  const feedLink = useCallback((row: number, col: number): ({ url: string } | { file: string; media?: Media } | { name: string }) | undefined => {
    const { log, width, members, me } = clickState.current;
    const content = contentRef.current;
    if (!content) return;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const body = kids[kids.length - 2];
      if (!body?.yogaNode) continue;
      const at = screenAt(body);
      const lines = bodyTextLines(bodyOf(entry.msg.text), width);
      const n = row - 1 - at.top;
      if (n < 0 || n >= lines.length) continue;
      const files = (entry.msg.media ?? []).map((m) => m.name);
      const hit = linkAt(lines, n, col - 1 - at.left, { files, isMember: (x) => members.has(x), me, width });
      if (hit && "file" in hit) return { ...hit, media: entry.msg.media?.find((m) => m.name === hit.file) };
      return hit;
    }
    return;
  }, []);

  // A click on a sender or recipient in a message header of the feed. Each log entry is one
  // child of the content box, so the entry's header row is found from the laid-out tree.
  const feedName = useCallback((row: number, col: number): string | undefined => {
    const { log, me } = clickState.current;
    const view = viewRef.current;
    const content = contentRef.current;
    if (!view?.yogaNode || !content) return;
    const y = row - 1;
    const x = col - 1;
    const v = screenAt(view);
    if (y < v.top || y >= v.top + view.yogaNode.getComputedHeight()) return;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.grouped || entry.msg.kind === "system") continue;
      const line = child.nodeName === "ink-box" ? (child.childNodes[0] as DOMElement | undefined) : undefined;
      if (!line) continue;
      const at = screenAt(line);
      if (process.env["MC_CLICK_DEBUG"]) fs.appendFileSync(process.env["MC_CLICK_DEBUG"]!, JSON.stringify({ feedName: entry.msg.from?.name, top: at.top, left: at.left, want: y }) + "\n");
      if (at.top !== y) continue;
      const from = entry.msg.from?.name ?? "";
      const fromW = terminalWidth(from);
      const c = x - at.left;
      const name = c >= 0 && c < fromW ? from : entry.msg.to && c >= fromW + 3 && c < fromW + 3 + terminalWidth(entry.msg.to) ? entry.msg.to : undefined;
      return name && name !== me ? name : undefined;
    }
    return;
  }, []);

  /// A drag over the conversation paints a selection and puts it on the clipboard when the
  /// button comes up — the terminal cannot do it while the chat is listening for clicks, so
  /// the chat does it. A press and release in one cell is a click, not a selection.
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const dragging = useRef(false);
  // the press is remembered here as well as in state: the release arrives before React has
  // re-rendered, and reading the old state there would turn a click into a stray selection
  const anchor = useRef<{ row: number; col: number } | null>(null);
  const onPress = useCallback((row: number, col: number) => {
    dragging.current = true;
    anchor.current = { row, col };
    setSelection({ anchor: { row, col }, head: { row, col } });
  }, []);
  const onDrag = useCallback((row: number, col: number) => {
    if (!dragging.current) return;
    setSelection((s) => (s ? { ...s, head: { row, col } } : s));
  }, []);

  const onClick = useCallback(
    (row: number, col: number) => {
      if (pickerRef.current) return;
      // the action on the right of the line under the input: ✕ cancel reply, or 🗄 unarchive
      if (cancelRef.current && (store.state.replyTo || store.state.archived)) {
        const at = screenAt(cancelRef.current);
        const label = store.state.replyTo ? CANCEL_REPLY : UNARCHIVE;
        if (at.top === row - 1 && col - 1 >= at.left && col - 1 < at.left + label.length + 1) {
          if (store.state.replyTo) {
            if (store.cancelReply(editor.text).clear) editor.clear();
          } else void store.submit("/unarchive");
          return refresh();
        }
      }
      // "↑ load more" at the top of the history
      const content = contentRef.current;
      if (content) {
        for (const [i, child] of content.childNodes.entries()) {
          if (clickState.current.log[i]?.type !== "more" || clickState.current.log[i]?.type === undefined) continue;
          const at = screenAt(child as DOMElement);
          if (at.top === row - 1 && !(clickState.current.log[i] as { start: boolean }).start) return loadMore();
        }
      }
      // "n/N waiting for reply" under the input: a click switches to the next one
      if (waitingRef.current && store.pendingSuggestions().length && (() => {
        const at = screenAt(waitingRef.current!);
        return at.top === row - 1 && col - 1 >= at.left && col - 1 < at.left + (waitingText()?.length ?? 0);
      })()) {
        // switches to the next one waiting, as Tab does
        const filled = store.stepSuggestion(editor.text);
        if (filled !== null) {
          editor.set(filled);
          editor.end();
        }
        return refresh();
      }
      // a pin above the input: a click goes to that message in the conversation
      if (pinsRef.current && store.state.pins.length) {
        const box = screenAt(pinsRef.current);
        const pins = store.state.pins;
        const shown = shownPins(pins);
        const r = row - 1 - box.top - (pins.length > shown.length ? 1 : 0);
        if (row - 1 >= box.top && r < shown.length) {
          if (r >= 0) store.jumpTo(shown[r]!.id);
          return refresh();
        }
      }
      // a task box in the input: a click ticks it, or unticks it
      if (composerRef.current) {
        const box = screenAt(composerRef.current as DOMElement);
        const line = taskLineAt(editor.text, editor.cursor, composerWidth.current, row - 1 - box.top, col - 1 - box.left);
        if (line >= 0) {
          editor.set(toggleTaskLine(editor.text, line), editor.cursor);
          return refresh();
        }
      }
      const { room, members: list, me } = clickState.current;
      const act = feedAction(row, col);
      if (act) {
        const { msg, action } = act;
        // a file button: save it to ~/Downloads and hand it to the desktop
        if (action === "file" && act.file) {
          void store.openMedia(act.file);
          return refresh();
        }
        // "↩ replying" / "↪ forwarding" under the message: cancels it
        if (action === "cancel") {
          if (forwardRef.current?.id === msg.id) {
            setForward(null);
            forwardRef.current = null;
            editor.clear();
            store.setStatus("forwarding cancelled", "warn", 1500);
          } else if (store.cancelReply(editor.text).clear) editor.clear();
          return refresh();
        }
        if (action === "more") {
          store.toggleMore(msg.id);
          return refresh();
        }
        if (action === "edit") {
          // your message back in the input: enter saves it as the next version, esc leaves it
          store.startEdit(msg);
          editor.set(msg.text);
          editor.end();
          return refresh();
        }
        if (action === "versions") {
          void store.showVersions(msg.id);
          return refresh();
        }
        if (action === "pin" || action === "unpin") {
          void store.pin(msg, action === "pin");
          return refresh();
        }
        if (action === "reply") {
          // the same thing as clicking a name: address them and let you write
          const author = msg.from?.name;
          const who = author && author !== me ? author : msg.to && msg.to !== me ? msg.to : null;
          // with a suggestion for you: an empty input and the suggestion as ghost text
          if (who && store.startReply(msg, who)) editor.set("");
          else if (who) address(who);
          return refresh();
        }
        if (store.state.more) store.toggleMore(store.state.more);
        // forward: hold the message, ask who for, and send it on when the name is picked
        setForward(msg);
        editor.set("@");
        editor.end();
        store.setStatus(`forwarding ${msg.from?.name ?? "?"}'s message · pick who, or clear the @ and ← for another room · esc cancels`, "ok");
        return refresh();
      }
      // inside a message: a web address opens in the browser, a file token or file name opens
      // that attachment, a person's name goes into the input
      const link = feedLink(row, col);
      if (link) {
        // tests see what a click opened here (the status line cuts a long address at the width)
        if (process.env["MC_CLICK_DEBUG"]) fs.appendFileSync(process.env["MC_CLICK_DEBUG"]!, JSON.stringify({ opened: link }) + "\n");
        if ("url" in link) void store.openLink(link.url);
        else if ("file" in link) {
          const m = link.media;
          if (m) void store.openMedia(m);
          else store.setStatus(`${link.file} is not attached to this message`, "warn", 2500);
        } else address(link.name);
        return refresh();
      }
      const name = feedName(row, col);
      if (name) return address(name);
      const dbg = process.env["MC_CLICK_DEBUG"];
      // the status line is the first row of the live area; the terminal counts rows from 1
      const liveBox = screenAt(liveRef.current);
      const statusRow = liveBox.top + 1;
      const hit = segments(room, list, me).find((s) => col - 1 - liveBox.left >= s.start && col - 1 - liveBox.left < s.end);
      if (dbg) fs.appendFileSync(dbg, JSON.stringify({ row, col, statusRow, hit }) + "\n");
      if (!hit || row !== statusRow) return;
      address(hit.name);
    },
    [address, feedAction, feedName, editor, refresh, store]
  );

  const onRelease = useCallback(
    (row: number, col: number) => {
      dragging.current = false;
      const started = anchor.current;
      anchor.current = null;
      const moved = started && (started.row !== row || started.col !== col);
      if (!moved) {
        setSelection(null);
        return onClick(row, col);
      }
      const done: Selection = { anchor: started!, head: { row, col } };
      setSelection(done);
      const text = textOf(done, feedLines());
      if (text) store.copy(text);
    },
    [onClick, feedLines, store]
  );

  // Live mode takes the keyboard: every key goes to the agent but Esc, which leaves (live.ts says how
  // Esc reaches the agent), as a click on the bar's yellow button does. The chat's own keys and input
  // wait until you leave.
  const liveMode = useRef(state.live);
  liveMode.current = state.live;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const onLive = (seq: string): void => {
      MOUSE.lastIndex = 0;
      for (let m = MOUSE.exec(seq); m; m = MOUSE.exec(seq)) {
        const [button, col, row] = [Number(m[1]), Number(m[2]), Number(m[3])];
        // the bar is the last row of the frame, which stops one row short of the window
        if (m[4] === "M" && button === 0 && row === rowsRef.current - 1 && col > GUTTER && col <= GUTTER + LIVE_LEAVE_BUTTON.length) return void store.stopLive();
      }
      // scrolling back: shift+↑↓, shift+PgUp/PgDn, the wheel; not keys for the agent
      const back = liveScrollOf(seq, Math.max(1, (store.state.live?.rows ?? 24) - 2));
      if (back) return store.liveScrollBy(back);
      const { leave, keys } = liveInput(seq);
      if (leave) void store.stopLive();
      else if (keys) store.liveKeys(keys);
    };
    const onData = (data: Buffer | string) => {
      const seq = typeof data === "string" ? data : data.toString("utf8");
      if (liveMode.current) return onLive(seq);
      // A chunk can hold several of these (press and release together, a wheel burst): drop
      // every one of them from what ink will type, then act on the first real click or report.
      const reports = seq.match(REPORTS);
      if (reports) {
        swallow.current = reports.join("").replace(/\u001b/g, "");
        setTimeout(() => (swallow.current = ""), 0);
        MOUSE.lastIndex = 0;
        let wheel = 0;
        for (let m = MOUSE.exec(seq); m; m = MOUSE.exec(seq)) {
          const button = Number(m[1]);
          const col = Number(m[2]);
          const row = Number(m[3]);
          const pressed = m[4] === "M";
          // 64 and 65 are the wheel; 32 is movement with the left button down; 0 is that button
          if (pressed && button === 64) wheel -= WHEEL_LINES;
          else if (pressed && button === 65) wheel += WHEEL_LINES;
          else if (!mouseRef.current) continue;
          else if (pressed && button === 0) onPress(row, col);
          else if (pressed && button === 32) onDrag(row, col);
          else if (!pressed) onRelease(row, col);
        }
        if (wheel) scrollBy(wheel);
        return;
      }
      const hit = MODIFIED_ENTER.exec(seq);
      if (!hit) return;
      const shift = ((Number(hit[1] ?? hit[2]) - 1) & 1) === 1;
      // ink reads the kitty form itself; with no shift it is an ordinary enter
      if (!shift && hit[1]) return;
      handledEnter.current = true;
      swallow.current = hit[0].replace(/\u001b/g, "");
      // ink dispatches the same keypress synchronously right after this listener; the flag is
      // consumed there. Clear it on the next tick so a later plain Enter still sends.
      setTimeout(() => {
        handledEnter.current = false;
        swallow.current = "";
      }, 0);
      if (popupOpen.current) return;
      if (!shift) return submit();
      editor.insert("\n");
      refresh();
    };
    process.stdin.prependListener("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, [editor, refresh, submit, scrollBy, onPress, onDrag, onRelease]);

  // A pasted path to an image or document (a file dropped on the terminal) becomes its token.
  usePaste((text) => {
    if (liveMode.current) return; // the raw bytes, brackets and all, already went to the agent
    const token = store.attachPasted(text) ?? store.attachNamed(text);
    editor.insert(token ? token + " " : text.replace(/\r\n?/g, "\n"));
    refresh();
  });

  useInput((input, key) => {
    if (liveMode.current) return;
    const open = popup.kind !== null;
    if (key.ctrl && input === "c") {
      if (editor.text) {
        editor.clear();
        return refresh();
      }
      return store.quit();
    }
    if (key.ctrl && input === "d" && !editor.text) return store.quit();
    // The terminal keeps the mouse by default, so a drag selects text in the feed and in the
    // input as usual. One key lends it to the chat when you want to click, and takes it back.
    if (key.ctrl && input === "t") {
      store.setMouse(!store.state.mouse, true);
      return;
    }
    // cmd+v, once the terminal is told to send ^V for it, lands here too: an image on the
    // clipboard becomes an attachment, a path becomes one, anything else is pasted as text.
    if (key.ctrl && input === "v") {
      const insert = store.pasteClipboard();
      if (insert) editor.insert(insert);
      return refresh();
    }
    // /loops: in the room list's place, with its keys; enter or → opens a loop (its actions), as
    // the archived folder opens; ← or esc goes back, then closes
    if (store.state.loops) {
      const v = store.state.loops;
      const items = loopItems(v, editor.text);
      if (key.escape || (key.leftArrow && !editor.text)) {
        if (v.open) {
          const back = loopItems({ ...v, open: null }, editor.text).findIndex((i) => i.loop!.id === v.open);
          store.setLoopsView({ open: null, confirm: false, index: Math.max(0, back) });
          return;
        }
        store.closeLoops();
        editor.clear();
        return refresh();
      }
      if (key.upArrow || key.downArrow) {
        if (!items.length) return;
        store.setLoopsView({ confirm: false, index: (Math.min(v.index, items.length - 1) + (key.upArrow ? -1 : 1) + items.length) % items.length });
        return;
      }
      if (key.return || (key.rightArrow && editor.cursor >= editor.text.length)) {
        const item = items[Math.min(v.index, items.length - 1)];
        if (!item) return;
        if (!item.action) {
          editor.clear();
          store.setLoopsView({ open: item.loop!.id, index: 0, confirm: false });
          return refresh();
        }
        return void store.loopAction(item.loop!.id, item.action);
      }
      // inside a loop there is nothing to type; in the list, what is typed filters it
      if (v.open) return;
      if ((input && !key.ctrl && !key.meta) || key.backspace || key.delete) store.setLoopsView({ index: 0 });
    } else if (pickerRef.current) {
      const p = pickerRef.current;
      const items = p.room ? memberItems(p.room, p.members ?? [], editor.text) : p.forward ? pickerItems(p.rooms, editor.text, store.state.room, false) : allItems(p.rooms, p.others ?? [], editor.text, store.state.room, true, p.archived ?? [], p.folder);
      const closePicker = () => {
        setPicker(null);
        // still forwarding: back to picking someone in this room
        editor.set(forwardRef.current ? "@" : "");
        setPopup(EMPTY_POPUP);
        refresh();
      };
      // in the archived folder: Esc (or ←) goes back to the rooms
      if (p.folder && (key.escape || (key.leftArrow && !editor.text))) {
        editor.clear();
        setPicker({ ...p, folder: false, index: 0 });
        return refresh();
      }
      if (key.escape) return closePicker();
      if (key.leftArrow && !editor.text) {
        // from a room's members back to the rooms, with that room chosen
        if (p.room) {
          const back = pickerItems(p.rooms, "", store.state.room, false).findIndex((i) => i.room === p.room);
          setPicker({ rooms: p.rooms, index: Math.max(0, back), forward: true });
          return;
        }
        return closePicker();
      }
      if (key.upArrow || key.downArrow) {
        if (!items.length) return;
        setPicker({ ...p, index: (Math.min(p.index, items.length - 1) + (key.upArrow ? -1 : 1) + items.length) % items.length });
        return;
      }
      if (key.return || (key.rightArrow && editor.cursor >= editor.text.length)) {
        const item: PickerItem | undefined = items[Math.min(p.index, items.length - 1)];
        if (!item) return;
        if (item.folder) {
          editor.clear();
          setPicker({ ...p, folder: true, index: 0 });
          return refresh();
        }
        const held = forwardRef.current;
        if (held && p.room) {
          // the recipient is picked: a member, or the room itself
          setForward(null);
          forwardRef.current = null;
          store.setStatus(null);
          if (item.member) void store.forward(held, item.member.name, "", item.member);
          else void store.forwardToRoom(held, item.room);
          return closePicker();
        }
        if (held) {
          editor.clear();
          setPicker({ ...p, room: item.room, members: null, index: 0 });
          void store.membersOf(item.room).then((members) => setPicker((cur) => (cur && cur.room === item.room ? { ...cur, members } : cur)));
          return;
        }
        closePicker();
        void (item.hub ? store.switchHub(item.hub, item.room) : store.switchRoom(item.room)).then(toBottom);
        return;
      }
      // anything else edits the name; the choice goes back to the top of what matches
      if (input && !key.ctrl && !key.meta) setPicker({ ...p, index: 0 });
      if (key.backspace || key.delete) setPicker({ ...p, index: 0 });
    } else if (key.leftArrow && !editor.text && popup.kind === null) {
      const forward = Boolean(forwardRef.current);
      const others = forward ? [] : (store.config.hubs ?? []).map((hub) => ({ hub, rooms: null }));
      setPicker({ rooms: [], others, index: 0, forward });
      if (others.length) void store.otherRooms().then((list) => setPicker((cur) => (cur && !cur.forward ? { ...cur, others: list } : cur)));
      void store.rooms().then((rooms) => setPicker((cur) => (cur ? { ...cur, rooms, index: Math.max(0, pickerItems(rooms, "", store.state.room).findIndex((i) => i.room === store.state.room)) } : cur)));
      if (!forward) void store.archivedRooms().then((archived) => setPicker((cur) => (cur && !cur.forward ? { ...cur, archived } : cur)));
      return;
    }
    // a suggestion taken and not changed: Tab puts the next one in its place, shift+tab the previous
    if (!picker && key.tab && store.takenUnchanged(editor.text)) {
      editor.set(store.takeNext(key.shift ? -1 : 1));
      editor.end();
      return refresh();
    }
    // a suggested reply in the empty input: Tab takes it, Enter never sends it, typing sends it away
    if (store.ghostNow(editor.text)) {
      if (key.tab) {
        editor.set(store.takeGhost() ?? "");
        editor.end();
        // the message it answers: scrolled to and lit up, as a pin does
        if (store.state.replyTo) void store.jumpTo(store.state.replyTo.id, "reply");
        return refresh();
      }
      if (key.return && !key.shift && !key.meta) {
        store.setStatus("tab takes the suggestion, or type your own", "warn", 2500);
        return refresh();
      }
      // Esc, or ⌫ in the empty input: dismissed, and the next one waiting is offered
      if (key.escape || ((key.backspace || key.delete) && !editor.text)) {
        store.clearGhost();
        store.setStatus("dismissed: the next one waiting, if any", "ok", 1500);
        return refresh();
      }
    }
    if (key.escape && store.state.replyTo && !store.ghostNow(editor.text) && (!editor.text || store.replyingToSuggestion())) {
      if (store.cancelReply(editor.text).clear) editor.clear();
      return refresh();
    }
    if (key.escape) {
      const twice = Date.now() - lastEsc.current < 900;
      lastEsc.current = Date.now();
      if (store.state.editing) {
        store.cancelEdit();
        editor.set("");
        return refresh();
      }
      // a message held for forwarding goes first: esc puts it down
      if (forwardRef.current) {
        setForward(null);
        forwardRef.current = null;
        editor.set("");
        setPopup(EMPTY_POPUP);
        store.setStatus("forwarding cancelled", "warn", 1500);
        return refresh();
      }
      if (open) {
        setPopup({ ...EMPTY_POPUP, dismissed: editor.token().text });
        return redraw();
      }
      if (twice) editor.clear();
      return refresh();
    }
    // shift+↑↓ with nothing typed: the oldest message loaded (again: load more), the newest
    if (!picker && !editor.text && key.shift && (key.upArrow || key.downArrow) && !key.ctrl && !key.meta) {
      if (key.upArrow) feedTop();
      else toBottom();
      return;
    }
    if (key.pageUp || key.pageDown) {
      scrollBy((key.pageUp ? -1 : 1) * Math.max(1, (view.hasMeasured ? view.height : rows) - 2));
      return;
    }
    if (open && (key.upArrow || key.downArrow)) {
      const n = popup.items.length;
      setPopup({ ...popup, index: (popup.index + (key.upArrow ? -1 : 1) + n) % n });
      return;
    }
    if (open && (key.tab || key.return)) {
      const item = popup.items[popup.index];
      if (item) editor.replaceToken(item.insert);
      setPopup(EMPTY_POPUP);
      return refresh();
    }
    if (key.return && handledEnter.current) {
      handledEnter.current = false;
      return; // the raw listener above already inserted the newline
    }
    // the tail of an unrecognised modified-enter sequence, arriving as ordinary text
    if (swallow.current) {
      if (key.escape) return;
      if (input && swallow.current.startsWith(input)) {
        swallow.current = swallow.current.slice(input.length);
        return;
      }
      swallow.current = "";
    }
    // shift+enter; option+enter and ctrl+j too, for terminals that cannot report shift
    if (input === "\n" || (key.return && (key.shift || key.meta))) {
      editor.insert("\n");
      return refresh();
    }
    if (key.return) {
      if (editor.text.endsWith("\\")) {
        editor.backspace();
        editor.insert("\n");
        return refresh();
      }
      return submit();
    }
    if (key.tab) return;
    if (key.backspace) key.meta || key.ctrl ? editor.deleteWordLeft() : editor.backspace();
    else if (key.delete) editor.delete();
    else if (key.leftArrow) key.meta || key.ctrl ? editor.wordLeft() : editor.left();
    else if (key.rightArrow) key.meta || key.ctrl ? editor.wordRight() : editor.right();
    else if (key.upArrow) {
      if (!editor.vertical(-1)) editor.historyPrev();
    } else if (key.downArrow) {
      if (!editor.vertical(1)) editor.historyNext();
    } else if (key.home || (key.ctrl && input === "a")) editor.home();
    else if (key.end || (key.ctrl && input === "e")) editor.end();
    else if (key.ctrl && input === "u") editor.killToStart();
    else if (key.ctrl && input === "k") editor.killToEnd();
    else if (key.ctrl && input === "w") editor.deleteWordLeft();
    else if (key.ctrl && input === "l") {
      stdout.write("\u001B[2J\u001B[H");
      redraw();
    } else if (key.meta && input === "b") editor.wordLeft();
    else if (key.meta && input === "f") editor.wordRight();
    else if (key.meta && input === "d") editor.deleteWordRight();
    else if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;
    else if (input && !/[\u0000-\u001F\u007F]/.test(input)) editor.insert(input);
    else return;
    refresh();
  });

  const members = state.members;
  // The one spinner tick, at the root: every frame re-renders the tree down to the composer,
  // which keeps Ink placing the terminal cursor (it only does so on renders the composer joins).
  const frame = useAnimation({ intervalMs: SPIN_INTERVAL, isActive: store.working });
  const nameW = useMemo(() => Math.min(14, Math.max(6, ...[...members.values()].map((m) => terminalWidth(m.name)))), [members]);
  const width = Math.max(30, columns - GUTTER - 1);
  composerWidth.current = width;
  const footerRoom = rows - 3 - Math.min(6, editor.lines.length) - 3;
  const pending = store.pending(editor.text);
  // the room list or /loops in the conversation's place
  const overlay = Boolean(picker || state.loops);
  return (
    // One row short of the window: Ink 7.1 treats a frame that fills the screen as fullscreen,
    // drops its final newline and then miscounts by a row, so the terminal cursor lands above the
    // input and the bottom line is never cleared before a redraw.
    state.live ? (
      // live mode: the agent's screen in place of the conversation (which comes back on leaving)
      <Box flexDirection="column" width={columns} height={rows - 1} paddingLeft={GUTTER}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="column">
          <LiveView live={state.live} height={rows - 2} width={columns - GUTTER} />
        </Box>
        <LiveBar live={state.live} member={members.get(state.live.name)} width={columns - GUTTER} />
      </Box>
    ) : (
    <Box flexDirection="column" width={columns} height={rows - 1} paddingLeft={GUTTER}>
      <Box ref={viewRef} flexGrow={1} flexShrink={1} overflowY="hidden" flexDirection="column">
        {/* The conversation is pinned to the bottom of the view and scrolled back by how far the
            reader is above the end. Absolute, so its height is its entries' alone: laid out in
            the flow, a margin that took the free space (an empty log: all of it) squeezed the
            entries that arrived next to zero rows, and a margin that followed the offset fed
            back into the height it was computed from. The room list takes its place while open. */}
        <Box ref={contentRef} position="absolute" left={0} right={0} bottom={overlay ? 0 : offset - maxOffset} flexDirection="column" flexShrink={0}>
          {picker && (picker.room ? <MemberPicker room={picker.room} members={picker.members ?? null} filter={editor.text} index={picker.index} height={viewH} /> : <RoomPicker rooms={picker.rooms} others={picker.forward ? [] : picker.others} hub={state.hub} filter={editor.text} index={picker.index} current={state.room} height={viewH} archived={picker.forward ? [] : picker.archived ?? []} folder={picker.folder} />)}
          {!picker && state.loops && <LoopPicker view={state.loops} filter={editor.text} room={state.room} height={viewH} />}
          {/* one box per entry, so a click can be traced back to its entry */}
          {!overlay && shownLog.map((entry, i) => (
            // a message ends with a line of air, so the action row does not touch what follows;
            // a joined/left line only when the next line is not another one of them
            <Box key={entry.id} flexDirection="column" flexShrink={0} marginBottom={(entry.type === "message" || entry.type === "note") && !(isSystem(entry) && isSystem(shownLog[i + 1])) ? 1 : 0}>
              <EntryView entry={entry} members={members} nameW={nameW} state={state} width={columns - GUTTER} body={bodyTops[entry.id] ?? { top: -1000, left: 0 }} selection={selection} flash={flash} forwarding={forward?.id ?? null} />
            </Box>
          ))}
        </Box>
      </Box>
      {!overlay && state.pins.length > 0 && <PinnedLines boxRef={pinsRef} pins={state.pins} width={columns - GUTTER} />}
      <Box ref={liveRef} flexDirection="column" flexShrink={0}>
        {/* the member line belongs to the room you are in; the room list stands on its own */}
        {!overlay && <StatusBar room={state.room} members={members} me={state.me.name} url={state.url} frame={frame} mouse={state.mouse} />}
        {popup.kind && <Popup popup={popup} room={footerRoom} />}
        <Composer boxRef={composerRef} hint={!overlay && store.ghostNow(editor.text) ? " · tab" : undefined} after={!overlay && store.takenUnchanged(editor.text) ? (store.pendingSuggestions().length > 1 ? "  · enter sends · tab next" : "  · enter sends") : undefined} text={editor.text} cursor={editor.cursor} width={width} placeholder={state.loops ? (state.loops.open ? "↑↓ enter · ← or esc back" : "filter · ↑↓ enter · esc back") : !picker && state.archived ? `${state.room} is archived · read-only${state.me.role === "owner" ? " · /unarchive" : ""}` : !picker && store.ghostNow(editor.text) ? store.ghostNow(editor.text)!.shown : state.replyTo && !picker ? `reply to ${state.replyTo.to}` : picker ? (picker.room ? "filter · ↑↓ enter sends · ← rooms" : picker.forward ? "filter · ↑↓ enter · esc back" : "filter or new room · ↑↓ enter · esc back") : `message ${state.room} · @ for agents · / for commands · ← rooms`} tokens={pending.map((a) => a.token)} origin={live.hasMeasured ? { left: live.left, top: live.top } : undefined} me={state.me.name} />
        <Footer text={editor.text} busy={state.busy} status={state.status} members={members} room={state.room} attachments={pending.length} frame={frame} waiting={overlay ? undefined : waitingText()} waitingRef={waitingRef} action={overlay ? undefined : state.replyTo ? CANCEL_REPLY : state.archived && state.me.role === "owner" ? UNARCHIVE : undefined} cancelRef={cancelRef} />
      </Box>
    </Box>
    )
  );
};

export const App = ({ store, theme }: { store: Store; theme: Theme }) => {
  const [current, setCurrent] = useState(theme);
  return (
    <ThemeProvider theme={current}>
      <Chat store={store} setTheme={setCurrent} />
    </ThemeProvider>
  );
};
