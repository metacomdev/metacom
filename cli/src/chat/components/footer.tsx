import { Box, Text, type DOMElement } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { Spin } from "@/chat/components/glyph";
import { CONTROL, type Member } from "@/chat/store";

/// On the right of the line under the input while you reply: a click (or Esc) cancels the reply.
export const CANCEL_REPLY = "✕ cancel reply · esc";
/// There in an archived room (for the owner): a click brings it back.
export const UNARCHIVE = "🗄 unarchive";

/// One line under the input: what enter will do, or what the chat is busy with.
export const Footer = ({ text, busy, status, members, room, attachments = 0, frame, waiting, waitingRef, action, cancelRef }: { text: string; busy: string | null; status?: { text: string; tone: string } | null; members: Map<string, Member>; room: string; attachments?: number; frame: number; mouse?: boolean; waiting?: string; waitingRef?: React.RefObject<DOMElement | null>; action?: string; cancelRef?: React.RefObject<DOMElement | null> }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const line = (node: React.ReactNode) => (
    <Box paddingLeft={2}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{node}</Text>
      </Box>
      {waiting && (
        <Box ref={waitingRef} flexShrink={0} marginLeft={2}>
          <Text color={theme.colors.warning}>{waiting}</Text>
        </Box>
      )}
      {action && (
        <Box ref={cancelRef} flexShrink={0} marginLeft={2}>
          <Text color={theme.colors.warning}>{action}</Text>
        </Box>
      )}
    </Box>
  );
  if (status)
    return line(
      <Text color={status.tone === "warn" ? theme.colors.warning : status.tone === "error" ? theme.colors.error : status.tone === "plain" ? theme.colors.mutedForeground : theme.colors.success}>{status.text}</Text>
    );
  if (busy)
    return line(
      <Text>
        <Spin frame={frame} color={theme.colors.primary} /> {busy}
      </Text>
    );
  const files = attachments ? ` with ${attachments} file${attachments > 1 ? "s" : ""}` : "";
  if (!text)
    return line(
      <Text color={muted}>
        @ to address an agent · / for commands · shift+enter new line · drag to copy · /help
      </Text>
    );
  // the first mention anywhere is who the message is for, so the hint follows it too
  const mentions = [...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2]!.replace(/[.,:;!?]+$/, ""));
  const head = mentions.find((n) => members.has(n)) ?? (text.startsWith("@") ? mentions[0] : undefined);
  if (head) {
    const name = head;
    const m = members.get(name);
    if (!m)
      return line(
        <Text>
          <Text color={theme.colors.warning}>nobody called {name} is in this room</Text>
          <Text color={muted}> · /say to post it anyway</Text>
        </Text>
      );
    if (m.kind === "agent")
      return line(
        <Text color={muted}>
          enter types this{files} into {m.name}
          {m.connected ? "" : " when it comes back"}
        </Text>
      );
    return line(<Text color={muted}>enter sends this{files} to {m.name} directly</Text>);
  }
  if (text.startsWith("/")) return line(<Text color={muted}>enter runs the command</Text>);
  if (CONTROL.test(text)) return line(<Text color={theme.colors.warning}>control commands go to an agent: @Alex !/compact</Text>);
  return line(<Text color={muted}>enter posts to {room}{files}</Text>);
};
