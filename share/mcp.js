#!/usr/bin/env node
'use strict';

// metacom-share: an MCP server (stdio, no dependencies) that lets an agent publish what it built to
// metacom share, hand out session links (one per audience), and see who opened them.
//
//   SHARE_API  internal API of the share service, e.g. http://share:8911
//   SHARE_KEY  the room's publish key; it decides the room, the agent cannot choose another
//
//   claude mcp add -s user metacom-share -e SHARE_API=… -e SHARE_KEY=… -- node /path/to/mcp.js

const fs = require('node:fs');
const path = require('node:path');

const API = (process.env.SHARE_API || 'http://share:8911').replace(/\/$/, '');
const KEY = process.env.SHARE_KEY || '';
const SKIP = new Set(['node_modules', '.git', '.next', '.cache', '__pycache__']);
const MAX_BYTES = 50 * 1024 * 1024;

const ID = { type: 'string', description: 'The artifact id, e.g. k3j9x2m8q1w7zd-4f8a-p2v9xq (from publish or list)' };
const SESSION = { type: 'string', description: 'A session id (8 characters) or its label' };
const EXPIRES = { type: 'string', description: 'Optional lifetime: 2h, 7d, 4w; omit or "never" for no limit' };

const TOOLS = [
  {
    name: 'publish',
    description:
      'Publish something static you built (an HTML page or site, a presentation, a dashboard, a PDF, images) to metacom share. ' +
      'Give a folder (served from its index.html) or files. Creates the artifact and its first session, and returns the session link ' +
      '(…/?session=…): whoever has it can open the artifact, people and agents alike, and every visit is recorded. ' +
      'Post the link in the room. For another audience, make another session (session_create) rather than reusing a link. ' +
      'Secrets (keys, tokens, .env) are refused. To change something already published, use update instead: a publish is always a new artifact and a new link.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute paths: one folder, or one or more files' },
        title: { type: 'string', description: 'What it is, e.g. "Q3 values deck"' },
        session: { type: 'string', description: 'Internal name of the first session, e.g. "acme team". Ask the person what to call it before publishing, unless they already said; visitors never see it' },
        expires: EXPIRES,
        footer: { type: 'boolean', description: 'false: no "Made by agents in a metacom room · metacom.dev" line at the end of its pages (shown by default)' },
      },
      required: ['paths', 'title'],
    },
  },
  {
    name: 'update',
    description:
      'Change an artifact you published, in place: the same id and the same session links, with the new files as a new version ' +
      '(the old ones are kept; rollback returns to one). Visitors get it on their next load; anyone with it open sees a "This was updated: Reload" notice. ' +
      'mode "replace" (default): the paths are the whole new version. mode "merge": the current files stay, these are added or replace theirs, and `remove` drops files. ' +
      'Say what changed in `note`. Every new file is checked for secrets, as on publish.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths, as for publish: one folder, or files. Optional with mode "merge" and remove' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace (default) or merge' },
        remove: { type: 'array', items: { type: 'string' }, description: 'merge only: paths in the artifact to drop, e.g. "old/slide.html"' },
        entry: { type: 'string', description: 'Optional: the file the links open at; kept from the current version if it still exists' },
        note: { type: 'string', description: 'What changed, e.g. "pricing slide fixed"' },
        footer: { type: 'boolean', description: 'false: no "Made by agents in a metacom room · metacom.dev" line at the end of its pages ; true brings it back' },
      },
      required: ['id'],
    },
  },
  {
    name: 'versions',
    description: "An artifact's versions: number, when, by whom, the note, files and size; the current one marked.",
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'rollback',
    description: 'Make an earlier version of an artifact current again. The same links; visitors get it on their next load. Nothing is deleted, so you can roll forward too.',
    inputSchema: { type: 'object', properties: { id: ID, version: { type: 'number', description: 'The version number, from versions' } }, required: ['id', 'version'] },
  },
  {
    name: 'list',
    description: "This room's artifacts: id, title, who published, sessions (live/total), visitors, who is watching now.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_create',
    description:
      'A new session (a new link) for an artifact, e.g. one per team you pitch to. Before creating it, ask the person what to call it ' +
      '(an internal name such as "acme team", never shown to visitors) unless they already said. Returns the link; it is shown only now.',
    inputSchema: { type: 'object', properties: { id: ID, label: { type: 'string', description: 'Internal name, e.g. "acme team"' }, expires: EXPIRES }, required: ['id', 'label'] },
  },
  {
    name: 'session_rename',
    description: "Rename a session (its internal name only; the link and its visitors' records stay as they are).",
    inputSchema: { type: 'object', properties: { id: ID, session: SESSION, label: { type: 'string', description: 'The new internal name' } }, required: ['id', 'session', 'label'] },
  },
  {
    name: 'online',
    description:
      "Who is watching this room's artifacts right now: artifact, session, person or agent, browser and device, place, since when, and the page or slide they are on. " +
      'A browser counts while its page sends heartbeats (every 30 s) and is not hidden; an agent while it made a request in the last 75 s.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_expire',
    description: "End a session: its link stops working at once. Other sessions of the artifact keep working.",
    inputSchema: { type: 'object', properties: { id: ID, session: SESSION }, required: ['id', 'session'] },
  },
  {
    name: 'sessions',
    description: "An artifact's sessions: label, status (live/expired), created, expires, visitors (people/agents), online now, last seen.",
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'visitors',
    description:
      'Who opened an artifact, per session: visitor id, person or agent, browser, OS, device, screen and window size, IP, country, city, ' +
      'language, time zone, first and last seen, views, and whether they are watching right now.',
    inputSchema: { type: 'object', properties: { id: ID, session: { ...SESSION, description: 'Optional: one session (id or label); all if omitted' } }, required: ['id'] },
  },
  {
    name: 'activity',
    description: "A session's event log, oldest first: views, files fetched, slides, heartbeats, hide/show, leave — per visitor or all.",
    inputSchema: {
      type: 'object',
      properties: { id: ID, session: SESSION, user: { type: 'string', description: 'Optional visitor id (12 characters) from visitors' }, limit: { type: 'number', description: 'Last N events (default 200)' } },
      required: ['id', 'session'],
    },
  },
  {
    name: 'revoke',
    description: 'Revoke a whole artifact: every session link stops working at once. To end one audience, use session_expire.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
];

/// The files to send: a folder is walked (hidden files and node_modules left out) with paths
/// relative to it; separate files go by their own names.
const collect = (paths) => {
  const out = [];
  let total = 0;
  const add = (abs, rel) => {
    const size = fs.statSync(abs).size;
    total += size;
    if (total > MAX_BYTES) throw new Error('more than 50 MB in total');
    out.push({ path: rel.split(path.sep).join('/'), data: fs.readFileSync(abs).toString('base64') });
  };
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, base);
      else if (entry.isFile()) add(abs, path.relative(base, abs));
    }
  };
  if (paths.length === 1 && fs.statSync(paths[0]).isDirectory()) walk(paths[0], paths[0]);
  else
    for (const p of paths) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p, path.dirname(p));
      else add(p, path.basename(p));
    }
  if (out.length === 0) throw new Error('nothing to publish there');
  return out;
};

const call = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `share answered ${res.status}`);
  return json;
};

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

const tools = {
  publish: async ({ paths, title, session, expires, footer }) => {
    const files = collect((paths || []).map((p) => path.resolve(p)));
    const r = await call('POST', '/api/publish', { title, files, session, expires, footer });
    return [
      `Published "${r.title}" (${r.files} file${r.files === 1 ? '' : 's'}, ${(r.bytes / 1024).toFixed(0)} KB) in room ${r.room}; artifact id ${r.id}.`,
      `Session "${r.session.label}" (${r.session.sid}${r.session.expires ? `, until ${when(r.session.expires)}` : ''}):`,
      r.session.link,
      'Post the link in the room. It opens in a browser and works for agents too (curl -L; …/_files lists every file, …/_bundle.zip has them all).',
      'The link is shown only now. For another audience create another session; to stop one, expire it.',
    ].join('\n');
  },
  update: async ({ id, paths, mode, remove, entry, note, footer }) => {
    const files = paths && paths.length ? collect(paths.map((p) => path.resolve(p))) : [];
    const r = await call('POST', '/api/update', { id, files, mode, remove, entry, note, footer });
    const s = await call('GET', `/api/sessions?${qs({ id })}`);
    const live = s.sessions.filter((x) => x.status === 'live').map((x) => `"${x.label}"`);
    const n = (list, word) => `${list.length} ${word}`;
    return [
      `Updated "${r.title}" to v${r.version} (${r.mode}): ${n(r.added, 'added')}, ${n(r.changed, 'changed')}, ${n(r.removed, 'removed')}; now ${r.files} file${r.files === 1 ? '' : 's'}, ${(r.bytes / 1024).toFixed(0)} KB.`,
      ...[['added', r.added], ['changed', r.changed], ['removed', r.removed]].filter(([, l]) => l.length).map(([k, l]) => `  ${k}: ${l.slice(0, 20).join(', ')}${l.length > 20 ? ` … (+${l.length - 20})` : ''}`),
      `Same links${live.length ? ` (live sessions: ${live.join(', ')})` : ''}: visitors get v${r.version} on their next load. To undo: rollback to v${r.version - 1}.`,
    ].join('\n');
  },
  versions: async ({ id }) => {
    const r = await call('GET', `/api/versions?${qs({ id })}`);
    return [`${r.title}: current v${r.current}`, ...r.versions.map((v) => `${v.current ? '● ' : '  '}v${v.n} · ${when(v.created)} by ${v.by}${v.note ? ` · ${v.note}` : ''} · ${v.files} file(s), ${(v.bytes / 1024).toFixed(0)} KB${v.pruned ? ' · pruned' : ''}`)].join('\n');
  },
  rollback: async ({ id, version }) => {
    const r = await call('POST', '/api/rollback', { id, version });
    return `Rolled "${r.title}" back from v${r.from} to v${r.version}. Same links; visitors get it on their next load.`;
  },
  list: async () => {
    const r = await call('GET', '/api/list');
    if (!r.artifacts.length) return `Nothing published in ${r.room} yet.`;
    return r.artifacts
      .map((a) => `${a.revoked ? '[revoked] ' : ''}${a.title} — id ${a.id} · v${a.version || 1} · by ${a.by} · ${when(a.created)}${a.updated ? ` (updated ${when(a.updated)})` : ''} · sessions ${a.live}/${a.sessions} live · ${a.visitors} visitor(s)${a.online ? ` · ${a.online} watching now` : ''}`)
      .join('\n');
  },
  session_create: async ({ id, label, expires }) => {
    const s = await call('POST', '/api/sessions/create', { id, label, expires });
    return `Session "${s.label}" (${s.sid}${s.expires ? `, until ${when(s.expires)}` : ''}):\n${s.link}\nShown only now.`;
  },
  session_rename: async ({ id, session, label }) => {
    const s = await call('POST', '/api/sessions/rename', { id, session, label });
    return `Session ${s.sid} renamed: "${s.was}" → "${s.label}".`;
  },
  online: async () => {
    const r = await call('GET', '/api/online');
    if (!r.online.length) return `Nobody is watching anything in ${r.room} right now.`;
    const ago = (iso) => {
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
    };
    return [`${r.online.length} watching now in ${r.room}:`, ...r.online.map((o) => {
      const where = [o.city, o.country].filter(Boolean).join(', ') || o.ip;
      const at = [o.page, o.hash].filter(Boolean).join('') || 'the start';
      return `● ${o.title} · session "${o.session}" · ${o.uid} ${o.kind} · ${o.browser || '?'} on ${o.os || '?'} (${o.device}${o.window ? `, ${o.window}` : ''}) · ${where} · for ${ago(o.since)} · at ${at}`;
    })].join('\n');
  },
  session_expire: async ({ id, session }) => {
    const s = await call('POST', '/api/sessions/expire', { id, session });
    return `Session "${s.label}" (${s.sid}) has ended; its link no longer works.`;
  },
  sessions: async ({ id }) => {
    const r = await call('GET', `/api/sessions?${qs({ id })}`);
    if (!r.sessions.length) return `${r.title}: no sessions.`;
    return [`${r.title}:`, ...r.sessions.map((s) => `${s.label} (${s.sid}) — ${s.status} · created ${when(s.created)} by ${s.by}${s.expires ? ` · until ${when(s.expires)}` : ''} · ${s.visitors} visitor(s): ${s.humans} people, ${s.agents} agents · ${s.online} watching now · last seen ${when(s.lastSeen)}`)].join('\n');
  },
  visitors: async ({ id, session }) => {
    const r = await call('GET', `/api/visitors?${qs({ id, session })}`);
    const lines = [];
    for (const s of r.sessions) {
      lines.push(`Session "${s.label}" (${s.sid}): ${s.users.length} visitor(s)`);
      for (const u of s.users) {
        const where = [u.city, u.country].filter(Boolean).join(', ') || '?';
        const screen = u.screen ? ` · screen ${u.screen}, window ${u.window || '?'}${u.dpr ? ` @${u.dpr}x` : ''}` : '';
        lines.push(
          `  ${u.onlineNow ? '● now ' : ''}${u.uid} · ${u.kind} · ${u.browser || '?'} on ${u.os || '?'} (${u.device})${screen} · ${u.ip} ${where}` +
            `${u.timezone ? ` · ${u.timezone}` : ''}${u.language ? ` · ${u.language}` : ''} · first ${when(u.first)} · last ${when(u.last)} · ${u.views || 0} view(s), ${u.requests} request(s)`,
        );
      }
    }
    return lines.join('\n') || 'No visitors yet.';
  },
  activity: async ({ id, session, user, limit }) => {
    const r = await call('GET', `/api/activity?${qs({ id, session, user, limit })}`);
    if (!r.events.length) return `Session "${r.label}": no events yet.`;
    return [`Session "${r.label}" (${r.sid}), ${r.events.length} event(s):`, ...r.events.map((e) => {
      const { ts, uid, event, ...rest } = e;
      const detail = Object.entries(rest).filter(([k]) => k !== 'ip').map(([k, v]) => `${k}=${v}`).join(' ');
      return `${when(ts)}:${ts.slice(17, 19)} ${uid} ${event}${detail ? ' ' + detail : ''}`;
    })].join('\n');
  },
  revoke: async ({ id }) => {
    await call('POST', '/api/revoke', { id });
    return `Revoked ${id}: every session link of it stops working.`;
  },
};

// MARK: JSON-RPC over stdio, one message per line

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const handle = async (msg) => {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') {
      return write({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'metacom-share', version: '0.4.0' } } });
    }
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const fn = tools[params.name];
      if (!fn) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      if (!KEY) return write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'SHARE_KEY is not set for metacom-share' }] } });
      try {
        const text = await fn(params.arguments || {});
        return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (error) {
        return write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error.message } ] } });
      }
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });
  } catch (error) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
  }
};

let buffer = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const job = handle(msg).finally(() => pending.delete(job));
    pending.add(job);
  }
});
// the client went away: answer what is in flight, then leave
process.stdin.on('end', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
