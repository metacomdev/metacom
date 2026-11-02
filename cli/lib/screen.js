'use strict';

const crypto = require('node:crypto');
const { Terminal } = require('@xterm/headless');

/// A headless terminal that follows the agent's output, so the wrapper can look at the real
/// screen (including Claude Code's alternate screen) instead of guessing from raw bytes.
/// herdr classifies agents from the bottom of the live screen; this does the same.
/// Rows kept above the screen.
const SCROLLBACK = 2000;

class Screen {
  constructor(cols, rows) {
    // what scrolled off the top is kept for live mode's scrolling back (history())
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: SCROLLBACK });
  }

  /// `parsed` runs once the data is on the screen (xterm parses asynchronously).
  write(data, parsed) {
    this.term.write(data, parsed);
  }

  resize(cols, rows) {
    this.term.resize(cols, rows);
  }

  /// Last `count` non-empty rendered rows, oldest first.
  lines(count = 40) {
    const buffer = this.term.buffer.active;
    const out = [];
    for (let i = buffer.length - 1; i >= 0 && out.length < count; i--) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).trimEnd();
      if (text || out.length) out.push(text);
    }
    return out.reverse();
  }

  /// The visible viewport as rows with their colours (SGR), for live mode: the cursor's cell is
  /// drawn inverse when the cursor is shown. Returns { cols, rows, cursor: [x, y], lines }.
  frame() {
    const term = this.term;
    const buffer = term.buffer.active;
    const top = Math.max(0, Math.min(buffer.baseY, buffer.length - term.rows));
    const cx = buffer.cursorX;
    const cy = buffer.cursorY + buffer.baseY - top;
    const showCursor = !term.modes || term.modes.showCursor !== false;
    const lines = [];
    for (let y = 0; y < term.rows; y++) lines.push(this.row(top + y, showCursor && y === cy ? cx : -1));
    return { cols: term.cols, rows: term.rows, cursor: [cx, cy], lines };
  }

  /// A screenful `offset` rows above the live one (0: the live screen), from the scrollback, for
  /// live mode's scrolling back. `max` is how far back there is to go.
  history(offset) {
    const term = this.term;
    const buffer = term.buffer.active;
    const bottom = Math.max(0, Math.min(buffer.baseY, buffer.length - term.rows));
    const back = Math.max(0, Math.min(bottom, Math.floor(Number(offset)) || 0));
    const lines = [];
    for (let y = 0; y < term.rows; y++) lines.push(this.row(bottom - back + y, -1));
    return { cols: term.cols, rows: term.rows, offset: back, max: bottom, lines };
  }

  /// One buffer row with its colours (SGR); the cell at column `cursorX` drawn inverse.
  row(index, cursorX) {
    const term = this.term;
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    {
      const line = buffer.getLine(index);
      let out = '';
      let last = '0';
      let pending = ''; // trailing default-styled spaces are dropped
      if (line) {
        for (let x = 0; x < term.cols; x++) {
          line.getCell(x, cell);
          if (cell.getWidth() === 0) continue;
          const atCursor = x === cursorX;
          const sgr = sgrOf(cell, atCursor);
          const ch = cell.getChars() || ' ';
          if (sgr === '0' && ch === ' ') {
            pending += ' ';
            continue;
          }
          if (pending) {
            out += (last !== '0' ? '\x1b[0m' : '') + pending;
            last = '0';
            pending = '';
          }
          if (sgr !== last) out += `\x1b[${sgr}m`;
          last = sgr;
          out += ch;
        }
      }
      if (last && last !== '0') out += '\x1b[0m';
      return out;
    }
  }

  /// The visible viewport only (rows on screen), for blocked detection.
  visible() {
    const buffer = this.term.buffer.active;
    const rows = this.term.rows;
    const out = [];
    const top = Math.max(0, Math.min(buffer.baseY, buffer.length - rows));
    for (let i = top; i < Math.min(buffer.length, top + rows); i++) {
      const line = buffer.getLine(i);
      if (line) out.push(line.translateToString(true).trimEnd());
    }
    return out;
  }
}

/// A cell's look as SGR parameters ("0" for the default), for frame().
const sgrOf = (cell, inverse) => {
  const p = [];
  if (cell.isBold()) p.push(1);
  if (cell.isDim()) p.push(2);
  if (cell.isItalic()) p.push(3);
  if (cell.isUnderline()) p.push(4);
  if (Boolean(cell.isInverse()) !== Boolean(inverse)) p.push(7);
  if (cell.isStrikethrough && cell.isStrikethrough()) p.push(9);
  const color = (fg) => {
    const c = fg ? cell.getFgColor() : cell.getBgColor();
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return;
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return p.push(fg ? 38 : 48, 2, (c >> 16) & 255, (c >> 8) & 255, c & 255);
    if (c < 8) return p.push((fg ? 30 : 40) + c);
    if (c < 16) return p.push((fg ? 90 : 100) + c - 8);
    p.push(fg ? 38 : 48, 5, c);
  };
  color(true);
  color(false);
  return p.length ? '0;' + p.join(';') : '0';
};

// Visible shapes of "the agent needs an answer": Claude Code permission and question dialogs,
// Codex approvals, generic y/n prompts. Deliberately strict, as herdr does: a miss shows idle,
// never blocked, and nothing is typed on a false idle because the owner sees the screen.
const BLOCKED = [
  /Do you want to (proceed|make this edit|run|allow|create)/i,
  /Esc to cancel|Enter to confirm|Enter to select/i,
  /Yes, (allow|and don't ask|don't ask again)/i,
  /tell Claude what to do/i,
  /\(y\/n\)|\[Y\/n\]|\[y\/N\]/,
  /Allow (this )?command\?|Approve\?|approval required/i,
  /Quick safety check|trust this folder|\d\. Trust folder \(/i,
  /Select an option|Choose an option/i,
  /Permission required|Allow always|Always allow/i,
  // an agent that has not been logged in yet is waiting for a person, not for work
  /Sign in with|Press enter to continue|paste your API key|How would you like to authenticate/i,
  // Codex's own dialogs (its update offer: "1. Update now" is the default, so a command typed in
  // would accept it): their footer is "enter continue · esc skip"
  /enter (to )?continue\s*·\s*esc/i,
];

// Rows that belong to a dialog rather than to normal output: options, pointers, box borders.
const FURNITURE = /^\s*(❯|›|>|\d+\.|\(|[╭╰│─├┤┃┏┗]|esc\b|enter\b|\[|yes\b|no\b|tab\b|↑|↓|allow\b|deny\b|always\b|approve\b|reject\b|accept\b|cancel\b)/i;

/// The question the agent is stuck on, or null. A question counts only while it is still the
/// bottom of the screen: once ordinary output follows it, it was answered.
const blockedReason = (rows) => {
  const kept = rows.filter((r) => r && r.trim());
  // a boxed dialog (Gemini CLI) that is the bottom of the screen is unanswered, whatever is in the box
  if (kept.length && /^\s*╰─/.test(kept[kept.length - 1])) {
    let top = kept.length - 2;
    while (top >= 0 && !/^\s*╭─/.test(kept[top])) top--;
    for (const r of top >= 0 ? kept.slice(top + 1, -1).map(unbox) : []) {
      for (const re of BLOCKED) {
        const m = r.match(re);
        if (m) return m[0];
      }
    }
  }
  const tail = kept.map(unbox).filter((r) => r.trim()).slice(-8);
  for (let i = tail.length - 1; i >= 0; i--) {
    for (const re of BLOCKED) {
      const m = tail[i].match(re);
      if (!m) continue;
      const after = tail.slice(i + 1);
      return after.every((r) => FURNITURE.test(r)) ? m[0] : null;
    }
  }
  return null;
};

// MARK: the question as a message: what it asks and its options, so the owner can answer by reply

const RULE = /^\s*[─━]{20,}\s*$/;
const FOOTER = /Esc to cancel|Enter to confirm|Enter to select|Tab to amend|↑\/↓ to (navigate|select)|enter (to )?continue\s*·\s*esc/i;
const POINTER = /^(\s*)([❯›>●])\s+/;
const NUMBERED = /^(\s*)(?:[❯›>●]\s+)?(\d+)\.\s+(.*)$/;
// Gemini CLI draws its dialogs in a box: ╭─╮ on top, │ on both sides of every row
const BOX_TOP = /^\s*╭─+╮\s*$/;
const unbox = (r) => (/^\s*│.*│\s*$/.test(r) ? r.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '') : r);
const YES_NO = /\(y\/n\)|\[Y\/n\]|\[y\/N\]/;
const MAX_LINES = 14;
const COUNTDOWN = /automatically (deny|approve|allow|reject|cancel)\w* (this|the) request in \d|on an unattended session$/i;
/// Text without what changes while a question waits: clocks (0:05, 12:03:44) and durations (5s, 3 min).
const steady = (t) => String(t).replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '#').replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|secs?|seconds?|m|mins?|minutes?)\b/gi, '#');
const MAX_CHARS = 900;

/// The dialog at the bottom of the screen as { id, text, options: [{ label, keys? }], pointer }, or
/// null when there is none. `text` is what the dialog says above its options (title, command,
/// question); `pointer` is the option the cursor is on, so an answer knows how far to move.
/// Options are the numbered ones (Claude Code's permission dialogs, wrapped lines joined) or, without
/// numbers, the run of lines aligned with the ❯ line (its trust dialog). A y/n prompt gets Yes/No,
/// typed as y or n.
const questionOf = (rows) => {
  if (!blockedReason(rows)) return null;
  const all = rows.map((r) => r.replace(/\s+$/, ''));
  // the dialog: below the last horizontal rule (or inside the last box), without its footer
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (RULE.test(all[i]) || BOX_TOP.test(all[i])) { start = i + 1; break; }
  const region = all.slice(start).filter((r) => !/^\s*╰─+╯\s*$/.test(r)).map(unbox).filter((r) => r.trim() && !FOOTER.test(r) && !/^\s*Tip:/.test(r));
  const options = [];
  let pointer = 0;
  let first = -1;
  const numbered = region.map((r) => NUMBERED.exec(r));
  if (numbered.some(Boolean)) {
    first = numbered.findIndex(Boolean);
    let indent = 0;
    for (let i = first; i < region.length; i++) {
      const m = numbered[i];
      if (m) {
        indent = region[i].indexOf(m[3]);
        if (POINTER.test(region[i])) pointer = options.length;
        options.push({ label: m[3].trim() });
      } else if (options.length && region[i].search(/\S/) >= indent) options[options.length - 1].label += ' ' + region[i].trim();
      else break;
    }
  } else {
    const at = region.findIndex((r) => POINTER.test(r));
    if (at >= 0) {
      const col = (r) => (POINTER.test(r) ? r.indexOf(r.replace(POINTER, '')) : r.search(/\S/));
      const c = col(region[at]);
      first = at;
      while (first > 0 && col(region[first - 1]) === c && !POINTER.test(region[first - 1])) first--;
      // the line just above a run of options is the question, not an option: it is never part of the run
      // unless it is aligned with them, which only options are
      let end = at;
      while (end + 1 < region.length && col(region[end + 1]) === c) end++;
      for (let i = first; i <= end; i++) {
        if (POINTER.test(region[i])) pointer = options.length;
        options.push({ label: region[i].replace(POINTER, '').trim() });
      }
      if (options.length < 2) {
        options.length = 0;
        first = -1;
      }
    }
  }
  if (!options.length && YES_NO.test(region.join('\n'))) options.push({ label: 'Yes', keys: 'y\r' }, { label: 'No', keys: 'n\r' });
  const above = (first >= 0 ? region.slice(0, first) : region).map((r) => r.replace(/^\s*│\s?/, '').trim()).filter(Boolean);
  // Claude Code's "will automatically deny this request in 0:05" counts down every second: it is
  // not part of the question, and stale as soon as it is sent
  let text = above.filter((l) => !COUNTDOWN.test(l)).slice(-MAX_LINES).join('\n');
  if (text.length > MAX_CHARS) text = '…' + text.slice(-MAX_CHARS);
  if (!text) text = blockedReason(rows);
  // the same question while a timer on it ticks keeps its id, so it is asked once
  const id = crypto.createHash('sha256').update(JSON.stringify([steady(text), options.map((o) => steady(o.label))])).digest('hex').slice(0, 12);
  return { id, text, options: options.map((o) => ({ ...o, label: o.label.slice(0, 200) })), pointer };
};

// An agent that has hit its plan's limit says so on screen: Claude Code "You've hit your weekly
// limit · resets 5am (Europe/Berlin)", Codex "You've hit your usage limit …".
// Only as a line of its own (after a status mark such as ⎿ or ■), so an agent quoting it is no limit.
const LIMIT = /^\s*(?:[⎿■⚠✗×!>│]\s*)?((?:you'?ve|you have) (?:hit|reached) your [\w-]+(?: [\w-]+)? limit[^\n]*)/i;

/// The limit line at the bottom of the screen, or null.
const limitOf = (rows) => {
  const tail = rows.filter(Boolean).slice(-14);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(LIMIT);
    if (m) return m[1].trim();
  }
  return null;
};

module.exports = { Screen, blockedReason, questionOf, limitOf };
