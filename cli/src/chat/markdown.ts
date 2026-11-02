import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

/// Messages are written the way people write to agents: numbered steps, bullets, `code`,
/// **bold**, a fenced block now and then. A terminal chat that prints them as one flat
/// paragraph loses the shape of what was said, so the chat reads the markdown and draws it —
/// a list keeps its hanging indent, code keeps its colour, and the text stays selectable,
/// because every line still knows exactly which characters it shows.

export type Tone = "code" | "mention" | "muted" | "rule" | "link" | "accent";
export type Span = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; inverse?: boolean; tone?: Tone; name?: string };
export type Line = { text: string; spans: Span[] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
/// A task line: `- [ ] …` or `- [x] …`, drawn as its box and the text (struck through when done).
export const TASK = /^(\s*)(?:([-*+]) )?\[( |x|X)\](?: (.*))?$/;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const CODE = /`([^`\n]+)`/;
const BOLD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/;
const ITALIC = /(?:^|(?<=[^\w*]))\*([^*\n]+)\*(?![\w*])|(?:^|(?<=[^\w_]))_([^_\n]+)_(?![\w_])/;
const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/giu;
// What a click opens: a web address, or a file token as the chat writes it, "[image 2.png]".
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const FILE_TOKEN = /\[([^\[\]\n]{1,120}\.[a-z0-9]{1,6})\]/gi;

type Style = { bold?: boolean; italic?: boolean; tone?: Tone };
type IsMember = (name: string) => boolean;

const add = (out: Span[], text: string, style: Style, name?: string): void => {
  if (!text) return;
  out.push(name ? { text, ...style, name } : { text, ...style });
};

/// Web addresses and "[file.ext]" tokens, underlined: a click opens them. The rest goes on to
/// the mentions.
const links = (text: string, style: Style, isMember: IsMember): Span[] => {
  const found = [...text.matchAll(URL_RE), ...text.matchAll(FILE_TOKEN)].sort((a, b) => a.index! - b.index!);
  const out: Span[] = [];
  let last = 0;
  for (const m of found) {
    if (m.index! < last) continue;
    out.push(...mentions(text.slice(last, m.index), style, isMember));
    add(out, m[0], { ...style, tone: "link" });
    last = m.index! + m[0].length;
  }
  out.push(...mentions(text.slice(last), style, isMember));
  return out;
};

/// @mentions of people who are actually here, so a name lights up in its own colour.
const mentions = (text: string, style: Style, isMember: IsMember): Span[] => {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const word = m[2]!;
    if (!isMember(word)) continue;
    const start = m.index! + m[1]!.length;
    add(out, text.slice(last, start), style);
    add(out, `@${word}`, { ...style, tone: "mention" }, word);
    last = m.index! + m[0].length;
  }
  add(out, text.slice(last), style);
  return out;
};

/// `code`, **bold**, *italic* and mentions, in that order: the marks come off the text, which
/// is what the reader sees and therefore what a selection copies.
export const inline = (text: string, isMember: IsMember, style: Style = {}): Span[] => {
  const code = CODE.exec(text);
  if (code) {
    return [
      ...inline(text.slice(0, code.index), isMember, style),
      { text: code[1]!, ...style, tone: "code" },
      ...inline(text.slice(code.index + code[0].length), isMember, style),
    ];
  }
  const bold = BOLD.exec(text);
  if (bold) {
    return [
      ...inline(text.slice(0, bold.index), isMember, style),
      ...inline(bold[1] ?? bold[2]!, isMember, { ...style, bold: true }),
      ...inline(text.slice(bold.index + bold[0].length), isMember, style),
    ];
  }
  const italic = ITALIC.exec(text);
  if (italic) {
    const body = italic[1] ?? italic[2]!;
    const at = text.indexOf(body, italic.index) - 1;
    return [
      ...inline(text.slice(0, at), isMember, style),
      ...inline(body, isMember, { ...style, italic: true }),
      ...inline(text.slice(at + body.length + 2), isMember, style),
    ];
  }
  return links(text, style, isMember);
};

export type LinkTarget = { url: string } | { file: string } | { name: string };

/// What sits under a click in a message body: `lines` are the body's drawn lines, `row` the
/// one clicked, `col` the terminal column within it. A web address (followed onto the next
/// line when it wraps there), a "[file.ext]" token or a name of an attached file, or a person —
/// "@name", or a bare name of someone here.
export const linkAt = (lines: string[], row: number, col: number, ctx: { files: string[]; isMember: IsMember; me: string; width?: number }): LinkTarget | undefined => {
  const line = lines[row];
  if (line === undefined || col < 0) return;
  // the character under the column, counting wide characters as the terminal does
  let at = -1;
  let x = 0;
  let i = 0;
  for (const g of splitGraphemes(line)) {
    const w = terminalWidth(g);
    if (col >= x && col < x + Math.max(1, w)) {
      at = i;
      break;
    }
    x += w;
    i += g.length;
  }
  if (at < 0) return;
  const hit = (re: RegExp, text: string, pos = at) => [...text.matchAll(re)].find((m) => m.index! <= pos && pos < m.index! + m[0].length);
  // A web address too long for a line is cut mid-word onto the lines after it: every line of it
  // but the last is full, ends in a non-space, and the next goes on after its indent (a list's
  // hang, a quote's bar). Those lines are joined, from wherever the click is, back and forth, so the whole
  // address opens. With the width unknown, any line ending in a word joins the next.
  const full = (k: number) => (ctx.width ? terminalWidth(lines[k]!) >= ctx.width : true);
  // what a continued line starts with before the address goes on: a list's hang, a quote's bar
  const LEAD = /^[\s│]*/;
  const joins = (k: number) => k >= 0 && k + 1 < lines.length && full(k) && /\S$/.test(lines[k]!) && /\S/.test(lines[k + 1]!.replace(LEAD, ""));
  let first = row;
  while (joins(first - 1)) first--;
  let last = row;
  while (joins(last)) last++;
  let joined = "";
  let pos = -1;
  for (let k = first; k <= last; k++) {
    const text = k === first ? lines[k]! : lines[k]!.replace(LEAD, "");
    const lead = lines[k]!.length - text.length;
    if (k === row) pos = at < lead ? -1 : joined.length + at - lead;
    joined += text;
  }
  const url = pos >= 0 ? hit(URL_RE, joined, pos) : undefined;
  if (url) return { url: url[0] };
  const token = hit(FILE_TOKEN, line);
  if (token) return { file: token[1]! };
  for (const f of ctx.files) {
    for (let k = line.indexOf(f); k >= 0; k = line.indexOf(f, k + 1)) if (k <= at && at < k + f.length) return { file: f };
  }
  const word = hit(/@?[a-z0-9][a-z0-9._-]*/giu, line);
  if (word) {
    const name = word[0].replace(/^@/, "").replace(/[._-]+$/, "");
    if (name !== ctx.me && ctx.isMember(name)) return { name };
  }
  return;
};

const widthOf = (spans: Span[]): number => spans.reduce((n, s) => n + terminalWidth(s.text), 0);
const lineOf = (spans: Span[]): Line => ({ text: spans.map((s) => s.text).join(""), spans });

/// Words with the style they carry, so wrapping can move them between lines.
const words = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const span of spans) {
    for (const part of span.text.split(/(\s+)/)) {
      if (part) out.push({ ...span, text: part });
    }
  }
  return out;
};

/// A paragraph, list item or quote laid out in `width` columns: the first line starts after
/// `lead`, every line after it under `hang`, which is how a numbered step keeps its shape.
export const wrapSpans = (spans: Span[], width: number, lead: Span[] = [], hang = ""): Line[] => {
  const room = Math.max(1, width);
  const out: Line[] = [];
  let current: Span[] = [...lead];
  let used = widthOf(lead);
  const indent: Span[] = hang ? [{ text: hang }] : [];
  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1]!.text.trim() === "") current.pop();
    out.push(lineOf(current));
    current = [...indent];
    used = terminalWidth(hang);
  };
  for (const word of words(spans)) {
    const w = terminalWidth(word.text);
    const blank = word.text.trim() === "";
    if (blank && current.length === indent.length && out.length > 0) continue; // no space after a wrap
    if (used + w > room && !blank && current.length > (out.length === 0 ? lead.length : indent.length)) flush();
    // a word longer than the line (a url, a path) is cut rather than pushing the layout out
    if (w > room) {
      const rest = splitGraphemes(word.text);
      while (rest.length > 0) {
        const free = room - used;
        const take: string[] = [];
        let taken = 0;
        while (rest.length > 0 && taken + terminalWidth(rest[0]!) <= free) {
          taken += terminalWidth(rest[0]!);
          take.push(rest.shift()!);
        }
        if (take.length === 0) {
          // not even one character fits: on a fresh line take one anyway (a wide glyph in a
          // one-column room, or a hang as wide as the room), or this loops until memory runs out
          if (used <= terminalWidth(hang) || current.length === 0) {
            const g = rest.shift()!;
            take.push(g);
            taken += terminalWidth(g);
          }
          else {
            flush();
            continue;
          }
        }
        current.push({ ...word, text: take.join("") });
        used += taken;
        if (rest.length > 0) flush();
      }
      continue;
    }
    current.push(word);
    used += w;
  }
  if (current.length > indent.length || out.length === 0) flush();
  return out;
};

const hardLines = (text: string, width: number, style: Style): Line[] => {
  const out: Line[] = [];
  let rest = splitGraphemes(text);
  do {
    const take: string[] = [];
    let taken = 0;
    while (rest.length > 0 && taken + terminalWidth(rest[0]!) <= Math.max(1, width)) {
      taken += terminalWidth(rest[0]!);
      take.push(rest.shift()!);
    }
    // a character wider than the room still goes on a line of its own, or rest never shrinks
    if (take.length === 0 && rest.length > 0) take.push(rest.shift()!);
    out.push(lineOf([{ text: take.join(""), ...style }]));
  } while (rest.length > 0);
  return out;
};

/// A message body as the screen shows it. One entry per drawn line: `text` is exactly what
/// that line prints (what a selection copies), `spans` how it is coloured.
// MARK: tables (GFM), drawn with box-drawing characters to fit the width: cells wrap, the widest
// text column gives way first; a row whose first cell is **bold** and the rest empty is a band
// (an inverted row across the table); a negative number in a right-aligned column is inverted.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const NEGATIVE = /^\s*[-−]\s*\d/;

export const renderTable = (head: string[], align: ("left" | "right" | "center")[], body: string[][], width: number, isMember: IsMember): Line[] => {
  const n = head.length;
  const rows = body.map((r) => [...r, ...Array<string>(n).fill("")].slice(0, n));
  const isBand = (r: string[]) => /^\*\*.+\*\*$/.test(r[0] ?? "") && r.slice(1).every((c) => !c);
  const parts = (t: string) => t.split(/<br\s*\/?>/i);
  const natural = (t: string) => Math.max(0, ...parts(t).map((p) => widthOf(inline(p, isMember))));
  const cellsIn = (c: number) => [head[c]!, ...rows.filter((r) => !isBand(r)).map((r) => r[c]!)];
  const want = head.map((_, c) => Math.max(1, ...cellsIn(c).map(natural)));
  // at least its longest word (a number is one word), so words wrap whole
  const longestWord = (t: string) => Math.max(0, ...parts(t).flatMap((p) => inline(p, isMember).map((sp) => sp.text).join("").split(/\s+/).map((x) => terminalWidth(x))));
  const least = head.map((_, c) => Math.min(want[c]!, Math.max(3, ...cellsIn(c).map(longestWord))));
  const inner = (ws: number[]) => ws.reduce((a, b) => a + b + 2, 0) + (n - 1);
  const room = width - 2 - (inner(want) - want.reduce((a, b) => a + b, 0)); // for text, borders and padding taken off
  let w = [...want];
  if (inner(want) + 2 > width) {
    const base = least.reduce((a, b) => a + b, 0);
    if (base <= room) {
      // the room left over goes to each column in proportion to how much more it would like
      const extra = room - base;
      const more = want.map((x, c) => x - least[c]!);
      const total = more.reduce((a, b) => a + b, 0) || 1;
      w = least.map((x, c) => x + Math.floor((extra * more[c]!) / total));
    } else {
      // not even the words fit: the widest columns give way, down to 3
      w = [...least];
      while (inner(w) + 2 > width) {
        const i = w.indexOf(Math.max(...w));
        if (w[i]! <= 3) break;
        w[i]! -= 1;
      }
    }
  }
  const muted = (text: string): Span => ({ text, tone: "muted" });
  const border = (l: string, m: string, r: string) => lineOf([muted(l + w.map((x) => "─".repeat(x + 2)).join(m) + r)]);
  const cellLines = (t: string, c: number, style: Style): Line[] =>
    parts(t).flatMap((p) => (p.trim() ? wrapSpans(inline(p, isMember, style), w[c]!) : [{ text: "", spans: [] }]));
  const rowLines = (r: string[], style: Style): Line[] => {
    const cells = r.map((t, c) => cellLines(t, c, style));
    const height = Math.max(1, ...cells.map((l) => l.length));
    const out: Line[] = [];
    for (let k = 0; k < height; k++) {
      const spans: Span[] = [muted("│")];
      r.forEach((t, c) => {
        const line = cells[c]![k] ?? { text: "", spans: [] };
        const free = Math.max(0, w[c]! - terminalWidth(line.text));
        const neg = align[c] === "right" && NEGATIVE.test(t);
        // a negative number: the accent colour, bold (the gap still to close)
        const body = neg ? line.spans.map((sp) => ({ ...sp, tone: "accent" as Tone, bold: true })) : line.spans;
        const left = align[c] === "right" ? free : align[c] === "center" ? Math.floor(free / 2) : 0;
        spans.push({ text: " " + " ".repeat(left) }, ...body, { text: " ".repeat(free - left) + " " }, muted("│"));
      });
      out.push(lineOf(spans));
    }
    return out;
  };
  const out: Line[] = [border("┌", "┬", "┐"), ...rowLines(head, { bold: true }), border("├", "┼", "┤")];
  for (const r of rows) {
    if (isBand(r)) {
      const room = inner(w);
      const text = inline(r[0]!, isMember).map((sp) => sp.text).join("");
      const cut = terminalWidth(text) > room - 2 ? splitGraphemes(text).slice(0, Math.max(1, room - 3)).join("") + "…" : text;
      out.push(lineOf([muted("│"), { text: (" " + cut).padEnd(room), inverse: true, bold: true }, muted("│")]));
    } else out.push(...rowLines(r, {}));
  }
  out.push(border("└", "┴", "┘"));
  return out;
};

export const renderBody = (body: string, width: number, isMember: IsMember = () => false): Line[] => {
  const out: Line[] = [];
  let fenced = false;
  const all = body.split("\n");
  for (let i = 0; i < all.length; i++) {
    const raw = all[i]!;
    if (!fenced && TABLE_ROW.test(raw) && TABLE_SEP.test(all[i + 1] ?? "")) {
      const align = cellsOf(all[i + 1]!).map((a) => (a.startsWith(":") && a.endsWith(":") ? "center" : a.endsWith(":") ? "right" : "left")) as ("left" | "right" | "center")[];
      let j = i + 2;
      const rows: string[][] = [];
      while (j < all.length && TABLE_ROW.test(all[j]!)) rows.push(cellsOf(all[j++]!));
      out.push(...renderTable(cellsOf(raw), align, rows, width, isMember));
      i = j - 1;
      continue;
    }
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(...hardLines("  " + raw.replace(/\t/g, "  "), width, { tone: "code" }));
      continue;
    }
    if (raw.trim() === "") {
      out.push({ text: "", spans: [] });
      continue;
    }
    if (RULE.test(raw)) {
      out.push(lineOf([{ text: "─".repeat(Math.max(1, Math.min(width, 40))), tone: "rule" }]));
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push(...wrapSpans(inline(heading[2]!, isMember, { bold: true }), width));
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      const lead: Span[] = [{ text: `${quote[1]}│ `, tone: "muted" }];
      out.push(...wrapSpans(inline(quote[2]!, isMember, { tone: "muted" }), width, lead, `${quote[1]}│ `));
      continue;
    }
    const task = TASK.exec(raw);
    if (task) {
      const [, pad, , box, rest = ""] = task as unknown as [string, string, string, string, string | undefined];
      const done = box !== " ";
      const mark = `${pad}${done ? "[x]" : "[ ]"} `;
      const lead: Span[] = [{ text: mark, tone: "muted" }];
      const body = inline(rest, isMember, done ? { tone: "muted" } : {}).map((sp) => (done ? { ...sp, strike: true } : sp));
      out.push(...wrapSpans(body, width, lead, " ".repeat(terminalWidth(mark))));
      continue;
    }
    const item = ORDERED.exec(raw) ?? BULLET.exec(raw);
    if (item) {
      const [, pad, mark, rest] = item as unknown as [string, string, string, string];
      const bullet = /^\d/.test(mark) ? mark : "·";
      const lead: Span[] = [{ text: `${pad}${bullet} `, tone: /^\d/.test(mark) ? undefined : "muted" }];
      out.push(...wrapSpans(inline(rest, isMember), width, lead, " ".repeat(terminalWidth(`${pad}${bullet} `))));
      continue;
    }
    const pad = /^\s*/.exec(raw)![0];
    const lead: Span[] = pad ? [{ text: pad }] : [];
    out.push(...wrapSpans(inline(raw.slice(pad.length), isMember), width, lead, pad));
  }
  return out;
};

/// Just the text of each drawn line: what selection and copy work on.
export const bodyTextLines = (body: string, width: number): string[] => renderBody(body, width).map((l) => l.text);
