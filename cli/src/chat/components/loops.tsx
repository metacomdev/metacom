import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { padToTerminalWidth } from "@/lib/terminal-text";
import { nameColor } from "@/chat/palette";
import { when, type Loop, type LoopsView } from "@/chat/store";

/// A row of the /loops list: a loop, or (inside one) what can be done to it.
export type LoopItem = { loop?: Loop; action?: "toggle" | "run" | "delete" };

export const labelOf = (l: Loop): string => l.label ?? `every ${l.every}`;

/// How the last run went, in a few words: "12:00 sent to leader", "14:00 skipped: metadev is offline".
export const lastRun = (l: Loop): string => {
  if (!l.last) return "not run yet";
  const at = when(l.last.at);
  if (l.last.outcome === "sent") return `${at} sent to ${l.last.to.join(", ")}${l.last.why ? ` (${l.last.why})` : ""}`;
  if (l.last.outcome === "waiting") return `${at} waiting for an idle agent`;
  return `${at} skipped: ${l.last.why ?? "?"}`;
};

/// What the list shows for what is typed, as the room list does: the loops whose target, schedule
/// or prompt contain it. Inside a loop (enter or → on it, as on the archived folder), its actions.
export const loopItems = (view: LoopsView, filter: string): LoopItem[] => {
  if (view.open) {
    const loop = view.list.find((l) => l.id === view.open);
    return loop ? [{ loop, action: "toggle" }, { loop, action: "run" }, { loop, action: "delete" }] : [];
  }
  const q = filter.trim().toLowerCase();
  return view.list.filter((l) => `@${l.target} ${labelOf(l)} ${l.prompt} ${l.by.name}`.toLowerCase().includes(q)).map((loop) => ({ loop }));
};

/// /loops, in the room list's place and its look: a title, then a row per loop (`›` on the chosen
/// one, its schedule and target, the prompt, and in the quiet colour when it runs next and how it
/// ran last). Inside a loop: turn on/off, run now, delete (asks once more). Scrolls to keep the
/// chosen row in sight.
export const LoopPicker = ({ view, filter, room, height }: { view: LoopsView; filter: string; room: string; height: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const items = loopItems(view, filter);
  const at = Math.min(view.index, Math.max(0, items.length - 1));
  const lines: React.ReactNode[] = [];
  let activeLine = 0;
  const mark = (active: boolean) => <Text color={theme.colors.primary}>{active ? "›" : " "}</Text>;
  const open = view.open ? view.list.find((l) => l.id === view.open) : null;
  if (open) {
    lines.push(
      <Text key="title" wrap="truncate-end">
        <Text color={muted}>‹ </Text>
        <Text bold>{labelOf(open)}</Text>
        <Text color={nameColor(open.target)} bold>{` → @${open.target}`}</Text>
        <Text color={muted}>{` · ${open.on ? "on" : "off"} · ← or esc back`}</Text>
      </Text>,
    );
    lines.push(<Text key="prompt" wrap="truncate-end">{`  ${open.prompt.replace(/\s+/g, " ")}`}</Text>);
    lines.push(<Text key="runs" color={muted} wrap="truncate-end">{`  ${open.on ? `next ${when(open.next)}` : "off"} · last ${lastRun(open)} · by ${open.by.name}`}</Text>);
    lines.push(<Box key="space" height={1} />);
    items.forEach((item, i) => {
      const active = i === at;
      if (active) activeLine = lines.length;
      const text = item.action === "toggle" ? (open.on ? "turn off" : "turn on") : item.action === "run" ? "run now" : view.confirm ? "sure? enter deletes it" : "delete";
      const tone = item.action === "delete" && view.confirm ? theme.colors.warning : active ? theme.colors.primary : theme.colors.foreground;
      lines.push(
        <Text key={item.action} wrap="truncate-end">
          {mark(active)} <Text color={tone} bold={active}>{text}</Text>
        </Text>,
      );
    });
  } else {
    lines.push(
      <Text key="title" wrap="truncate-end">
        <Text bold>{`loops in ${room}`}</Text>
        <Text color={muted}>{`  ${view.list.length} · the hub sends each on time, whatever the agents' sessions do`}</Text>
      </Text>,
    );
    lines.push(<Box key="space" height={1} />);
    if (!items.length) lines.push(<Text key="none" color={muted}>{view.list.length ? "no loop matches" : `no loops in ${room} · /loop @agent <prompt> every 2h makes one`}</Text>);
    const labelW = Math.min(26, Math.max(8, ...items.map((i) => labelOf(i.loop!).length + 2)));
    const targetW = Math.min(18, Math.max(6, ...items.map((i) => i.loop!.target.length + 3)));
    items.forEach((item, i) => {
      const l = item.loop!;
      const active = i === at;
      if (active) activeLine = lines.length;
      lines.push(
        <Text key={l.id} wrap="truncate-end">
          {mark(active)} <Text color={l.on ? theme.colors.success : muted}>{l.on ? "●" : "○"}</Text>{" "}
          <Text color={active ? theme.colors.primary : l.on ? theme.colors.foreground : muted} bold={active}>
            {padToTerminalWidth(labelOf(l), labelW)}
          </Text>
          <Text color={nameColor(l.target)}>{padToTerminalWidth(`@${l.target}`, targetW)}</Text>
          <Text color={l.on ? theme.colors.foreground : muted}>{l.prompt.replace(/\s+/g, " ")}</Text>
          <Text color={muted}>{`  · ${l.on ? `next ${when(l.next)}` : "off"} · last ${lastRun(l)}`}</Text>
        </Text>,
      );
    });
  }
  const rows = Math.max(1, height);
  const top = Math.max(0, Math.min(lines.length - rows, activeLine - Math.floor(rows / 2)));
  return (
    <Box flexDirection="column" height={rows} justifyContent="flex-end">
      {lines.slice(top, top + rows)}
    </Box>
  );
};
