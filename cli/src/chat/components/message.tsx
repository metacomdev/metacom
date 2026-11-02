import { Box, Text, type DOMElement } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";
import { type Selection, sliceOf } from "@/chat/selection";
import { type Line, type Span, renderBody } from "@/chat/markdown";
import { Name } from "@/chat/components/text";
import { nameColor } from "@/chat/palette";
import type { Media, Member, Message } from "@/chat/store";

/// The row of actions under a message: reply, ⋯ (forward, edit, pin), then one button per attached file.
/// Each is a glyph and a word, and the gaps are fixed, so a click can be turned back into an
/// action without measuring the screen.
export const ACTIONS = [
  { name: "reply", text: "↩ reply" },
  { name: "more", text: "⋯" },
] as const;
export type Action = (typeof ACTIONS)[number]["name"] | "file" | "forward" | "edit" | "versions" | "pin" | "unpin" | "cancel";
/// What ⋯ opened under a message: edit (your own) and pin or unpin. null while it is closed. Or,
/// for the message you are replying to or forwarding, that alone: its one button cancels it.
export type Menu = { mine: boolean; pinned: boolean; edited?: boolean } | "replying" | "forwarding" | null;
const GAP = 2;
const MAX_FILE_LABEL = 32;

const fileLabel = (m: Media): string => {
  const g = splitGraphemes(m.name);
  return "↗ " + (g.length > MAX_FILE_LABEL ? g.slice(0, MAX_FILE_LABEL - 1).join("") + "…" : m.name);
};

const buttons = (media: Media[] = [], menu: Menu = null): { action: Action; text: string; file?: Media }[] =>
  menu === "replying" ? [{ action: "cancel", text: "↩ replying" }] : menu === "forwarding" ? [{ action: "cancel", text: "↪ forwarding" }] : [
  ...ACTIONS.map((a) => ({ action: a.name as Action, text: a.text })),
  ...(menu ? [{ action: "forward" as const, text: "↪ forward" }, ...(menu.mine ? [{ action: "edit" as const, text: "✎ edit" }] : []), ...(menu.edited ? [{ action: "versions" as const, text: "≡ versions" }] : []), menu.pinned ? { action: "unpin" as const, text: "⚐ unpin" } : { action: "pin" as const, text: "⚑ pin" }] : []),
  ...media.map((m) => ({ action: "file" as const, text: fileLabel(m), file: m })),
];

export const actionsText = (media?: Media[], menu: Menu = null): string =>
  buttons(media, menu)
    .map((b) => b.text)
    .join(" ".repeat(GAP));

/// Which action a click at column `c` (0-based, relative to the row's left edge) landed on,
/// and for a file button, which file.
export const actionAt = (c: number, media?: Media[], menu: Menu = null): { action: Action; file?: Media } | undefined => {
  let col = 0;
  for (const b of buttons(media, menu)) {
    const w = terminalWidth(b.text);
    if (c >= col && c < col + w) return { action: b.action, file: b.file };
    col += w + GAP;
  }
  return undefined;
};

/// A forwarded message carries where it came from at the front of its text, so an agent
/// reading its terminal sees it. On screen it belongs beside the time instead.
export const FORWARDED = /^\[forwarded from ([^\]]+)\]\s*/;
export const bodyOf = (text: string): string => text.replace(FORWARDED, "");

/// "14:52" today; "yesterday 14:52", "12 Oct 14:52" (and the year, if not this one) before.
export const time = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(d)) / 86400000);
  if (ago <= 0) return hm;
  if (ago === 1) return `yesterday ${hm}`;
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}${year} ${hm}`;
};

/// A room message in two lines: who and when on top, the text below at full width. Consecutive
/// messages from one sender drop the header, so a burst reads as one block. Directed messages
/// carry an arrow to the recipient; control commands are set apart in the accent colour.
/// One span of a drawn line, in the colour its markdown asks for.
const SpanText = ({ span }: { span: Span }) => {
  const theme = useTheme();
  const tone =
    span.tone === "code" || span.tone === "accent"
      ? theme.colors.accent
      : span.tone === "mention"
        ? nameColor(span.name ?? span.text.replace(/^@/, ""))
        : span.tone === "muted" || span.tone === "rule"
          ? theme.colors.mutedForeground
          : undefined;
  return (
    <Text color={span.tone === "link" ? theme.colors.info ?? theme.colors.accent : tone} bold={span.bold || span.tone === "mention"} italic={span.italic} strikethrough={span.strike} inverse={span.inverse} underline={span.tone === "link"}>
      {span.text}
    </Text>
  );
};

/// One line of a message body. A selected part is drawn inverse, which is how a terminal
/// shows its own selection, so a drag looks the way it does everywhere else; the styling
/// steps aside while it is selected, because a terminal shows one selection colour.
const BodyLine = ({ line, row, left, selection }: { line: Line; row: number; left: number; selection: Selection | null }) => {
  const slice = sliceOf(selection, row, left, line.text);
  if (!slice) {
    return (
      <Text>
        {line.spans.map((span, i) => (
          <SpanText key={i} span={span} />
        ))}
      </Text>
    );
  }
  const g = splitGraphemes(line.text);
  return (
    <Text>
      {g.slice(0, slice.from).join("")}
      <Text inverse>{g.slice(slice.from, slice.to).join("")}</Text>
      {g.slice(slice.to).join("")}
    </Text>
  );
};

export const MessageLine = ({ msg, grouped, members, width = 80, top = 0, left = 0, selection = null, menu = null, pinned = false, flash = false, flagFirst = false }: { msg: Message; grouped: boolean; members: Map<string, Member>; width?: number; top?: number; left?: number; selection?: Selection | null; nameW?: number; menu?: Menu; pinned?: boolean; flash?: boolean; flagFirst?: boolean }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  if (msg.kind === "system") {
    return (
      <Box>
        <Text color={muted} wrap="wrap">
          · {msg.text}  {time(msg.ts)}
        </Text>
      </Box>
    );
  }
  const from = msg.from?.name ?? "?";
  const kind = members.get(from)?.kind ?? msg.from?.kind;
  const control = msg.kind === "control";
  // a forwarded message says so beside the time, not in the middle of what was written
  const forwarded = FORWARDED.exec(msg.text);
  const body = bodyOf(msg.text);
  return (
    <Box flexDirection="column">
      {!grouped && (
        <Text>
          {pinned && flagFirst ? <Text color={theme.colors.warning}>⚑ </Text> : null}
          <Name name={from} kind={kind} />
          {msg.to && (
            <Text>
              {" "}
              <Text color={control ? theme.colors.accent : msg.kind === "info" ? muted : theme.colors.foreground}>{control ? "⌘" : "→"}</Text>{" "}
              <Text color={nameColor(msg.to)} bold>
                {msg.to}
              </Text>
            </Text>
          )}
          {/* jumped to from a pin: its time lit up for a moment */}
          <Text color={flash ? theme.colors.warning : muted} inverse={flash}>
            {"  " + time(msg.ts)}
          </Text>
          <Text color={muted}>
            {msg.edited ? "  edited" : ""}
            {msg.loop ? `  ↻ ${msg.loop.label ?? `every ${msg.loop.every}`}` : ""}
            {pinned && !flagFirst ? "  ⚑" : ""}
            {forwarded ? `  [forwarded from ${forwarded[1]}]` : ""}
            {msg.from?.room && msg.from.room !== msg.room ? `  · from ${msg.from.room}` : ""}
          </Text>
        </Text>
      )}
      <Box flexDirection="column">
        {renderBody(body, width, (name) => members.has(name)).map((line, i) =>
          // a blank line the author wrote is a row of its own: an empty Text has no height
          line.text === "" ? (
            <Box key={i} height={1} />
          ) : control ? (
            <Text key={i} color={theme.colors.accent}>
              {line.text}
            </Text>
          ) : (
            <BodyLine key={i} line={line} row={top + i} left={left} selection={selection} />
          )
        )}
      </Box>
      <Box>
        <Text color={(flash && grouped) || menu === "replying" || menu === "forwarding" ? theme.colors.warning : theme.colors.mutedForeground} inverse={flash && grouped} wrap="truncate-end">
          {actionsText(msg.media, menu)}
          {grouped && msg.edited ? "   edited" : ""}
        </Text>
      </Box>
    </Box>
  );
};

/// The pinned messages above the input, one line each, the newest nearest it; three at most,
/// then "N more". /pins shows them whole, and ⋯ under a message pins or unpins it.
/// The pins shown above the input, top to bottom: the newest nearest the input, three at most.
export const shownPins = (pins: Message[]): Message[] => [...pins].reverse().slice(-3);

export const PinnedLines = ({ pins, width, boxRef }: { pins: Message[]; width: number; boxRef?: React.RefObject<DOMElement | null> }) => {
  const theme = useTheme();
  const shown = shownPins(pins);
  const more = pins.length - shown.length;
  const cut = (t: string, n: number) => {
    // the first line only, as plain text: no **, __, `, # or > marks, no pipes
    const one = (t.split("\n").find((l) => l.trim()) ?? "")
      .replace(/\*\*|__|`/g, "")
      .replace(/^\s*(#{1,6}\s+|>\s?)/, "")
      .replace(/^\s*\||\|\s*$/g, "")
      .replace(/\s*\|\s*/g, " · ")
      .trim();
    return one.length > n ? one.slice(0, Math.max(0, n - 1)) + "…" : one;
  };
  return (
    <Box ref={boxRef} flexDirection="column" flexShrink={0}>
      {more > 0 && <Text color={theme.colors.warning}>{`⚑ ${more} more pinned · /pins`}</Text>}
      {shown.map((m) => {
        const head = `⚑ ${m.from?.name ?? "?"} ${time(m.ts)}  `;
        return (
          <Text key={m.id} wrap="truncate-end">
            <Text color={theme.colors.warning}>⚑ </Text>
            <Text color={nameColor(m.from?.name ?? "?")} bold>{m.from?.name ?? "?"}</Text>
            <Text color={theme.colors.mutedForeground}>{` ${time(m.ts)}  `}</Text>
            {cut(m.text, width - head.length - 1)}
          </Text>
        );
      })}
    </Box>
  );
};

