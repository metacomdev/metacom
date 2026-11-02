# Room templates

A template is a team for a kind of job: which agents, whom each takes instructions from, and what each does.

```sh
metacom template list
metacom template show research-report
metacom template use research-report --goal "A two-page brief on …"
```

`use` does the following:
1. It opens each role in its own tmux window, in the current folder or `--dir`. With `--print` it prints the commands for you to run instead.
2. It waits for every agent to join. A role stuck on a first-run question, such as "trust this folder?", is shown once; answer it in the chat (`metacom <room>`) and the wait goes on.
3. It gives each role its part.
4. It posts the kickoff in the room.

Each agent starts on a token of its own, which the wrapper makes the first time (`/tokens` lists them).

## The file

A template is `<name>.json`. Yours go in `~/.config/metacom-hub/templates/`, and one with the same name as a bundled template replaces it.

```json
{
  "name": "research-report",
  "summary": "One line: what the team is for.",
  "room": "report",
  "example": "an example goal, shown by show",
  "rules": ["What every role must keep to.", "When to ask the owner."],
  "roles": [
    {
      "name": "research",
      "agent": "claude",
      "args": [],
      "does": "a short line for the team list",
      "instructions": "What this role does, whom it hands work to (hub_send) and when it is done."
    }
  ]
}
```

- **`name`**: the file's name.
- **`room`**: the default room; change it with `--room`.
- **Role names:** lowercase letters, digits and dashes. Each role becomes the agent's name in the room.
- **`agent`** and **`args`**: the command that runs it (`claude`, `codex`, `opencode`, or any terminal program). `--agent-args "…"` adds to every role's arguments, e.g. `"--permission-mode auto"`.
- **`does`**: an optional short line for the team list. Without it, the first sentence of `instructions` is used.

Each role is told:
- its name and room;
- the goal;
- the whole team with what each does;
- its own instructions;
- the rules.

It is also told to hand work on with `hub_send`, to post progress with `hub_say`, and to ask the owner only when the rules say so.

## Bundled

| template | roles | from |
| --- | --- | --- |
| `launch-offer` | research, writer, builder, reviewer | our café demo: priced packages from real evidence, a launch email and a page to sign off |
| `landing-review` | builder, reviewer, qa | how our landing reached ship quality: rubric scores, measured gates, fixes |
| `research-report` | research, writer, checker | a sourced brief where every claim is checked against its source |

### Company fields

All optional; a template with them is a company template.

```json
{
  "goal": "the question that asks for this week's goal",
  "lead": "director",
  "approve": ["what the owner signs off"],
  "review": { "by": "reviewer", "checks": "what it verifies before the owner sees work" },
  "loops": [{ "target": "director", "every": "0 9 * * *", "prompt": "the morning check" }],
  "roles": [{ "name": "director", "budget": 30 }]
}
```

- **lead:** made the room's manager (`/manage`): it sets the loops and posts the first plan.
- **budget:** dollars a day for that role (the spend guard); rigor scales it: light ×1.5, strict ×0.7.
- **review:** added to the rules; with `--rigor strict`, nothing reaches you as done before it passes.
- **loops:** set when the team starts, by the hub, on the lead's behalf.

## Company templates

A whole team for a kind of business: a lead that plans and manages the loops, a review step, daily budgets, and a list of what you approve. `metacom start` asks three questions (the business, this week's goal, how strict) and starts one; `metacom template use <name> --goal "…" [--rigor light|standard|strict]` starts one directly.

### agency

A small creative agency: a brief in, a reviewed campaign out (concept, copy, assets list, schedule), with the owner signing off before anything reaches the client.

**Roles**

- **director** (lead): turns the goal into a brief and a plan, assigns the work, takes it to the owner
- **producer**: the schedule, the assets list and what each piece needs
- **writer**: the concept line and the copy
- **reviewer**: checks the work against the brief before the owner sees it

**What you approve**

- the creative brief, before production starts
- anything sent to the client or published

**Review:** reviewer checks every claim, name, price and date against the brief and its sources, the copy for tone and typos, and that each deliverable in the brief exists.

Start it: `metacom start --template agency`

### tender-office

A tender and grants office: finds open calls that fit, decides go or no-go with the owner, drafts the application and checks every requirement before submission.

**Roles**

- **bidlead** (lead): plans, picks calls with the owner, runs each bid to a reviewed draft
- **scout**: finds open calls that fit, with links and deadlines
- **writer**: drafts the application from the call's requirements
- **reviewer**: checks every requirement before the owner sees it

**What you approve**

- go or no-go on each call
- the final application, before anything is submitted

**Review:** reviewer checks every mandatory requirement and document of the call against the draft, deadlines and formats, budget arithmetic, and that every claim about the organisation is one the owner gave.

Start it: `metacom start --template tender-office`

### content-studio

A content studio: plans a week of content, writes and designs it, checks it, and queues it for the owner to publish.

**Roles**

- **editor** (lead): plans the week, assigns pieces, takes them to the owner
- **writer**: writes each piece from its brief
- **designer**: image briefs and layouts for each piece
- **reviewer**: checks each piece before the owner sees it

**What you approve**

- the week's content plan
- each piece, before it is published

**Review:** reviewer checks facts and numbers against their sources, links open, the brand's voice, typos, and that each piece matches the plan.

Start it: `metacom start --template content-studio`

### dev-studio

A small software team: plans the work, builds it on a branch with tests, reviews and tests it, and asks the owner before anything ships.

**Roles**

- **lead** (lead): plans the work, splits it, takes it to the owner
- **builder**: writes the code and its tests on the branch
- **reviewer**: reviews every change
- **tester**: runs the tests and tries the change as a user would

**What you approve**

- the plan, if it changes scope
- merging, deploying or publishing anything

**Review:** reviewer checks the diff line by line, that tests cover the change and pass when run, no secrets or debug code, and that it does what the plan says.

Start it: `metacom start --template dev-studio`

### sales-desk

A sales desk: researches leads that fit, writes specific outreach drafts and offers, and keeps the pipeline; the owner approves every message before it goes out.

**Roles**

- **desk** (lead): sets the profile and the offer, runs the pipeline, takes drafts to the owner
- **researcher**: finds leads that fit, with sources
- **writer**: writes a specific draft for each lead
- **reviewer**: checks every lead and draft

**What you approve**

- the offer one-pager
- every outreach message, before it is sent

**Review:** reviewer checks each lead's facts against its source link, that each draft is specific to its lead and true about the offer, and nothing is promised that the offer does not say.

Start it: `metacom start --template sales-desk`

