import { Box, Text, useBoxMetrics, useCursor } from "ink";
import React, { useRef } from "react";

import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { resolveBorderStyle } from "@/lib/terminal-style";
import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";
import { nameColor } from "@/chat/palette";

/// A row of the input with attachment tokens such as `[image 2.png]` in the accent colour.
/// A token cut by the wrap is shown plain on both rows.
const Tokens = ({ row, tokens, color, muted }: { row: string; tokens: string[]; color: string; muted?: string }) => {
  // a task line: its box dim, and a done one struck through
  const task = tokens.length === 0 && /^(\s*(?:[-*+] )?\[( |x|X)\])(.*)$/.exec(row);
  if (task) {
    const done = task[2] !== " ";
    return (
      <Text>
        <Text color={muted}>{task[1]}</Text>
        <Text color={done ? muted : undefined} strikethrough={done}>
          {task[3]}
        </Text>
      </Text>
    );
  }
  if (tokens.length === 0) return <Text>{row}</Text>;
  const parts: React.ReactNode[] = [];
  let i = 0;
  let last = 0;
  while (i < row.length) {
    const hit = tokens.find((t) => row.startsWith(t, i));
    if (!hit) {
      i++;
      continue;
    }
    if (i > last) parts.push(<Text key={parts.length}>{row.slice(last, i)}</Text>);
    parts.push(
      <Text key={parts.length} color={color}>
        {hit}
      </Text>
    );
    i += hit.length;
    last = i;
  }
  if (last < row.length) parts.push(<Text key={parts.length}>{row.slice(last)}</Text>);
  return <Text>{parts}</Text>;
};

import { INPUT_ROWS, layout, windowOf } from "@/chat/input-layout";
export { INPUT_ROWS, layout, taskLineAt, toggleTaskLine } from "@/chat/input-layout";

/// The input box: a rounded frame in the theme's border colour, a `❯` prompt, character-wrapped
/// lines, a window of INPUT_ROWS rows that follows the cursor, and the real terminal cursor.
/// `tokens` are the attachment placeholders in the text, drawn in the accent colour.
export const Composer = ({ text, cursor, width, placeholder, hint, after, tokens = [], origin, me, boxRef }: { text: string; cursor: number; width: number; placeholder: string; hint?: string; after?: string; tokens?: string[]; origin?: { left: number; top: number }; me?: string; boxRef?: { current: unknown } }) => {
  const theme = useTheme();
  const unicode = useUnicode();
  const own = useRef(null);
  // the app's ref when it gives one (it finds the box on screen for clicks); one ref, so Ink
  // measures the same node and nothing re-renders in a loop
  const ref = (boxRef ?? own) as typeof own;
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const textW = Math.max(10, width - 6);
  const { rows, cursor: at } = layout(text, cursor, textW);
  const top = windowOf(rows.length, at.row);
  const shown = rows.slice(top, top + INPUT_ROWS);
  const above = top;
  const below = rows.length - top - shown.length;
  const cursorRow = at.row - top;
  const measured = metrics.hasMeasured && origin !== undefined;
  // Set during render, as Ink's docs do: useCursor only stores the value and hands it to the
  // renderer in this component's commit, so setting it in an effect left the cursor one render
  // behind the text. Metrics are relative to the parent box; `origin` is where that parent sits
  // on the screen, which is Ink's cursor origin.
  // +1 for the box's top border, +1 more for the "↑ N more lines" row when the window scrolled
  setCursorPosition(measured ? { x: origin.left + metrics.left + 4 + at.col, y: origin.top + metrics.top + 1 + (above > 0 ? 1 : 0) + cursorRow } : undefined);
  const muted = theme.colors.mutedForeground;
  return (
    <Box ref={ref} flexDirection="column" borderStyle={resolveBorderStyle(theme.border.style, unicode)} borderColor={theme.colors.border} paddingX={1} width={width}>
      {above > 0 && (
        <Text color={muted}>
          {"  ↑ "}{above} more line{above > 1 ? "s" : ""}
        </Text>
      )}
      {shown.map((row, i) => (
        <Box key={top + i} flexDirection="row">
          {/* the prompt in your own name's colour: this is you speaking */}
          <Text color={me ? nameColor(me) : theme.colors.primary} bold>
            {top + i === 0 ? "❯ " : "  "}
          </Text>
          {text === "" && i === 0 ? (
            <Text color={muted}>
              {measured ? placeholder : "▌" + placeholder}
              {/* the key that takes a suggestion: dimmer, never part of what it fills in */}
              {hint ? <Text dimColor>{hint}</Text> : null}
            </Text>
          ) : measured || cursorRow !== i ? (
            <Tokens row={row} tokens={tokens} color={theme.colors.accent} muted={muted} />
          ) : (
            <Text>
              {row.slice(0, at.col)}
              <Text inverse>{row.slice(at.col, at.col + 1) || " "}</Text>
              {row.slice(at.col + 1)}
            </Text>
          )}
          {/* after what you typed, dim: what the keys do now (a suggestion taken, unchanged) */}
          {after && text !== "" && i === shown.length - 1 && below === 0 ? <Text dimColor>{after}</Text> : null}
        </Box>
      ))}
      {below > 0 && (
        <Text color={muted}>
          {"  ↓ "}{below} more line{below > 1 ? "s" : ""}
        </Text>
      )}
    </Box>
  );
};
