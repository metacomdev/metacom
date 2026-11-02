'use strict';

// The terminal chat (cli/src/chat) for a browser, line for line, as Preact components written
// with htm (vendor/htm-preact.umd.js, no build): one component per piece of the terminal —
// Banner, MessageView, StatusBar, Popup, Composer, Footer, RoomPicker — over one small store.
// Where the terminal needs a key, a tap does the same here: names, ↩ and ↪ under a message, a
// room in the list, and on a phone the rooms button under the input.

const { html, render, useEffect, useLayoutEffect, useReducer, useRef, useState } = window.htmPreact;

// MARK: hub. A metacom client small enough to live here: calls get callbacks by id, events go
// to listeners by "unit/name". Reconnects and signs in again when the socket drops.

class Hub {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.calls = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.onOpen = async () => {};
    this.onState = () => {};
  }

  on(event, fn) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), fn]);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = async () => {
        try {
          const me = await this.call('auth/signin', { token: this.token });
          await this.onOpen(me);
          this.onState(true);
          resolve(me);
        } catch (error) {
          reject(error);
        }
      };
      ws.onmessage = ({ data }) => {
        let packet = null;
        try {
          packet = JSON.parse(data);
        } catch {
          return;
        }
        if (packet.type === 'callback') {
          const pending = this.calls.get(packet.id);
          if (!pending) return;
          this.calls.delete(packet.id);
          if (packet.error) pending.reject(new Error(packet.error.message));
          else pending.resolve(packet.result);
        } else if (packet.type === 'event') {
          for (const fn of this.listeners.get(packet.name) || []) fn(packet.data);
        }
      };
      ws.onclose = () => {
        this.onState(false);
        for (const p of this.calls.values()) p.reject(new Error('disconnected'));
        this.calls.clear();
        if (this.token) setTimeout(() => this.connect().catch(() => {}), 2000);
      };
      ws.onerror = () => {};
    });
  }

  call(method, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('not connected'));
      const id = crypto.randomUUID();
      this.calls.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'call', id, method, args }));
      setTimeout(() => {
        if (!this.calls.has(id)) return;
        this.calls.delete(id);
        reject(new Error('timeout'));
      }, 20000);
    });
  }
}

// MARK: store. Everything on screen comes from here; components re-render when it changes.

const saved = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode
    }
  },
};

// Pictures and videos shown in the feed, or only their ↗ links: per room on this device, "*" for
// the rest (/preview on|off [all])
const previews = () => {
  try {
    return JSON.parse(saved.get('tui.previews') || '{}');
  } catch {
    return {};
  }
};
// what this device chose, room then all rooms, else the hub's default (/preview off hub)
const previewOn = (room) => {
  const p = previews();
  return room in p ? p[room] : '*' in p ? p['*'] : S.hubPreviews !== false;
};

// A room has an address of its own, /sales or /dev: open one by its link, go back and forth
// between rooms with the browser's back and forward.
const ROOM_RE = /^[\w][\w.-]{0,63}$/;
function pathRoom() {
  const p = decodeURIComponent(location.pathname.slice(1));
  return ROOM_RE.test(p) ? p : null;
}
// An invite link, /<room>/invite/<token>: the token is taken out of the address at once (history,
// screenshots), kept in memory until the person signs in with a name, then saved like any sign-in.
const INVITE = (() => {
  const m = /^\/([\w][\w.-]{0,63})\/invite\/([\w-]{16,128})\/?$/.exec(location.pathname);
  if (!m) return null;
  history.replaceState({ room: m[1] }, '', '/' + encodeURIComponent(m[1]));
  return { room: m[1], token: m[2] };
})();
/// A token as the screen shows it: its first 6 and last 4 characters. The whole one is only ever in
/// memory and in what a copy button puts on the clipboard, never in the page's text or attributes,
/// so a screenshot or a shared screen does not give it away.
const masked = (token) => `${token.slice(0, 6)}…••••…${token.slice(-4)}`;
/// The three steps that bring a person's own agent into the room, with this hub and token filled in:
/// [what, the command to copy, the command to show].
const agentSteps = (token, room, name) => {
  const hubUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const join = `metacom ${room} -n ${name || '<you>'}claude claude`;
  return [
    ['install metacom', 'curl -fsSL https://metacom.dev/install.sh | sh'],
    ['sign in to this hub', `metacom connect ${hubUrl} ${token}`, `metacom connect ${hubUrl} ${masked(token)}`],
    ['your agent joins, in your project folder', join],
  ];
};
/// Joining over the API with the same token (README "Over the API"): HTTPS calls with it as a
/// Bearer token, or a WebSocket that signs in with it. [what, the text copied, the text shown].
const apiSteps = (token, room, name) => {
  const ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';
  const api = `${location.origin}/api`;
  const who = name || 'you';
  const both = (fn) => [fn(token), fn(masked(token))];
  return [
    ['HTTPS: POST /api/<unit>/<method>, a JSON body, the token as Bearer', `${api}/room/history`],
    ['read the room', ...both((t) => `curl -s ${api}/room/history -H "Authorization: Bearer ${t}" -H "Content-Type: application/json" -d '{"room":"${room}","limit":20}'`)],
    ['post to it', ...both((t) => `curl -s ${api}/room/say -H "Authorization: Bearer ${t}" -H "Content-Type: application/json" -d '{"room":"${room}","text":"hello from the API"}'`)],
    [
      `WebSocket: ${ws}, live (Node 22+ or a browser)`,
      ...both(
        (t) => `const ws = new WebSocket('${ws}');
let n = 0;
const wait = new Map();
const call = (method, args) => new Promise((done) => { const id = String(++n); wait.set(id, done); ws.send(JSON.stringify({ type: 'call', id, method, args })); });
ws.onmessage = ({ data }) => { const p = JSON.parse(data); if (p.type === 'callback') wait.get(p.id)?.(p); else console.log(p.name, p.data); };
ws.onopen = async () => {
  await call('auth/signin', { token: '${t}' });
  await call('agents/register', { name: '${who}', room: '${room}', kind: 'human' });
  await call('room/say', { room: '${room}', text: 'hello from the API' });
};`,
      ),
    ],
  ];
};
const copyText = (text, what) => navigator.clipboard?.writeText(text).then(() => setStatus(`${what} copied`, 'ok', 3000), () => setStatus('copy did not work here; long-press to select', 'warn', 4000));
const showRoom = (room, replace = false) => {
  if (pathRoom() === room) return;
  history[replace ? 'replaceState' : 'pushState']({ room }, '', '/' + encodeURIComponent(room));
};

const S = {
  hub: null,
  signedIn: false,
  loginError: '',
  me: { name: '', role: '?' },
  hubPreviews: true, // the hub's default for pictures and videos in the feed (/preview off hub)
  // the room in the address (/sales) wins; else the last one open on this device
  room: pathRoom() || saved.get('tui.room') || 'dev',
  draft: '', // what was being typed before ↑ went into what was sent
  all: [], // every member, every room
  members: new Map(), // this room's
  log: [], // what the conversation shows
  rooms: [],
  picker: null, // { index } while the room list is open
  popup: { kind: null, items: [], index: 0 },
  forward: null, // a message held to forward
  files: [], // { token, file, name }
  text: '',
  caret: null, // where to put the caret after the text was set from code
  history: [],
  historyAt: -1,
  status: null,
  busy: null,
  frame: 0,
  live: null, // live mode: { name, cols, rows, cursor, lines, ready } (docs/direct.md)
  loops: null, // /loops open, in the room list's place: { room, list, index, open: a loop's id (its actions), confirm }
};
const listeners = new Set();
const set = (patch = {}) => {
  Object.assign(S, patch);
  for (const fn of listeners) fn();
};
const useStore = () => {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);
  return S;
};

let seq = 0;
const lastMessage = { current: null };
const push = (entry) => {
  const log = [...S.log, { ...entry, id: `e${++seq}` }];
  set({ log: log.length > 500 ? log.slice(-400) : log });
};

// MARK: small things

/// "14:52" today; "yesterday 14:52", "12 Oct 14:52" (and the year, if not this one) before.
const time = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(d)) / 86400000);
  if (ago <= 0) return hm;
  if (ago === 1) return `yesterday ${hm}`;
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}${year} ${hm}`;
};
const stateOf = (m) => (!m.connected ? 'offline' : m.status === 'working' ? 'working' : 'online');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Name colours: the hub's index into this palette (hub/lib/colors.js), the chat's order; a name
// the hub has not coloured falls back to its hash over the first ten, as the chat does.
const PALETTE = ['#61AFEF', '#E88F4C', '#98C379', '#C678DD', '#56B6C2', '#E5C07B', '#E06C75', '#7DC8A0', '#BEA0E6', '#DCA08C', '#FF79C6', '#8BE9FD', '#F1FA8C', '#4EC9B0', '#FFB86C', '#A6ACEC', '#D7875F', '#B5CEA8', '#FF6E6E', '#87AFFF'];
const hash = (s) => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};
const nameColor = (name) => {
  const key = String(name).toLowerCase();
  // the room's own first: cmo here and cmo in another room are two agents
  const m = [...S.members.values(), ...S.all].find((x) => x.name.toLowerCase() === key);
  return PALETTE[m && typeof m.color === 'number' ? m.color % PALETTE.length : hash(key) % 10];
};

// MARK: markdown, as the chat reads it (cli/src/chat/markdown.ts)

const CODE = /`([^`\n]+)`/;
const BOLD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/;
const ITALIC = /(?:^|(?<=[^\w*]))\*([^*\n]+)\*(?![\w*])|(?:^|(?<=[^\w_]))_([^_\n]+)_(?![\w_])/;
const LINKS = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]|\[[^[\]\n]{1,120}\.[a-z0-9]{1,6}\]|@[a-z0-9][a-z0-9._-]*[a-z0-9]|@[a-z0-9]/gi;

const styled = (style) => [style.bold ? 'b' : '', style.muted ? 'muted' : ''].filter(Boolean).join(' ');

/// Inline marks: `code`, **bold**, *italic*, then what a tap acts on — a web address, a
/// "[file]" the message carries, an @name of someone here.
const inline = (text, msg, style = {}) => {
  const code = CODE.exec(text);
  if (code) return [...inline(text.slice(0, code.index), msg, style), html`<span class="code">${code[1]}</span>`, ...inline(text.slice(code.index + code[0].length), msg, style)];
  const bold = BOLD.exec(text);
  if (bold) return [...inline(text.slice(0, bold.index), msg, style), ...inline(bold[1] ?? bold[2], msg, { ...style, bold: true }), ...inline(text.slice(bold.index + bold[0].length), msg, style)];
  const italic = ITALIC.exec(text);
  if (italic) {
    const body = italic[1] ?? italic[2];
    const at = text.indexOf(body, italic.index) - 1;
    return [...inline(text.slice(0, at), msg, style), ...inline(body, msg, { ...style, italic: true }), ...inline(text.slice(at + body.length + 2), msg, style)];
  }
  const cls = styled(style);
  const st = style.italic ? 'font-style: italic' : '';
  const files = new Map((msg.media || []).map((f) => [f.name, f]));
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LINKS)) {
    const word = m[0];
    let node = null;
    if (/^https?:/i.test(word)) node = html`<a class="link" href=${word} target="_blank" rel="noopener">${word}</a>`;
    else if (word.startsWith('[')) {
      const f = files.get(word.slice(1, -1));
      if (f) node = html`<a class="link" href=${f.url} target="_blank" rel="noopener">${word}</a>`;
    } else {
      const name = word.slice(1);
      if (S.all.some((x) => x.name === name)) node = html`<button type="button" class="mention" style=${{ color: nameColor(name) }} onClick=${() => name !== S.me.name && address(name)}>${word}</button>`;
    }
    if (!node) continue;
    out.push(html`<span class=${cls} style=${st}>${text.slice(last, m.index)}</span>`, node);
    last = m.index + word.length;
  }
  out.push(html`<span class=${cls} style=${st}>${text.slice(last)}</span>`);
  return out;
};

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
/// A task line: `- [ ] …` or `- [x] …`.
const TASK = /^(\s*)(?:([-*+]) )?\[( |x|X)\](?: (.*))?$/;

const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/// A message body: a list keeps its hanging indent, code its colour, a quote its bar.
// MARK: tables (GFM): a header row, a |---|--:| row, then rows; a row whose first cell is **bold**
// and the rest empty is a band across the table (a section, as on a Blue Sheet)
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/// The tables in a message's lines: start line → { head, align, body, end }.
const tablesIn = (rows) => {
  const out = new Map();
  let fenced = false;
  for (let i = 0; i < rows.length; i++) {
    if (FENCE.test(rows[i])) fenced = !fenced;
    if (fenced || !TABLE_ROW.test(rows[i]) || !TABLE_SEP.test(rows[i + 1] || '')) continue;
    const align = cellsOf(rows[i + 1]).map((a) => (a.startsWith(':') && a.endsWith(':') ? 'center' : a.endsWith(':') ? 'right' : 'left'));
    let j = i + 2;
    const body = [];
    while (j < rows.length && TABLE_ROW.test(rows[j])) body.push(cellsOf(rows[j++]));
    out.set(i, { head: cellsOf(rows[i]), align, body, end: j });
    i = j - 1;
  }
  return out;
};

const isBand = (row) => /^\*\*.+\*\*$/.test(row[0] || '') && row.slice(1).every((c) => !c);
const NEGATIVE = /^\s*[-−]\s*\d/;

const Table = ({ t, msg }) => {
  const n = t.head.length;
  // a cell's own lines (<br>), each with the message's inline styles: **bold**, `code`, links
  const cell = (txt) => txt.split(/<br\s*\/?>/i).flatMap((part, k) => (k ? [html`<br />`, ...inline(part, msg)] : inline(part, msg)));
  const cls = (c, v) => [t.align[c] === 'right' && 'num', t.align[c] === 'right' && NEGATIVE.test(v) && 'neg', !v && 'blank'].filter(Boolean).join(' ');
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="table">
    <table class="md">
      <thead>
        <tr>${t.head.map((h, c) => html`<th class=${cls(c, '')} style=${{ textAlign: t.align[c] }}>${cell(h)}</th>`)}</tr>
      </thead>
      <tbody>
        ${t.body.map((r) => {
          const row = [...r, ...Array(Math.max(0, n - r.length)).fill('')].slice(0, n);
          if (isBand(row)) return html`<tr class="band"><td colspan=${n}>${cell(row[0])}</td></tr>`;
          return html`<tr>${row.map((v, c) => html`<td class=${cls(c, v)} style=${{ textAlign: t.align[c] }}>${cell(v)}</td>`)}</tr>`;
        })}
      </tbody>
    </table>
  </div>`;
};

const Body = ({ text, msg, control }) => {
  const lines = [];
  let fenced = false;
  const rows = text.split('\n');
  const tables = tablesIn(rows);
  let skip = -1;
  rows.forEach((raw, i) => {
    if (i < skip) return;
    if (tables.has(i)) {
      const t = tables.get(i);
      skip = t.end;
      lines.push(html`<${Table} key=${i} t=${t} msg=${msg} />`);
      return;
    }
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    const hang = (lead, kids, cls = '') => html`<div key=${i} class="line hang ${cls}" style=${{ '--hang': `${lead.length}ch` }}>${kids}</div>`;
    if (fenced) lines.push(html`<div key=${i} class="line" style="white-space: pre; overflow-x: auto"><span class="code">${'  ' + raw.replace(/\t/g, '  ')}</span></div>`);
    else if (raw.trim() === '') lines.push(html`<div key=${i} class="line"></div>`);
    else if (RULE.test(raw)) lines.push(html`<div key=${i} class="line"><span class="rule">${'─'.repeat(40)}</span></div>`);
    else if (HEADING.test(raw)) lines.push(html`<div key=${i} class="line">${inline(HEADING.exec(raw)[2], msg, { bold: true })}</div>`);
    else if (QUOTE.test(raw)) {
      const q = QUOTE.exec(raw);
      const lead = `${q[1]}│ `;
      lines.push(hang(lead, [html`<span class="quote">${lead}</span>`, ...inline(q[2], msg, { muted: true })]));
    } else if (TASK.test(raw)) {
      const [, pad, , box, rest = ''] = TASK.exec(raw);
      const done = box !== ' ';
      const lead = `${pad}${done ? '[x]' : '[ ]'} `;
      const boxEl = html`<span class="task-box">${done ? '[x]' : '[ ]'}</span>`;
      lines.push(hang(lead, [html`<span>${pad}</span>`, boxEl, html`<span> </span>`, html`<span class=${done ? 'task-done' : ''}>${inline(rest, msg)}</span>`]));
    } else if (ORDERED.test(raw) || BULLET.test(raw)) {
      const [, pad, mark, rest] = ORDERED.exec(raw) || BULLET.exec(raw);
      const ordered = /^\d/.test(mark);
      const lead = `${pad}${ordered ? mark : '·'} `;
      lines.push(hang(lead, [html`<span class=${ordered ? '' : 'bullet'}>${lead}</span>`, ...inline(rest, msg)]));
    } else {
      const pad = /^\s*/.exec(raw)[0];
      lines.push(pad ? hang(pad, [html`<span>${pad}</span>`, ...inline(raw.slice(pad.length), msg)]) : html`<div key=${i} class="line">${inline(raw, msg)}</div>`);
    }
  });
  return html`<div class="body ${control ? 'accent' : ''}">${lines}</div>`;
};

// MARK: the conversation

const Name = ({ name }) => html`<button type="button" class="name" style=${{ color: nameColor(name) }} onClick=${() => name !== S.me.name && address(name)}>${name}</button>`;

const FORWARDED = /^\[forwarded from ([^\]]+)\]\s*/;

const Banner = () => html`<div class="entry banner">
  <div><span class="b primary">metacom</span><span class="muted"> · </span><span class="b">${S.room}</span><span class="muted"> at ${location.host} as </span><${Name} name=${S.me.name} /><span class="muted"> (${S.me.role}) · web</span></div>
  <span class="muted">@Name to address an agent · / for commands · /help for keys</span>
</div>`;

/// "edited" opens the earlier versions under the message, and closes them again.
const toggleVersions = async (id) => {
  const open = { ...(S.versions || {}) };
  if (open[id]) delete open[id];
  else {
    try {
      open[id] = (await S.hub.call('room/versions', { id })).versions;
    } catch (error) {
      return note(error.message, 'error');
    }
  }
  set({ versions: open });
};

const Edited = ({ msg }) => (msg.edited ? html`<span class="edited">edited</span>` : null);
/// A hub loop's fire (lib/loops.js): which schedule sent it.
const LoopTag = ({ msg }) => (msg.loop ? html`<span class="muted" title="sent by a hub loop · /loops">  ↻ ${msg.loop.label || `every ${msg.loop.every}`}</span>` : null);

const Versions = ({ msg }) => {
  const list = S.versions?.[msg.id];
  if (!list) return null;
  return html`<div class="versions">
    ${list.map((v) => html`<div class="version"><div class="muted">v${v.rev}${v.rev === list.length ? ' (shown)' : ''} · ${time(v.ts)}</div><div class="vtext">${v.text}</div></div>`)}
  </div>`;
};

// MARK: ⋯ under a message: edit (your own) and pin

const mine = (msg) => msg.from?.name === S.me.name && msg.kind !== 'system' && msg.kind !== 'control';

const More = ({ msg }) => {
  const pinned = S.pinIds?.has(msg.id);
  return html`<span class="more-items">
    <button type="button" onClick=${() => (set({ more: null }), startForward(msg))}>↪ forward</button>
    ${mine(msg) && html`<button type="button" onClick=${() => startEdit(msg)}>✎ edit</button>`}
    ${msg.edited && html`<button type="button" onClick=${() => (set({ more: null }), toggleVersions(msg.id))}>≡ ${S.versions?.[msg.id] ? 'hide versions' : 'versions'}</button>`}
    <button type="button" onClick=${() => pinMessage(msg, !pinned)}>${pinned ? '⚐ unpin' : '⚑ pin'}</button>
  </span>`;
};

/// Your message back in the input; enter saves it as its next version, esc leaves it as it was.
const startEdit = (msg) => {
  set({ editing: msg, more: null });
  setText(msg.text);
  focusInput();
  setStatus(`editing your message · enter saves it · esc cancels`, 'ok');
};

const pinMessage = async (msg, on) => {
  set({ more: null });
  try {
    const r = await S.hub.call('room/pin', { id: msg.id, on });
    setStatus(`${on ? 'pinned' : 'unpinned'} · ${r.count} pinned in ${S.room}`, 'ok', 2500);
  } catch (error) {
    failure(error);
  }
};

const setPins = (pins) => set({ pins, pinIds: new Set(pins.map((m) => m.id)), pinsAll: pins.length > 3 ? S.pinsAll : false });

const loadPins = async () => {
  try {
    setPins((await S.hub.call('room/pins', { room: S.room })).pins);
  } catch {
    setPins([]);
  }
};

/// To a message in the conversation (a pin, a suggestion), scrolled to and lit up. One older than
/// what the feed shows is fetched alone (room/message) and put at the top of the feed, as the
/// oldest message there, with a "…" line under it for the history skipped: a message like any
/// other (a pin with ⚑ before its sender), with its ⋯ and reply. It stays until the room is
/// opened again; the history in between is never loaded.
let jumps = 0; // a jump that fetches gives way to any asked for while it fetched
const jumpTo = async (m, kind = 'pin') => {
  const mine = ++jumps;
  let el = document.getElementById(`m-${m.id}`);
  if (!el) {
    let msg;
    try {
      msg = await S.hub.call('room/message', { room: S.room, id: m.id });
    } catch {
      return note(`that message is no longer in the room: ${m.from?.name ?? '?'}: ${firstLine(m.text || '')}`, 'warn');
    }
    if (mine !== jumps) return;
    if (!(S.cards || []).some((c) => c.msg.id === msg.id)) set({ cards: [...(S.cards || []), { msg, kind }].sort((a, b) => a.msg.ts.localeCompare(b.msg.ts)) });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    el = document.getElementById(`m-${m.id}`);
    if (!el || mine !== jumps) return;
  }
  // one step, exactly: the feed's own scroll set so the message sits in its middle (a smooth
  // scrollIntoView stopped part of the way on iPhone, so a tap went only some of the way there)
  feedStick.current = false;
  const feed = document.getElementById('feed');
  const r = el.getBoundingClientRect();
  const f = feed.getBoundingClientRect();
  feed.scrollTop += r.top - f.top - Math.max(0, (f.height - r.height) / 2);
  set({ flash: m.id });
  // one timer: an earlier jump's, to the same message, must not put this light out early
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => set({ flash: null }), 1600);
};
let flashTimer = null;

/// An older message fetched alone, at the top of the feed (see jumpTo). It looks like any message
/// (a pin: ⚑ before its sender) and is an old one: outside the conversation's log, so no "now"
/// line, count, alert or suggestion queue takes it for the newest.
const Card = ({ card }) => html`<div class="card"><${MessageView} msg=${card.msg} grouped=${false} flagFirst=${card.kind === 'pin'} /></div>`;

/// The pinned messages, above the input: newest nearest it, each cut to two lines. A click (one tap)
/// on one scrolls the conversation to the message, where it is now (after an edit too), and lights
/// it up. Unpinning is in the message's own ⋯. More than three: the three newest and "N more".
/// A pin shows the message's first line only, as plain text: no **, __, `, # or > marks, no pipes.
const firstLine = (text) =>
  (text.split('\n').find((l) => l.trim()) || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(#{1,6}\s+|>\s?)/, '')
    .replace(/^\s*\||\|\s*$/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .trim();

const PinView = ({ m }) => {
  const go = () => jumpTo(m);
  return html`<div class="pin" id=${`p-${m.id}`}>
    <div class="pintext" role="button" tabindex="0" title="go to it in the conversation" onClick=${go} onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go())}><span class="pinmark">⚑</span> <span class="b" style=${{ color: nameColor(m.from?.name ?? '?') }}>${m.from?.name ?? '?'}</span> <span class="muted">${time(m.ts)}${m.edited ? ' · edited' : ''}</span>  ${firstLine(m.text)}</div>
  </div>`;
};

const Pins = () => {
  const s = useStore();
  const pins = s.pins || [];
  // always there, hidden while nothing is pinned: an element that appears later lands at the end
  if (!pins.length) return html`<div class="pins" hidden></div>`;
  const newestLast = [...pins].reverse();
  const shown = s.pinsAll ? newestLast : newestLast.slice(-3);
  const hidden = newestLast.length - shown.length;
  return html`<div class="pins" aria-label="pinned messages">
    ${hidden > 0 && html`<button type="button" class="pinsmore" onClick=${() => set({ pinsAll: true })}>⚑ ${hidden} more pinned</button>`}
    ${s.pinsAll && newestLast.length > 3 && html`<button type="button" class="pinsmore" onClick=${() => set({ pinsAll: false })}>⚑ show the 3 newest only</button>`}
    ${shown.map((m) => html`<${PinView} key=${m.id} m=${m} />`)}
  </div>`;
};

// /start: three questions, then the one command that starts a company team on a machine (the hub
// starts nothing itself). The teams and their goal questions are the CLI's company templates
// (cli/templates; a test keeps these in step).
const TEAMS = {"agency": "What should the agency make this week, and for whom?", "content-studio": "What is the brand, who reads it, and what should this week's content achieve?", "dev-studio": "What are we building or fixing this week, in which repository?", "sales-desk": "What do you sell, to whom, and how many new conversations do you want this week?", "tender-office": "What does your organisation do, and which kind of tenders or grants should we look for this week?"};
const TEAM_WORDS = [
  ['tender-office', /\b(tenders?|grants?|bids?|procurement|rfps?|calls? for)\b/i],
  ['sales-desk', /\b(sales?|sell|selling|leads?|outreach|prospects?|pipeline|b2b)\b/i],
  ['agency', /\b(agency|campaigns?|clients?|marketing|brand(ing)?|creative|ads?)\b/i],
  ['content-studio', /\b(content|blog|newsletter|social|posts?|videos?|podcast|media|publish)\b/i],
  ['dev-studio', /\b(software|apps?|code|saas|website|api|repo|developers?|engineering)\b/i],
];
const teamFor = (business) => (TEAM_WORDS.find(([, re]) => re.test(business)) || ['dev-studio'])[0];
const quoted = (s) => `"${String(s).replace(/["\\$`]/g, '\\$&')}"`;
const startStep = (answer) => {
  const w = S.wizard;
  if (w.step === 1) {
    const team = TEAMS[answer.toLowerCase()] ? answer.toLowerCase() : teamFor(answer);
    S.wizard = { step: 2, business: answer, team };
    return note(`2/3 ${TEAMS[team]}  (team: ${team}; others: ${Object.keys(TEAMS).filter((n) => n !== team).join(', ')}: type one to switch)`, 'ok');
  }
  if (w.step === 2) {
    if (TEAMS[answer.toLowerCase()]) {
      S.wizard = { ...w, team: answer.toLowerCase() };
      return note(`2/3 ${TEAMS[S.wizard.team]}  (team: ${S.wizard.team})`, 'ok');
    }
    S.wizard = { ...w, step: 3, goal: answer };
    return note('3/3 How strict? light, standard or strict', 'ok');
  }
  const rigor = ['light', 'standard', 'strict'].includes(answer.toLowerCase()) ? answer.toLowerCase() : 'standard';
  S.wizard = null;
  const cmd = `metacom start --template ${w.team} --business ${quoted(w.business)} --goal ${quoted(w.goal)} --rigor ${rigor} --room ${S.room}`;
  return push({ type: 'block', block: html`<div><span class="muted">── start a ${w.team} team in ${S.room} ──</span><div class="screen">
    <div>Run this on the machine where the agents should work (signed in to this hub with <span class="b">metacom connect</span>):</div>
    <div class="tokenlink">${cmd}</div>
    <div><button type="button" class="copylink" onClick=${() => copyText(cmd, 'command')}>copy</button></div>
    <div class="muted">it starts the team, makes its lead the manager, sets budgets (${rigor}) and loops, and the lead posts the first plan here</div>
  </div></div>` });
};

// an agent's request for an outward action: the owner approves or declines it here (only the hub
// owner can; the hub refuses anyone else), and it shows how it was decided
const decide = (rid, approve) => S.hub.call('agents/decide', { id: rid, approve }).catch(failure);
const routineOpen = (r) => (r.risk === 'routine' ? S.log.filter((e) => e.type === 'message' && e.msg.request?.risk === 'routine' && e.msg.request.status === 'open' && e.msg.request.room === r.room).length : 0);
const RequestView = ({ msg }) => {
  const r = msg.request;
  const open = r.status === 'open';
  return html`<div class="entry request" id=${`m-${msg.id}`}>
    <div class="head"><${Name} name=${msg.from?.name ?? '?'} /><span class="muted">${`  asks the owner · ${time(msg.ts)} · request ${r.id}`}</span></div>
    <div class="b">⏵ ${r.action}${r.risk && r.risk !== 'outward' ? html` <span class=${r.risk === 'irreversible' ? 'warn' : 'muted'}>· ${r.risk}</span>` : ''}</div>
    ${r.detail && html`<div class="muted">${r.detail}</div>`}
    <div class="actions">${
      open && S.me.role === 'owner'
        ? html`<button type="button" class="approve" onClick=${() => decide(r.id, true)}>✓ approve</button><button type="button" class="decline" onClick=${() => decide(r.id, false)}>✕ decline</button>${routineOpen(r) > 1 && html`<button type="button" class="approveall" onClick=${() => S.hub.call('agents/decideAll', { room: r.room, approve: true }).catch(failure)}>✓ approve all ${routineOpen(r)} routine</button>`}`
        : html`<span class=${r.status === 'approved' ? 'success' : 'muted'}>${open ? 'waiting for the owner' : `${r.status}${r.by ? ` by ${r.by}` : ''}`}</span>`
    }</div>
  </div>`;
};

const MessageView = ({ msg, grouped, tight, flagFirst = false }) => {
  if (msg.kind === 'system') return html`<div class="entry system muted">· ${msg.text}  ${time(msg.ts)}</div>`;
  if (msg.kind === 'request' && msg.request) return html`<${RequestView} msg=${msg} />`;
  const from = msg.from?.name ?? '?';
  const control = msg.kind === 'control';
  const forwarded = FORWARDED.exec(msg.text);
  const reply = () => {
    const who = from !== S.me.name ? from : msg.to && msg.to !== S.me.name ? msg.to : null;
    if (!who) return;
    if (msg.suggest) return startSuggested(msg, who);
    set({ replyTo: { id: msg.id, to: who }, ghost: null });
    address(who);
  };
  const pinned = S.pinIds?.has(msg.id);
  // the message you are replying to (or forwarding) stays marked while you write, its actions
  // only that: "↩ replying" ("↪ forwarding"), which cancels it
  const answering = S.replyTo?.id === msg.id;
  const forwarding = S.forward?.id === msg.id;
  return html`<div class=${`entry message${S.editing?.id === msg.id ? ' editing' : ''}${S.flash === msg.id ? ' flash' : ''}${answering || forwarding ? ' replying' : ''}`} id=${`m-${msg.id}`} style=${tight ? 'margin-bottom: 0' : ''}>
    ${!grouped &&
    html`<div class="head">
      ${pinned && flagFirst && html`<span class="pinmark first" title="pinned">⚑</span>`}
      <${Name} name=${from} />
      ${msg.to && html`<span class="arrow" style=${{ color: control ? 'var(--accent)' : msg.kind === 'info' ? 'var(--muted)' : 'var(--fg)' }}>${control ? '⌘' : '→'}</span><${Name} name=${msg.to} />`}
      <span class="muted">${`  ${time(msg.ts)}${forwarded ? `  [forwarded from ${forwarded[1]}]` : ''}`}</span>
      <${Edited} msg=${msg} />
      <${LoopTag} msg=${msg} />
      ${pinned && !flagFirst && html`<span class="pinmark" title="pinned">⚑</span>`}
    </div>`}
    <${Body} text=${msg.text.replace(FORWARDED, '')} msg=${msg} control=${control} />
    <${Versions} msg=${msg} />
    ${previewOn(msg.room || S.room) && (msg.media || []).filter((f) => PICTURE.test(f.type)).map((f) => html`<a class="picture" href=${f.url} target="_blank" rel="noopener" title=${`${f.name} · open full size`}><img src=${f.url} alt=${f.name} loading="lazy" onLoad=${keepEnd} /></a>`)}
    ${previewOn(msg.room || S.room) && (msg.media || []).filter((f) => PLAYABLE.test(f.type)).map((f) => html`<video class="video" src=${f.url} controls playsinline preload="metadata" onLoadedMetadata=${keepEnd}></video>`)}
    ${answering || forwarding
      ? html`<div class="actions">
          <button type="button" class="answering" title="cancel" onMouseDown=${(e) => e.preventDefault()} onClick=${answering ? cancelReply : cancelForward}>${answering ? '↩ replying' : '↪ forwarding'}</button>
        </div>`
      : html`<div class="actions">
      <button type="button" onClick=${reply}>↩ reply</button>
      <button type="button" class="more" title="more" aria-label="more actions" aria-expanded=${S.more === msg.id} onClick=${() => set({ more: S.more === msg.id ? null : msg.id })}>⋯</button>
      ${S.more === msg.id && html`<${More} msg=${msg} />`}
      ${grouped && html`<${Edited} msg=${msg} />`}
      ${(msg.media || []).map((f) => html`<a href=${f.url} target="_blank" rel="noopener" class="file" title=${f.name}>↗ ${f.name.length > 32 ? f.name.slice(0, 31) + '…' : f.name}</a>`)}
    </div>`}
  </div>`;
};

// what browsers play themselves; .mkv, .avi and the rest stay links to download
const PLAYABLE = /^video\/(mp4|x-m4v|quicktime|webm)$/;
/// Pictures shown in the message itself (a tap opens the full size): an attachment is easy to miss
/// as a link at the end of the row, as people new to the chat found.
const PICTURE = /^image\/(png|jpeg|gif|webp|avif)$/;
/// A picture or video got its size after the feed was laid out: at the end, stay at the end.
const keepEnd = () => {
  const f = document.getElementById('feed');
  if (f && feedStick.current) f.scrollTop = f.scrollHeight;
};

const Note = ({ text, tone, ts }) => html`<div class="entry system muted"><span style=${{ color: tone === 'error' ? 'var(--error)' : 'var(--warning)' }}>·</span> ${text}  ${time(ts)}</div>`;

const Block = ({ block }) => html`<div class="entry block">${block}</div>`;

/// A loop's next or last run as people read it: "14:00", "tomorrow 09:00", "Mon 19 Oct 09:00".
const runAt = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
};
const lastRun = (l) => {
  if (!l.last) return 'not run yet';
  const at = runAt(l.last.at);
  if (l.last.outcome === 'sent') return `${at} sent to ${l.last.to.join(', ')}${l.last.why ? ` (${l.last.why})` : ''}`;
  if (l.last.outcome === 'waiting') return `${at} waiting for an idle agent`;
  return `${at} skipped: ${l.last.why || '?'}`;
};

/// The feed as drawn: older messages fetched alone first (under the banner, oldest first), a "…"
/// line for the history skipped, then the log.
const feedEntries = (s) => {
  const cards = s.cards || [];
  const head = s.log[0]?.type === 'banner' ? [s.log[0]] : [];
  // "load more" (or "start of room") at the top of the loaded history
  const more = s.log.some((e) => e.type === 'message') ? [{ type: 'more', id: 'more' }] : [];
  if (!cards.length) return [...head, ...more, ...s.log.slice(head.length)];
  return [...head, ...cards.map((card) => ({ type: 'card', id: `card-${card.msg.id}`, card })), { type: 'gap', id: 'gap' }, ...more, ...s.log.slice(head.length)];
};

// whether the feed follows new messages to its end; a jump to a pinned message turns it off
const feedStick = { current: true };

const Feed = () => {
  const s = useStore();
  const ref = useRef(null);
  const stick = feedStick;
  // before the browser paints: at the end when a room was just opened, or when the reader was
  // already there — so a room appears at its end, never scrolling down into view
  useLayoutEffect(() => {
    const f = ref.current;
    if (!f) return;
    // older messages put above: the reader's place kept
    if (S.keepScroll) {
      const el = document.getElementById(S.keepScroll.id);
      if (el) f.scrollTop += el.getBoundingClientRect().top - f.getBoundingClientRect().top - S.keepScroll.at;
      S.keepScroll = null;
      return;
    }
    const opened = S.scrollEnd;
    if (opened) {
      S.scrollEnd = false;
      stick.current = true;
    }
    if (!stick.current) return;
    f.scrollTop = f.scrollHeight;
    // and again once the layout has settled: the first frame and the web font can still change
    // how tall the conversation is
    if (opened) {
      requestAnimationFrame(() => stick.current && (f.scrollTop = f.scrollHeight));
      document.fonts?.ready.then(() => stick.current && (f.scrollTop = f.scrollHeight));
    }
  });
  const onScroll = () => {
    const f = ref.current;
    stick.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
  };
  return html`<div id="feed" ref=${ref} onScroll=${onScroll}>
    <div class="spacer"></div>
    ${feedEntries(s).map((e, i, all) => {
      const next = all[i + 1];
      if (e.type === 'card') return html`<${Card} key=${e.id} card=${e.card} />`;
      if (e.type === 'gap') return html`<div key=${e.id} class="entry gap muted" title="history skipped">…</div>`;
      if (e.type === 'more') return html`<${LoadMore} key=${e.id} />`;
      if (e.type === 'banner') return html`<${Banner} key=${e.id} />`;
      if (e.type === 'message') return html`<${MessageView} key=${e.id} msg=${e.msg} grouped=${e.grouped} tight=${next && next.type === 'message' && next.grouped} />`;
      if (e.type === 'note') return html`<${Note} key=${e.id} ...${e} />`;
      if (e.type === 'rule') return html`<div key=${e.id} class="entry rule-now">${'─'.repeat(24)} now</div>`;
      return html`<${Block} key=${e.id} block=${e.block} />`;
    })}
  </div>`;
};

// A night of dropped connections: "X left" then "X joined" within ten minutes is not a
// departure; what is left of a run keeps each person's last line (as the chat does).
const JOIN_LEFT = /^(\S+) (left|joined)(?: from .*)?$/;
const foldReconnects = (list) => {
  const drop = new Set();
  const open = new Map();
  for (const m of list) {
    const hit = m.kind === 'system' && JOIN_LEFT.exec(m.text);
    if (!hit) continue;
    const left = open.get(hit[1]);
    if (hit[2] === 'left') open.set(hit[1], m);
    else if (left && Date.parse(m.ts) - Date.parse(left.ts) < 600000) {
      drop.add(left.id);
      drop.add(m.id);
      open.delete(hit[1]);
    }
  }
  const out = [];
  let run = [];
  const flush = () => {
    const lastOf = new Map(run.map((m) => [JOIN_LEFT.exec(m.text)[1], m]));
    out.push(...run.filter((m) => lastOf.get(JOIN_LEFT.exec(m.text)[1]) === m));
    run = [];
  };
  for (const m of list) {
    if (drop.has(m.id)) continue;
    if (m.kind === 'system' && JOIN_LEFT.test(m.text)) run.push(m);
    else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
};

// Consecutive messages from one sender within two minutes drop the repeated time and name.
const grouped = (m) => {
  if (m.kind === 'system') {
    lastMessage.current = null;
    return false;
  }
  const from = m.from?.name ?? '?';
  const ts = Date.parse(m.ts);
  const last = lastMessage.current;
  const g = Boolean(last && !m.edited && last.name === from && !m.to && !last.to && ts - last.ts < 120000);
  lastMessage.current = { name: from, ts, to: m.to };
  return g;
};
const pushMessage = (m) => push({ type: 'message', msg: m, grouped: grouped(m) });

/// The messages of this room since the newest one shown, said while the connection was down (or
/// while a phone kept the page asleep), in order, none twice.
const catchUp = async () => {
  if (!S.hub || !S.signedIn) return;
  const room = S.room;
  const shown = S.log.filter((e) => e.type === 'message');
  const newest = shown.reduce((t, e) => (e.msg.ts > t ? e.msg.ts : t), '');
  if (!newest) return;
  const have = new Set(shown.map((e) => e.msg.id));
  const missed = await S.hub.call('room/history', { room, since: newest, limit: 500 }).catch(() => []);
  if (S.room !== room) return;
  let any = false;
  for (const m of missed) {
    if (have.has(m.id) || (m.room && m.room !== room)) continue;
    pushMessage(m);
    any = true;
  }
  if (any) markRead();
};

const note = (text, tone = 'warn') => {
  // warnings and errors stay in the conversation; the rest is said under the input a moment
  if (tone !== 'warn' && tone !== 'error') return setStatus(text, tone === 'dim' ? 'plain' : tone, 4000);
  lastMessage.current = null;
  push({ type: 'note', text, tone, ts: new Date().toISOString() });
};

/// A room's conversation, built whole: banner, the last 30 real messages, the "now" rule.
/// When a message stands in the feed: an edited one where its last edit was made.
const when = (m) => m.edited || m.ts;

/// The grouping again, top to bottom, after a message left its place.
const regroup = (log) => {
  lastMessage.current = null;
  return log.map((e) => {
    if (e.type === 'message') return { ...e, grouped: grouped(e.msg) };
    if (e.type === 'note' || e.type === 'block') lastMessage.current = null;
    return e;
  });
};

/// A room's history in the order the feed shows it: an edited message stands where it was last
/// edited, not where it was first posted.
const ordered = (history) =>
  foldReconnects(history)
    .map((m, i) => [m, i])
    .sort((a, b) => (when(a[0]) < when(b[0]) ? -1 : when(a[0]) > when(b[0]) ? 1 : a[1] - b[1]))
    .map(([m]) => m);

/// The conversation from the last 30 messages, or (`from`, a message id) from just before that one.
/// What was fetched and is not shown waits for "load more" (S.back).
const conversation = (history, from = null) => {
  lastMessage.current = null;
  const all = ordered(history);
  const at = from ? all.findIndex((m) => m.id === from) : -1;
  const list = at >= 0 ? all.slice(Math.max(0, at - 2)) : all.slice(-30);
  S.back = { hidden: all.slice(0, all.length - list.length), oldest: history[0]?.id || null, start: !from && history.length < HISTORY_PAGE };
  const entries = [{ type: 'banner' }, ...list.map((m) => ({ type: 'message', msg: m, grouped: grouped(m) })), ...(list.length ? [{ type: 'rule' }] : [])];
  return entries.map((e) => ({ ...e, id: `e${++seq}` }));
};

// MARK: further back. Shift+↑ (input empty, or the focus elsewhere) goes to the oldest message
// loaded, and again there loads more, as the "↑ load more" row at the top of the history does: first what was
// fetched and not shown, then pages from the hub, the reader's place kept. Shift+↓: the newest.
const HISTORY_PAGE = 300;
const MORE_PAGE = 50;
let loadingMore = false;
const loadMore = async () => {
  const b = S.back;
  if (loadingMore || !b) return;
  let older;
  if (b.hidden.length) {
    older = b.hidden.slice(-MORE_PAGE);
    S.back = { ...b, hidden: b.hidden.slice(0, b.hidden.length - older.length) };
  } else if (!b.start && b.oldest) {
    loadingMore = true;
    set({ moreBusy: true });
    try {
      const page = await S.hub.call('room/history', { room: S.room, before: b.oldest, limit: MORE_PAGE });
      older = ordered(page);
      S.back = { hidden: [], oldest: page[0]?.id || b.oldest, start: page.length < MORE_PAGE };
    } catch (error) {
      return failure(error);
    } finally {
      loadingMore = false;
      set({ moreBusy: false });
    }
  } else return;
  const have = new Set(S.log.filter((e) => e.type === 'message').map((e) => e.msg.id));
  older = older.filter((m) => !have.has(m.id));
  const feed = document.getElementById('feed');
  // the reader stays where they were: the first message in view stays exactly there (its own
  // header may go, grouped with the older ones now above it), the older above it
  const fr = feed && feed.getBoundingClientRect();
  const first = feed && [...feed.querySelectorAll('[id^="m-"]')].find((el) => el.getBoundingClientRect().bottom > fr.top);
  S.keepScroll = first ? { id: first.id, at: first.getBoundingClientRect().top - fr.top } : null;
  feedStick.current = false;
  const head = S.log[0]?.type === 'banner' ? [S.log[0]] : [];
  const ids = new Set(older.map((m) => m.id));
  const log = regroup([...head, ...older.map((m) => ({ type: 'message', msg: m, id: `e${++seq}` })), ...S.log.slice(head.length)]);
  set({ log, back: S.back, cards: (S.cards || []).filter((c) => !ids.has(c.msg.id)) });
};
const feedTop = () => {
  const f = document.getElementById('feed');
  if (!f) return;
  if (f.scrollTop <= 4) return void loadMore();
  feedStick.current = false;
  f.scrollTop = 0;
};
const feedEnd = () => {
  const f = document.getElementById('feed');
  if (!f) return;
  feedStick.current = true;
  f.scrollTop = f.scrollHeight;
};
/// shift+↑ / shift+↓ for the feed; says whether it was one
const feedKey = (e) => {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'ArrowUp') return (e.preventDefault(), feedTop(), true);
  if (e.key === 'ArrowDown') return (e.preventDefault(), feedEnd(), true);
  return false;
};
const atStart = (s) => Boolean(s.back) && !s.back.hidden.length && s.back.start;
const LoadMore = () => {
  const s = useStore();
  return html`<div class="loadmore">${atStart(s) ? html`<span class="muted">start of room</span>` : html`<button type="button" disabled=${Boolean(s.moreBusy)} onMouseDown=${(e) => e.preventDefault()} onClick=${() => loadMore()}>${s.moreBusy ? 'loading…' : isTouch() ? '↑ load more' : '↑ load more · shift+↑'}</button>`}</div>`;
};

// The room's history, fetched before anything changes on screen, then shown in one step and at
// its end: no empty feed, no messages arriving one by one, no scrolling down into view.
const load = async () => {
  const history = await S.hub.call('room/history', { room: S.room, limit: HISTORY_PAGE });
  set({ log: conversation(history), scrollEnd: true, editing: null, more: null, cards: [] });
  loadPins();
  loadWaiting();
  markRead();
};

let readTimer = null;
const markRead = () => {
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    S.hub.call('room/read', { room: S.room }).catch(() => {});
  }, 1000);
};

// MARK: the line above the input

const StatusBar = () => {
  const s = useStore();
  const list = [...s.members.values()]
    .filter((m) => m.name !== s.me.name && m.connected)
    .sort((a, b) => (stateOf(a) === 'working' ? 0 : 1) - (stateOf(b) === 'working' ? 0 : 1) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || a.name.localeCompare(b.name));
  return html`<div id="status">
    <span class="who">
      ${!list.length && html`<span class="muted">nobody else here</span>`}
      ${list.map((m) => {
        const st = stateOf(m);
        const glyph = m.kind === 'human' ? '◆' : st === 'working' ? SPIN[s.frame % SPIN.length] : '●';
        return html`<button key=${m.name} type="button" onClick=${() => address(m.name)}><span style="color: var(--success)">${glyph}</span> <span style=${{ color: nameColor(m.name) }}>${m.name}</span>${m.owner && html`<span class="muted"> · ${m.owner}</span>`}${st === 'working' && html`<span class="muted"> working</span>`}</button>`;
      })}
    </span>
    <span class="me">${s.me.name} · <span class="room">${s.room}</span></span>
  </div>`;
};
setInterval(() => {
  if ([...S.members.values()].some((m) => m.connected && m.status === 'working') || S.busy) set({ frame: S.frame + 1 });
}, 80);
// a suggestion past its time leaves the queue (and the counter) even with nothing else happening
setInterval(() => set({ minute: Date.now() }), 60000);

// MARK: the hint under the input

let statusTimer = null;
const setStatus = (text, tone = 'ok', ms = 0) => {
  clearTimeout(statusTimer);
  set({ status: text ? { text, tone } : null });
  if (text && ms) statusTimer = setTimeout(() => set({ status: null }), ms);
};
const setBusy = (busy) => set({ busy });

const CONTROL = /^!(?:(?:stop|type)\b|\/)/;
/// Keyboard help (keys, what enter does): not on a touch screen, which has no such keys and no
/// width for it. What happened, what is awaited, and warnings show everywhere.
const help = (text) => (isTouch() ? ['muted', ''] : ['muted', text]);
const hintOf = (s) => {
  if (s.status) {
    const t = s.status.tone;
    return [t === 'warn' ? 'warning' : t === 'error' ? 'error' : t === 'plain' ? 'muted' : 'success', s.status.text];
  }
  if (s.busy) return ['', html`<span class="primary">${SPIN[s.frame % SPIN.length]}</span> ${s.busy}`];
  if (s.picker) return help('filter or new room · ↑↓ enter · esc back');
  const text = s.text;
  const pending = s.files.filter((f) => text.includes(f.token)).length;
  const files = pending ? ` with ${pending} file${pending > 1 ? 's' : ''}` : '';
  if (!text) return help('@ to address an agent · / for commands · shift+enter new line · /help');
  const mentions = [...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2].replace(/[.,:;!?]+$/, ''));
  const head = mentions.find((n) => s.members.has(n)) ?? (text.startsWith('@') ? mentions[0] : undefined);
  if (head) {
    const m = s.members.get(head);
    if (!m) return ['', html`<span class="warning">nobody called ${head} is in this room</span><span class="muted"> · /say to post it anyway</span>`];
    return help(m.kind === 'agent' ? `enter types this${files} into ${m.name}${m.connected ? '' : ' when it comes back'}` : `enter sends this${files} to ${m.name} directly`);
  }
  if (text.startsWith('/')) return help('enter runs the command');
  if (CONTROL.test(text)) return ['warning', 'control commands go to an agent: @Alex !/compact'];
  return help(`enter posts to ${s.room}${files}`);
};

/// ✕ cancel reply (and Esc with nothing typed): no reply target, and the suggestion it came with
/// is not offered again at once. A suggestion taken and not changed goes from the input; what you
/// typed stays.
const cancelReply = () => {
  const id = S.replyTo?.id;
  const skipped = S.skipped || [];
  // a suggestion taken: dismissed for good, and its text goes from the input
  const taken = replyingToSuggestion();
  if (taken) {
    if (takenUnchanged()) setText('');
    set({ replyTo: null });
    dismissSuggestion(taken.id);
    focusInput();
    return setStatus('suggestion dismissed', 'ok', 1500);
  }
  if (takenUnchanged()) setText('');
  set({ replyTo: null, ghost: null, picked: null, skipped: id && !skipped.includes(id) ? [...skipped, id] : skipped });
  focusInput();
  setStatus('reply cancelled', 'ok', 1500);
};

// the paperclip under the input, one outline drawing on every screen (the 📎 emoji differs by system)
const CLIP = html`<svg class="clip" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>`;

const Footer = () => {
  const s = useStore();
  const [cls, hint] = hintOf(s);
  // a phone has no Esc: while you reply, a button on the right of this row cancels it. Pressing it
  // keeps the focus (and the phone's keyboard) in the input.
  const keep = (e) => e.preventDefault();
  // a mouse: the press keeps the focus, the click cancels. A finger: done when it lifts, and that
  // touch kept from turning into the click (and the focus move) a phone makes of it, since the
  // button is gone by then and the click would land on the row behind it
  const lift = (e) => {
    e.preventDefault();
    cancelReply();
  };
  return html`<div id="footer">
    <button id="roomsBtn" type="button" onMouseDown=${keep} onClick=${() => (S.loops ? closeLoops() : S.picker ? closePicker() : openPicker())}>${s.picker || s.loops ? '× close' : '← rooms'}</button>
    <span id="hint" class=${cls}>${hint}</span>
    <${Waiting} />
    ${!s.picker && !s.loops && !s.archived && !s.replyTo && html`<button id="attachBtn" type="button" aria-label="attach a file" title="attach a file (or paste, or drop one)" onMouseDown=${keep} onClick=${pickFiles}>${CLIP}</button>`}
    ${s.archived && !s.picker && !s.loops && !s.replyTo && s.me.role === 'owner' && html`<button id="unarchive" type="button" onMouseDown=${keep} onClick=${() => command('/unarchive').catch(failure)}>🗄 unarchive</button>`}
    ${s.replyTo && !s.picker && !s.loops && html`<button id="cancelReply" type="button" onMouseDown=${keep} onTouchEnd=${lift} onClick=${cancelReply}>${isTouch() ? '✕ cancel' : html`✕ cancel reply<span class="muted"> · esc</span>`}</button>`}
  </div>`;
};

// MARK: the input and the list over it

const COMMANDS = [
  { name: 'loop', args: '@<agent|all|any> <prompt + when>', help: "the hub sends the prompt on a schedule, whatever the agent's session does; when is in the words: every minute, every 2h, hourly, every day at 9, every weekday at 9:30; @any = the first idle agent" },
  { name: 'invite', args: '<label> [all | room, room | + room]', help: 'a link that lets people (and their own agents) into this room, or those rooms; copied for you to send (owner)' },
  { name: 'kill', args: '<agent>', help: 'stop an agent for good, its notes first (the hub owner: any agent; a user: its own)' },
  { name: 'lead', args: '<agent>|off', help: "the room's lead: every message from a person here that names no one goes to that agent too (owner)" },
  { name: 'loops', args: '', help: "the room's loops: turn one on or off, run it now, or delete it" },
  { name: 'wait', args: '<name>', help: 'block until the agent is idle or needs you' },
  { name: 'direct', args: '<agent>', help: "an agent's own terminal here: its screen, your keys to it; esc or the yellow button leaves, ctrl+esc sends esc to it (the hub owner, or the agent's owner) · also @agent /direct" },
  { name: 'say', args: '<text>', help: 'post to the room even if it starts with @ or /' },
  { name: 'attach', args: '', help: 'put a file into the message (or paste, or drop one)' },
  { name: 'rooms', args: '', help: 'all rooms with counts (or ← on an empty line)' },
  { name: 'room', args: '<name>', help: 'open another room, creating it if it is new' },
  { name: 'archive', args: '[room]', help: 'archive a room (owner): read-only and out of the list; nothing is deleted' },
  { name: 'unarchive', args: '[room]', help: 'bring an archived room back (owner)' },
  { name: 'tokens', args: '', help: 'every token: role, rooms, online now, agents running (owner)' },
  { name: 'token', args: '<name> agent|member [room,..]', help: 'issue a raw token, shown once (owner); to invite people: /invite' },
  { name: 'revoke', args: '<name>', help: 'revoke a token and close its connections (owner)' },
  { name: 'grant', args: '<name> <room,..|all>', help: 'let a token into more rooms, or every room (owner)' },
  { name: 'ungrant', args: '<name> <room,..>', help: 'take rooms from a token (owner)' },
  { name: 'limit', args: '<name> <room,..>', help: "set a token's rooms exactly (owner)" },
  { name: 'alerts', args: '[on|off|stuck|done|all|test|stop]', help: 'phone alerts for this room: stuck (the default), done, all or off; on also turns this device on; stop takes this device off' },
  { name: 'secrets', args: '', help: 'who holds which secrets, by name (hand one over: @agent $NAME=value$; no @: every agent online here)' },
  { name: 'manage', args: '<agent>|off', help: "this room's manager: an agent that may set, pause and delete loops for any agent here (owner)" },
  { name: 'delegate', args: 'answers <agent>|off', help: "let named agents answer other agents' folder-trust questions for you (nothing else: not tool permissions, logins or approvals) (owner)" },
  { name: 'budget', args: '[agent $/day]', help: "each agent's spend today and its daily budget ($30 unless set); at 80% the room is told, at 100% it pauses until /resume (owner)" },
  { name: 'resume', args: '<agent>', help: 'lift a budget pause for the rest of the day; what it was sent goes in (owner)' },
  { name: 'start', args: '', help: 'a working team in this room: three questions (your business, this week\'s goal, how strict), then the one command to run where the agents should work' },
  { name: 'approvals', args: '', help: 'every request waiting for your approval, in every room (owner)' },
  { name: 'approve', args: '[id|all]', help: "approve an agent's request for an outward action (push, deploy, publish, restart): it is typed into the agent as your word (owner); no id lists the open ones" },
  { name: 'decline', args: '[id]', help: "decline an agent's request (owner)" },
  { name: 'preview', args: '[on|off] [all|hub]', help: 'pictures and videos in the feed, or only their ↗ links: this room, or every room with all (this device); hub: the default for everyone on this hub (owner)' },
  { name: 'clear', args: '', help: 'clear the screen' },
  { name: 'help', args: '', help: 'keys and commands' },
];

// Members after "@", commands after a leading "/" — or, while forwarding, whom to.
const computePopup = (text, caret) => {
  const upto = text.slice(0, caret);
  if (S.forward) {
    const q = text.replace(/^@/, '').toLowerCase();
    return { kind: 'mention', items: [...S.members.values()].filter((m) => m.name !== S.me.name && m.name.toLowerCase().includes(q)).map((m) => ({ label: m.name, member: m })) };
  }
  const at = /(^|\s)@([^\s]*)$/.exec(upto);
  if (at) {
    const q = at[2].toLowerCase();
    const items = [...S.members.values()]
      .filter((m) => m.name !== S.me.name && m.name.toLowerCase().includes(q))
      .sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? -1 : 1) || a.name.localeCompare(b.name))
      .map((m) => ({ label: m.name, member: m }));
    // a command's argument naming an agent in full (/direct @builder) needs no list: enter runs it
    if (text.startsWith('/') && items.length && items[0].label.toLowerCase() === q) return { kind: null, items: [] };
    // "@all" at the start: every agent here, at the bottom, below everyone (enter takes the
    // highlighted one: the first name, unless you move to @all or type it in full)
    if (!text.startsWith('/') && upto.startsWith('@') && 'all'.startsWith(q)) items.push({ label: 'all', member: { name: 'all', kind: 'all', connected: true } });
    return { kind: 'mention', items };
  }
  // "/direct al": the agents here, for the command's argument (no @ needed); a name typed in full runs it
  const arg = /^\/(direct|live|kill|wait)\s+([^\s@]*)$/.exec(upto);
  if (arg) {
    const q = arg[2].toLowerCase();
    const items = [...S.members.values()]
      .filter((m) => m.kind === 'agent' && m.name.toLowerCase().includes(q))
      .sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? -1 : 1) || a.name.localeCompare(b.name))
      .map((m) => ({ label: m.name, member: m, bare: true }));
    if (items.length && items[0].label.toLowerCase() === q) return { kind: null, items: [] };
    return { kind: 'mention', items };
  }
  const cmd = /^\/(\S*)$/.exec(upto);
  if (cmd) return { kind: 'command', items: COMMANDS.filter((c) => c.name.startsWith(cmd[1].toLowerCase())).map((c) => ({ label: c.name, command: c })) };
  return { kind: null, items: [] };
};

const Popup = () => {
  const s = useStore();
  const p = s.popup;
  if (s.picker || !p.kind || !p.items.length) return html`<div id="popup"></div>`;
  const rows = 6;
  const top = Math.max(0, Math.min(p.index - rows + 1, p.items.length - rows));
  const nameW = Math.max(6, ...p.items.map((i) => i.label.length)) + 1;
  return html`<div id="popup" class="open">
    ${p.items.slice(top, top + rows).map((item, i) => {
      const active = top + i === p.index;
      const onClick = () => {
        set({ popup: { ...S.popup, index: top + i } });
        choose();
      };
      let rest;
      if (p.kind === 'mention') {
        const m = item.member;
        const st = m.kind === 'route' ? 'the hub picks an agent' : m.kind === 'all' ? 'every agent here' : stateOf(m);
        const glyph = m.kind === 'route' || m.kind === 'all' ? '◎' : m.kind === 'human' ? (m.connected ? '◆' : '◇') : st === 'offline' ? '○' : '●';
        rest = html`<span style=${{ color: m.kind === 'route' || m.kind === 'all' ? 'var(--accent)' : st === 'offline' ? 'var(--muted)' : 'var(--success)' }}>${glyph}</span> <span class="label" style=${{ color: nameColor(m.name) }}>${('@' + item.label).padEnd(nameW)}</span> <span class="muted">${st.padEnd(9)}</span> <span class="muted">${[m.host ? '@' + m.host : '', m.repo || ''].filter(Boolean).join('  ')}</span>`;
      } else {
        const c = item.command;
        rest = html`<span class="label" style=${{ color: active ? 'var(--primary)' : 'var(--fg)' }}>${('/' + c.name).padEnd(nameW)}</span> <span class="muted">${c.args.padEnd(28)}</span> <span class="muted">${c.help}</span>`;
      }
      return html`<button key=${item.label} type="button" class="item ${active ? 'active' : ''}" onMouseDown=${(e) => e.preventDefault()} onClick=${onClick}><span class="mark">${active ? '›' : ' '}</span>${rest}</button>`;
    })}
    <span class="hint">${`  ↑↓ choose · tab inserts · esc closes${p.items.length > rows ? ` · ${p.items.length} matches` : ''}`}</span>
  </div>`;
};

/// Set the text from code (a name addressed, a choice inserted), caret where it belongs.
const setText = (text, caret = text.length) => {
  S.writeText = true;
  onText(text, caret);
  set({ caret });
};

const onText = (text, caret) => {
  if (S.picker) return set({ text, picker: { index: 0 } });
  if (S.loops) return set({ text, loops: { ...S.loops, index: 0 } });
  // your own words hide the suggestion while there are any; it is still waiting
  const next = computePopup(text, caret);
  const same = next.kind === S.popup.kind && next.items.length === S.popup.items.length;
  set({ text, popup: { ...next, index: same ? Math.min(S.popup.index, Math.max(0, next.items.length - 1)) : 0 } });
};

const address = (name) => {
  setText(`@${name} ` + S.text.replace(/^@\S*\s*/, ''));
  focusInput();
};
const focusInput = () => document.getElementById('text')?.focus();

const choose = () => {
  const p = S.popup;
  const item = p.items[p.index];
  if (!item) return;
  if (S.forward && p.kind === 'mention') {
    const held = S.forward;
    set({ forward: null });
    setText('');
    return forward(held, item.member);
  }
  const input = document.getElementById('text');
  const caret = input ? input.selectionStart : S.text.length;
  const upto = S.text.slice(0, caret);
  const rest = S.text.slice(caret);
  const insert = item.bare ? `${item.label} ` : p.kind === 'mention' ? `@${item.label} ` : `/${item.label} `;
  const start = item.bare ? upto.replace(/[^\s]*$/, '') : p.kind === 'mention' ? upto.replace(/@[^\s]*$/, '') : '';
  setText(start + insert + rest.replace(/^\S*/, ''), (start + insert).length);
};

const Composer = () => {
  const s = useStore();
  const ref = useRef(null);
  // after text set from code: the caret where it belongs, and the box as tall as its lines
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    // the box's text is written only when code set it: dictation (iOS) and other input methods show
    // their words in the box before any input event, and a render writing the last known text back
    // would wipe them and end the dictation
    if (S.writeText || !t.dataset.ready) {
      if (t.value !== s.text) t.value = s.text;
      S.writeText = false;
      t.dataset.ready = '1';
    }
    if (s.caret !== null) {
      t.setSelectionRange(s.caret, s.caret);
      S.caret = null;
    }
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
    placeCursor();
  });
  // the block cursor follows the caret wherever it goes: typing, clicks, arrows, selection
  useEffect(() => {
    const t = ref.current;
    const moved = () => placeCursor(true);
    document.addEventListener('selectionchange', moved);
    for (const ev of ['focus', 'blur', 'scroll', 'keyup']) t.addEventListener(ev, moved);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('selectionchange', moved);
      window.removeEventListener('resize', moved);
    };
  }, []);
  // a phone has the rooms link under the input and little width: the short form
  const narrow = window.innerWidth < 640;
  const placeholder = s.archived && !s.picker ? `${s.room} is archived · read-only${s.me.role === 'owner' ? ' · /unarchive' : ''}` : ghostNow() ? '' : s.replyTo && !s.text ? `reply to ${s.replyTo.to}` : s.loops ? (s.loops.open ? '↑↓ enter · esc back' : 'filter · ↑↓ enter · esc back') : s.picker ? 'filter or new room · ↑↓ enter · esc back' : narrow ? `message ${s.room} · @ agents · / commands` : `message ${s.room} · @ for agents · / for commands · ← rooms`;
  const onPaste = (e) => {
    const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((it) => it.kind === 'file');
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    // a file copied in Finder: some browsers hand over only its name and its icon as a picture,
    // which would go out instead of the file; say how to send it rather than send the icon
    const names = text.trim().split(/\r?\n/).filter((n) => n && !n.includes('/') && /\.[a-z0-9]{1,5}$/i.test(n));
    const files = items.map((it) => it.getAsFile()).filter(Boolean);
    const iconOnly = names.length && names.length === text.trim().split(/\r?\n/).length && files.length && files.every((f) => f.type.startsWith('image/') && !names.includes(f.name)) && names.some((n) => !/\.(png|jpe?g|gif|webp|heic)$/i.test(n));
    if (iconOnly) {
      e.preventDefault();
      note(`the browser passed only the icon of ${names.join(', ')}, not the file · drag it into the chat, or /attach`, 'warn');
      return;
    }
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) attach(f);
  };
  // ^ and ⌄ over a phone's keyboard go to the field before or after the input: two all but
  // invisible ones. Landing on one steps the suggestion (if any waits) and puts the focus straight
  // back, so the keyboard stays up. Always there and always enabled: iOS settles its arrows when
  // the input takes the focus, and suggestions load after that (disabled until then, the arrows
  // stayed grey on an iPhone). Also, the input next to them never moves in the page (a focused
  // field that moves loses the focus).
  const step = (dir) => {
    if (!s.picker && !s.editing && !s.forward) stepSuggestion(dir);
    ref.current?.focus({ preventScroll: true });
  };
  return html`<div id="composer">
    <span class="prompt" style=${{ color: nameColor(s.me.name) }}>❯</span>
    <div id="marks" aria-hidden="true"></div>
    <input class="step" type="text" tabindex="0" aria-label="previous suggestion" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" onFocus=${() => step(-1)} />
    <textarea id="text" ref=${ref} rows="1" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder=${placeholder}
      onInput=${(e) => onText(e.target.value, e.target.selectionStart)} onClick=${onInputClick} onPointerDown=${onInputPointer} onMouseMove=${onInputHover} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
    <input class="step" type="text" tabindex="0" aria-label="next suggestion" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" onFocus=${() => step(1)} />
    <div id="mirror" aria-hidden="true"></div>
    <div id="cursor" aria-hidden="true"></div>
  </div>`;
};

// MARK: task lines in the input: `- [ ]` and `- [x]` drawn by a layer behind the textarea (whose
// own text goes transparent while there are any), so caret, selection, paste, IME and phones stay
// the textarea's own. A click whose caret lands on the box ticks it.

const TASK_INPUT = /^(\s*(?:[-*+] )?)\[( |x|X)\]/;
const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const markTasks = (text) =>
  text
    .split('\n')
    .map((line) => {
      const m = TASK_INPUT.exec(line);
      if (!m) return escapeHtml(line);
      const rest = line.slice(m[0].length);
      const done = m[2] !== ' ';
      return `<span class="task-box">${escapeHtml(m[1])}</span><span class="task-box task-hit">[${m[2]}]</span><span class="${done ? 'task-done' : ''}">${escapeHtml(rest)}</span>`;
    })
    .join('\n') + (text.endsWith('\n') ? ' ' : '');

const placeMarks = (t) => {
  const marks = document.getElementById('marks');
  const composer = document.getElementById('composer');
  if (!marks || !composer) return;
  const g = !t.value ? ghostNow() : null;
  const ghost = g ? g.shown : '';
  // a suggestion taken and not changed: what the keys do now, dim, after it
  const keys = t.value && takenUnchanged() ? (isTouch() ? `  · return sends${pendingSuggestions().length > 1 ? ' · ⌄ next' : ''}` : `  · enter sends${pendingSuggestions().length > 1 ? ' · tab next' : ''}`) : '';
  const on = Boolean(ghost) || Boolean(keys) || t.value.split('\n').some((l) => TASK_INPUT.test(l));
  composer.classList.toggle('marks-on', on);
  if (!on) return;
  marks.style.left = t.offsetLeft + 'px';
  marks.style.top = t.offsetTop + 'px';
  marks.style.width = t.clientWidth + 'px';
  marks.style.height = t.clientHeight + 'px';
  // the key that takes it, after the suggestion and dimmer: never part of what it fills in
  const hint = ghost ? `<span class="ghost-key"> · ${isTouch() ? 'enter' : 'tab'}</span>` : '';
  const html = markTasks(t.value) + (ghost ? `<span class="ghost">${escapeHtml(ghost)}</span>${hint}` : '') + (keys ? `<span class="ghost-key">${escapeHtml(keys)}</span>` : '');
  if (marks.innerHTML !== html) marks.innerHTML = html;
  marks.scrollTop = t.scrollTop;
};

/// A press on a box in the input ticks it. Found by the box's rectangle in the layer, not by where
/// the browser puts the caret (which differs between browsers and lands after the click).
const onInputPointer = (e) => {
  const t = e.currentTarget;
  if (!document.getElementById('composer')?.classList.contains('marks-on')) return;
  const k = boxAt(e.clientX, e.clientY);
  if (k < 0) return;
  e.preventDefault();
  const caret = t.selectionStart;
  let seen = -1;
  const lines = t.value.split('\n').map((l) => {
    const m = TASK_INPUT.exec(l);
    if (!m || ++seen !== k) return l;
    return m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + l.slice(m[0].length);
  });
  if (document.activeElement !== t) t.focus();
  setText(lines.join('\n'), caret);
};

const boxAt = (x, y) =>
  [...document.querySelectorAll('#marks .task-hit')].findIndex((b) => {
    const r = b.getBoundingClientRect();
    return x >= r.left - 2 && x <= r.right + 2 && y >= r.top && y <= r.bottom;
  });

/// Over a box the pointer is a hand, so the box reads as something to press.
const onInputHover = (e) => {
  e.currentTarget.style.cursor = document.getElementById('composer')?.classList.contains('marks-on') && boxAt(e.clientX, e.clientY) >= 0 ? 'pointer' : '';
};

const onInputClick = (e) => onText(e.target.value, e.target.selectionStart);

/// The terminal's block cursor over the textarea: a copy of the text up to the caret, laid out
/// in an invisible box of the same width and font, says where the caret is; the block goes
/// there. Solid for a moment after it moves, then it blinks, as a terminal's does.
let restTimer = null;
const placeCursor = (moved = false) => {
  const tt = document.getElementById('text');
  if (tt) placeMarks(tt);
  const t = document.getElementById('text');
  const mirror = document.getElementById('mirror');
  const cursor = document.getElementById('cursor');
  if (!t || !mirror || !cursor) return;
  if (document.activeElement !== t || t.selectionStart !== t.selectionEnd) {
    cursor.classList.remove('on');
    return;
  }
  const at = t.selectionStart;
  mirror.style.width = t.clientWidth + 'px';
  mirror.style.left = t.offsetLeft + 'px';
  mirror.style.top = t.offsetTop + 'px';
  mirror.textContent = t.value.slice(0, at);
  const mark = document.createElement('span');
  // the character under the cursor, or a space at the end: the block is as wide as it
  mark.textContent = t.value.slice(at, at + 1).replace('\n', ' ') || ' ';
  mirror.append(mark);
  cursor.style.left = t.offsetLeft + mark.offsetLeft + 'px';
  cursor.style.top = t.offsetTop + mark.offsetTop - t.scrollTop + 'px';
  cursor.style.width = Math.max(mark.offsetWidth, 1) + 'px';
  cursor.classList.add('on');
  if (moved || !cursor.classList.contains('rest')) {
    cursor.classList.remove('rest');
    clearTimeout(restTimer);
    restTimer = setTimeout(() => cursor.classList.add('rest'), 500);
  }
};

const onKey = (e) => {
  const t = e.target;
  if (S.loops) return loopsKey(e);
  if (S.picker) return pickerKey(e);
  // shift+↑↓ with nothing typed: the feed's oldest loaded message (again: load more), its newest;
  // with text, they select it as ever
  if (!t.value && feedKey(e)) return;
  // a suggestion taken and not changed: Tab puts the next one in its place, shift+tab the previous
  if (e.key === 'Tab' && takenUnchanged()) {
    e.preventDefault();
    return takeNext(e.shiftKey ? -1 : 1);
  }
  // a suggested reply: Tab takes it; Enter with nothing typed never sends it
  if (!t.value && e.key === 'Tab' && ghostNow()) {
    e.preventDefault();
    return takeGhost();
  }
  if (!t.value && e.key === 'Enter' && !e.shiftKey && ghostNow()) {
    e.preventDefault();
    // a phone has no Tab: its Return takes the suggestion (a second Return sends it)
    if (isTouch()) return takeGhost();
    return setStatus('tab takes the suggestion, or type your own', 'warn', 2500);
  }
  const p = S.popup;
  const open = p.kind && p.items.length;
  if (open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    return set({ popup: { ...p, index: (p.index + (e.key === 'ArrowUp' ? -1 : 1) + p.items.length) % p.items.length } });
  }
  if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (p.kind === 'mention' || !t.value.includes(' '))))) {
    e.preventDefault();
    return choose();
  }
  // your own text: Tab switches nothing (nor moves to the fields ^ ⌄ use on a phone)
  if (e.key === 'Tab' && pendingSuggestions().length) return e.preventDefault();
  // ⌫ in the empty input (as Esc): dismisses the suggestion offered, and the next is offered
  if (e.key === 'Backspace' && !t.value && ghostNow()) {
    e.preventDefault();
    dropGhost();
    placeCursor();
    return setStatus('dismissed: the next one waiting, if any', 'ok', 1500);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.forward) return cancelForward();
    if (S.editing) {
      set({ editing: null });
      setText('');
      return setStatus('editing cancelled', 'warn', 1500);
    }
    if (!t.value && dropGhost()) {
      placeCursor();
      return setStatus('dismissed: the next one waiting, if any', 'ok', 1500);
    }
    if (S.replyTo && (!t.value || replyingToSuggestion())) return cancelReply();
    if (open) return set({ popup: { kind: null, items: [], index: 0 } });
    if (S.replyTo) set({ replyTo: null });
    return setText('');
  }
  if (e.key === 'ArrowLeft' && !t.value) {
    e.preventDefault();
    return openPicker();
  }
  // ↑ on the first line walks back through what you sent, ↓ forward again; past the newest
  // comes back what you were typing before you went, as the terminal chat's editor does
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !t.value.slice(0, t.selectionStart).includes('\n') && S.history.length) {
    if (e.key === 'ArrowDown' && S.historyAt < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && S.historyAt < 0) S.draft = t.value;
    const at = e.key === 'ArrowUp' ? Math.min(S.history.length - 1, S.historyAt + 1) : S.historyAt - 1;
    set({ historyAt: at });
    return setText(at < 0 ? S.draft || '' : S.history[S.history.length - 1 - at]);
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (t.value.endsWith('\\')) return setText(t.value.slice(0, -1) + '\n');
    submit();
  }
};

// Files: pasted or dropped ones wait as a token in the text, "[image 1.png]", and go with the
// message if the token is still there when it is sent.
let imageSeq = 0;
const attach = (file) => {
  const name = file.name && file.name !== 'image.png' ? file.name : `image ${++imageSeq}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const token = `[${name}]`;
  set({ files: [...S.files, { token, file, name }] });
  const input = document.getElementById('text');
  const at = input ? input.selectionStart : S.text.length;
  setText(S.text.slice(0, at) + token + ' ' + S.text.slice(at), at + token.length + 1);
};
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) attach(f);
});
// iOS Safari opens its picker (Photos, camera, Files) only from a tap, and for an input in the page:
// the input goes into the page for the pick and out after it
const pickFiles = () => {
  const i = document.createElement('input');
  i.type = 'file';
  i.multiple = true;
  i.style.display = 'none';
  i.onchange = () => {
    for (const f of i.files) attach(f);
    i.remove();
    document.getElementById('text')?.focus({ preventScroll: true });
  };
  document.body.appendChild(i);
  i.click();
};

// what a browser leaves untyped (often .mkv, .avi) is typed by its extension
const BY_EXT = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp', mpeg: 'video/mpeg', mpg: 'video/mpeg', md: 'text/markdown', log: 'text/plain', diff: 'text/plain', patch: 'text/plain' };
const typeOf = (f) => (f.file.type && f.file.type !== 'application/octet-stream' ? f.file.type : BY_EXT[(f.name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');
const upload = async (f) => {
  const res = await fetch('/media', {
    method: 'POST',
    headers: { 'Content-Type': typeOf(f), Authorization: `Bearer ${S.hub.token}`, 'X-Name': encodeURIComponent(f.name) },
    body: f.file,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`);
  return { ...(await res.json()), name: f.name };
};
const uploadAll = async (text) => {
  const list = S.files.filter((f) => text.includes(f.token)).sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));
  if (!list.length) return undefined;
  const out = [];
  for (const f of list) {
    setBusy(`uploading ${f.name}…`);
    out.push(await upload(f));
  }
  return out;
};

// MARK: sending, as the chat does it

const mentioned = (t) => {
  for (const m of t.matchAll(/(^|\s)@([^\s]+)/g)) {
    const name = m[2].replace(/[.,:;!?]+$/, '');
    if (S.members.has(name)) return name;
  }
  return t.startsWith('@') ? t.slice(1).split(/\s/)[0] : null;
};

// `$NAME=value$` as the whole input: a room secret. Stored by the hub, never posted, and kept
// out of the input history; `$NAME=$` removes it.
const SECRET_INPUT = /^\s*\$([A-Z][A-Z0-9_]*)=([\s\S]*)\$\s*$/;

/// A message that is only a secret goes to every agent online in the room (the hub keeps none):
/// say who got it.
const storeSecret = async ([, name, value]) => {
  const draft = S.text;
  setText('');
  setBusy(value ? 'handing over…' : 'taking back…');
  try {
    const r = await S.hub.call('room/say', { room: S.room, text: draft });
    const h = r.handed || { to: [], missed: [] };
    setStatus(`🔒 $${name} ${value ? 'handed to' : 'taken back from'} ${h.to.join(', ') || 'nobody'}${h.missed.length ? ` · not online: ${h.missed.join(', ')}` : ''}`, 'ok', 6000);
  } catch (error) {
    failure(error);
  } finally {
    setBusy(null);
  }
};

const submit = async () => {
  const t = S.text.trim();
  if (!t) return;
  // an archived room is read-only: commands still run (/unarchive, /live, …), messages do not go
  if (S.archived && !t.startsWith('/') && !S.forward) return setStatus(`${S.room} is archived: read-only${S.me.role === 'owner' ? ' · /unarchive brings it back' : ''}`, 'warn', 3000);
  const secret = SECRET_INPUT.exec(S.text);
  if (secret) return storeSecret(secret);
  const draft = S.text;
  // a secret handed in the message ($NAME=value$) is remembered by its name only
  set({ history: [...S.history, t.replace(/\$([A-Z][A-Z0-9_]*)=[^$\n]+\$/g, '$$$1')], historyAt: -1 });
  setText('');
  setBusy('sending…');
  const editing = S.editing;
  try {
    if (editing) {
      const r = await S.hub.call('room/edit', { id: editing.id, text: draft });
      set({ editing: null });
      setStatus(r.unchanged ? 'no change' : `saved as v${r.rev}`, 'ok', 2000);
      return;
    }
    // the answer to "how often?" after a /loop with no schedule in it: asked once, so anything
    // else drops the question and goes as typed
    const asked = S.loopAsk;
    S.loopAsk = null;
    const choice = asked && /^[1-9]$/.test(t) ? asked.options[Number(t) - 1] : null;
    if (choice) return await makeLoop(asked.line, choice.every);
    // an answer to /start's questions; a command or esc ends them
    if (S.wizard && !t.startsWith('/')) return startStep(t);
    if (S.wizard) S.wizard = null;
    if (S.replyTo && !t.startsWith('/') && !t.startsWith('@') && !t.startsWith('>')) await directed(`@${S.replyTo.to} ${t}`);
    else if (t.startsWith('/')) await command(t);
    else if (mentioned(t)) await directed(t);
    else if (t.startsWith('>')) await dispatch(t.slice(1).trim());
    else if (CONTROL.test(t)) note('control commands go to an agent, e.g. @Alex !/compact', 'warn');
    else await S.hub.call('room/say', { room: S.room, text: t, media: await uploadAll(t) });
    set({ files: S.files.filter((f) => S.text.includes(f.token)), replyTo: null, ghost: null });
  } catch (error) {
    setText(draft);
    failure(error);
  } finally {
    setBusy(null);
    // back in the input: the next suggestion waiting is a Tab away
    requestAnimationFrame(focusInput);
  }
};

const failure = (error) => {
  let msg = error instanceof Error ? error.message : String(error);
  const blocked = msg.match(/^(\S+) is blocked on a question/);
  if (blocked) msg = `${blocked[1]} is blocked on a question · reply with its option number, or /direct ${blocked[1]} to answer it on its screen`;
  if (/^Owners only/.test(msg)) msg = `owners only · your token has the ${S.me.role} role`;
  note(msg, 'error');
};

const directed = async (t) => {
  // "@alenclaude /direct", "@alenclaude /kill": the command, on that agent
  const after = /^@([^\s]+)\s+\/(direct|live|kill|wait)\s*$/.exec(t.trim());
  if (after) return command(`/${after[2]} ${after[1]}`);
  const to = mentioned(t);
  const lead = t.match(new RegExp(`^@${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([\\s\\S]*)$`));
  const body = lead ? lead[1].trim() : t;
  if (to === 'auto') return dispatch(body);
  // every agent here: the hub types it into each (a !/command from the owner: as at its terminal)
  if (to === 'all' && !S.members.has('all')) {
    if (!body) return note('say something after @all', 'warn');
    const r = await S.hub.call('room/say', { room: S.room, text: t, media: await uploadAll(t) });
    return note(r.all ? (r.all.length ? `to every agent here: ${r.all.join(', ')}` : `no agent is online in ${S.room}`) : 'posted to the room', r.all && r.all.length ? 'dim' : 'warn');
  }
  const member = S.members.get(to);
  if (!member) {
    await S.hub.call('room/say', { room: S.room, text: t });
    return note(`posted to the room as text (nobody called ${to} is here)`, 'dim');
  }
  // "@alenclaude" and nothing else: its terminal, as /direct (the hub says "isn't yours" when it is not)
  if (!body && member.kind === 'agent') return command(`/direct ${to}`);
  if (!body) return note(`say something after @${to}`, 'warn');
  const kind = member.kind === 'agent' ? 'command' : 'info';
  const replyTo = S.replyTo && S.replyTo.to === to ? S.replyTo.id : undefined;
  const r = await S.hub.call('agents/send', { to, text: body, kind, media: await uploadAll(body), replyTo });
  if (!r.delivered) note(`${to} is offline, queued until it is back`, 'dim');
};

// MARK: suggested replies. The newest message to you that suggests a reply, and that you have not
// answered (no reply to it, no later message from you to its sender), shows in the empty input as
// ghost text, "@sender suggestion". Tab (or the chip on a phone) makes it your text, a reply to that
// message; Esc (or ✕ cancel once taken) dismisses it for good, on the hub, on all your devices;
// typing your own puts it aside. Enter never sends a ghost. On a
// phone (no Tab) the first Return takes it, and a second one sends.
// ↩ reply on another such message shows its own the same way.

/// Past the time its sender gave it (12 h unless it said otherwise): no longer waiting.
const expired = (m) => Boolean(m.suggestUntil) && Date.parse(m.suggestUntil) <= Date.now();

/// Every suggestion to you still waiting for a reply, oldest first: not answered by a reply to it,
/// nor by a later message from you to its sender that answers no message in particular.
const pendingSuggestions = () => {
  const me = S.me.name;
  const replied = new Set();
  const lastPlain = {}; // sender -> where your last message to them, not a reply to one, is
  // the hub's list (all of the room's history) for what is older than the feed, then the feed
  const shown = S.log.filter((e) => e.type === 'message').map((e) => e.msg);
  const inFeed = new Set(shown.map((m) => m.id));
  const msgs = [...(S.waiting || []).filter((m) => !inFeed.has(m.id)), ...shown];
  msgs.forEach((m, i) => {
    if (m.from?.name !== me) return;
    if (m.replyTo) return void replied.add(m.replyTo);
    const to = m.to || (/^@(\S+)/.exec(m.text || '') || [])[1];
    if (to) lastPlain[to] = i;
  });
  return msgs
    .map((m, i) => [m, i])
    .filter(([m, i]) => m.suggest && !expired(m) && m.from && m.from.name !== me && !replied.has(m.id) && !(lastPlain[m.from.name] > i))
    .map(([m]) => suggestionOf(m, m.from.name));
};

/// The hub's list of suggestions waiting for you in this room, from all of its history.
const loadWaiting = async (room = S.room) => {
  try {
    const r = await S.hub.call('room/suggestions', { room });
    if (room === S.room) set({ waiting: r.suggestions });
  } catch {
    if (room === S.room) set({ waiting: [] });
  }
};

/// A waiting suggestion's message: in the feed, or older than it (from the hub's list).
const waitingMessage = (id) => S.log.find((x) => x.type === 'message' && x.msg.id === id)?.msg || ((S.cards || []).find((c) => c.msg.id === id)?.msg || null) || (S.waiting || []).find((m) => m.id === id) || null;

/// A suggestion as the input offers it: the whole text to fill in, and what the placeholder shows
/// (a checklist: its first line and how many items follow).
const suggestionOf = (m, who) => {
  const full = `@${who} ${m.suggest}`;
  const lines = full.split('\n');
  const shown = lines.length > 1 ? `${lines[0]} (+${lines.length - 1} item${lines.length === 2 ? '' : 's'})` : full;
  return { id: m.id, to: who, text: full, shown };
};

/// The one to offer now: the one you stepped to (^ ⌄, alt+↑↓), else the oldest waiting one you
/// have not skipped (Esc).
const pendingSuggestion = () => {
  const all = pendingSuggestions();
  return all.find((g) => g.id === S.picked) || all.find((g) => !(S.skipped || []).includes(g.id)) || null;
};

/// The suggestion Tab put in the input, while its text is as it was taken: Tab may replace it.
const takenUnchanged = () => {
  if (!S.replyTo || !S.text) return null;
  return pendingSuggestions().find((g) => g.id === S.replyTo.id && g.text === S.text) || null;
};

/// Tab again on a suggestion taken and unchanged: the next one waiting (shift+tab: the previous,
/// round the ends) in its place, its message scrolled to and lit up. Enter sends the one shown.
const takeNext = (dir) => {
  const all = pendingSuggestions();
  const at = all.findIndex((g) => g.id === S.replyTo.id);
  const next = all[(at + dir + all.length) % all.length];
  set({ ghost: null, picked: next.id, replyTo: { id: next.id, to: next.to } });
  setText(next.text, next.text.length);
  const m = waitingMessage(next.id);
  if (m) jumpTo(m, 'reply');
};

/// ^ and ⌄ over a phone's keyboard: the previous or next suggestion waiting (round the end), in
/// the input with its place in the queue, and its message scrolled to and lit up. One taken
/// (Return) and unchanged is replaced, filled in, as Tab does on a desktop; your own text stays.
const stepSuggestion = (dir) => {
  const all = pendingSuggestions();
  if (!all.length) return false;
  if (takenUnchanged()) return void takeNext(dir);
  const cur = S.ghost || pendingSuggestion();
  const at = cur ? all.findIndex((g) => g.id === cur.id) : -1;
  const next = all[at < 0 ? (dir > 0 ? 0 : all.length - 1) : (at + dir + all.length) % all.length];
  set({ ghost: null, picked: next.id, skipped: (S.skipped || []).filter((id) => id !== next.id) });
  const m = waitingMessage(next.id);
  if (m) jumpTo(m, 'reply');
  return true;
};

/// The ghost in the input now: one ↩ reply asked for, else the oldest one waiting.
const ghostNow = () => {
  if (S.text || S.picker || S.loops || S.editing || S.forward) return null;
  return S.ghost || pendingSuggestion();
};

const startSuggested = (msg, who) => {
  set({ ghost: suggestionOf(msg, who), replyTo: { id: msg.id, to: who } });
  setText('');
  focusInput();
  setStatus(`${isTouch() ? 'enter' : 'tab'} takes the suggestion${isTouch() ? '' : ' · esc dismisses it'}`, 'ok', 4000);
};

const takeGhost = () => {
  const g = ghostNow();
  if (!g) return false;
  set({ ghost: null, replyTo: { id: g.id, to: g.to } });
  setText(g.text, g.text.length);
  focusInput();
  // the message it answers: scrolled to and lit up, as a pin does, loaded back to if older
  const m = waitingMessage(g.id);
  if (m) jumpTo(m, 'reply');
  return true;
};

/// A suggestion put away here: its message stays, without it, and it leaves the queue.
const forgetSuggestion = (id) => {
  const strip = (m) => (m.id === id && m.suggest ? { ...m, suggest: undefined } : m);
  set({
    log: S.log.map((e) => (e.type === 'message' && e.msg.id === id && e.msg.suggest ? { ...e, msg: strip(e.msg) } : e)),
    waiting: (S.waiting || []).filter((m) => m.id !== id),
    cards: (S.cards || []).map((c) => (c.msg.id === id && c.msg.suggest ? { ...c, msg: strip(c.msg) } : c)),
    ghost: S.ghost && S.ghost.id === id ? null : S.ghost,
    picked: S.picked === id ? null : S.picked,
  });
};

/// Esc (or ✕ cancel) on a suggestion: put away for good, on the hub, so it stays gone after a
/// reload and on your other devices. The next waiting one is offered.
const dismissSuggestion = (id) => {
  forgetSuggestion(id);
  S.hub.call('room/dismiss', { room: S.room, id }).catch((e) => setStatus(`not dismissed: ${e.message}`, 'warn', 3000));
};

/// The suggestion a reply was started from, while it is still waiting.
const replyingToSuggestion = () => (S.replyTo ? pendingSuggestions().find((g) => g.id === S.replyTo.id) || null : null);

/// Esc on the one offered: dismissed, and the next waiting one is offered.
const dropGhost = () => {
  const g = ghostNow();
  if (g) dismissSuggestion(g.id);
  return Boolean(g);
};

/// On the row under the input, on its right: where the one offered is in the queue, and how many
/// wait; a click switches to the next.
const Waiting = () => {
  const s = useStore();
  const all = pendingSuggestions();
  if (!all.length || s.picker) return null;
  const cur = s.ghost || (s.replyTo && all.find((g) => g.id === s.replyTo.id)) || pendingSuggestion();
  const at = cur ? all.findIndex((g) => g.id === cur.id) : -1;
  // a click (a tap) switches to the next one waiting, as Tab and ⌄ do
  const go = () => {
    stepSuggestion(1);
    focusInput();
  };
  const n = `${at >= 0 ? `${at + 1}/${all.length}` : all.length}`;
  if (!isTouch()) return html`<button type="button" class="waiting" onMouseDown=${(e) => e.preventDefault()} onClick=${go}>${n} waiting for reply</button>`;
  // a phone: ‹ › step through them (as ^ ⌄ over its keyboard do), done when the finger lifts, so
  // the keyboard stays up
  const lift = (dir) => (e) => {
    e.preventDefault();
    stepSuggestion(dir);
    focusInput();
  };
  return html`<span class="waiting">
    ${all.length > 1 && html`<button type="button" class="stepbtn" aria-label="previous suggestion" onTouchEnd=${lift(-1)} onClick=${() => stepSuggestion(-1)}>‹</button>`}
    <button type="button" class="count" onTouchEnd=${(e) => (e.preventDefault(), go())} onClick=${go}>${n}<span class="w"> waiting</span></button>
    ${all.length > 1 && html`<button type="button" class="stepbtn" aria-label="next suggestion" onTouchEnd=${lift(1)} onClick=${() => stepSuggestion(1)}>›</button>`}
  </span>`;
};

const isTouch = () => matchMedia('(hover: none)').matches;


const dispatch = async (body) => {
  if (!body) return note('say what to do after @auto', 'warn');
  const r = await S.hub.call('agents/dispatch', { text: body, room: S.room, media: await uploadAll(body) });
  note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? '' : ', queued'}`, 'dim');
};

const cancelForward = () => {
  set({ forward: null });
  setText('');
  focusInput();
  setStatus('forwarding cancelled', 'warn', 1500);
};

const startForward = (msg) => {
  set({ forward: msg });
  setText('@');
  focusInput();
  setStatus(`forwarding ${msg.from?.name ?? '?'}'s message · pick who · esc cancels`, 'ok');
};
const forward = async (msg, member) => {
  const body = `[forwarded from ${msg.from?.name ?? '?'}${msg.to ? ` → ${msg.to}` : ''}] ${msg.text}`;
  try {
    const r = await S.hub.call('agents/send', { to: member.name, text: body, kind: member.kind === 'agent' ? 'command' : 'info', media: msg.media });
    setStatus(r.delivered ? `forwarded to ${member.name}` : `${member.name} is offline, queued`, 'ok', 2500);
  } catch (error) {
    failure(error);
  }
};

// MARK: commands

// tokens as /tokens shows them (cli/lib/format.js tokensTable)
const ago = (ts) => {
  if (!ts) return 'never used';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const tokensTable = (list) => {
  const rows = list.map((t) => [
    t.name,
    t.role,
    t.rooms ? t.rooms.join(',') : 'all rooms',
    t.connections ? `online · ${t.connections} conn` : `offline · ${ago(t.lastUsed)}`,
    (t.agents || []).length ? `${t.agents.length} agent${t.agents.length === 1 ? '' : 's'}: ${t.agents.join(' ')}` : (t.people || []).length ? `as ${t.people.join(' ')}` : '-',
  ]);
  const head = ['name', 'role', 'rooms', 'status', 'running'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  return [fmt(head), ...rows.map(fmt)].join('\n');
};

const Row = (k, v) => html`<div><span>${k.padEnd(34)}</span><span class="muted">${v}</span></div>`;
const Glyph = (m) => {
  const st = stateOf(m);
  return html`<span style=${{ color: st === 'offline' ? 'var(--muted)' : 'var(--success)' }}>${m.kind === 'human' ? (m.connected ? '◆' : '◇') : st === 'offline' ? '○' : '●'}</span>`;
};

/// `/loop @all send me a report every minute`: made, and the schedule shown back as the hub read
/// it; with no schedule in the words, the hub's question with its numbered choices (reply 1-3).
const makeLoop = async (line, every) => {
  const r = await S.hub.call('loops/create', { room: S.room, line, every, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (r.ask) {
    S.loopAsk = { line, options: r.ask.options };
    return note(`${r.ask.text}\n${r.ask.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\nreply 1-${r.ask.options.length}, or put when in the line: "every 2h", "every day at 9", "hourly"`, 'warn');
  }
  return note(`loop set: ${r.label || `every ${r.every}`} → @${r.target}: ${r.prompt} · next ${runAt(r.next)} · /loops lists them`, 'ok');
};

const command = async (t) => {
  const [cmd, ...rest] = t.slice(1).split(/\s+/);
  // an agent's name may be written as a mention: /direct @builder
  if (['direct', 'live', 'wait', 'kill'].includes(cmd) && rest[0]) rest[0] = rest[0].replace(/^@/, '');
  const arg = rest.join(' ');
  const call = (m, a) => S.hub.call(m, a);
  const block = (b) => push({ type: 'block', block: b });
  switch (cmd) {
    case 'help':
      return block(html`<div>
        <span class="b primary">messages</span>
        ${Row('text', 'post to the room; @Name inside is a mention')}${Row('@Alex do the thing', 'typed into that agent when it is idle')}${Row('@Alex !/compact  !stop', 'the agent\'s own slash command, or stop it; acts at once')}${Row('/direct Alex  @Alex /direct', 'its own terminal here, your keys to it; esc leaves')}
        <span class="b primary">commands</span>
        ${COMMANDS.map((c) => Row(`/${c.name} ${c.args}`, c.help))}
        <span class="b primary">keys</span>
        ${Row('enter', 'send · shift+enter for a new line')}${Row('@ and /', 'open a list; ↑↓ choose, tab or enter inserts, esc closes')}${Row('↑ ↓', 'through what you sent')}${Row('← on an empty line', 'the room list (or the rooms button)')}${Row('tap', 'a name addresses it · ↩ reply and ⋯ (forward, edit, pin) act on a message')}
      </div>`);
    // /live: the old name, kept working
    case 'live':
    case 'direct': {
      const [name] = rest;
      if (!name) return note('usage: /direct <agent> · or @agent /direct', 'warn');
      return startLive(name);
    }
    case 'wait': {
      const [name] = rest;
      if (!name) return note('usage: /wait <name>', 'warn');
      setBusy(`waiting for ${name}…`);
      const r = await call('agents/wait', { name, timeoutMs: 600000 });
      return note(r.timeout ? `still waiting, ${name} is ${r.status}` : `${name} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`, r.status === 'blocked' ? 'warn' : 'ok');
    }
    case 'say':
      if (!arg) return note('usage: /say <text>', 'warn');
      return call('room/say', { room: S.room, text: arg, media: await uploadAll(arg) });
    case 'attach':
      return pickFiles();
    case 'rooms':
      return openPicker();
    case 'room':
      if (!arg) return note('usage: /room <name> · or ← on an empty line for the list', 'warn');
      return switchRoom(arg);
    case 'alerts': {
      // per room: on, off, stuck, done, all here; `test` sends one; `stop` takes this device off
      const sub = rest[0] || '';
      const describe = (r) => {
        const word = (ev) => (!ev.length ? 'off' : ev.length === 2 ? 'stuck + done' : ev[0] === 'done' ? 'done only' : 'stuck');
        const others = Object.entries(r.others);
        return `alerts in ${r.room}: ${word(r.events)}${others.length ? ` · elsewhere: ${others.map(([room, ev]) => `${room} ${word(ev)}`).join(', ')}` : ''} · other rooms: stuck · ${r.devices} device${r.devices === 1 ? '' : 's'}`;
      };
      if (!sub) return note(describe(await call('push/room', { room: S.room })), 'ok');
      if (['off', 'stuck', 'done', 'all'].includes(sub)) return note(describe(await call('push/room', { room: S.room, choice: sub })), 'ok');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return note('no push in this browser here; on an iPhone, add metacom to the Home Screen (Share → Add to Home Screen) and run /alerts from there', 'warn');
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (sub === 'stop') {
        const s = await reg.pushManager.getSubscription();
        if (s) {
          await call('push/unsubscribe', { endpoint: s.endpoint });
          await s.unsubscribe();
        }
        return note('this device gets no alerts now (from any room); /alerts on brings them back');
      }
      if (sub === 'test') {
        const r = await call('push/test', {});
        return note(r.sent ? `test alert sent to ${r.sent} device${r.sent === 1 ? '' : 's'}` : 'no device has alerts on: /alerts on', r.sent ? 'ok' : 'warn');
      }
      if (sub !== 'on') return note('usage: /alerts [on|off|stuck|done|all] for this room · /alerts test · /alerts stop (this device)', 'warn');
      if ((await Notification.requestPermission()) !== 'granted') return note('notifications are blocked for this site: allow them in the browser settings, then /alerts on', 'warn');
      const { publicKey } = await call('push/key', {});
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      let s;
      try {
        s = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      } catch (error) {
        return note(`this browser refused push (${error.message}); on a phone, install metacom as an app first (Add to Home Screen)`, 'warn');
      }
      await call('push/subscribe', { subscription: s.toJSON(), events: ['blocked', 'done'] });
      return note(describe(await call('push/room', { room: S.room, choice: 'on' })), 'ok');
    }
    case 'tokens':
      return block(html`<div><span class="muted">── tokens ──</span><div class="screen">${tokensTable(await call('admin/tokens', {}))}</div></div>`);
    case 'token': {
      // /token <name> agent|member [room,room]: a raw token, shown once (people are invited with /invite)
      const [name, role, where] = rest;
      if (!name || !['agent', 'member'].includes(role)) return note('usage: /token <name> agent|member [room,room] · no rooms: every room · to invite people: /invite <label>', 'warn');
      const r = await call('admin/createToken', { name, role, rooms: where ? where.split(',').filter(Boolean) : undefined });
      const room = r.record.rooms ? r.record.rooms[0] : 'default';
      const how =
        role === 'member'
          ? `give it to them with ${location.origin}/${room} : they open it and sign in with the token and a name`
          : `on the agent's machine or container: MC_HUB_URL=${location.origin.replace(/^http/, 'ws')}/ MC_TOKEN=<token> metacom ${room} -n <agent> claude`;
      return block(html`<div><span class="muted">── token ${r.record.name} · only you see this ──</span><div class="screen">
        <div class="b">${r.token}</div>
        <div>${role}, ${r.record.rooms ? 'only ' + r.record.rooms.join(', ') : 'every room'}. Shown once, copy it now.</div>
        <div>${how}</div>
      </div></div>`);
    }
    case 'invite': {
      // /invite <label> [all | room, room | + room]: a user token (a person, and their own agents, in
      // those rooms) and its invite link, copied
      const name = rest[0];
      if (!name) return note('usage: /invite <label> [all | room, room] · /invite <label> + room adds a room · /tokens lists them', 'warn');
      const after = rest.slice(1).join(' ').trim();
      const roomsIn = (t) => t.split(/[\s,]+/).filter(Boolean);
      if (after.startsWith('+')) {
        const r = await call('admin/setRooms', { token: name, add: roomsIn(after.slice(1)) });
        return note(`${r.name} now works in ${r.rooms ? r.rooms.join(', ') : 'every room'}`, 'ok');
      }
      const rooms = after === 'all' ? undefined : after ? roomsIn(after) : [S.room];
      const r = await call('admin/createToken', { name, role: 'member', rooms, steer: 'answer', agents: true });
      const link = `${location.origin}/${rooms ? rooms[0] : S.room}/invite/${r.token}`;
      const copied = await navigator.clipboard?.writeText(link).then(() => true, () => false);
      const copy = (e) => {
        e.preventDefault();
        navigator.clipboard?.writeText(link).then(() => setStatus('Invite link copied', 'ok', 4000), () => setStatus('copy it from the line above', 'warn', 4000));
      };
      if (copied) setStatus('Invite link copied', 'ok', 4000);
      return block(html`<div><span class="muted">── invite ${r.record.name} · only you see this ──</span><div class="screen">
        <div>${rooms ? rooms.join(', ') : 'every room'} · a user: joins as a person, may run their own agents there · several people can share it, each under their own name</div>
        <div class="tokenlink">${link.slice(0, link.length - r.token.length) + masked(r.token)}</div>
        <div>${copied ? html`<span class="success">Invite link copied</span> · ` : ''}<button type="button" class="copylink" onClick=${copy}>${copied ? 'copy again' : 'Tap to copy invite link'}</button></div>
        <div class="muted">/tokens lists them · /revoke ${r.record.name} ends it for everyone using it</div>
      </div></div>`);
    }
    case 'revoke': {
      if (!arg) return note('usage: /revoke <token name>', 'warn');
      const r = await call('admin/revokeToken', { token: arg });
      return note(`revoked ${r.name}; ${r.closed} connection${r.closed === 1 ? '' : 's'} closed`, 'ok');
    }
    case 'grant':
    case 'ungrant':
    case 'limit': {
      const [name, where] = rest;
      if (!name || !where) return note(`usage: /${cmd} <token name> <room,room${cmd === 'grant' ? '|all' : ''}>`, 'warn');
      const rooms = where.split(',').filter(Boolean);
      const args = cmd === 'grant' ? (where === 'all' ? { all: true } : { add: rooms }) : cmd === 'ungrant' ? { remove: rooms } : { set: rooms };
      const r = await call('admin/setRooms', { token: name, ...args });
      return note(`${r.name} now works in ${r.rooms ? r.rooms.join(', ') : 'every room'}${r.closed ? `; closed ${r.closed} connection${r.closed === 1 ? '' : 's'} elsewhere` : ''}`, 'ok');
    }
    case 'archive':
    case 'unarchive': {
      // nothing is deleted: an archived room is read-only, its log where it was
      const room = arg || S.room;
      const r = await call(`room/${cmd}`, { room });
      if (cmd === 'archive') return note(r.unchanged ? `${room} is already archived` : `archived ${room}: read-only, its log kept${r.agents?.length ? ` · told ${r.agents.join(', ')}` : ''} · /unarchive ${room} brings it back`, 'ok');
      return note(`${room} is back from the archive`, 'ok');
    }
    case 'loop':
      if (!arg) return note('usage: /loop @<agent|all|any> <prompt, with when: "every 2h", "every day at 9", "hourly">', 'warn');
      return makeLoop(arg);
    case 'loops':
      return openLoops();
    case 'kill': {
      if (!arg) return note('usage: /kill <agent> · stops it for good, its notes first', 'warn');
      const r = await call('agents/kill', { name: arg.replace(/^@/, '') });
      return note(`${r.name} is stopping: notes first, then it ends`, 'ok');
    }
    case 'lead': {
      if (!arg) return note('usage: /lead <agent> · or /lead off', 'warn');
      const r = await call('room/lead', { room: S.room, name: arg.replace(/^@/, '') });
      return note(r.lead ? `${r.lead} is the lead here: messages to nobody in particular go to it` : 'no lead here', 'ok');
    }
    case 'secrets': {
      const r = await S.hub.call('room/secrets', { room: S.room });
      if (!r.agents.length) return note(`no agent in ${r.room} holds a secret · hand one over: @agent $NAME=value$ (no @: every agent online here)`, 'warn');
      push({ type: 'block', block: `🔒 secrets in ${r.room}, by name (each on its agent's machine)\n${r.agents.map((a) => `  ${a.agent}: ${a.names.map((n) => `$${n}`).join(', ')}${a.connected ? '' : '  (offline)'}`).join('\n')}` });
      break;
    }
    case 'manage': {
      const names = rest.join(' ').split(/[\s,]+/).filter((n) => n && n !== 'off').map((n) => n.replace(/^@/, ''));
      if (!rest.length) return note(`usage: /manage <agent>[, <agent>] · /manage off: who may set loops for ${S.room}'s agents`, 'warn');
      const r = await call('room/manage', { room: S.room, names });
      return note(r.managers.length ? `${r.managers.join(', ')} manage${r.managers.length === 1 ? 's' : ''} ${r.room}: loops for its agents` : `${r.room} has no manager`, 'ok');
    }
    case 'delegate': {
      const [what, ...who] = rest;
      if (what !== 'answers') return note('usage: /delegate answers <agent>[, <agent>] · /delegate answers off', 'warn');
      const names = who.join(' ').split(/[\s,]+/).filter((n) => n && n !== 'off');
      const r = await call('agents/delegate', { what, names });
      return note(r.answers.length ? `${r.answers.join(', ')} may answer agents' folder-trust questions (nothing else)` : 'only you answer agents\' folder-trust questions now', 'ok');
    }
    case 'budget': {
      const [who, amount] = rest;
      if (!who) {
        const list = await call('agents/budgets', {});
        return note(list.length ? list.map((b) => `${b.name}@${b.room}  $${b.cost.toFixed(2)} of $${b.budget}${b.paused ? '  · paused' : ''}`).join('\n') + '\n/budget <agent> $<per day> · /resume <agent>' : 'no agents yet', 'ok');
      }
      if (!amount) return note('usage: /budget <agent> $<dollars a day>', 'warn');
      const r = await call('agents/budget', { name: who.replace(/^@/, ''), dollars: amount });
      return note(`${r.name}: $${r.budget} a day`, 'ok');
    }
    case 'resume': {
      if (!arg) return note('usage: /resume <agent>', 'warn');
      const r = await call('agents/resume', { name: arg.replace(/^@/, '') });
      return note(`${r.name} resumed for today${r.released ? `, ${r.released} held message${r.released === 1 ? '' : 's'} sent in` : ''}`, 'ok');
    }
    case 'start':
      S.wizard = { step: 1 };
      return note('1/3 What is your business, in a line?  (a command ends these questions)', 'ok');
    case 'approvals': {
      const open = await call('agents/approvals', {});
      return note(open.length ? open.map((r) => `${r.room} · ${r.id} · ${r.agent}${r.risk === 'outward' ? '' : ` (${r.risk})`}: ${r.action}`).join('\n') + '\n/approve <id> · /decline <id> · /approve all (a room\'s routine ones)' : 'nothing waits for your approval', 'ok');
    }
    case 'approve':
    case 'decline': {
      const rid = (rest[0] || '').trim();
      if (rid === 'all') {
        const r = await call('agents/decideAll', { room: S.room, approve: cmd === 'approve' });
        return note(r.decided.length ? `${cmd === 'approve' ? 'approved' : 'declined'} ${r.decided.length} routine request${r.decided.length === 1 ? '' : 's'} in ${S.room}` : `no routine requests open in ${S.room}`, 'ok');
      }
      if (!rid) {
        const open = await call('agents/requests', { room: S.room });
        return note(open.length ? open.map((r) => `${r.id} · ${r.agent}: ${r.action}`).join('\n') + `\n/${cmd} <id>` : `no open requests in ${S.room}`, 'ok');
      }
      const r = await call('agents/decide', { id: rid, approve: cmd === 'approve' });
      return note(`${r.status} "${r.action}" for ${r.agent}`, 'ok');
    }
    case 'preview': {
      const [how, where] = rest;
      const all = where === 'all' || how === 'all';
      const state = (on) => (on ? 'pictures and videos shown' : 'only their ↗ links');
      if (!['on', 'off'].includes(how)) return note(`previews in ${S.room}: ${state(previewOn(S.room))} (the hub's default: ${S.hubPreviews === false ? 'off' : 'on'}) · /preview on|off for this room, /preview on|off all for every room${S.me.role === 'owner' ? ', /preview on|off hub for everyone' : ''}`, 'ok');
      const on = how === 'on';
      if (where === 'hub') {
        await call('admin/previews', { on });
        return note(`the whole hub: ${state(on)}, for everyone who has not chosen otherwise on their device`, 'ok');
      }
      const p = previews();
      // every room: the default, and no room keeps its own
      saved.set('tui.previews', JSON.stringify(all ? { '*': on } : { ...p, [S.room]: on }));
      set({ log: [...S.log] });
      return note(`${all ? 'every room' : S.room}: ${state(on)} (on this device)`, 'ok');
    }
    case 'clear':
      lastMessage.current = null;
      return set({ log: [] });
    default:
      return note(`unknown command /${cmd} · /help lists them`, 'warn');
  }
};

// MARK: rooms

const ROOM = /^[\w][\w.-]{0,63}$/;
/// The room list: the rooms, then at the bottom the "archived" folder (with how many). In the
/// folder, the archived rooms. A filter matches archived rooms too, shown under the folder's name.
const pickerItems = () => {
  const q = S.text.trim().toLowerCase();
  const archived = (S.archivedRooms || []).filter((r) => r.room.toLowerCase().includes(q)).map((r) => ({ room: r.room, archived: r }));
  if (S.picker?.folder) return archived;
  const shown = S.rooms.filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q)).map((r) => ({ room: r.room, summary: r }));
  const here = S.rooms.some((r) => r.room === S.room) || (S.archivedRooms || []).some((r) => r.room === S.room);
  if (!here && S.room.includes(q)) shown.unshift({ room: S.room });
  if (q && archived.length) shown.push(...archived);
  const raw = S.text.trim();
  if (raw && ROOM.test(raw) && !shown.some((r) => r.room === raw) && !(S.archivedRooms || []).some((r) => r.room === raw)) shown.push({ room: raw, create: true });
  if (!q && (S.archivedRooms || []).length) shown.push({ room: '', folder: true, count: S.archivedRooms.length });
  return shown;
};
const counts = (s) => {
  if (!s || s.agents === 0) return 'no agents';
  const parts = [`${s.online}/${s.agents} online`];
  if (s.working) parts.push(`${s.working} working`);
  if (s.blocked) parts.push(`${s.blocked} need you`);
  return parts.join(' · ');
};

const RoomPicker = () => {
  const s = useStore();
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  const items = pickerItems();
  const at = Math.min(s.picker.index, Math.max(0, items.length - 1));
  const nameW = Math.min(28, Math.max(8, ...items.map((i) => i.room.length + 2)));
  return html`<div id="rooms" ref=${ref} style=${{ '--nameW': `${nameW}ch` }}>
    <div class="title">${s.picker.folder ? html`<button type="button" class="back" onMouseDown=${(e) => e.preventDefault()} onClick=${() => set({ picker: { index: 0 } })}>‹ back</button> archived rooms${isTouch() ? '' : ' · ← or esc back'}` : 'rooms'}</div>
    ${!items.length && html`<span class="muted">${s.picker.folder ? 'no archived room matches' : s.rooms.length ? 'no room matches · type a name to create one' : 'loading…'}</span>`}
    ${items.map(
      (item, i) => html`${item.archived && !s.picker.folder && !items[i - 1]?.archived ? html`<div class="title" key="archived-head">archived</div>` : ''}<button key=${item.folder ? '/archived' : item.room} type="button" class="row ${i === at ? 'active' : ''}" onMouseDown=${(e) => e.preventDefault()} onClick=${() => pick(item)}>
        <span class="mark">${i === at ? '›' : ' '}</span>
        ${item.folder
          ? html`<span class="muted">${item.count} archived room${item.count === 1 ? '' : 's'}</span>`
          : item.archived
          ? html`<span class="room">${item.room}</span><span class="muted">${item.archived.messages} message${item.archived.messages === 1 ? '' : 's'} · last ${ago(item.archived.last)}</span>${item.room === s.room ? html`<span class="muted">  · you are here</span>` : ''}`
          : item.create
          ? html`<span class=${i === at ? 'b primary' : ''}>+ create ${item.room}</span>`
          : html`<span class="room">${item.room}</span><span class="muted">${counts(item.summary)}</span>${item.summary?.unread ? html`<span class="b warning"> · ${item.summary.unread} unread</span>` : ''}${item.room === s.room ? html`<span class="muted">  · you are here</span>` : ''}`}
      </button>`,
    )}
  </div>`;
};

// MARK: loops, listed as the rooms are

const loopLabel = (l) => l.label || `every ${l.every}`;
/// What /loops shows for what is typed, as the room list does: the loops whose target, schedule or
/// prompt contain it. Inside a loop (enter, → or a tap on it, as on the archived folder), its actions.
const loopItems = () => {
  const v = S.loops;
  if (v.open) {
    const loop = v.list.find((l) => l.id === v.open);
    return loop ? ['toggle', 'run', 'delete'].map((action) => ({ loop, action })) : [];
  }
  const q = S.text.trim().toLowerCase();
  return v.list.filter((l) => `@${l.target} ${loopLabel(l)} ${l.prompt} ${l.by.name}`.toLowerCase().includes(q)).map((loop) => ({ loop }));
};

const LoopPicker = () => {
  const s = useStore();
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  const v = s.loops;
  const items = loopItems();
  const at = Math.min(v.index, Math.max(0, items.length - 1));
  const open = v.open && v.list.find((l) => l.id === v.open);
  const keep = (e) => e.preventDefault();
  if (open) {
    const word = (a) => (a === 'toggle' ? (open.on ? 'turn off' : 'turn on') : a === 'run' ? 'run now' : v.confirm ? 'sure? enter deletes it' : 'delete');
    return html`<div id="rooms" ref=${ref}>
      <div class="title"><button type="button" class="back" onMouseDown=${keep} onClick=${loopsBack}>‹ back</button> <span class="b" style=${{ color: 'var(--fg)' }}>${loopLabel(open)}</span> <span class="b" style=${{ color: nameColor(open.target) }}>→ @${open.target}</span> · ${open.on ? 'on' : 'off'}${isTouch() ? '' : ' · ← or esc back'}
        <div class="loop-prompt">${open.prompt}</div>
        <div>${open.on ? `next ${runAt(open.next)}` : 'off'} · last ${lastRun(open)} · by ${open.by.name}</div>
      </div>
      ${items.map(
        (item, i) => html`<button key=${item.action} type="button" class="row ${i === at ? 'active' : ''}" onMouseDown=${keep} onClick=${() => (set({ loops: { ...S.loops, index: i } }), loopAction(item))}>
          <span class="mark">${i === at ? '›' : ' '}</span><span class=${`room ${item.action === 'delete' && v.confirm ? 'warning' : ''}`}>${word(item.action)}</span>
        </button>`,
      )}
    </div>`;
  }
  const nameW = Math.min(26, Math.max(8, ...items.map((i) => loopLabel(i.loop).length + 2)));
  return html`<div id="rooms" ref=${ref} style=${{ '--nameW': `${nameW}ch` }}>
    <div class="title">loops in ${v.room}${v.list.length ? ` · ${v.list.length}` : ''}</div>
    ${!items.length && html`<span class="muted">${v.list.length ? 'no loop matches' : `no loops in ${v.room} · /loop @agent <prompt> every 2h makes one`}</span>`}
    ${items.map(
      (item, i) => html`<button key=${item.loop.id} type="button" class="row ${i === at ? 'active' : ''}" onMouseDown=${keep} onClick=${() => openLoop(item.loop)}>
        <span class="mark">${i === at ? '›' : ' '}</span><span style=${{ color: item.loop.on ? 'var(--success)' : 'var(--muted)' }}>${item.loop.on ? '●' : '○'}</span> <span class="room">${loopLabel(item.loop)}</span><span style=${{ color: nameColor(item.loop.target) }}>@${item.loop.target}</span>  <span class=${item.loop.on ? '' : 'muted'}>${item.loop.prompt}</span><span class="muted">  · ${item.loop.on ? `next ${runAt(item.loop.next)}` : 'off'} · last ${lastRun(item.loop)}</span>
      </button>`,
    )}
  </div>`;
};

const openLoops = async () => {
  const list = await S.hub.call('loops/list', { room: S.room });
  set({ loops: { room: S.room, list, index: 0, open: null, confirm: false }, popup: { kind: null, items: [], index: 0 } });
  setText('');
  focusInput();
};
const closeLoops = () => {
  set({ loops: null });
  setText('');
};
const openLoop = (loop) => {
  setText('');
  set({ loops: { ...S.loops, open: loop.id, index: 0, confirm: false } });
};
const loopsBack = () => {
  const id = S.loops.open;
  set({ loops: { ...S.loops, open: null, confirm: false, index: 0 } });
  set({ loops: { ...S.loops, index: Math.max(0, loopItems().findIndex((i) => i.loop.id === id)) } });
};
const loopAction = async ({ loop, action }) => {
  const swap = (r) => S.loops && set({ loops: { ...S.loops, confirm: false, list: S.loops.list.map((x) => (x.id === r.id ? r : x)) } });
  try {
    if (action === 'toggle') {
      swap(await S.hub.call('loops/toggle', { id: loop.id, on: !loop.on }));
      return setStatus(`${loop.on ? 'off' : 'on'}: ${loopLabel(loop)} → @${loop.target}`, 'ok', 2500);
    }
    if (action === 'run') {
      const r = await S.hub.call('loops/run', { id: loop.id });
      swap(r);
      return setStatus(r.last?.outcome === 'sent' ? `sent to ${r.last.to.join(', ')}` : `not sent: ${r.last?.why || r.last?.outcome}`, r.last?.outcome === 'sent' ? 'ok' : 'warn', 3000);
    }
    if (!S.loops.confirm) return set({ loops: { ...S.loops, confirm: true } });
    await S.hub.call('loops/delete', { id: loop.id });
    const list = S.loops.list.filter((x) => x.id !== loop.id);
    set({ loops: { ...S.loops, list, open: null, confirm: false, index: 0 } });
    setStatus(`deleted: ${loopLabel(loop)} → @${loop.target}`, 'ok', 2500);
  } catch (error) {
    if (S.loops) set({ loops: { ...S.loops, confirm: false } });
    setStatus(error.message, 'warn', 4000);
  }
};
const loopsKey = (e) => {
  const v = S.loops;
  const items = loopItems();
  if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !e.target.value)) {
    e.preventDefault();
    return v.open ? loopsBack() : closeLoops();
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) return;
    return set({ loops: { ...v, confirm: false, index: (Math.min(v.index, items.length - 1) + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length } });
  }
  if (e.key === 'Enter' || (e.key === 'ArrowRight' && e.target.selectionStart >= e.target.value.length)) {
    e.preventDefault();
    const item = items[Math.min(v.index, items.length - 1)];
    if (!item) return;
    return item.action ? loopAction(item) : openLoop(item.loop);
  }
  // inside a loop there is nothing to type
  if (v.open && e.key.length === 1 && !e.ctrlKey && !e.metaKey) e.preventDefault();
};

const loadRooms = async () => {
  const [rooms, archivedRooms] = await Promise.all([S.hub.call('room/list', {}).catch(() => S.rooms), S.hub.call('room/list', { archived: true }).catch(() => S.archivedRooms || [])]);
  set({ rooms, archivedRooms });
};
const openPicker = async () => {
  set({ picker: { index: 0 }, popup: { kind: null, items: [], index: 0 } });
  setText('');
  await loadRooms();
  set({ picker: { index: Math.max(0, pickerItems().findIndex((i) => i.room === S.room)) } });
  focusInput();
};
const closePicker = () => {
  set({ picker: null });
  setText('');
};
// the list stays until the room is ready, then the room replaces it in one step
const pick = async (item) => {
  if (item.folder) {
    setText('');
    return set({ picker: { index: 0, folder: true } });
  }
  if (item.room === S.room) return closePicker();
  await switchRoom(item.room);
};
const pickerKey = (e) => {
  const items = pickerItems();
  if (e.key === 'Escape') {
    e.preventDefault();
    // in the archived folder: back to the rooms
    if (S.picker.folder) return set({ picker: { index: 0 } });
    return closePicker();
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) return;
    // within the list shown: the archived folder stays open
    return set({ picker: { ...S.picker, index: (Math.min(S.picker.index, items.length - 1) + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length } });
  }
  // in the archived folder, ← (nothing typed) goes back to the rooms, as Esc does
  if (e.key === 'ArrowLeft' && S.picker.folder && !e.target.value) {
    e.preventDefault();
    return set({ picker: { index: 0 } });
  }
  if (e.key === 'Enter' || (e.key === 'ArrowRight' && e.target.selectionStart >= e.target.value.length)) {
    e.preventDefault();
    const item = items[Math.min(S.picker.index, items.length - 1)];
    if (item) pick(item);
  }
};

// Another room: joined and its history fetched while this one (or the room list) stays on
// screen, then room, members, conversation and address change in one render, at its end.
const switchRoom = async (room, { fromHistory = false } = {}) => {
  if (room === S.room) return;
  if (!ROOM.test(room)) return note('a room name is letters, digits, dot, dash or underscore', 'warn');
  const [history] = await Promise.all([S.hub.call('room/history', { room, limit: HISTORY_PAGE }), join(room)]);
  saved.set('tui.room', room);
  if (!fromHistory) showRoom(room);
  S.room = room;
  set({ room, members: roomMembers(S.all), log: conversation(history), scrollEnd: true, picker: null, writeText: true, text: '', popup: { kind: null, items: [], index: 0 }, editing: null, more: null, pinsAll: false, waiting: [], cards: [] });
  loadPins();
  loadWaiting(room);
  markRead();
};

// MARK: members

const roomMembers = (list) => new Map(list.filter((m) => m.room === S.room).map((m) => [m.name, m]));
const members = (list) => set({ all: list, members: roomMembers(list) });

const join = async (room = S.room) => {
  await S.hub.call('agents/register', { name: S.me.name, room, kind: 'human', host: 'web' });
  const j = await S.hub.call('room/join', { room });
  set({ archived: Boolean(j && j.archived) });
  await S.hub.call('agents/status', { status: 'waiting' }).catch(() => {});
};

// MARK: sign in

const InviteLogin = () => {
  const s = useStore();
  const [who, setWho] = useState(saved.get('tui.name') || '');
  const go = () => signIn(INVITE.token, who.trim());
  const copy = (text) => navigator.clipboard?.writeText(text).catch(() => {});
  return html`<div id="login" class="invite">
    <div><span class="b primary">metacom</span><span class="muted"> · you're invited to </span><span class="b">${INVITE.room}</span><span class="muted"> on ${location.host}</span></div>
    <label class="field"><span class="prompt">❯</span><input id="name" placeholder="your name, e.g. alen" autocomplete="off" autocapitalize="off" spellcheck="false" value=${who} onInput=${(e) => setWho(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && go()} /></label>
    <button id="loginBtn" class="go" type="button" onClick=${go}>join ⏎</button>
    <div id="loginError">${s.loginError}</div>
    <div class="steps"><div class="muted">bring your own agent (optional), in a terminal:</div>
      ${agentSteps(INVITE.token, INVITE.room, who.trim()).map(([what, cmd, shown], i) => html`<div class="step"><span class="muted">${i + 1}. ${what}</span><div class="cmd"><code>${shown || cmd}</code><button type="button" class="copylink" onClick=${() => copy(cmd)}>copy</button></div></div>`)}
    </div>
    <details class="steps api"><summary class="muted">or join over the API (HTTPS or WebSocket, this link's token)</summary>
      ${apiSteps(INVITE.token, INVITE.room, who.trim()).map(([what, cmd, shown]) => html`<div class="step"><span class="muted">${what}</span><div class="cmd"><code>${shown || cmd}</code><button type="button" class="copylink" onClick=${() => copy(cmd)}>copy</button></div></div>`)}
      <div class="muted">the same rights as the link: this room, as a user · the methods: README, "Over the API"</div>
    </details>
  </div>`;
};

const Login = () => {
  const s = useStore();
  if (INVITE) return InviteLogin();
  const token = useRef(null);
  const name = useRef(null);
  const go = () => signIn(token.current.value.trim(), name.current.value.trim());
  const enter = (e) => e.key === 'Enter' && go();
  return html`<div id="login">
    <div><span class="b primary">metacom</span><span class="muted"> · sign in</span></div>
    <label class="field"><span class="prompt">❯</span><input id="token" ref=${token} type="password" placeholder="token" autocomplete="off" autocapitalize="off" spellcheck="false" value=${saved.get('tui.token') || saved.get('hub.token') || ''} onKeyDown=${enter} /></label>
    <label class="field"><span class="prompt">❯</span><input id="name" ref=${name} placeholder="your name, e.g. ada" autocomplete="off" autocapitalize="off" spellcheck="false" value=${saved.get('tui.name') || ''} onKeyDown=${enter} /></label>
    <div class="muted">your owner token: on the hub's machine, ~/.local/share/metacom-hub/bootstrap-token.txt, or "token" in ~/.config/metacom-hub/config.json after metacom connect</div>
    <button id="loginBtn" class="go" type="button" onClick=${go}>connect ⏎</button>
    <div id="loginError">${s.loginError}</div>
  </div>`;
};

// sign in with the token and the name you go by in the rooms, both remembered on this device
const signIn = async (token, name) => {
  if (!token || !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) return set({ loginError: !token ? 'a token, please' : 'a name: letters, digits, dot, dash, underscore' });
  set({ loginError: '' });
  const hub = new Hub((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/', token);
  let first = true;
  hub.onOpen = async (me) => {
    set({ me: { name, role: me.role }, hubPreviews: me.previews !== false });
    // a token for some rooms only opens one of them, whatever the address said
    if (me.rooms && !me.rooms.includes(S.room)) {
      S.room = me.rooms[0];
      set({ room: S.room });
    }
    if (!first) {
      await join();
      members(await hub.call('agents/list', {}));
      // what was said here while the connection was down
      await catchUp();
    }
  };
  hub.onState = (on) => {
    if (on) checkVersion();
    // what was answered or asked while away, elsewhere too
    if (on && S.signedIn) loadWaiting();
    if (!on && S.live) endLive('direct view ended: the connection to the hub dropped');
    setBusy(on ? null : 'reconnecting…');
  };
  hub.on('room/message', (m) => {
    if (m.room && m.room !== S.room) return;
    pushMessage(m);
    if (m.to === S.me.name) markRead();
  });
  // an author changed a message: the new version takes its place
  // a request decided: its line shows the decision
  hub.on('room/request', (r) => set({ log: S.log.map((e) => (e.type === 'message' && e.msg.request?.id === r.id ? { ...e, msg: { ...e.msg, request: r } } : e)) }));
  hub.on('room/edit', ({ message: m }) => {
    if (m.room && m.room !== S.room) return;
    // the latest version moves to the bottom of the feed; the old place is gone (the log keeps both)
    const open = S.versions?.[m.id];
    const kept = regroup(S.log.filter((e) => !(e.type === 'message' && e.msg.id === m.id)));
    set({ log: kept, cards: (S.cards || []).filter((c) => c.msg.id !== m.id) });
    pushMessage(m);
    if (open) toggleVersions(m.id).then(() => toggleVersions(m.id));
    if (S.pinIds?.has(m.id)) loadPins();
  });
  // withdrawn by its sender, or replaced by a newer one from it
  hub.on('room/withdrawn', ({ room, ids }) => {
    if (room !== S.room) return;
    for (const id of ids) {
      if (S.replyTo?.id === id && takenUnchanged()) {
        setText('');
        set({ replyTo: null });
      }
      forgetSuggestion(id);
    }
  });
  // put away on another of your devices
  hub.on('room/dismissed', ({ room, id }) => {
    if (room !== S.room) return;
    if (S.replyTo?.id === id && takenUnchanged()) {
      setText('');
      set({ replyTo: null });
    }
    forgetSuggestion(id);
  });
  hub.on('room/pins', ({ room, pins }) => room === S.room && setPins(pins));
  hub.on('room/loops', ({ room, loops }) => S.loops && S.loops.room === room && set({ loops: { ...S.loops, list: loops } }));
  hub.on('room/archived', ({ room, archived }) => {
    if (room === S.room) set({ archived });
    if (S.picker) loadRooms();
  });
  hub.on('hub/prefs', ({ previews: on }) => set({ hubPreviews: on !== false, log: [...S.log] }));
  hub.on('agents/changed', ({ members: list }) => members(list));
  hub.on('agents/liveFrame', (f) => onLiveFrame(f));
  hub.on('agents/liveEnd', ({ name: who, reason }) => {
    if (S.live && S.live.name === who) endLive(`${who}'s direct view ended (${reason})`);
  });
  // the room open here was deleted: off to default, and say why
  hub.on('room/deleted', async ({ room, by }) => {
    if (room !== S.room) return;
    await switchRoom('default');
    note(`${room} was deleted by ${by}`, 'warn');
  });
  set({ hub });
  try {
    await hub.connect();
    first = false;
    await join();
    members(await hub.call('agents/list', {}));
    await load();
    saved.set('tui.token', token);
    saved.set('tui.name', name);
    set({ signedIn: true });
    showRoom(S.room, true);
    if (INVITE && token === INVITE.token) {
      push({ type: 'block', block: html`<div><span class="muted">── bring your own agent ──</span><div class="screen">${agentSteps(token, S.room, name).map(([what, cmd, shown], i) => html`<div><span class="muted">${i + 1}. ${what}</span></div><div><span class="b">${shown || cmd}</span> <button type="button" class="copylink" onClick=${() => copyText(cmd, 'command')}>copy</button></div>`)}</div></div>` });
    }
    restoreDraft();
    focusInput();
  } catch (error) {
    hub.token = null;
    set({ loginError: error.message, hub: null });
  }
};


// MARK: live mode (docs/direct.md). An agent's screen in place of the conversation, as it changes:
// the wrapper sends rows with their colours (SGR), only the rows that changed. Every key goes to
// the agent but Esc, which leaves, as the yellow [× leave] button does; ctrl+Esc (or ctrl+], or the
// bar's esc button) sends Esc to the agent. Owner only (the hub checks).

const LIVE_FIRST_FRAME_MS = 4000;
let liveKeysBuffer = '';
let liveKeysTimer = null;

const startLive = async (name) => {
  const member = S.members.get(name);
  if (member && member.kind !== 'agent') return note(`${name} is a person; direct view is for agents`, 'warn');
  set({ live: { name, cols: 0, rows: 0, cursor: null, lines: [], ready: false } });
  try {
    await S.hub.call('agents/live', { name, on: true });
  } catch (error) {
    set({ live: null });
    throw error;
  }
  // an agent whose wrapper predates live mode never sends a frame: say so rather than show nothing
  setTimeout(() => {
    if (!S.live || S.live.name !== name || S.live.ready) return;
    stopLive().then(() => note(`no screen from ${name}: its wrapper is older than direct view. Restart it to open it directly.`, 'warn'));
  }, LIVE_FIRST_FRAME_MS);
};
const stopLive = async () => {
  const live = S.live;
  if (!live) return;
  flushLiveKeys();
  set({ live: null });
  await S.hub.call('agents/live', { name: live.name, on: false }).catch(() => {});
  focusInput();
};
const endLive = (text) => {
  set({ live: null });
  note(text, 'warn');
};
const onLiveFrame = (f) => {
  const live = S.live;
  if (!live || live.name !== f.name) return;
  const lines = f.full ? new Array(f.rows).fill('') : live.lines.slice(0, f.rows);
  while (lines.length < f.rows) lines.push('');
  for (const [i, line] of Object.entries(f.lines)) lines[Number(i)] = line;
  set({ live: { name: live.name, cols: f.cols, rows: f.rows, cursor: f.cursor, lines, ready: live.ready || f.full, scroll: live.scroll || null } });
};

// MARK: scrolling back while live. Shift+↑↓ (a row), shift+PgUp/PgDn (a page), the wheel or a
// swipe: a screenful from the agent's scrollback, asked from its wrapper, in place of the live
// one; nothing goes to the agent. Any other key (or "↓ live") is back at the bottom, and the key
// goes to the agent as ever.
let scrollWant = null;
let scrollBusy = false;
let scrollGen = 0;
const liveScrollBy = (rows) => liveScrollTo((S.live?.scroll?.offset || 0) + rows);
const liveScrollTo = async (offset) => {
  if (!S.live) return;
  const max = S.live.scroll ? S.live.scroll.max : Infinity;
  offset = Math.max(0, Math.min(max, Math.round(offset)));
  if (offset === 0) return liveBottom();
  scrollWant = offset;
  if (scrollBusy) return;
  scrollBusy = true;
  const gen = scrollGen;
  try {
    while (scrollWant !== null) {
      const want = scrollWant;
      scrollWant = null;
      const r = await S.hub.call('agents/liveScroll', { name: S.live.name, offset: want });
      if (!S.live || S.live.name !== r.name || gen !== scrollGen) break;
      set({ live: { ...S.live, scroll: r.offset ? r : null } });
    }
  } catch (error) {
    setStatus(`scrolling back: ${error.message}`, 'warn', 4000);
  } finally {
    scrollBusy = false;
    scrollWant = null;
  }
};
const liveBottom = () => {
  scrollGen++;
  scrollWant = null;
  if (S.live && S.live.scroll) set({ live: { ...S.live, scroll: null } });
};
const liveKeys = (data) => {
  if (!S.live || !data) return;
  // what goes to the agent brings the live screen back first
  liveBottom();
  liveKeysBuffer += data;
  if (!liveKeysTimer) liveKeysTimer = setTimeout(flushLiveKeys, 25);
};
const flushLiveKeys = () => {
  clearTimeout(liveKeysTimer);
  liveKeysTimer = null;
  const data = liveKeysBuffer;
  liveKeysBuffer = '';
  if (!data || !S.live) return;
  S.hub.call('agents/liveKeys', { name: S.live.name, data }).catch((error) => endLive(`direct view ended: ${error.message}`));
};

/// A browser key as the bytes a terminal would send; null for what is not a key (a lone shift).
const LIVE_KEYS = {
  Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f', Delete: '\x1b[3~', Insert: '\x1b[2~',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};
const keyBytes = (e) => {
  if (e.key === 'Tab' && e.shiftKey) return '\x1b[Z';
  let out = LIVE_KEYS[e.key];
  if (out === undefined) {
    if (e.key.length !== 1) return null;
    out = e.key;
    if (e.ctrlKey) {
      const c = e.key.toLowerCase();
      if (/^[a-z]$/.test(c)) out = String.fromCharCode(c.charCodeAt(0) - 96);
      else if (c === ' ' || c === '@' || c === '2') out = '\x00';
      else if (c === '[') out = '\x1b';
      else if (c === '\\') out = '\x1c';
      else if (c === '^' || c === '6') out = '\x1e';
      else if (c === '_' || c === '-') out = '\x1f';
    }
  }
  return e.altKey ? '\x1b' + out : out;
};
// the keyboard belongs to the agent while live: caught before the page's own handlers
document.addEventListener(
  'keydown',
  (e) => {
    if (!S.live) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc leaves; ctrl+Esc (and ctrl+], a key no agent uses) is Esc for the agent
    if (e.key === 'Escape' && e.ctrlKey) return liveKeys('\x1b');
    if (e.key === 'Escape') return void stopLive();
    // shift+↑↓ a row, shift+PgUp/PgDn a page: scrolling back, not keys for the agent
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const page = Math.max(1, (S.live.rows || 24) - 2);
      const rows = { ArrowUp: 1, ArrowDown: -1, PageUp: page, PageDown: -page }[e.key];
      if (rows) return void liveScrollBy(rows);
    }
    if (e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) return (liveBottom(), liveKeys('\x1b'));
    // cmd+v on a Mac is a paste, handled below; other cmd keys stay the browser's
    if (e.metaKey) return;
    const bytes = keyBytes(e);
    if (bytes) {
      liveBottom();
      liveKeys(bytes);
    }
  },
  true,
);
// shift+↑↓ for the feed when the focus is not in a field (the input handles its own)
document.addEventListener('keydown', (e) => {
  if (S.live || S.picker || S.loops || !S.signedIn) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
  feedKey(e);
});
document.addEventListener(
  'paste',
  (e) => {
    if (!S.live) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text') || '';
    if (text) {
      liveBottom();
      liveKeys(`\x1b[200~${text}\x1b[201~`);
    }
  },
  true,
);

/// A row with its SGR codes as coloured spans.
const ANSI16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const color256 = (n) => {
  if (n < 16) return ANSI16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (v) => (v ? 55 + v * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
};
const sgrSpans = (line) => {
  const out = [];
  let st = {};
  let last = 0;
  const re = /\x1b\[([\d;]*)m/g;
  const emit = (text) => {
    if (!text) return;
    const fg = st.inverse ? st.bg || 'var(--bg)' : st.fg;
    const bg = st.inverse ? st.fg || 'var(--fg)' : st.bg;
    const style = { color: fg, background: bg, fontWeight: st.bold ? 700 : undefined, opacity: st.dim ? 0.6 : undefined, fontStyle: st.italic ? 'italic' : undefined, textDecoration: [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ') || undefined };
    out.push(html`<span style=${style}>${text}</span>`);
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    emit(line.slice(last, m.index));
    last = re.lastIndex;
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) st = {};
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4) st.underline = true;
      else if (n === 7) st.inverse = true;
      else if (n === 9) st.strike = true;
      else if (n >= 30 && n <= 37) st.fg = ANSI16[n - 30];
      else if (n >= 90 && n <= 97) st.fg = ANSI16[n - 90 + 8];
      else if (n >= 40 && n <= 47) st.bg = ANSI16[n - 40];
      else if (n >= 100 && n <= 107) st.bg = ANSI16[n - 100 + 8];
      else if ((n === 38 || n === 48) && p[i + 1] === 5) {
        st[n === 38 ? 'fg' : 'bg'] = color256(p[i + 2]);
        i += 2;
      } else if ((n === 38 || n === 48) && p[i + 1] === 2) {
        st[n === 38 ? 'fg' : 'bg'] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        i += 4;
      }
    }
  }
  emit(line.slice(last));
  return out;
};

/// The agent's screen, its font sized so the agent's width fits the window. A tap focuses a
/// hidden field, so a phone brings its keyboard up; what is typed there goes to the agent.
const LiveScreen = () => {
  const s = useStore();
  const box = useRef(null);
  const [, redraw] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const live = s.live;
  const width = box.current ? box.current.clientWidth : window.innerWidth;
  // a monospace cell is about 0.6em wide; never larger than the page's own text, never too small to
  // read (a phone scrolls sideways instead)
  const size = live.cols ? Math.max(9, Math.min(14, Math.floor((width - 8) / (live.cols * 0.602)))) : 14;
  // the wheel and a vertical swipe scroll back, a row per line's height moved
  const rowPx = size * 1.2;
  const drag = useRef({ y: null, rest: 0 });
  const move = (px) => {
    const d = drag.current;
    d.rest += px;
    const rows = Math.trunc(d.rest / rowPx);
    if (!rows) return;
    d.rest -= rows * rowPx;
    liveScrollBy(rows);
  };
  const lines = live.scroll ? live.scroll.lines : live.lines;
  return html`<div id="live" ref=${box} onClick=${() => document.getElementById('liveType')?.focus()}
      onWheel=${(e) => (e.preventDefault(), move(-e.deltaY))}
      onTouchStart=${(e) => ((drag.current.y = e.touches[0].clientY), (drag.current.rest = 0))}
      onTouchMove=${(e) => {
        const y = e.touches[0].clientY;
        if (drag.current.y !== null) move(y - drag.current.y);
        drag.current.y = y;
      }}>
    ${live.ready ? html`<pre style=${{ fontSize: size + 'px' }}>${lines.map((line) => html`<div class="row">${line ? sgrSpans(line) : ' '}</div>`)}</pre>` : html`<div class="muted">connecting to ${live.name}'s screen…</div>`}
    ${live.scroll && html`<button type="button" class="back" onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => (e.stopPropagation(), liveBottom())}>${isTouch() ? '↓ live' : `scrolled ${live.scroll.offset} up · ↓ to return`}</button>`}
    <input id="liveType" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label=${`type to ${live.name}`}
      onInput=${(e) => {
        const v = e.target.value;
        e.target.value = '';
        if (v) liveKeys(v);
      }} />
  </div>`;
};

/// The bar under the screen: the yellow way out, whose screen it is, and keys a phone lacks.
const LiveBar = () => {
  const s = useStore();
  const live = s.live;
  const m = s.members.get(live.name);
  const st = !m || !m.connected ? 'offline' : m.status === 'waiting' ? 'idle' : m.status;
  const key = (label, bytes) => html`<button type="button" class="livekey" onMouseDown=${(e) => e.preventDefault()} onClick=${() => liveKeys(bytes)}>${label}</button>`;
  return html`<div id="livebar">
    <button type="button" class="leave" onMouseDown=${(e) => e.preventDefault()} onClick=${() => stopLive()}>[× leave]</button>
    <span><span class="success">●</span> <b>${live.name}</b> <span class="muted">direct · ${st}<span class="hint">${live.cols ? ` · ${live.cols}×${live.rows}` : ''} · your keys go to it · shift+↑↓ or shift+PgUp/PgDn scroll back · esc or the yellow button leaves · ctrl+esc sends esc to it</span></span></span>
    <span class="keys">${key('esc', '\x1b')}${key('tab', '\t')}${key('↑', '\x1b[A')}${key('↓', '\x1b[B')}${key('←', '\x1b[D')}${key('→', '\x1b[C')}${key('⏎', '\r')}${key('^C', '\x03')}</span>
  </div>`;
};

// MARK: the page

const App = () => {
  const s = useStore();
  useEffect(() => {
    document.body.classList.toggle('picking', Boolean(s.picker));
    document.body.classList.toggle('living', Boolean(s.live));
  });
  if (!s.signedIn) return html`<${Login} />`;
  if (s.live) return html`<${LiveScreen} /><${LiveBar} />`;
  return html`
    ${s.picker ? html`<${RoomPicker} />` : s.loops ? html`<${LoopPicker} />` : html`<${Feed} />`}
    ${!s.picker && html`<${Pins} />`}
    <${StatusBar} />
    <div class="slot"><${Popup} /></div>
    ${/* the parts that come and go each have a box of their own: one appearing or going can then
        never move the input in the page, and a focused input that moves loses the focus */ ''}
    <${Composer} />
    <${Footer} />
  `;
};

// A page left open (an iPhone's Home Screen app resumes without reloading) keeps the chat it was
// opened with: when it comes back to the front, or its connection does, it asks the hub which web
// chat is current and reloads if that changed. What you were writing, and the message it
// answers, come back after the reload; only an edit, a forward or live mode waits for it.
let loadedVersion = null;
const versionNow = () =>
  fetch('/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && j.web) || null)
    .catch(() => null);
versionNow().then((v) => (loadedVersion = v));
const DRAFT = 'tui.draft';
const checkVersion = async () => {
  const v = await versionNow();
  if (!loadedVersion || !v || v === loadedVersion || S.editing || S.forward || S.live) return;
  if (S.text || S.replyTo) sessionStorage.setItem(DRAFT, JSON.stringify({ room: S.room, text: S.text, replyTo: S.replyTo }));
  location.reload();
};

/// After a reload for a new version: the draft and the reply it was, in the room they were in.
const restoreDraft = () => {
  let d = null;
  try {
    d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null');
  } catch {}
  sessionStorage.removeItem(DRAFT);
  if (!d || d.room !== S.room) return;
  if (d.replyTo) set({ replyTo: d.replyTo });
  if (d.text) setText(d.text);
};
// back to the page (a phone woke it, or the tab came to the front): what was said meanwhile, even
// when the socket survived asleep and never reconnected
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkVersion();
  void catchUp();
});

render(html`<${App} />`, document.getElementById('app'));
// ← anywhere on the page, when no field is being typed in, opens the room list, as ← on an
// empty input does
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
  if (!S.signedIn || S.picker || S.loops) return;
  e.preventDefault();
  openPicker();
});
// back and forward between rooms
window.addEventListener('popstate', () => {
  const room = pathRoom();
  if (room && S.signedIn && room !== S.room) {
    if (S.picker) closePicker();
    if (S.loops) closeLoops();
    switchRoom(room, { fromHistory: true });
  }
});
if (!INVITE && saved.get('tui.token') && saved.get('tui.name')) signIn(saved.get('tui.token'), saved.get('tui.name'));

// Phones: the on-screen keyboard shrinks the visual viewport, not the layout one (iOS), so the
// page is sized to the visual viewport and moved with it; the input stays just above the
// keyboard, and a conversation that was at its end stays at its end.
const vv = window.visualViewport;
const fit = () => {
  if (!vv) return;
  const feed = document.getElementById('feed');
  const atEnd = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const st = document.documentElement.style;
  st.setProperty('--vh', Math.round(vv.height) + 'px');
  st.setProperty('--vv-top', Math.round(vv.offsetTop) + 'px');
  document.body.classList.toggle('keyboard', window.innerHeight - vv.height > 120);
  if (feed && atEnd) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
};
// focusing the input brings the keyboard up: follow it as it opens
document.addEventListener('focusin', () => setTimeout(fit, 250));
document.addEventListener('focusout', () => setTimeout(fit, 250));
if (vv) {
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
window.addEventListener('scroll', () => {
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
});
