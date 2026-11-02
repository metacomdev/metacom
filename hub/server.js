#!/usr/bin/env node
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('metacom');
const { Auth } = require('./lib/auth.js');
const { Hub } = require('./lib/hub.js');
const { createContext } = require('./lib/context.js');
const { guardSockets } = require('./lib/guard.js');
const { serveWeb } = require('./lib/web.js');
const { serveMedia } = require('./lib/media.js');
const { Push } = require('./lib/push.js');

const env = process.env;
const host = env.HUB_HOST || '127.0.0.1';
const port = Number(env.HUB_PORT || 8900);
const dataDir = env.HUB_DATA || path.join(os.homedir(), '.local', 'share', 'metacom-hub');

const stamp = () => new Date().toISOString().slice(11, 19);
const console = {
  log: (...a) => process.stdout.write(`${stamp()} ${a.join(' ')}\n`),
  info: (...a) => process.stdout.write(`${stamp()} ${a.join(' ')}\n`),
  warn: (...a) => process.stderr.write(`${stamp()} WARN ${a.join(' ')}\n`),
  error: (...a) => {
    const line = a.map((x) => (x instanceof Error ? x.message : String(x)).split('\n    at ')[0]).join(' ');
    process.stderr.write(`${stamp()} ERROR ${line}\n`);
  },
  debug: () => {},
};

/// `node server.js token <name> [--role owner|agent|member] [--room R]...`: mint a token on the
/// hub machine, offline; `--room` (repeatable) limits an agent or member token to those rooms.
/// Whoever can read the hub's data directory is its owner; this is how a lost owner token is
/// replaced. A running hub picks the new token up from tokens.json without a restart.
const mintToken = (argv) => {
  const name = argv[0];
  const role = argv.includes('--role') ? argv[argv.indexOf('--role') + 1] : 'owner';
  const rooms = argv.flatMap((a, i) => (a === '--room' ? String(argv[i + 1] || '').split(',') : [])).filter(Boolean);
  const steer = argv.includes('--steer-answer') ? 'answer' : argv.includes('--steer');
  if (!name || name.startsWith('-')) {
    process.stderr.write('usage: node server.js token <name> [--role owner|agent|member] [--room R]... [--steer | --steer-answer]\n');
    process.exit(1);
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const quiet = { ...console, warn: () => {}, log: () => {} };
  const auth = new Auth(dataDir, quiet);
  const { token, record } = auth.create({ name, role, rooms: rooms.length ? rooms : null, steer });
  process.stderr.write(`${role} token "${record.name}"${record.rooms ? ' for ' + record.rooms.join(', ') : ''} created in ${path.join(dataDir, 'tokens.json')}, shown once:\n`);
  process.stdout.write(token + '\n');
  if (role === 'member') process.stderr.write(`for them: open <hub url>/${record.rooms ? record.rooms[0] : ''} in a browser and sign in with it, or: metacom connect <hub url> <this token>\n`);
  else process.stderr.write(`on your machine: metacom connect <hub url> ${role === 'owner' ? '<this token>' : '<owner token> --agent-token <this token>'}\n`);
};

const main = async () => {
  if (process.argv[2] === 'token') return mintToken(process.argv.slice(3));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const seeds = [
    { token: env.HUB_OWNER_TOKEN, name: 'env-owner', role: 'owner' },
    { token: env.HUB_AGENT_TOKEN, name: 'env-agent', role: 'agent' },
  ].filter((s) => s.token);
  const auth = new Auth(dataDir, console, seeds);
  const hub = new Hub({ dataDir, auth, console });
  hub.push = new Push({ store: hub.store, console });
  const context = createContext({ hub, auth, console });
  const tls = env.HUB_KEY && env.HUB_CERT;
  const options = {
    host,
    port,
    protocol: tls ? 'https' : 'http',
    key: tls ? fs.readFileSync(env.HUB_KEY) : undefined,
    cert: tls ? fs.readFileSync(env.HUB_CERT) : undefined,
    cors: { origin: env.HUB_CORS || '*' },
    timeouts: { bind: 2000 },
  };
  const server = new Server(context, options);
  serveMedia(server.httpServer, { media: hub.media, auth, console });
  serveWeb(server.httpServer, path.join(__dirname, 'web'), hub);
  guardSockets(server.wsServer, console);
  await server.listen();
  console.log(`hub: ${tls ? 'wss' : 'ws'}://${host}:${port}  data ${dataDir}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && !tls) {
    console.warn('hub: listening on a non-local address without TLS; put it behind Caddy or Tailscale');
  }
  const stop = async () => {
    console.log('hub: stopping');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
