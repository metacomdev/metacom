import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { padToTerminalWidth, terminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { ROOM, type HubRooms, type Member, type RoomSummary } from "@/chat/store";

export type PickerItem = { room: string; summary?: RoomSummary; create?: boolean; member?: Member; hub?: string; archived?: RoomSummary; folder?: number };

/// The rooms the list shows for what is typed: the ones whose name contains it, and, when the
/// name is new and a valid room name, a last row that creates it.
/// Archived rooms are not among them: they sit in the "archived" folder at the bottom (with how
/// many), and in the folder (`folder`) the list is theirs. A filter matches them too, listed
/// after the rooms under the folder's name.
export const pickerItems = (rooms: RoomSummary[], filter: string, current: string, create = true, archived: RoomSummary[] = [], folder = false): PickerItem[] => {
  const q = filter.trim();
  const old: PickerItem[] = archived.filter((r) => r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, archived: r }));
  if (folder) return old;
  // only names that can be opened: an old member can still sit in "*", which is no room
  const shown: PickerItem[] = rooms.filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, summary: r }));
  // the room you are in is listed even before the hub has heard it spoken in
  if (!rooms.some((r) => r.room === current) && !archived.some((r) => r.room === current) && current.toLowerCase().includes(q.toLowerCase())) shown.unshift({ room: current });
  if (q) shown.push(...old);
  if (create && q && ROOM.test(q) && !shown.some((r) => r.room === q)) shown.push({ room: q, create: true });
  if (!q && archived.length) shown.push({ room: "", folder: archived.length });
  return shown;
};

/// This hub's rooms (pickerItems), then every other saved hub's that match, each marked with
/// its hub: choosing one of those moves the chat to that hub. "+ create" comes last, so a name
/// typed that exists on another hub opens that room rather than making a new one here.
export const allItems = (rooms: RoomSummary[], others: HubRooms[], filter: string, current: string, create = true, archived: RoomSummary[] = [], folder = false): PickerItem[] => {
  if (folder) return pickerItems(rooms, filter, current, false, archived, true);
  const q = filter.trim().toLowerCase();
  const elsewhere = others.flatMap((o) => (o.rooms ?? []).filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q)).map((r) => ({ room: r.room, summary: r, hub: o.hub.name })));
  const here = pickerItems(rooms, filter, current, create, archived);
  const last = (i: PickerItem) => Boolean(i.create || i.folder);
  return [...here.filter((i) => !last(i)), ...elsewhere, ...here.filter(last)];
};

const ago = (ts?: string): string => {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

const counts = (s?: RoomSummary): string => {
  if (!s || s.agents === 0) return "no agents";
  const parts = [`${s.online}/${s.agents} online`];
  if (s.working) parts.push(`${s.working} working`);
  if (s.blocked) parts.push(`${s.blocked} need you`);
  return parts.join(" · ");
};

/// The room list that takes the conversation's place, a section per hub: the hub's link in bold
/// in its colour and its room count, then its rooms. `›` on the chosen row, the room you are in marked,
/// the counts in the quiet colour. Scrolls to keep the chosen row in sight.
export const RoomPicker = ({ rooms, others = [], hub, filter, index, current, height, archived = [], folder = false }: { rooms: RoomSummary[]; others?: HubRooms[]; hub: { name: string; http: string }; filter: string; index: number; current: string; height: number; archived?: RoomSummary[]; folder?: boolean }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const items = allItems(rooms, folder ? [] : others, filter, current, true, archived, folder);
  const at = Math.min(index, Math.max(0, items.length - 1));
  const nameW = Math.min(28, Math.max(8, ...items.map((i) => i.room.length + 2)));
  const lines: React.ReactNode[] = [];
  let activeLine = 0;
  // a hub's heading: its address without the scheme (hub.example.com), in bold in the hub's
  // colour, and how many rooms it has
  const section = (name: string, http: string, count: number | null, first: boolean) => {
    if (!first) lines.push(<Box key={`gap-${name}`} height={1} />);
    lines.push(
      <Text key={`hub-${name}`} wrap="truncate-end">
        <Text color={nameColor(name)} bold>
          {http.replace(/^\w+:\/\//, "").replace(/\/+$/, "")}
        </Text>
        <Text color={muted}>{count === null ? "" : `  ${count} ${count === 1 ? "room" : "rooms"}`}</Text>
      </Text>,
    );
    lines.push(<Box key={`space-${name}`} height={1} />);
  };
  const row = (item: PickerItem) => {
    const active = items.indexOf(item) === at;
    if (active) activeLine = lines.length;
    const mark = active ? "›" : " ";
    if (item.folder) {
      lines.push(
        <Text key="/archived" wrap="truncate-end">
          <Text color={theme.colors.primary}>{mark}</Text>{" "}
          <Text color={active ? theme.colors.primary : muted} bold={active}>{`${item.folder} archived room${item.folder === 1 ? "" : "s"}`}</Text>
        </Text>,
      );
      return;
    }
    if (item.archived) {
      const a = item.archived;
      lines.push(
        <Text key={`archived/${item.room}`} wrap="truncate-end">
          <Text color={theme.colors.primary}>{mark}</Text>{" "}
          <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
            {padToTerminalWidth(item.room, nameW)}
          </Text>
          <Text color={muted}>{`${a.messages ?? 0} message${a.messages === 1 ? "" : "s"} · last ${ago(a.last)}${item.room === current ? "  · you are here" : ""}`}</Text>
        </Text>,
      );
      return;
    }
    if (item.create) {
      lines.push(
        <Text key={"+" + item.room} wrap="truncate-end">
          <Text color={theme.colors.primary}>{mark}</Text>{" "}
          <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
            + create {item.room}
          </Text>
        </Text>,
      );
      return;
    }
    const here = !item.hub && item.room === current;
    lines.push(
      <Text key={`${item.hub ?? ""}/${item.room}`} wrap="truncate-end">
        <Text color={theme.colors.primary}>{mark}</Text>{" "}
        <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
          {padToTerminalWidth(item.room, nameW)}
        </Text>
        <Text color={muted}>{counts(item.summary)}</Text>
        {item.summary?.unread ? <Text color={theme.colors.warning} bold>{` · ${item.summary.unread} unread`}</Text> : null}
        <Text color={muted}>{here ? "  · you are here" : ""}</Text>
      </Text>,
    );
  };
  const roomCount = (list: RoomSummary[] | null) => (list ? list.filter((r) => ROOM.test(r.room)).length : null);
  if (folder) {
    lines.push(<Text key="folder" color={muted}>archived rooms · read-only · esc back</Text>);
    lines.push(<Box key="folder-space" height={1} />);
    if (items.length === 0) lines.push(<Text key="none" color={muted}>no archived room matches</Text>);
    items.forEach(row);
  } else {
    section(hub.name, hub.http, rooms.length ? roomCount(rooms) : null, true);
    const local = items.filter((i) => !i.hub);
    if (local.length === 0) lines.push(<Text key="none" color={muted}>{rooms.length ? "no room matches · type a name to create one" : "loading…"}</Text>);
    // archived rooms a filter found: under the folder's name
    local.forEach((item, n) => {
      if (item.archived && !local[n - 1]?.archived) lines.push(<Text key="archived-head" color={muted}>archived</Text>);
      row(item);
    });
  }
  for (const o of folder ? [] : others) {
    section(o.hub.name, o.url ?? o.hub.http, roomCount(o.rooms), false);
    const mine = items.filter((i) => i.hub === o.hub.name);
    if (!o.rooms) lines.push(<Text key={`state-${o.hub.name}`} color={o.error ? theme.colors.warning : muted}>{o.error ? `not reachable: ${o.error}` : "loading…"}</Text>);
    else if (mine.length === 0) lines.push(<Text key={`state-${o.hub.name}`} color={muted}>no room matches</Text>);
    mine.forEach(row);
  }
  const rows = Math.max(1, height);
  const top = Math.max(0, Math.min(lines.length - rows, activeLine - Math.floor(rows / 2)));
  return (
    <Box flexDirection="column" height={Math.max(1, height)} justifyContent="flex-end">
      {lines.slice(top, top + rows)}
    </Box>
  );
};

/// Forwarding into another room: the room itself (everyone there) first, then its members,
/// people before agents, filtered by what is typed.
export const memberItems = (room: string, members: Member[], filter: string): PickerItem[] => {
  const q = filter.trim().toLowerCase();
  const rank = (m: Member) => (m.kind === "human" ? 0 : 1) + (m.connected ? 0 : 2);
  const shown = members
    .filter((m) => m.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((m) => ({ room, member: m }));
  return q && !room.toLowerCase().includes(q) ? shown : [{ room }, ...shown];
};

/// The second step of forwarding to another room: who in it gets the message.
export const MemberPicker = ({ room, members, filter, index, height }: { room: string; members: Member[] | null; filter: string; index: number; height: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const items = memberItems(room, members ?? [], filter);
  const at = Math.min(index, Math.max(0, items.length - 1));
  const rows = Math.max(1, height - 2);
  const top = Math.max(0, Math.min(at - rows + 1, items.length - rows));
  return (
    <Box flexDirection="column" height={Math.max(1, height)} justifyContent="flex-end">
      <Text color={muted}>forward to someone in {room}</Text>
      <Box height={1} />
      {members === null && <Text color={muted}>loading…</Text>}
      {items.slice(top, top + rows).map((item, i) => {
        const active = top + i === at;
        const mark = <Text color={theme.colors.primary}>{active ? "›" : " "}</Text>;
        if (!item.member) {
          return (
            <Text key={"#" + item.room} wrap="truncate-end">
              {mark}{" "}
              <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
                everyone in {item.room}
              </Text>
            </Text>
          );
        }
        const m = item.member;
        return (
          <Text key={m.name} wrap="truncate-end">
            {mark} <Glyph member={m} />{" "}
            <Text color={nameColor(m.name)} bold={active}>
              {m.name}
            </Text>
            <Text color={muted}>
              {"  "}
              {m.connected ? (m.kind === "agent" ? m.status : "online") : "offline, gets it later"}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
};
