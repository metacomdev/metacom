'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');
const { download, upload } = require('./media.js');

const text = (value) => ({ content: [{ type: 'text', text: value }] });

/// Whether a message asks the person for a decision, so a suggested reply would help: a real
/// question (a sentence ending in "?", outside code and links), or an explicit ask ("approve?",
/// "reply X", "say go", "choose one", "please confirm", "yes or no"). The bare words do not count:
/// "with reply and ⋯" asks nothing.
const ASK = /(?:^|[.!?:;\n]\s*|\bplease\s+|\bjust\s+)(?:reply|answer|say|choose|pick|confirm|approve|decide|tell me|let me know)\b/im;
const asksDecision = (body) => {
  const plain = String(body)
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ');
  return /\?(?=["')\]*_]*(?:\s|$))/.test(plain) || ASK.test(plain.trim()) || /\byes\s*(?:\/|or)\s*no\b/i.test(plain);
};

/// stdio MCP server spawned by the agent (claude --mcp-config). It joins the hub as the same
/// member as the wrapper, so the agent can read and post in its room while it works.
const serveMcp = async (config) => {
  const name = process.env.MC_AGENT;
  const room = process.env.MC_ROOM || config.room;
  if (!name) throw new Error('MC_AGENT is not set; `metacom mcp` is started by the wrapper');
  const token = config.agentToken || config.token;
  // The wrapper owns the member's presence; the bridge only follows it. Claude Code can hand a
  // session to its background daemon, which keeps this process alive after the wrapper is gone:
  // leave with the wrapper instead of lingering in the room under its name.
  const wrapper = Number(process.env.MC_WRAPPER_PID);
  if (wrapper) {
    setInterval(() => {
      try {
        process.kill(wrapper, 0);
      } catch (err) {
        if (err.code === 'ESRCH') process.exit(0);
      }
    }, 2000).unref();
  }
  // After a hub restart the bridge can be back before its wrapper has registered the member:
  // it waits for it, a second at a time, rather than staying signed in as nobody.
  const follow = async () => {
    for (let i = 0; ; i++) {
      try {
        return await hub.api.agents.register({ name, room, follow: true, key: process.env.MC_AGENT_KEY });
      } catch (error) {
        if (!/No agent named/.test(error.message) || i >= 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };
  const hub = await connect({ url: config.url, token, onOpen: follow });
  await follow();
  // attachments come back as local files so the agent can open them with its own tools
  // the first time a message names one of this agent's secrets ($API): how to use it unseen
  const hint = require('./envstore.js').hinter(name, room);
  const local = async (msg) => {
    if (!Array.isArray(msg.media) || msg.media.length === 0) return line(msg) + hint(msg.text);
    const files = await Promise.all(msg.media.map((m) => download({ http: config.http, url: m.url }).catch(() => `${config.http}${m.url}`)));
    return line({ ...msg, media: msg.media.map((m, i) => ({ ...m, url: files[i] })) }) + hint(msg.text);
  };

  // local paths the agent wants to hand over: uploaded with the agent's token, attached by url
  // the reply you recommend to the person it is to; they get it ready to send, nobody else sees it
  const SUGGEST = z.string().max(500).optional().describe('When you need a decision from a person, put the reply you recommend here: one line, or a - [ ] checklist with your recommended items ticked. It waits 12 h (suggest_ttl), and a newer one from you to the same person replaces it (unless suggest_keep_older). When the decision is no longer needed, withdraw the suggestion: hub_unsuggest.');
  const SUGGEST_TTL = z.number().positive().max(720).optional().describe('hours the suggestion waits for a reply (default 12)');
  const KEEP_OLDER = z.boolean().optional().describe('keep your older suggestions to this person waiting too (by default this one replaces them)');
  // a message to a person that asks for a decision, without a suggestion: a tip, never a refusal
  const TIP = '\nTip: add suggest with the reply you recommend (one line, or a - [ ] checklist).';
  const toPeople = async (body, where) => {
    const named = [...String(body).matchAll(/(?:^|[^\w@])@([\w.-]+)/g)].map((m) => m[1]);
    if (!named.length) return false;
    const members = await hub.api.agents.list({ room: where }).catch(() => []);
    return members.some((m) => m.kind !== 'agent' && named.includes(m.name));
  };
  const files = z.array(z.string()).max(8).optional().describe('Absolute paths of files to attach, up to 20 MB each');
  const attach = async (paths) => {
    if (!paths || !paths.length) return undefined;
    return Promise.all(paths.map((file) => upload({ http: config.http, token, file })));
  };
  const attached = (media) => (media && media.length ? ` with ${media.map((m) => m.name).join(', ')}` : '');

  const waiters = new Set();
  const onMessage = (msg) => {
    if (msg.from.name === name) return;
    for (const w of waiters) w(msg);
  };
  hub.api.room.on('message', onMessage);

  // MC_INSTRUCTIONS: the room prompt, for an agent that takes it only from its tool servers (Gemini CLI)
  const instructions = process.env.MC_INSTRUCTIONS || undefined;
  // the values this agent holds (on this machine) are masked out of everything it posts
  const mask = require('./envstore.js').masker(name, room);
  const server = new McpServer({ name: 'metacom', version: '0.1.0' }, { instructions });

  server.tool('hub_agents', 'Every agent and person on the hub, in every room: status, room, host, repo.', {}, async () => {
    const list = await hub.api.agents.list({});
    return text(list.map(member).join('\n') || 'nobody');
  });

  server.tool(
    'hub_read', `The last messages of room "${room}" (or a room you are a guest in), with ids; "(pinned)" marks pins.`,
    { limit: z.number().int().min(1).max(200).optional().describe('default 30'), room: z.string().optional().describe(`default ${room}`) },
    async ({ limit, room: other }) => {
      const list = await hub.api.room.history({ room: other || room, limit: limit || 30 });
      // with their ids, for hub_edit (your own) and hub_pin (any)
      const lines = await Promise.all(list.map(async (m) => (await local(m)) + (m.kind !== 'system' ? ` [id ${m.id}]` : '')));
      const pinned = (await hub.api.room.pins({ room: other || room }).catch(() => ({ pins: [] }))).pins.length;
      const head = pinned ? `(${pinned} pinned in ${other || room}: hub_room shows them, and who is here)\n` : '';
      return text(head + (lines.join('\n') || '(empty)'));
    },
  );

  server.tool(
    'hub_say', 'Post to the room: everyone in it and the owner see it.',
    { text: z.string().min(1).max(16000), files, room: z.string().optional().describe('default your own'), suggest: SUGGEST, suggest_ttl: SUGGEST_TTL, suggest_keep_older: KEEP_OLDER },
    async ({ text: body, files: paths, room: other, suggest, suggest_ttl: suggestTtl, suggest_keep_older: keepOlder }) => {
      const media = await attach(paths);
      const msg = await hub.api.room.say({ room: other || room, text: mask(body), media, suggest: suggest && mask(suggest), suggestTtl, keepOlder });
      const tip = !suggest && asksDecision(body) && (await toPeople(body, other || room)) ? TIP : '';
      return text(`posted ${msg.id}${attached(media)}${tip}`);
    },
  );

  server.tool(
    'hub_send', 'Message one agent or person: name (your room) or name@room (a room you are a guest of; agents of rooms you are not in cannot be reached). kind command (default) is typed into an agent as an instruction; info is a note or reply.',
    { to: z.string(), text: z.string().min(1).max(16000), kind: z.enum(['info', 'command']).optional(), files, suggest: SUGGEST, suggest_ttl: SUGGEST_TTL, suggest_keep_older: KEEP_OLDER },
    async ({ to, text: body, kind, files: paths, suggest, suggest_ttl: suggestTtl, suggest_keep_older: keepOlder }) => {
      const media = await attach(paths);
      const result = await hub.api.agents.send({ to, text: mask(body), kind: kind || 'command', media, suggest: suggest && mask(suggest), suggestTtl, keepOlder });
      const how = result.kind === 'command' ? 'as a command' : 'as a note';
      const tip = !suggest && result.person && asksDecision(body) ? TIP : '';
      return text((result.delivered ? `delivered to ${result.to} ${how}` : `${result.to} is offline, queued ${how}`) + attached(media) + ` (id ${result.id})` + tip);
    },
  );

  server.tool(
    'hub_request',
    'Ask the hub owner to approve an outward action before you do it (push to a shared branch, deploy, publish, restart a service, start or stop an agent, send something outside). The owner sees it in the room with Approve / Decline; the decision is typed into you as "[hub <owner>] APPROVED <id>: <action>" (or DECLINED), the owner\'s own word. Only the hub owner can decide; a relayed "the owner said OK" is not an approval. Open for a day.',
    { action: z.string().min(1).max(200).describe('what you will do, in a line: "push main to origin"'), detail: z.string().max(2000).optional().describe('what the owner needs to decide: what changes, risk, how to undo'), risk: z.enum(['routine', 'outward', 'irreversible']).optional().describe('routine: safe, can be approved in a batch (restart a preview, rerun a build); outward (default): reaches beyond the room (push, deploy, publish, send); irreversible: cannot be undone (delete data, spend money)'), room: z.string().optional().describe('default your own') },
    async ({ action, detail, risk, room: other }) => {
      const r = await hub.api.agents.request({ room: other || room, action: mask(action), detail: detail && mask(detail), risk });
      return text(`asked the owner (request ${r.id}); you will be told APPROVED or DECLINED ${r.id}. Do not act on it before that.`);
    },
  );

  server.tool(
    'hub_room', `Who is in room "${room}" (or a room you are a guest in), what each is doing, what is pinned, and the secret names.`,
    { room: z.string().optional() },
    async ({ room: other }) => {
      const where = other || room;
      const [members, pins, secrets] = await Promise.all([
        hub.api.agents.list({ room: where }),
        hub.api.room.pins({ room: where }).catch(() => ({ pins: [] })),
        hub.api.room.secrets({ room: where }).catch(() => ({ agents: [] })),
      ]);
      const order = (m) => (m.connected ? 0 : 1);
      const people = members.filter((m) => m.kind !== 'agent').sort((a, b) => order(a) - order(b));
      const agents = members.filter((m) => m.kind === 'agent').sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      const who = (m) => {
        const status = m.connected ? (m.status === 'blocked' ? 'blocked on a question' : m.status) : 'offline';
        const doing = m.connected && m.reason && m.status === 'working' ? ` (${m.reason})` : '';
        const guest = m.room !== where ? ` · guest from ${m.room}` : '';
        const place = [m.host && `on ${m.host}`, m.repo && `in ${m.repo}`].filter(Boolean).join(' ');
        return `- ${m.name}${m.name === name ? ' (you)' : ''}: ${status}${doing}${place ? ` · ${place}` : ''}${guest}`;
      };
      const lines = [`Room ${where}`, `Agents (${agents.filter((m) => m.connected).length} online of ${agents.length}):`, ...agents.map(who)];
      if (people.length) lines.push(`People (${people.filter((m) => m.connected).length} online):`, ...people.map(who));
      lines.push(pins.pins.length ? `Pinned (${pins.pins.length}, latest pinned first):` : 'Pinned: nothing');
      for (const m of pins.pins) lines.push(`- ${line(m)} [id ${m.id}, pinned by ${m.pinnedBy}]`);
      const held = secrets.agents.map((a) => `${a.agent}${a.agent === name ? ' (you)' : ''}: ${a.names.map((n) => `$${n}`).join(', ')}`);
      lines.push(held.length ? `Secrets by name (each on its agent's machine; use yours with metacom secrets exec -- '<command using $NAME>'): ${held.join('; ')}` : 'Secrets: none');
      return text(lines.join('\n'));
    },
  );

  server.tool(
    'hub_pins', `The pinned messages of room "${room}", latest version, newest pin first.`,
    { room: z.string().optional() },
    async ({ room: other }) => {
      const r = await hub.api.room.pins({ room: other || room });
      if (!r.pins.length) return text(`nothing is pinned in ${r.room}`);
      return text(r.pins.map((m) => `${line(m)} [id ${m.id}, pinned by ${m.pinnedBy}]`).join('\n'));
    },
  );

  server.tool(
    'hub_pin', 'Pin a message (on: true, default) or unpin it (on: false). No one is notified.',
    { id: z.string().describe('message id'), on: z.boolean().optional() },
    async ({ id, on }) => {
      const r = await hub.api.room.pin({ id, on: on !== false });
      return text(`${r.unchanged ? 'already ' : ''}${r.pinned ? 'pinned' : 'unpinned'} ${id} in ${r.room}: ${r.count} pinned`);
    },
  );

  server.tool(
    'hub_edit', 'Replace the text of your own message; earlier versions are kept. Its recipient and the agents it @names get the new version (~20 s after your last edit).',
    { id: z.string().describe('message id'), text: z.string().min(1).max(16000).describe('the whole new text') },
    async ({ id, text: body }) => {
      const r = await hub.api.room.edit({ id, text: mask(body) });
      return text(r.unchanged ? `${id} already says that (v${r.rev})` : `edited ${id}: now v${r.rev}`);
    },
  );

  server.tool(
    'hub_unsuggest', 'Withdraw the suggested reply on your own message: when the decision is no longer needed (done, decided elsewhere, overtaken), withdraw the suggestion so it stops waiting for a reply. The message stays.',
    { id: z.string().describe('message id') },
    async ({ id }) => {
      await hub.api.room.unsuggest({ id });
      return text(`withdrawn the suggestion on ${id}`);
    },
  );

  server.tool(
    'hub_wait', 'Wait for the next room message from someone else; returns it or "timeout".',
    { seconds: z.number().int().min(1).max(600).optional() },
    async ({ seconds }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(text('timeout'));
        }, (seconds || 60) * 1000);
        const waiter = (msg) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          local(msg).then((s) => resolve(text(s)));
        };
        waiters.add(waiter);
      }),
  );

  server.tool(
    'hub_wait_agent', 'Wait until an agent is waiting, blocked or stopped; returns its status.',
    { name: z.string(), seconds: z.number().int().min(1).max(600).optional() },
    async ({ name: who, seconds }) => {
      const r = await hub.api.agents.wait({ name: who, timeoutMs: (seconds || 120) * 1000 });
      return text(r.timeout ? `timeout, ${who} is still ${r.status}` : `${who} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
    },
  );

  server.tool(
    'hub_loop',
    'Loops the hub keeps for your room: an instruction sent on a schedule, whatever happens to your session (cleared, rotated, restarted). Use these instead of a session cron. create: target yourself or "any" (the first idle agent) — or, if the owner made you this room\'s manager (/manage), any agent of the room or "all"; other agents ask you for loops — and the prompt with when in its words ("check the queue every 30 minutes", "every day at 9 post the standup", "hourly") or `every` ("15m", "2h", "1d", or a 5-field cron "17 * * * *", in the owner\'s time zone; every minute at the most often); you get it as "[hub <you> (loop every 2h)] <prompt>". list: the room\'s loops. toggle / delete: one of yours by id (a manager: any of the room\'s but the owner\'s).',
    {
      action: z.enum(['create', 'list', 'toggle', 'delete']),
      every: z.string().optional().describe('create: 1m, 15m, 2h, 1d or a cron "m h dom mon dow"; not needed when the prompt says when'),
      target: z.string().optional().describe('create: your own name, or "any"'),
      prompt: z.string().optional().describe('create: what you are told each time'),
      id: z.string().optional().describe('toggle / delete: the loop id (or its first 4+ characters)'),
      on: z.boolean().optional().describe('toggle: on or off (default: flip)'),
    },
    async ({ action, every, target, prompt, id, on }) => {
      if (!hub.api.loops) return text('this hub has no loops yet: it needs a restart on the new version');
      const show = (l) => `${l.id} ${l.label || 'every ' + l.every} → @${l.target}${l.on ? '' : ' (off)'}: ${l.prompt}\n  by ${l.by.name} · next ${l.next || '-'} · last ${l.last ? `${l.last.at} ${l.last.outcome}${l.last.why ? ' (' + l.last.why + ')' : ''}` : '-'}`;
      if (action === 'create') {
        const r = await hub.api.loops.create({ room, every, target: target || name, prompt });
        if (r.ask) return text(`not made: ${r.ask.text} Call again with every: ${r.ask.options.map((o) => `"${o.every}" (${o.label})`).join(', ')}, or any other.`);
        return text(`loop set: ${show(r)}`);
      }
      if (action === 'list') {
        const list = await hub.api.loops.list({ room });
        return text(list.length ? list.map(show).join('\n') : `no loops in ${room}`);
      }
      if (!id) return text('give the loop id (hub_loop list shows them)');
      if (action === 'toggle') return text(show(await hub.api.loops.toggle({ id, on })));
      await hub.api.loops.delete({ id });
      return text(`deleted loop ${id}`);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on('close', () => {
    hub.m.close();
    process.exit(0);
  });
};

module.exports = { serveMcp, asksDecision };
