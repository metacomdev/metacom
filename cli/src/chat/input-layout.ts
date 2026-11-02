// The input box's text, wrapped to its width: which rows show, where the cursor is, and which
// task box a click lands on. Pure, so it is tested without a terminal.
import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

export const INPUT_ROWS = 6;

type Layout = { rows: string[]; cursor: { row: number; col: number }; lines: number[]; first: boolean[] };

/// Character-wrap the editor's lines to `width` columns and find the cursor's visual cell.
export const layout = (text: string, cursor: number, width: number): Layout => {
  const rows: string[] = [];
  const lines: number[] = [];
  const first: boolean[] = [];
  let at = { row: 0, col: 0 };
  let index = 0;
  for (const [n, line] of text.split("\n").entries()) {
    const start = rows.length;
    let cur = "";
    let w = 0;
    if (cursor === index) at = { row: rows.length, col: 0 };
    for (const g of splitGraphemes(line)) {
      const gw = terminalWidth(g);
      if (w + gw > width) {
        rows.push(cur);
        cur = "";
        w = 0;
      }
      cur += g;
      w += gw;
      index += g.length;
      if (cursor === index) at = { row: rows.length, col: w };
    }
    rows.push(cur);
    for (let r = start; r < rows.length; r++) {
      lines[r] = n;
      first[r] = r === start;
    }
    // the cursor at the end of an exactly full row belongs at the start of the next one
    if (w === width && cursor === index) {
      at = { row: rows.length, col: 0 };
      rows.push("");
      lines.push(n);
      first.push(false);
    }
    index += 1;
  }
  return { rows, cursor: at, lines, first };
};

/// The window of rows the box shows: the INPUT_ROWS around the cursor.
export const windowOf = (rowCount: number, cursorRow: number): number => (rowCount > INPUT_ROWS ? Math.max(0, Math.min(cursorRow - INPUT_ROWS + 1, rowCount - INPUT_ROWS)) : 0);

/// A click at (r, c) inside the input box (0-based, from the box's top-left corner): the number of
/// the text line whose task box `[ ]` / `[x]` it landed on, or -1.
export const taskLineAt = (text: string, cursor: number, width: number, r: number, c: number): number => {
  const { rows, cursor: at, lines, first } = layout(text, cursor, Math.max(10, width - 6));
  const top = windowOf(rows.length, at.row);
  const row = top + r - 1 - (top > 0 ? 1 : 0); // the top border, and the "↑ N more lines" row
  if (row < top || row >= Math.min(rows.length, top + INPUT_ROWS) || !first[row]) return -1;
  const m = /^(\s*(?:[-*+] )?)\[( |x|X)\]/.exec(rows[row]!);
  const col = c - 4; // the border, the padding and the "❯ " prompt
  return m && col >= m[1]!.length - 1 && col <= m[1]!.length + 3 ? lines[row]! : -1;
};

/// The line's box ticked, or unticked.
export const toggleTaskLine = (text: string, line: number): string =>
  text
    .split("\n")
    .map((l, i) => (i === line ? l.replace(/^(\s*(?:[-*+] )?)\[( |x|X)\]/, (_, lead: string, b: string) => `${lead}[${b === " " ? "x" : " "}]`) : l))
    .join("\n");
