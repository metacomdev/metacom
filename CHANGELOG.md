# Changelog

## 0.1.0 (first public release)

### The core
- **The hub:** rooms, members and directed messages over WebSockets, with no database. Owner, agent and member tokens, and a web chat at `/<room>`.
- **The `metacom` command:**
  - the agent wrapper, for Claude Code, Codex, OpenCode or any terminal program;
  - the terminal chat;
  - MCP room tools for Claude Code and Codex.
- **Questions by reply:** an agent stuck on a dialog posts it with numbered options, and you answer with a number.
- **Agents in one repository:** `--worktree` gives each agent its own worktree and branch. New commits are posted to the room ("landed …", with the interface lines that changed) and sent to the other agents in that repository.
- **Plan limits and hand-off:** `metacom usage` shows tokens, estimated cost and plan limits per agent. An agent at its limit says so in the room, and `metacom handoff <agent> --start codex` passes its task, the room context and the repository state on to another vendor's agent.
- **Phone alerts:** when an agent is blocked or done, through web push (`/alerts on` in the web chat) or ntfy (`HUB_NTFY_URL`). A question's options answer in one tap.
- **Several hubs in one chat:** `metacom login <url> <token> --hub NAME` saves another hub. The room list shows each hub by its address (`HUB_PUBLIC_URL` when set) with its rooms, and picking a room on another hub moves the chat there.
- **Live mode:** an agent's screen in the chat, with your keys sent to it, in the terminal chat and the web chat.
- **Share links (`share/`):** publish static work as private links, with visitor records, versions and rollback.
- **Security defaults:**
  - agents refuse the owner token;
  - forged `[hub …]` prefixes are quoted;
  - `HUB_TRUST_PROXY` for hubs behind a proxy.

### Invite people with one link
- **`/invite <label> [all | room, room | + room]`** makes a user token and its invite link for this room (or those rooms, or every room) and copies the link ("Invite link copied"; on a phone, a button to copy it). `/invite <label> + room` adds a room later. The block is shown only to you.
- **The invite page asks only for a name.** Several people can share one link, each under their own name. Under the name, three steps to bring your own agent, each with a copy button: install, `metacom connect <hub> <token>`, `metacom <room> -n <you>claude claude`.
- **The token is never shown whole:** the invite page, your `/invite` block and the terminal chat show its first 6 and last 4 characters. The copy buttons copy the full value, and the page takes the token out of its address as soon as it opens.
- **Users:** someone who joins through a link talks in its rooms, answers its agents' questions and runs agents of their own there. They can't manage tokens, and they can't open or control anyone else's agents.
- **Join over the API:** the invite page's "or join over the API" shows, for its room, the HTTPS calls with the link's token as `Authorization: Bearer` (a curl to read the room and one to post) and a WebSocket client, masked on screen and copied whole. Any token works this way, with its own rights (README, "Over the API").
- **Member tokens that steer:** a member token can answer its agents' questions (`steer: 'answer'`, what invite links use) or also drive them directly (`steer: true`).
- **Room sessions are gone from the chat:** `/invite` now invites people, and `/invite <agent>` no longer starts a second session of an agent in another room.

### Owner approvals
- **An agent asks before an outward action:** `hub_request` (MCP) or `metacom request "<action>" [--detail …] [--wait]`. The owner sees it in the room with approve / decline (web, phone) or `/approve` / `/decline <id>` (both chats). Only the hub owner can decide; the decision is recorded in the room and typed into the agent as "APPROVED <id>: <action>" (or DECLINED). Open for a day. `--wait` exits 0 when approved, 1 when declined or expired.
- **Risk, and fewer taps:** a request is routine, outward (the default) or irreversible (`--risk`). Routine ones open in a room are approved together ("approve all 3 routine", `/approve all`); the others one by one. `/approvals` lists every request waiting, in every room.

### Agents that don't wait on setup
- **Folder trust:** an agent started on the owner's own sign-in (by the owner, or a management agent on the owner's machine) has its folder marked trusted for Claude Code first, so it never stops at "trust this folder?" (`MC_NO_TRUST=1` turns it off). Invited users' agents still ask.
- **`/delegate answers <agent>`:** named agents may answer other agents' folder-trust questions for the owner; nothing else (tool permissions, logins and approvals stay the owner's).

### Company templates
- **Five teams for a kind of business:** agency, tender-office, content-studio, dev-studio and sales-desk (`metacom template list`). Each has roles with briefs, a lead that manages the room's loops and posts the first plan, a review step, daily budgets and a list of what you approve; `metacom template use <name> --goal "…" --rigor light|standard|strict` starts one, sets its lead, budgets and loops, and briefs every role. Their sections are in `cli/templates/README.md`.

### A team in one command
- **`metacom start`:** three questions (your business, this week's goal, how strict: light, standard or strict), the company template the business sounds like (you can pick another), and the team started, briefed, budgeted and looped; it ends with one line saying where to watch and steer it. `/start` in the web chat asks the same three and gives you the command, copied whole.

### A room's manager
- **`/manage <agent>`** (owner): that agent may set, pause and delete loops for any agent of the room (`hub_loop`), so the team asks its lead for loops instead of the owner. Caps count per agent looped to (3); the owner still sees and stops every loop; a manager of one room has no say in another.

### Spend guard
- **A daily budget per agent:** $30 unless set (`/budget <agent> $<per day>`, `HUB_DEFAULT_BUDGET`). The wrapper reports the agent's cost today every 10 minutes (Claude Code; read from its logs like `metacom usage`). At 80% the room hears it; at 100% the agent pauses: commands sent to it wait (control ones like `!stop` still act) and loop fires skip it, until `/resume <agent>`, a higher budget or the next day. `/budget` lists spend and budgets.

### Agents you own
- **Each agent gets a token of its own:** with an owner sign-in and no agent token saved, the wrapper makes one the first time an agent starts ("builder · claude @ your-host"), says so once and keeps it. `/tokens` lists them, and `/revoke` stops one. A revoked agent's next start makes a new token. The manual `metacom token agents --role agent --save` step is no longer needed (the command still works).
- **Ownership:** an agent belongs to the token that started it. On your own agents you can use `/direct`, `/kill`, `!stop`, `!restart` and `!/<command>`; the hub owner can use them on every agent. On someone else's: "<agent> isn't yours: ask its owner". The room shows whose each agent is ("alenclaude · alen").
- **`/direct`** (was `/live`, which still works) opens an agent's own terminal in the chat. All of these work: `@agent /direct`, `/direct @agent`, `/direct agent`, and `@agent` alone then Enter. After `/direct ` the chat offers the agents in the room.
- **`/kill <agent>`** (or `@agent /kill`) stops an agent for good, after it saves its notes.

### Web and phone
- **`/preview on|off [all]`** chooses, per room or for every room on this device, whether pictures and videos show in the feed or only their ↗ links. **`/preview off hub`** (owner) sets the default for everyone on the hub; a device's own choice still wins on that device.
- **A paperclip under the input** opens the file picker (photos, camera and files on a phone; on a desktop too). iOS gives a page no files on paste, so on an iPhone this is the way in.
- **Pasting files copied in Finder** sends the files (a PDF, a video) instead of their icon or name, in the terminal chat. The web chat says when the browser passed only the file's icon.
- **iOS dictation works** in the message box.

### CLI
- **OpenCode gets the room:** under the wrapper, `opencode` starts with the room's tools (MCP) and the room prompt (through `OPENCODE_CONFIG_CONTENT`, merged with your own config), so it answers and hands work on in the room like Claude Code, Codex and Gemini CLI. Checked with OpenCode 2.0.22.
- **`metacom connect <url> <token>`** saves a hub and its token, and replaces `metacom login` (which still works).

### Security
- **Secrets are shared only on purpose:**
  - a placeholder value (`sk-or-...`, `<key>`, `…`) is never a share, and stays as text;
  - an agent's chat message never shares one, and one with a real value is refused rather than posted;
  - agents share with `metacom secrets share`.
- **Invited users answer, they don't drive:** an invite token gets `steer: 'answer'`, so a user can open the terminal only of agents it started itself.
- **"owners only" names the token's real role** (it said "agent" for everyone).
