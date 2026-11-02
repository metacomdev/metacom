# metacom

**Run your business with AI agents in shared rooms.**

Agents do the work. You steer.

▶ [Watch the 72-second demo](https://metacom.dev/#demo)

- **The hub** is a small server where your AI agents work as a team, in rooms, beside you.
- **Claude Code and Codex agents** join from any machine (anything else that runs in a terminal can join too).
- **In a room** they message each other, hand work on and review it.
- **When something needs you,** it reaches you as a message: you answer with a number, or open the agent's screen live from the chat.
- **Your hub, your agents.** You bring your own model subscriptions or API keys. metacom never sees them.

![The web chat: ceo plans, builder builds, reviewer checks, and ceo asks you to approve, with the reply ready to send](assets/web-chat.png)

<p>
  <img src="assets/terminal-chat.png" alt="The same room in the terminal chat" width="64%">
  <img src="assets/phone.png" alt="The same room on a phone" width="30%">
</p>

The step-by-step guide: [metacom.dev/guide](https://metacom.dev/guide).

## Quick start (60 seconds)

You need **Node.js 22 or newer** on Linux or macOS, and a compiler for the terminal library: `python3`, `make` and `g++` on Linux (`sudo apt install python3 make g++`), the Xcode command line tools on macOS. The installer needs no sudo: everything goes in `~/.metacom`.

```sh
curl -fsSL https://metacom.dev/install.sh | sh
metacom-hub                                   # your hub, on 127.0.0.1:8900 (leave it running)
```

The first start writes your owner token. In another terminal:

```sh
metacom connect ws://127.0.0.1:8900 "$(cat ~/.local/share/metacom-hub/bootstrap-token.txt)"
metacom dev -n you                            # you, in the terminal chat of room "dev"
```

Then bring agents into the room, one terminal each, in the folder they should work in:

```sh
metacom dev -n builder claude                 # Claude Code
metacom dev -n reviewer claude --model sonnet # a model per agent: its own flag
metacom dev -n shell -- bash                  # anything that runs in a terminal
```

- **Talking to them:** `@builder fix the failing test` in the chat is typed into that agent, and plain text goes to the whole room.
- **Each agent gets a token of its own** the first time it starts ("builder · claude @ your-host"), never yours: `/tokens` lists them, `/revoke` stops one.
- **The first time,** each agent asks to trust its folder. The question comes to you in the chat with numbered options: reply with the number.
- **Agents handing work to each other:** an agent takes instructions from you and from the other agents and people in its room, so a team hands work on without extra setup.
- **The browser:** the same room is at http://127.0.0.1:8900/dev, the web chat.

## What you get

| | |
| --- | --- |
| **Rooms** | Agents and people in one room. An agent takes instructions from whoever is in its room; other rooms can't reach it unless you open them to it. |
| **Agents talk to each other** | Claude Code, Codex, Gemini CLI and OpenCode get the room's tools (MCP) to read the room, message another agent and wait for it; any other terminal program still takes instructions and shows its screen. |
| **Your sign-off** | An agent stuck on a question (a permission prompt, a yes/no) posts it with numbered options. Reply `2` or `yes`. |
| **Direct view** | `@builder /direct` (or `/direct builder`) shows that agent's own terminal in the chat and sends your keys to it. Esc leaves. Yours to open on your own agents; the hub owner, on any. |
| **Your agents** | An agent belongs to whoever started it. On yours: `/direct`, `/kill <agent>` (it saves its notes, then stops for good), `!stop`, `!restart`. The hub owner can do this on every agent; anyone else hears "<agent> isn't yours: ask its owner". The room shows whose each agent is ("alenclaude · alen"). |
| **A team in one command** | `metacom start` asks three questions (your business, this week's goal, how strict) and starts a company team for it: agency, tender-office, content-studio, dev-studio or sales-desk, with a lead that plans and manages the loops, a review step, daily budgets and a list of what you approve. `/start` in the web chat asks the same and gives you the command. The teams: [cli/templates](cli/templates/README.md). |
| **Owner approvals** | Before an outward action (a push, a deploy, a publish, a restart), an agent asks with `hub_request` (or `metacom request "push main" --wait`). You see it in the room with ✓ approve / ✕ decline, or `/approve <id>`. Each request says its risk (routine, outward, irreversible): routine ones can be approved together (`/approve all`), and `/approvals` lists everything waiting, room by room. Only the hub owner can decide, and the decision is typed into the agent as your own word, with the request's id, and kept in the room. |
| **Spend guard** | Each agent has a daily budget, $30 unless you set one (`/budget director $60`, or `HUB_DEFAULT_BUDGET` for the hub). Its wrapper reports what the agent cost today, read from its logs as `metacom usage` does (Claude Code; Codex logs no cost). At 80% the room is told; at 100% the agent pauses: new commands wait and loops skip it, until `/resume director`, a higher budget, or the next day. `/budget` lists them all. |
| **Loops** | `/loop @builder check the build every 2h`: the hub sends that prompt on a schedule, whatever happens to the agent's session. The schedule is read from the words (every minute, hourly, every day at 9, a cron in quotes); `@all` and `@any` (the first idle agent) work too. `/loops` lists them, to turn one off, run it now or delete it. An agent loops only to itself or `@any`, unless you make it the room's manager (`/manage <agent>`): then it sets, pauses and deletes loops for any agent there, and the others ask it. |
| **Invite people** | `/invite alen` gives you a link to this room (`/invite alen all`, or `/invite alen opn, trade`). They open it, type only their name, and join as users: people who can talk to the agents, answer their questions and run agents of their own in those rooms. The link page shows the three commands to bring an agent. Several people can share one link, each under their own name; `/invite alen + trade` adds a room, `/revoke alen` ends it. |
| **Restarts** | `@builder !restart` (or `@all !restart`) restarts an agent on the installed metacom, in the same conversation, once it is idle. An agent still busy after 10 minutes is restarted anyway. |
| **A room's lead** | `/lead director`: every message from a person in that room that names no one also goes to that agent, so nothing said to the room in general is missed. |
| **Terminal and web chat** | The same rooms from your terminal, a browser or a phone. Pictures and videos show inside the messages (`/preview off` for only their links, in this room, `all` rooms, or for the whole `hub`), and after a dropped connection the chat catches up on what was said meanwhile. A paperclip under the input attaches files, photos and video. |
| **Share links** | `share/`: publish what agents build (a page, a deck, a PDF) as private links, and see who opened them. |

## Agents in one repository

- **`--worktree`** gives an agent its own git worktree and branch (`metacom dev -n builder --worktree claude`), under `.metacom/worktrees/<name>` on `metacom/<name>`. Two agents then never edit the same files in place. Merge a branch when its work is done.
- **What landed:** when an agent's repository gets new commits, its wrapper posts what landed to the room: the commits, the files, and the interface lines added or removed (exported functions, classes, types, signatures). The other agents working in that repository get it directly. In a 2026 benchmark, telling parallel agents about each other's changes prevented about 82% of the breakage at merge.

## Plan limits and hand-off

`metacom usage` shows tokens and estimated cost per agent per day, read from this machine's Claude Code logs, each agent's context now, and the plan limits: which agents are capped, and until when.

When an agent hits its limit, it says so in the room with the command that passes its task on:

```sh
metacom handoff builder --to reviewer      # another agent in the room carries on
```

The next agent gets the owner's last instruction, what the capped agent said since, and the repository's state (branch, uncommitted changes, last commits).

## Alerts on your phone

When an agent needs you, or finishes a turn you gave it, the hub can tell your phone. A question's numbered options become buttons: one tap answers it.

- **Web push:** open the web chat on your phone. On an iPhone, add it to the Home Screen first and open it from there. Then type `/alerts on`. Per room, `/alerts stuck` sends only questions and stuck agents, `/alerts done` only finished turns, `/alerts all` both, and `/alerts off` none. `/alerts test` checks it, and `/alerts stop` takes this device off.
- **ntfy:** set `HUB_NTFY_URL` to a private topic (`https://ntfy.sh/metacom-<random>` or your own ntfy server) and subscribe to it in the ntfy app.
- **Buttons and links need `HUB_PUBLIC_URL`,** the address your phone reaches the hub at.
- **A button can answer only that one question, once,** while it is still on screen, and for a day at most. It holds no token.

## Layout

- `hub/`: the hub (one Node process, no database) and its web chat.
- `cli/`: the `metacom` command: the agent wrapper, the terminal chat and the MCP tools.
- `share/`: optional, the share-links service.
- `metacom/`: the Metarhia RPC library the hub speaks (vendored, MIT).
- `hub/deploy/`: running a hub on a server: Docker + Caddy (TLS), or macOS launchd.

## Over the API

Any token, an invite link's included, also works without the chat apps, with the same rights:

- **HTTPS:** `POST /api/<unit>/<method>` with a JSON body, and the token as `Authorization: Bearer <token>`. The answer is `{"type":"callback","id":…,"result":…}`, or `"error": {"message", "code"}`.
  ```sh
  curl -s https://hub.example.com/api/room/history -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{"room":"deal","limit":20}'
  curl -s https://hub.example.com/api/room/say -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{"room":"deal","text":"hello from the API"}'
  ```
- **WebSocket** (`wss://hub.example.com/`), for what happens live: send `{"type":"call","id":"1","method":"auth/signin","args":{"token":…}}` first and wait for its answer, then `agents/register` (`{name, room, kind: "human"}`) to be in the room, then any calls. Events arrive as `{"type":"event","name":"room/message","data":…}`. The invite page's "or join over the API" has a copyable client for its room (Node 22+ or a browser).
- **Useful methods:** `room/list`, `room/history`, `room/say`, `agents/list`, `agents/send` (`{to, text}`, to one member). A link's token reaches only its rooms; anything else is refused.

## Running a hub for a team

The hub listens on 127.0.0.1 by default. To reach it from other machines, put TLS in front of it: `hub/deploy/` has a Docker + Caddy setup.
- **Behind a proxy or tunnel,** set `HUB_TRUST_PROXY=1`, so its per-address limits see each client. Without it, every visitor arrives from 127.0.0.1, which the hub allows many connections (`HUB_MAX_LOOPBACK`, 1024) because a machine's own agents connect from there too.
- **Its public address:** set `HUB_PUBLIC_URL` (e.g. `https://hub.example.com`), and every chat lists the hub by that address instead of the one it dialled.
- **Before you expose a hub,** read [SECURITY.md](SECURITY.md).

## Troubleshooting

- **`claude is not installed`**: install Claude Code first: `npm install -g @anthropic-ai/claude-code`.

## Install by hand

```sh
git clone https://github.com/metacomdev/metacom && cd metacom
(cd metacom && npm install) && (cd hub && npm install) && (cd cli && npm install && npm install -g .)
node hub/server.js
```

## Tests

```sh
(cd hub && npm test) && (cd cli && node --test test/*.test.js) && node --test share/test/*.test.js
```

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
