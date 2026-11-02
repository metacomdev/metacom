'use strict';

// Shared templates. `metacom template share <name>` writes a template into a folder laid out as the
// public repository github.com/metacomdev/templates will be:
//
//   README.md               the index for people: each template, its team, the command to use it
//   index.json              the index for metacom: name, summary, roles, file, sha256
//   templates/<name>.json   one file per template
//
// `metacom template list|show|use … --from <where>` reads such an index: `metacomdev` (the public
// one, once it is published), an https URL of an index.json, or a folder. A template is checked as
// a local one is, and its file must match the sha256 in the index.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('./templates.js');

const PUBLIC = 'https://raw.githubusercontent.com/metacomdev/templates/main/index.json';
const DEFAULT_DIR = path.join(os.homedir(), 'metacom-templates');

// what must never go out in a shared template: a path on this machine, or something shaped like a key
const PRIVATE = [
  [/(^|[\s"'(=])(\/home\/[^/\s"']+|\/Users\/[^/\s"']+|[A-Z]:\\Users\\)/, 'a path on this machine'],
  [/\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/, 'something shaped like a key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  // a hub token: 32 random bytes as base64url
  [/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{43}(?![\w-])/, 'something shaped like a hub token'],
];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/// What would be published, as the file's text: the template's own fields, in a stable order.
const publishable = (t) => {
  const { name, summary, room, example, rules } = t;
  const roles = t.roles.map(({ accept, ...r }) => r); // accept was removed (2026-10-12)
  const out = { name, summary, room, ...(example ? { example } : {}), ...(rules && rules.length ? { rules } : {}), roles };
  const text = JSON.stringify(out, null, 2) + '\n';
  for (const [re, what] of PRIVATE) {
    const m = text.match(re);
    if (m) throw new Error(`template ${name} has ${what} in it (${m[0].trim().slice(0, 24)}…): take it out before sharing`);
  }
  return text;
};

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/// The index of every template in the folder, and the README made from it.
const reindex = (dir) => {
  const files = fs.readdirSync(path.join(dir, 'templates')).filter((f) => f.endsWith('.json')).sort();
  const entries = files.map((f) => {
    const text = fs.readFileSync(path.join(dir, 'templates', f), 'utf8');
    const t = templates.check(JSON.parse(text), f.slice(0, -5), `templates/${f}`);
    return { name: t.name, summary: t.summary, roles: t.roles.map((r) => ({ name: r.name, agent: r.agent })), file: `templates/${f}`, sha256: sha256(text) };
  });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, templates: entries }, null, 2) + '\n');
  const readme = [
    '# metacom templates',
    '',
    'Ready teams of agents for one job each. Start one in a room of your hub with one command:',
    '',
    '```',
    'metacom template use <name> --from metacomdev --goal "…"',
    '```',
    '',
    'Look before you start one: `metacom template show <name> --from metacomdev` prints each role, its agent and what it is told.',
    '',
    '| Template | Team | What it does |',
    '|---|---|---|',
    ...entries.map((e) => `| [${e.name}](${e.file}) | ${e.roles.map((r) => `${r.name} (${r.agent})`).join(', ')} | ${cell(e.summary)} |`),
    '',
    '## Add yours',
    '',
    'Make it in `~/.config/metacom-hub/templates/<name>.json`, try it with `metacom template use <name>`, then',
    '`metacom template share <name> --to <a clone of this repository>` and open a pull request. `share` checks it,',
    'refuses one with a path of your machine or a key in it, and rewrites this README and `index.json`.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), readme);
  return entries;
};

/// `template share`: write one template into the folder (made if missing) and rebuild its index.
const share = (name, dir = DEFAULT_DIR) => {
  const text = publishable(templates.load(name));
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  const file = path.join(dir, 'templates', `${name}.json`);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, text);
  const entries = reindex(dir);
  return { file, dir, changed: before !== text, count: entries.length };
};

const isUrl = (s) => /^https?:\/\//.test(s);

/// Where an index is, from what was given to --from.
const indexOf = (from) => {
  if (!from || from === 'metacomdev') return PUBLIC;
  if (isUrl(from)) return from;
  const p = path.resolve(from);
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.json') : p;
};

const read = async (where) => {
  if (!isUrl(where)) return fs.readFileSync(where, 'utf8');
  if (!where.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(where)) throw new Error(`${where}: only https`);
  const r = await fetch(where, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${where}: ${r.status}${where === PUBLIC && r.status === 404 ? ' (the public templates are not published yet)' : ''}`);
  return r.text();
};

/// The entries of a shared index.
const list = async (from) => {
  const where = indexOf(from);
  let index;
  try {
    index = JSON.parse(await read(where));
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? `${where}: no index here` : error.message);
  }
  if (!index || !Array.isArray(index.templates)) throw new Error(`${where}: not a templates index`);
  return { where, entries: index.templates.filter((e) => e && templates.NAME.test(e.name || '')) };
};

/// One template from a shared index, checked, and matching its sha256.
const get = async (name, from) => {
  const { where, entries } = await list(from);
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`no template ${name} in ${where}`);
  if (!/^templates\/[a-z][a-z0-9-]*\.json$/.test(e.file || '')) throw new Error(`${where}: ${name}'s file is not under templates/`);
  const at = isUrl(where) ? new URL(e.file, where).href : path.join(path.dirname(where), e.file);
  const text = await read(at);
  if (sha256(text) !== e.sha256) throw new Error(`${at}: does not match the sha256 in the index`);
  return { ...templates.check(JSON.parse(text), name, at), source: where, file: at };
};

module.exports = { share, reindex, list, get, publishable, PUBLIC, DEFAULT_DIR };
