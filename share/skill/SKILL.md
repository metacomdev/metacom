---
name: metacom-share
description: Share anything you built — an HTML page or site, a presentation, a dashboard, a report, a PDF, images — with people or other agents, through metacom share and its session links. Use it whenever you would otherwise reach for claude.ai Artifacts or Claude Docs, which this hub does not use, or whenever someone asks to "show", "publish", "send a link to", "preview" or "host" something.
---

# metacom-share

This hub shares work through **metacom share**, never through claude.ai Artifacts or Claude Docs.
Your tools come from the `metacom-share` MCP server, set up for your room: whatever you publish lands
in your room, and you can only see and manage your room's artifacts.

## Publishing

1. Build the thing as static files in a folder (an `index.html` at its root) or as one file (`.html`,
   `.pdf`, an image). Everything it needs goes in the folder: fonts, images, scripts — no build step on
   the server, and no secrets (API keys, tokens, `.env`: publishing is refused if it finds any).
2. **Ask the person who asked for it what to call the session** (an internal name such as "acme team"
   or "board review"; visitors never see it), unless they already said.
3. `publish` with `paths` (absolute) and a clear `title`, plus `session` (that name) and, if wanted,
   `expires` (`2h`, `7d`, `4w`).
4. Post the session link where it was asked for (`hub_say` in the room, or `hub_send` to the person).
   The link is shown only once; keep it in the message, not in files.

Shared HTML pages end with one quiet line, "Made by agents in a metacom room · metacom.dev". Publish with
`footer: false` when the person asks for it without (for example, material that goes out under a client's
name); `update` with `footer` turns it on or off later, without new files.

A session link is access: anyone who has it can open the artifact — people in a browser, and agents
too (`curl -L <link>`; `…/s/<session>/_files` lists every file with its URL, `…/_bundle.zip` is all of
them). So each audience gets **its own session**: for a second team, `session_create` a new one
instead of forwarding the first link, and `session_expire` it when that audience is done.

## Afterwards

- `list` — this room's artifacts and how many sessions/visitors each has.
- `sessions` (id) — an artifact's sessions, live or expired, with visitors and who is online.
- `visitors` (id, session?) — who opened it: person or agent, browser, device, screen, place, when.
- `online` — who is watching any of this room's artifacts right now, and on which page or slide.
- `activity` (id, session) — the event log: views, files, slides, heartbeats, leaving.
- `session_rename`, `session_expire`, `revoke` (the whole artifact, every link).
- `update`, `versions`, `rollback`: see below.

## Changing what you published

To change something you shared, **`update` it with its id** (from `list`), never a new `publish`,
unless the person wants a separate link. The id and every session link stay the same; visitors get the
new version on their next load, and anyone who has it open sees a small "This was updated: Reload".

- `paths` as for publish. By default they are the whole new version (`mode: "replace"`).
- `mode: "merge"` keeps the current files and adds or replaces only the given ones; `remove` drops
  paths from it.
- Say what changed in `note` (e.g. "pricing slide fixed").
- `versions` (id) lists the history; `rollback` (id, version) makes an earlier one current again.
  Nothing is lost by a rollback.
- Tell the room what changed, with the same link.
