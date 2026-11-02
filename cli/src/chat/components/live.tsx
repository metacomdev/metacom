import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { liveWindow } from "@/chat/live";
import type { Live, Member } from "@/chat/store";

/// The bar's yellow button: a click on it leaves live mode (app.tsx), as Esc does.
export const LIVE_LEAVE_BUTTON = "[× leave]";

/// Live mode: the agent's screen as it changes, in place of the conversation. Rows come with
/// their colours; a screen taller than the room for it shows the part with the cursor.
export const LiveView = ({ live, height, width }: { live: Live; height: number; width: number }) => {
  const theme = useTheme();
  if (!live.ready) return <Text color={theme.colors.mutedForeground}>connecting to {live.name}'s screen…</Text>;
  // scrolled back: that screenful (its bottom, when taller than the room), else the live one
  const shown = live.scroll ? live.scroll.lines : live.lines;
  const [start, end] = live.scroll ? liveWindow(shown.length, height, null) : liveWindow(live.rows, height, live.cursor ? live.cursor[1] : null);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {shown.slice(start, end).map((line, i) => (
        <Text key={start + i} wrap="truncate-end">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
};

/// The line under the live screen: the way out, whose screen it is, and its state.
export const LiveBar = ({ live, member, width }: { live: Live; member: Member | undefined; width: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const state = !member || !member.connected ? "offline" : member.status === "waiting" ? "idle" : member.status;
  const cropped = live.ready && (live.cols > width || live.rows > 0) ? (live.cols > width ? ` · ${live.cols}×${live.rows}, cropped to your window` : ` · ${live.cols}×${live.rows}`) : "";
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={theme.colors.warning} bold>
          {LIVE_LEAVE_BUTTON}
        </Text>
        <Text color={muted}>{"  "}</Text>
        <Text color={theme.colors.success}>● </Text>
        <Text bold>{live.name}</Text>
        {live.scroll ? (
          <Text color={theme.colors.warning}>{`  scrolled ${live.scroll.offset} up · ↓ to return`}</Text>
        ) : null}
        <Text color={muted}>
          {` direct · ${state}${cropped} · your keys go to it · shift+↑↓ or shift+PgUp/PgDn scroll back · esc or the yellow button leaves · ctrl+esc sends esc to it`}
        </Text>
      </Text>
    </Box>
  );
};
