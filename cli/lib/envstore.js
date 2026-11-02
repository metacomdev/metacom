'use strict';

// An agent's own secrets on the machine it runs on: what was handed to it in a message
// (`@builder … $NAME=value$`), kept by its wrapper in ~/.config/metacom-hub/env/<agent>@<room>.env
// (mode 600, outside any repository). The model never reads this file's values: they reach the
// agent's environment at its start and the commands it runs with `metacom secrets exec`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = () => path.join(os.homedir(), '.config', 'metacom-hub', 'env');
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE = /^[\w.-]{1,64}$/;

const fileOf = (agent, room) => {
  if (!SAFE.test(agent || '') || !SAFE.test(room || '')) throw new Error('an agent and a room name are needed');
  return path.join(DIR(), `${agent}@${room}.env`);
};

// NAME='value' lines, so the file is also something a shell can source
const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const LINE = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/;

/// { NAME: value } for that agent, or {} when it has none.
const read = (agent, room) => {
  let text = '';
  try {
    text = fs.readFileSync(fileOf(agent, room), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = m[2].replace(/'\\''/g, "'");
  }
  return out;
};

/// Adds or replaces entries; the folder is 700 and the file 600.
const write = (agent, room, entries) => {
  const file = fileOf(agent, room);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const all = { ...read(agent, room) };
  for (const [k, v] of Object.entries(entries)) if (NAME.test(k) && typeof v === 'string' && v) all[k] = v;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Object.entries(all).map(([k, v]) => `${k}=${quote(v)}`).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
};

/// Takes names out (a `$NAME=$` from the room).
const remove = (agent, room, names) => {
  const file = fileOf(agent, room);
  const all = read(agent, room);
  for (const n of names) delete all[n];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Object.entries(all).map(([k, v]) => `${k}=${quote(v)}`).join('\n') + (Object.keys(all).length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/// Text with every value this agent holds replaced by its $NAME: what the agent's own processes
/// do to all they send, so a value never reaches the hub (not even as a hash). The file is read
/// again only when it changed.
const masker = (agent, room) => {
  let seen = null;
  let pairs = [];
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    let stamp = null;
    try {
      stamp = fs.statSync(fileOf(agent, room)).mtimeMs;
    } catch {}
    if (stamp !== seen) {
      seen = stamp;
      pairs = Object.entries(stamp === null ? {} : read(agent, room)).sort((a, b) => b[1].length - a[1].length);
    }
    let out = text;
    for (const [name, value] of pairs) if (out.includes(value)) out = out.split(value).join(`$${name}`);
    return out;
  };
};

/// The first time a message this agent reads names one of its secrets ($API), a line on how to
/// use it without seeing it. Once per name for as long as this process runs.
const hinter = (agent, room) => {
  const told = new Set();
  return (text) => {
    if (typeof text !== 'string' || !text.includes('$')) return '';
    let held = {};
    try {
      held = read(agent, room);
    } catch {}
    const names = [...new Set([...text.matchAll(/\$([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].filter((n) => n in held && !told.has(n));
    for (const n of names) told.add(n);
    return names.map((n) => ` ($${n} is a secret: use \`metacom secrets put ${n} --env .env\` or \`metacom secrets exec --only ${n} -- <cmd>\`)`).join('');
  };
};

module.exports = { read, write, remove, masker, hinter, fileOf };
