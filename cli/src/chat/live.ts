// Live mode keys (docs/direct.md): what the chat's terminal sends, turned into what the agent's
// terminal expects. The chat runs with the kitty keyboard protocol on, so some keys arrive as
// CSI <code>;<mods> u; the agents run in a plain xterm, so they get the legacy bytes.
//
//   Esc            leaves live mode (it is not sent); so does the bar's yellow [× leave] button
//   ctrl+Esc       Esc to the agent (terminals with the kitty protocol, and browsers)
//   ctrl+]         Esc to the agent too, for terminals that send ctrl+Esc as a plain Esc
//   anything else  to the agent as typed: letters, Enter, Tab, arrows, ctrl+c, a paste

const ESC = "\u001b";
const KITTY = /\u001b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u/g;
// mouse reports (SGR and X10): the chat's own, never the agent's
const MOUSE = /\u001b\[<\d+;\d+;\d+[Mm]|\u001b\[M[\s\S]{3}/g;

export type LiveInput = { leave: boolean; keys: string };

/// One key in the kitty encoding as legacy bytes, or "leave" for a plain Esc.
const legacy = (code: number, mods: number): string | "leave" => {
  const m = Math.max(0, mods - 1);
  const shift = (m & 1) !== 0;
  const alt = (m & 2) !== 0;
  const ctrl = (m & 4) !== 0;
  if (code === 27) return ctrl ? ESC : "leave";
  let out: string;
  if (code === 13) out = "\r";
  else if (code === 9) out = shift ? "\u001b[Z" : "\t";
  else if (code === 127 || code === 8) out = "\u007f";
  else {
    let ch = String.fromCodePoint(code);
    if (shift && /^[a-z]$/.test(ch)) ch = ch.toUpperCase();
    if (ctrl) {
      const c = ch.toLowerCase();
      if (/^[a-z]$/.test(c)) ch = String.fromCharCode(c.charCodeAt(0) - 96);
      else if (c === " " || c === "@") ch = "\u0000";
      else if (c === "[") ch = ESC;
      else if (c === "\\") ch = "\u001c";
      else if (c === "]") return ESC; // ctrl+] is Esc for the agent
      else if (c === "^") ch = "\u001e";
      else if (c === "_") ch = "\u001f";
    }
    out = ch;
  }
  return alt ? ESC + out : out;
};

/// A chunk from the chat's stdin, as live mode reads it.
export const liveInput = (chunk: string): LiveInput => {
  const seq = chunk.replace(MOUSE, "");
  if (seq === ESC) return { leave: true, keys: "" };
  let leave = false;
  const keys = seq
    .replace(KITTY, (_all, code: string, mods: string | undefined) => {
      const k = legacy(Number(code), Number(mods ?? 1));
      if (k === "leave") {
        leave = true;
        return "";
      }
      return k;
    })
    // ctrl+] in a terminal without the kitty protocol
    .replace(/\u001d/g, ESC);
  return { leave, keys: leave ? "" : keys };
};

/// The rows to show when the agent's screen is taller than the room for it: a window that keeps
/// the cursor in view, the bottom of the screen by default (where an agent's input is).
export const liveWindow = (rows: number, height: number, cursorY: number | null): [number, number] => {
  if (rows <= height) return [0, rows];
  const bottom = rows - height;
  const start = cursorY === null ? bottom : Math.max(0, Math.min(bottom, cursorY - height + 2));
  return [start, start + height];
};

/// Scrolling back while live, from what the chat's terminal sends: rows up (+) or down (-), or 0
/// when it is not such a key. shift+↑↓ (CSI 1;2 A/B), shift+PgUp/PgDn (CSI 5;2~ / 6;2~), the
/// mouse wheel (SGR 64/65, three rows a notch).
export const liveScrollOf = (seq: string, page: number): number => {
  if (seq === "\u001b[1;2A") return 1;
  if (seq === "\u001b[1;2B") return -1;
  if (seq === "\u001b[5;2~") return page;
  if (seq === "\u001b[6;2~") return -page;
  const wheel = [...seq.matchAll(/\u001b\[<(64|65);\d+;\d+M/g)];
  if (wheel.length && seq.replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "") === "") return wheel.reduce((n, m) => n + (m[1] === "64" ? 3 : -3), 0);
  return 0;
};
