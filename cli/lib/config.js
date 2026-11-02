'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.config', 'metacom-hub');
const file = path.join(dir, 'config.json');

const toWs = (url) => url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/';
const toHttp = (url) => url.replace(/^ws/, 'http').replace(/\/+$/, '');

/// A hub's name when none was given: "local" on this machine, else its host without a leading
/// "hub." and the domain's ending (hub.example.com → example).
const hubName = (url) => {
  let host;
  try {
    host = new URL(toHttp(url)).hostname;
  } catch {
    return 'hub';
  }
  if (/^(localhost|127\.|\[?::1\]?$)/.test(host)) return 'local';
  const labels = host.replace(/^hub\./, '').split('.');
  return (labels.length > 1 && !/^\d+$/.test(labels[labels.length - 1]) ? labels.slice(0, -1).join('.') : host) || 'hub';
};

/// Other hubs saved with `metacom connect <url> <token> --hub <name>`, as { name, url, http, token }.
const others = (stored, url) =>
  (Array.isArray(stored.hubs) ? stored.hubs : [])
    .filter((h) => h && h.name && h.url && h.token && toWs(h.url) !== toWs(url))
    .map((h) => ({ name: String(h.name), url: toWs(h.url), http: toHttp(h.url), token: h.token }));

const read = () => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

const load = () => {
  const stored = read();
  const env = process.env;
  const url = env.MC_HUB_URL || stored.url || 'ws://127.0.0.1:8900/';
  // the default hub keeps its saved name only while it is the hub the name was given to
  const name = !env.MC_HUB_URL && stored.name ? stored.name : hubName(url);
  return {
    name,
    url: toWs(url),
    http: toHttp(url),
    token: env.MC_TOKEN || stored.token || null,
    fileToken: stored.token || null,
    tokenFromEnv: Boolean(env.MC_TOKEN),
    agentToken: env.MC_AGENT_TOKEN || stored.agentToken || null,
    room: env.MC_ROOM || stored.room || 'default',
    hubs: others(stored, url),
  };
};

const write = (next) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
};

/// The default hub (what agents on this machine use). Other saved hubs and fields stay.
const save = (values) => {
  const stored = read();
  const current = load();
  const url = values.url ? toWs(values.url) : current.url;
  const next = {
    ...stored,
    url,
    token: values.token ?? current.token,
    agentToken: values.agentToken ?? current.agentToken,
    room: values.room ?? current.room,
  };
  // a new default hub drops the old one's name; another hub's entry for this url goes too
  if (values.url && toWs(values.url) !== toWs(stored.url || '')) delete next.name;
  if (values.name) next.name = values.name;
  next.hubs = (stored.hubs || []).filter((h) => toWs(h.url) !== url);
  if (!next.hubs.length) delete next.hubs;
  write(next);
  return { ...next, name: next.name || hubName(url) };
};

/// Save another hub under a name, for the chat's room list (the default hub stays as it is).
const addHub = ({ name, url, token }) => {
  const stored = read();
  if (!stored.url) return save({ url, token, name });
  if (toWs(stored.url) === toWs(url)) return save({ token, name });
  const def = stored.name || hubName(stored.url);
  if (name === def) throw new Error(`"${name}" is your default hub's name; pick another with --hub`);
  const hubs = (stored.hubs || []).filter((h) => h.name !== name && toWs(h.url) !== toWs(url));
  hubs.push({ name, url: toWs(url), token });
  write({ ...stored, hubs });
  return { name, url: toWs(url) };
};

/// Agents' own tokens, made by the wrapper the first time an agent starts on an owner sign-in: one
/// per agent, kept by hub, machine and agent name, so a restart reuses it and /revoke stops just it.
const agentKey = (url, host, name) => `${toWs(url)}|${host}|${name}`;
const agentTokenFor = (url, host, name) => (read().agents || {})[agentKey(url, host, name)] || null;
const saveAgentToken = (url, host, name, entry) => {
  const stored = read();
  write({ ...stored, agents: { ...(stored.agents || {}), [agentKey(url, host, name)]: entry } });
};
const dropAgentToken = (url, host, name) => {
  const stored = read();
  const agents = { ...(stored.agents || {}) };
  delete agents[agentKey(url, host, name)];
  write({ ...stored, agents });
};

const removeHub = (name) => {
  const stored = read();
  const hubs = (stored.hubs || []).filter((h) => h.name !== name);
  if (hubs.length === (stored.hubs || []).length) return false;
  write({ ...stored, hubs });
  return true;
};

/// Rename a saved hub, the default one included.
const renameHub = (from, to) => {
  const stored = read();
  const c = load();
  if (from !== to && (to === c.name || c.hubs.some((h) => h.name === to))) throw new Error(`there is already a hub ${to}`);
  if (from === c.name) return write({ ...stored, name: to }), true;
  const hubs = (stored.hubs || []).map((h) => (h.name === from ? { ...h, name: to } : h));
  if (!hubs.some((h) => h.name === to)) return false;
  write({ ...stored, hubs });
  return true;
};

/// A saved hub by name, the default one included, as { name, url, http, token }.
const hub = (name) => {
  const c = load();
  if (name === c.name) return { name: c.name, url: c.url, http: c.http, token: c.fileToken || c.token };
  return c.hubs.find((h) => h.name === name) || null;
};

/// The hub `metacom connect` saved, whatever MC_HUB_URL says now.
const storedUrl = () => {
  const s = read();
  return s && s.url ? toWs(s.url) : null;
};

module.exports = { storedUrl, agentTokenFor, saveAgentToken, dropAgentToken, load, save, addHub, removeHub, renameHub, hub, hubName, file, toWs, toHttp };
