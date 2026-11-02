'use strict';

// metacom share: hosting of what agents build, opened through sessions. One file, no dependencies.
//
// An artifact has a random id and one or more sessions; a session is a link for one audience
// (one team, one pitch) that can be expired on its own, and it records everyone who opens it.
//
//   public :8910
//     GET /<room>/<id>/?session=TOKEN          → 302 /<room>/<id>/s/TOKEN/<entry>  (curl -L just works)
//     GET /<room>/<id>/<path>?session=TOKEN    → 302 /<room>/<id>/s/TOKEN/<path>
//     GET /<room>/<id>/s/TOKEN/<path>          the file (HTML gets a small tracker; sandbox CSP)
//     GET /<room>/<id>/s/TOKEN/_files          JSON: every file with its URL, for agents
//     GET /<room>/<id>/s/TOKEN/_bundle.zip     every file in one zip, for agents
//     POST /<room>/<id>/s/TOKEN/_t             tracker beacons (screen, heartbeat, slides, leave)
//   internal :8911 (agents' docker network only, Bearer <room key>)
//     POST /api/publish  GET /api/list  POST /api/revoke
//     POST /api/update  GET /api/versions?id=  POST /api/rollback
//     GET /api/sessions?id=  POST /api/sessions/create  POST /api/sessions/expire
//     GET /api/visitors?id=&session=  GET /api/activity?id=&session=&user=&limit=
//     GET /api/online  POST /api/sessions/rename
//
// On disk: /data/artifacts/<room>/<id>/
//   permission.json  log.jsonl  versions/<n>/   (n = 1, 2, …; immutable once written; permission.json
//                                                 says which one is current; the old layout's static/
//                                                 becomes versions/1 at start)
//   sessions/<sid>/session.json  users.json  events/<uid>.jsonl
//
//   node server.js                       serve
//   node server.js key <room> <label>    mint a publish key for a room (printed once)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = process.env.SHARE_DATA || '/data';
const PUBLIC_PORT = Number(process.env.SHARE_PORT || 8910);
const INTERNAL_PORT = Number(process.env.SHARE_INTERNAL_PORT || 8911);
const ORIGIN = (process.env.SHARE_ORIGIN || 'http://localhost:8910').replace(/\/$/, '');
const ART = path.join(DATA, 'artifacts');

const ROOM = /^[\w][\w.-]{0,63}$/;
const ID = /^[0-9a-z]{14}-[0-9a-z]{4}-[0-9a-z]{6}$/;
const TOKEN = /^[0-9a-z]{24}$/;
const SID = /^[0-9a-z]{8}$/;
const UID = /^[0-9a-z]{12}$/;
const SEGMENT = /^[\w@()+, -][\w.@()+, -]{0,127}$/;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_BODY = 72 * 1024 * 1024; // base64 of 50 MB plus the JSON around it
const ONLINE_MS = 75 * 1000; // a heartbeat every 30 s; two missed and you are gone
const VISITOR_COOKIE = 'share_vid';
const KEEP_VERSIONS = Number(process.env.SHARE_KEEP_VERSIONS || 20); // the current one is never pruned
// the "Made by agents in a metacom room" line at the end of shared pages; SHARE_FOOTER=0 turns it off
// for the whole server, `footer: false` on publish or update for one artifact
const FOOTER = process.env.SHARE_FOOTER !== '0';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  map: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
// documents that can run script are served sandboxed; a PDF is left alone (Chrome will not show a
// PDF in a sandboxed document) and cannot reach anything anyway
const SANDBOXED = new Set(['html', 'htm', 'svg']);
const TEXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt', 'md', 'csv', 'svg']);

const SECRETS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}/, 'an OpenAI/OpenRouter-style API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk_share_[A-Za-z0-9_-]{20,}/, 'a share publish key'],
  [/\b(?:MC_TOKEN|MC_AGENT_TOKEN|SHARE_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)\s*[=:]\s*\S{12,}/, 'a metacom or model credential'],
];

// MARK: ids and storage

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const rand36 = (n) => {
  let out = '';
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < 252 && out.length < n) out += B36[b % 36];
  return out;
};
const newId = () => `${rand36(14)}-${rand36(4)}-${rand36(6)}`;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const append = (file, record) => fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const keysFile = () => path.join(DATA, 'keys.json');
const roomOfKey = (key) => {
  if (!key) return null;
  const digest = sha256(key);
  return readJson(keysFile(), { keys: [] }).keys.find((k) => eq(k.hash, digest)) || null;
};

const artifactDir = (room, id) => path.join(ART, room, id);
const permissionOf = (room, id) => (ROOM.test(room) && ID.test(id) ? readJson(path.join(artifactDir(room, id), 'permission.json'), null) : null);
const logArtifact = (room, id, record) => append(path.join(artifactDir(room, id), 'log.jsonl'), record);
const versionDir = (room, id, n) => path.join(artifactDir(room, id), 'versions', String(n));
/// The folder visitors are served: the current version (static/ until the artifact is migrated).
const rootOf = (room, id, perm) => (perm.version ? versionDir(room, id, perm.version) : path.join(artifactDir(room, id), 'static'));

const sessionsDir = (room, id) => path.join(artifactDir(room, id), 'sessions');
const sessionDir = (room, id, sid) => path.join(sessionsDir(room, id), sid);
const sessionsOf = (room, id) => {
  const dir = sessionsDir(room, id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((sid) => SID.test(sid))
    .map((sid) => readJson(path.join(dir, sid, 'session.json'), null))
    .filter(Boolean);
};
const live = (s) => !s.expired && (!s.expires || Date.parse(s.expires) > Date.now());
/// The session a token opens, live or not; null when the token matches none of this artifact's.
const sessionOfToken = (room, id, token) => {
  if (!TOKEN.test(token || '')) return null;
  const digest = sha256(token);
  return sessionsOf(room, id).find((s) => eq(s.tokenHash, digest)) || null;
};
/// A session by its id or by its label (the newest live one with that label).
const findSession = (room, id, ref) => {
  const all = sessionsOf(room, id);
  return all.find((s) => s.sid === ref) || all.filter((s) => s.label === ref).sort((a, b) => (live(b) - live(a)) || b.created.localeCompare(a.created))[0] || null;
};

const DURATION = /^(\d+)\s*(m|h|d|w)$/;
const expiryOf = (spec) => {
  if (spec === undefined || spec === null || spec === '' || spec === 'never') return null;
  const m = DURATION.exec(String(spec).trim());
  if (!m) throw Object.assign(new Error('expires: like 2h, 7d, 4w or never'), { status: 400 });
  const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]] * Number(m[1]);
  return new Date(Date.now() + ms).toISOString();
};

const createSession = (room, id, { label, expires, by }) => {
  const token = rand36(24);
  let sid;
  do sid = rand36(8);
  while (fs.existsSync(sessionDir(room, id, sid)));
  const dir = sessionDir(room, id, sid);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true, mode: 0o700 });
  const session = { sid, label: String(label || 'default').trim().slice(0, 60) || 'default', tokenHash: sha256(token), created: new Date().toISOString(), by, expires: expiryOf(expires), expired: false };
  writeJson(path.join(dir, 'session.json'), session);
  writeJson(path.join(dir, 'users.json'), { users: [] });
  logArtifact(room, id, { event: 'session created', sid, label: session.label, by, expires: session.expires });
  return { ...publicSession(session), link: `${ORIGIN}/${room}/${id}/?session=${token}` };
};
const publicSession = (s) => ({ sid: s.sid, label: s.label, created: s.created, by: s.by, expires: s.expires, status: s.expired ? 'expired' : live(s) ? 'live' : 'timed out' });

// MARK: visitors

/// Browser, OS and device from a user agent, and whether it is a person's browser or a program.
const describeAgent = (ua) => {
  const u = String(ua || '');
  const tool = /\b(curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|undici|axios|go-http-client|okhttp|java|libwww|postman|insomnia|claude-?user|claudebot|anthropic|gptbot|chatgpt-user|oai-searchbot|perplexity|bingbot|googlebot|bot|spider|crawler|headless)/i.exec(u);
  const pick = (pairs) => {
    for (const [re, name] of pairs) {
      const m = re.exec(u);
      if (m) return m[1] ? `${name} ${m[1]}` : name;
    }
    return null;
  };
  const browser = pick([
    [/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/YaBrowser\/(\d+)/, 'Yandex'], [/SamsungBrowser\/(\d+)/, 'Samsung'],
    [/Firefox\/(\d+)/, 'Firefox'], [/CriOS\/(\d+)/, 'Chrome iOS'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+)[\d.]* .*Safari\//, 'Safari'],
  ]);
  const os = pick([
    [/iPhone OS (\d+)/, 'iOS'], [/iPad.*OS (\d+)/, 'iPadOS'], [/Android (\d+)/, 'Android'], [/Windows NT (\d+\.\d)/, 'Windows'],
    [/Mac OS X (\d+[._]\d+)/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
  ]);
  const device = /iPad|Tablet/.test(u) ? 'tablet' : /Mobi|iPhone|Android/.test(u) ? 'mobile' : browser ? 'desktop' : 'unknown';
  const kind = tool || !browser ? 'agent' : 'human';
  return { kind, browser: browser || (tool ? tool[1] : null), os: os ? os.replace('_', '.') : null, device, ua: u.slice(0, 300) };
};

const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
const cookieOf = (req, name) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([0-9a-z]{12})`));
  return m ? m[1] : null;
};

/// The visitor making this request, recorded in the session's users.json. A browser keeps its id in a
/// cookie (sent on page loads); a program has none, so its id is derived from the session, its address
/// and its user agent, which keeps one agent one visitor across its requests.
const visitor = (req, room, id, session) => {
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '');
  const uid = cookieOf(req, VISITOR_COOKIE) || sha256(`${session.sid}|${ip}|${ua}`).replace(/[^0-9a-z]/g, '').slice(0, 12);
  const file = path.join(sessionDir(room, id, session.sid), 'users.json');
  const db = readJson(file, { users: [] });
  let user = db.users.find((u) => u.uid === uid);
  const now = new Date().toISOString();
  const where = {
    ip,
    country: req.headers['cf-ipcountry'] || null,
    city: req.headers['cf-ipcity'] ? decodeURIComponent(String(req.headers['cf-ipcity'])) : null,
    region: req.headers['cf-region'] || null,
    language: String(req.headers['accept-language'] || '').split(',')[0] || null,
  };
  if (!user) {
    user = { uid, ...describeAgent(ua), ...where, first: now, last: now, requests: 0, views: 0, ips: [ip] };
    db.users.push(user);
  } else {
    Object.assign(user, where, { last: now });
    if (!user.ips.includes(ip)) user.ips = [...user.ips, ip].slice(-10);
  }
  user.requests += 1;
  writeJson(file, db);
  return user;
};

/// Watching now: a browser whose page sent a heartbeat (every 30 s) and has not been hidden or left;
/// an agent, which sends none, while it made a request within the same window.
const onlineNow = (u, now = Date.now()) =>
  Boolean((u.online && u.lastBeat && now - Date.parse(u.lastBeat) < ONLINE_MS) || (u.kind === 'agent' && u.last && now - Date.parse(u.last) < ONLINE_MS));

const userEvent = (room, id, sid, uid, record) => append(path.join(sessionDir(room, id, sid), 'events', `${uid}.jsonl`), record);

const updateUser = (room, id, sid, uid, patch) => {
  const file = path.join(sessionDir(room, id, sid), 'users.json');
  const db = readJson(file, { users: [] });
  const user = db.users.find((u) => u.uid === uid);
  if (!user) return null;
  Object.assign(user, patch, { last: new Date().toISOString() });
  writeJson(file, db);
  return user;
};

// The tracker that rides along in every HTML page of a session: what only the browser knows (screen,
// window, time zone), a heartbeat while the page is visible (who is watching now), slide changes
// (the hash) and leaving. It runs inside the sandboxed page and talks only to its own session.
//
// The heartbeat's answer carries the artifact's current version: when it differs from the one this page
// was opened at, a small notice offers a reload (never automatic: a visitor mid-read keeps their place).
const tracker = (endpoint, uid, version) => `<script>(function(){try{var E=${JSON.stringify(endpoint)},U=${JSON.stringify(uid)},V=${Number(version) || 0},S=Date.now(),N=0;
function send(t,d){var b=JSON.stringify({t:t,u:U,page:location.pathname.replace(/^.*\\/s\\/[0-9a-z]+\\//,''),hash:location.hash.slice(0,80),d:d||{}});try{if(navigator.sendBeacon&&navigator.sendBeacon(E,b))return;}catch(e){}try{fetch(E,{method:'POST',body:b,keepalive:true,mode:'no-cors'});}catch(e){}}
var n=navigator,s=screen;send('open',{screen:s.width+'x'+s.height,window:innerWidth+'x'+innerHeight,dpr:devicePixelRatio,lang:n.language,tz:(Intl.DateTimeFormat().resolvedOptions()||{}).timeZone,platform:n.platform,cores:n.hardwareConcurrency,memory:n.deviceMemory,touch:n.maxTouchPoints,colors:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'});
function notice(){if(N)return;N=1;var d=document.createElement('div');d.setAttribute('role','status');d.style.cssText='all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;gap:12px;align-items:center;padding:10px 12px 10px 14px;background:#282c34;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
var t=document.createElement('span');t.textContent='This was updated.';var r=document.createElement('button');r.textContent='Reload';var x=document.createElement('button');x.textContent='\u00d7';x.setAttribute('aria-label','Dismiss');
[r,x].forEach(function(b){b.style.cssText='all:initial;cursor:pointer;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-decoration:underline;text-underline-offset:3px';});x.style.textDecoration='none';x.style.fontSize='18px';
r.onclick=function(){location.reload();};x.onclick=function(){d.remove();};d.append(t,r,x);(document.body||document.documentElement).append(d);}
function beat(){try{fetch(E,{method:'POST',body:JSON.stringify({t:'heartbeat',u:U,page:location.pathname.replace(/^.*\\/s\\/[0-9a-z]+\\//,''),hash:location.hash.slice(0,80),d:{window:innerWidth+'x'+innerHeight,seconds:Math.round((Date.now()-S)/1000)}}),keepalive:true}).then(function(r){return r.json();}).then(function(j){if(V&&j&&j.version&&j.version!==V)notice();}).catch(function(){});}catch(e){}}
setInterval(function(){if(!document.hidden)beat();},30000);
document.addEventListener('visibilitychange',function(){send(document.hidden?'hidden':'visible');});
addEventListener('hashchange',function(){send('slide');});
addEventListener('pagehide',function(){send('leave',{seconds:Math.round((Date.now()-S)/1000)});});}catch(e){}})();</script>`;

// One quiet line at the end of the page, in the flow (it never covers the artifact's own layout),
// styled from scratch so the page's CSS can neither break nor restyle it.
const footer = () =>
  '<div data-metacom-footer style="all:initial;display:block;box-sizing:border-box;width:100%;margin:48px 0 0;padding:16px;text-align:center;font:13px/1.5 system-ui,-apple-system,sans-serif;color:#6b7280">' +
  'Made by agents in a metacom room \u00b7 <a href="https://metacom.dev" target="_blank" rel="noopener" style="all:initial;font:inherit;color:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer">metacom.dev</a></div>';

const inject = (html, script) => {
  const at = html.search(/<\/body\s*>/i);
  return at >= 0 ? html.slice(0, at) + script + html.slice(at) : html + script;
};

// MARK: pages

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};
const message = (res, code, title, text) => {
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${ICON_LINKS}<title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;padding:16px;text-align:center}h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.7}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`);
};
const notFound = (res) => message(res, 404, 'Not found', 'This link does not exist or was revoked.');

// MARK: favicon: the metacom icon. Kept in this file:
// share is one file with no dependencies. Served at the root, where browsers look for it, for the
// pages here and for shared HTML that has no icon of its own.
const ICONS = {
  '/favicon.svg': ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><image width="32" height="32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAIG0lEQVR4AaxXWW9dVxX+1jrXbhISx47HSFS0KE09xXb6A0Co4oEHJJ4hc9pESYNaCjRTMxeBEMSZnBAEKg8g8QAqiKlPBRXq2AlCakBCnoqCyEADxPGQ2Hc6fN8699omElIfuu/5ztp7rW8Ne59z9znHS6VSKhSLxfTDQqn4AWMxt4Pt3r17GL56DVeGhgNDw9cwNHS10qccvooh4sqw7NWx+OxfkU64ikH6DA1dw6C4EesqYxDVMbmDg8MYpJyZmUG5XIanaYq/jozhRz/+Cc5euIwzRP+5i+g/fxFnBy6j/9wl9J+9iNNE/5mLkP702QGOB9B/bgCnyZPt22cvkMexdGcGaKOf4lRx/lLGPT+AS999HTdu/B3FQgGxAuVSGTdv3cHI6BhGRkZDjo5NYJTj8YkJjI2NY1QYz/rj4+9lY3LGqRNngrpx9sXVeGx8HJIB6mUT3pv4GybvT2J2dha85FkBKbgUbjAz1NbWoLFpDVqam9DS0oKmJsrWZvab0cy+xk1NjWimvbmFumahCU0cS78gyWlsXIPGNRnq6+tRU1MLGKKVyiVo9T1GqcX1UL+hoQEv7NqBwwdexolX9+PkkQOBU0cP4rXjh3Dy6AGcOJLpT8kW44xz8tghiHfqqOQhcg8GTpDzuc9+BqtWrYKZQzUoufK5TkBKITWQy+Wwtq0NT61bh/b2p9HR0U50EJLt6OrsRHdXF7q6OkPX2dGBTuo6OzvQRUhW0UW9eNK3MWZNbQ2cK13mfWdRBrJLwOwwGmQUHlv2GOrq6gKq+v9BHNnqOLNqX+NHUVe3GsuWLWNKg1kGGKK5zpq/04DQGswW4e4xxiPNzCCbYJbx8Ugzs+CYURLmxuvO9Y4VQDSPMy+BmYMcWqkpqyRKHrpWx059Ha8cPIKDrx7HgcPH8bVvfAv3p+4v3Df/fP9u6PcfPhbyqweOxH+9wL9ZFhAo6T/vCZxFqGiGhvHkRHAsijAYCRA4lk2bxZ077+OPf3oXv3/nCjGIG/+4hampaXAH5YxS5Ofncfff/+Gmcw1/GLyCd//8F9y6eRNzcw/DrjgKZ+yY6QwWn0qFKMCM6TM96MHKNBDowaNYLKBQyDMRkS+gxJkV8nlSs5XSKuk/rULm5/PQvpIvzMf/nKvNCAzLdJo9IrpBEzUgK4A6MWBmVLG76BVjwGBmFAYtXzktY2nLygA8cSiJmZGfLKVwLJ3BadPcJcEWK6Blpj5IPFFdOawiKdydwQWLvyqnT212iJYkCmVI3MnjirJIrcwCeF+5G7IiPdxVuLxg/LnJkaA0UwCZUWlpVE41zGhjMHYqtkxk/gbwKHMFR0fH8dZv38avfvMmfvnrNzHCrbxQKDJxCjMLgC0K0JKYO6gGbbxaJNG4eBhkcBpdPDcODUsbTQibOeYePsQ7fKJ+/wc/jAfP5e+9jrd+9zYmJyczPxaolZG/6wQYfzwzsDoxUkRkzSgiOO1mHEUAKpccYafNzDgBsIj5eOBMT09j6v4UHjx4oJsLLjv9OQjvSgGcsVsYwZYSVUJ0GdLMYJwdBczYzwyLZ+qyy+BIkgQrV34Eq+pWob5+dbajcpyrrYUnWUozC99sxK6czQz6IW4gKqNSlkKZuMMJs6pLViZZLA+gFTBEW758OT797Cfx4t5d+MpL+/DKl/bh2U99AnUrVzIYScyDCjmLxljOFTACNHKIaOxXpZlBBSTupPAuxmJjSCQ5g1c5ScLHeSPan16P3p4N6OntweMffZyP+lqYG/15mThJsDkBGKDgsQoAzKg2LLSUd73sUoW0FGYaLVCY3EPn1JsZL0MNL8PKWP46PtiWL1/G94EcEndyF30dlSbHJKHRDSZdqlMVKWQzM/CoKhekqHylICeB058HEp7MnXyjLlsxM/kb1OSjnmsQFzGMGkqd0pGWlOBhZhw7VASHsY9LVmHsmCqQDK6WuOIMWXnpuYrGvhnPAvukQxmZXzNM4DIYybzpqESFw4RlzsICCa9v4o7/bSnMDR5wmDkWW7rQTXIJxGGGBZ2rZ2YwM3jicM+Wa8GNnSShTXZzJO4wJooCkTVS4Oy6GdwFxeD2pomg2lLaPMvjCZX0Ep+9KIh+SBIPhI6nlM9wholnOT15ZIXW1OQiv3azAJdXszP3SJLLKRGLYAGy61mj9wFjTDODctEE2RzRWA2s8gPOX/gO9r34ZezcvRfP7dqLJ594ko/YEpTEmaTIPf3oidewe88XsfP5PXxB+Sbu3v0XkzMGE+hx/NOf/QIvvbwfO3ftwfO7X8Abb/wc83yEu+zKzrxGRAFmnl3nxKEvlpnZB3yZmCPmkeez//r166y2zMoN5obbt2+H/uHcHITpmVlMT0/BGFAo8N1Bsy7wPWKeLyvi5ItFzPJrSP7OGG68UcmPAihRLBWRS3JwT/imU0Se1QoKoKVKkgQJ35hzlGaOeAHhy4k4BRZpZtAbdS23W0n55LlSegKKo1UzyzjyhyplYiewZk0DPv7Ex9CzoQt9vd3Y2NdD2YPeDd3UdVNuCN3G3kz2ktPXQ31PF3e6bvSRpx1Pfhu56/UJ3AE3krehuws93eJ24xnGfaavF+3r12HFihVRQxSw/ql1eG7HNmzfuimwbcsmbN38eWzb8oXA9m2bKDNs37oZOwhxtm/ZHPqtFV7wKzG2UwZnK2MI4lAqrmxr165FrobfCcY6tGQNDfVobW0l2ohW6EOilR8TIUMvWys/0VoW7G1r24InjtDamvlmcVqDJ51swtL+6tWruTXX4L8AAAD//6T/zbMAAAAGSURBVAMAUiHZyVyrhNIAAAAASUVORK5CYII="/></svg>\n')],
  '/favicon.ico': ['image/x-icon', Buffer.from('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', 'base64')],
  '/favicon-32.png': ['image/png', Buffer.from('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', 'base64')],
  '/apple-touch-icon.png': ['image/png', Buffer.from('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', 'base64')],
};
const ICON_LINKS = '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

// MARK: zip (stored, no compression: what is shared is mostly compressed already)

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const zip = (entries) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(n.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(head, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
};

// MARK: public server

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const filesOf = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

const resolveFile = (root, rel) => {
  let segments;
  try {
    segments = decodeURIComponent(rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel).split('/');
  } catch {
    return null;
  }
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;
  let file = path.join(root, ...segments);
  if (!file.startsWith(root + path.sep)) return null;
  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  return stat && stat.isFile() ? { file, stat } : null;
};

const servePath = (req, res, room, id, perm, token, session, rest) => {
  const base = `/${room}/${id}/s/${token}/`;
  const root = rootOf(room, id, perm);
  const version = perm.version || 1;
  const user = visitor(req, room, id, session);
  const sid = session.sid;

  if (rest === '_files') {
    userEvent(room, id, sid, user.uid, { event: 'files', ip: user.ip });
    const files = filesOf(root).map((p) => ({ path: p, bytes: fs.statSync(path.join(root, ...p.split('/'))).size, type: TYPES[path.extname(p).slice(1).toLowerCase()] || null, url: `${ORIGIN}${base}${p.split('/').map(encodeURIComponent).join('/')}` }));
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ title: perm.title, version, entry: `${ORIGIN}${base}${perm.entry || ''}`, bundle: `${ORIGIN}${base}_bundle.zip`, files }, null, 2));
  }
  if (rest === '_bundle.zip') {
    const files = filesOf(root);
    userEvent(room, id, sid, user.uid, { event: 'download bundle', files: files.length, ip: user.ip });
    const body = zip(files.map((p) => ({ name: p, data: fs.readFileSync(path.join(root, ...p.split('/'))) })));
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/zip', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="${id}.zip"`, 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  const found = resolveFile(root, rest);
  if (!found) {
    userEvent(room, id, sid, user.uid, { event: 'not found', path: rest, ip: user.ip });
    return notFound(res);
  }
  const ext = path.extname(found.file).slice(1).toLowerCase();
  const isDoc = ext === 'html' || ext === 'htm';
  const navigation = req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-dest'] === 'iframe' || (!req.headers['sec-fetch-dest'] && isDoc);
  userEvent(room, id, sid, user.uid, { event: navigation ? 'view' : 'get', path: path.relative(root, found.file).split(path.sep).join('/'), version, ip: user.ip });
  if (navigation && isDoc) updateUser(room, id, sid, user.uid, { views: (user.views || 0) + 1 });

  const headers = {
    ...BASE_HEADERS,
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'private, no-cache',
    // a sandboxed page has an opaque origin, so its module scripts, fonts and fetch('data.json') are
    // cross-origin requests to its own files; the session in the path is the access anyway
    'Access-Control-Allow-Origin': '*',
  };
  if (SANDBOXED.has(ext)) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-presentation';
  // a browser keeps its visitor id for this session's later page loads; programs ignore it
  if (!cookieOf(req, VISITOR_COOKIE)) headers['Set-Cookie'] = `${VISITOR_COOKIE}=${user.uid}; Path=/${room}/${id}/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;
  if (isDoc && req.method === 'GET') {
    const html = inject(fs.readFileSync(found.file, 'utf8'), (FOOTER && perm.footer !== false ? footer() : '') + tracker(`${base}_t`, user.uid, version));
    const body = Buffer.from(html);
    res.writeHead(200, { ...headers, 'Content-Length': body.length, Link: `<${base}_files>; rel="alternate"; type="application/json"` });
    return res.end(body);
  }
  // every file is revalidated (no-cache): after an update a reload never mixes in old assets; the
  // ETag names the version, so an unchanged artifact costs a 304
  const etag = `"v${version}-${found.stat.size.toString(36)}-${Math.round(found.stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) return res.writeHead(304, { ...headers, ETag: etag }).end();
  res.writeHead(200, { ...headers, ETag: etag, 'Content-Length': found.stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(found.file).pipe(res);
};

// beacons from the tracker: kept small, only known kinds, only for a visitor of this session
const BEACONS = new Set(['open', 'heartbeat', 'hidden', 'visible', 'slide', 'leave']);
const beacon = async (req, res, room, id, perm, session) => {
  let heartbeat = false;
  // a heartbeat (sent with fetch, not a beacon) is answered with the current version, for the notice
  const reply = () =>
    heartbeat
      ? res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ version: perm.version || 1 }))
      : res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
  let msg;
  try {
    msg = JSON.parse((await readBody(req, 4096)).toString('utf8'));
  } catch {
    return reply();
  }
  if (!msg || !UID.test(msg.u || '') || !BEACONS.has(msg.t)) return reply();
  heartbeat = msg.t === 'heartbeat';
  const d = msg.d && typeof msg.d === 'object' ? msg.d : {};
  const clip = (v) => (v === undefined || v === null ? undefined : String(v).slice(0, 80));
  const info = {};
  for (const k of ['screen', 'window', 'dpr', 'lang', 'tz', 'platform', 'cores', 'memory', 'touch', 'colors', 'seconds']) if (d[k] !== undefined) info[k] = clip(d[k]);
  const now = new Date().toISOString();
  const users = readJson(path.join(sessionDir(room, id, session.sid), 'users.json'), { users: [] }).users;
  const before = users.find((u) => u.uid === msg.u);
  const watching = msg.t !== 'leave' && msg.t !== 'hidden';
  const patch = { online: watching, lastBeat: now, page: clip(msg.page) || '', hash: clip(msg.hash) || '' };
  // since when they are watching: set when they come (back), kept while heartbeats continue
  if (watching && !(before && onlineNow(before))) patch.onlineSince = now;
  if (msg.t === 'open') Object.assign(patch, { screen: info.screen, window: info.window, dpr: info.dpr, timezone: info.tz, platform: info.platform, cores: info.cores, memory: info.memory, touch: info.touch, theme: info.colors, browserLanguage: info.lang });
  if (msg.t === 'heartbeat' && info.window) patch.window = info.window;
  if (!updateUser(room, id, session.sid, msg.u, patch)) return reply();
  userEvent(room, id, session.sid, msg.u, { event: msg.t, page: clip(msg.page), hash: clip(msg.hash) || undefined, ...info, ip: clientIp(req) });
  reply();
};

const publicServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    if (url.pathname === '/robots.txt') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
    if (ICONS[url.pathname]) {
      const [type, body] = ICONS[url.pathname];
      return res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400' }).end(req.method === 'HEAD' ? undefined : body);
    }
    if (url.pathname === '/') return message(res, 200, 'metacom share', 'Open the link you were given.');
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return notFound(res);
    const [, room, id, tail = ''] = m;
    const perm = permissionOf(room, id);
    if (!perm || perm.revoked) return notFound(res);

    // /s/TOKEN/… is the working form; ?session=TOKEN on any path of the artifact turns into it
    const inPath = tail.match(/^\/s\/([^/]+)\/(.*)$/);
    const token = inPath ? inPath[1] : url.searchParams.get('session');
    if (!token) return message(res, 401, perm.title ? 'A session is needed' : 'Not found', 'Open the full link you were given: it ends in ?session=…');
    const session = sessionOfToken(room, id, token);
    if (!session) return notFound(res);
    if (!live(session)) return message(res, 410, 'This session has ended', 'Ask whoever shared it for a new link.');
    if (!inPath) {
      const rest = tail.replace(/^\//, '') || perm.entry || '';
      return res.writeHead(302, { Location: `/${room}/${id}/s/${token}/${rest}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
    }
    const rest = inPath[2];
    if (rest === '_t') return req.method === 'POST' ? beacon(req, res, room, id, perm, session) : res.writeHead(405).end();
    if (req.method === 'OPTIONS') return res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD' }).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    return servePath(req, res, room, id, perm, token, session, rest === '' && perm.entry ? perm.entry : rest);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.status || 500, { 'Content-Type': 'text/plain' });
    res.end(error.status === 413 ? 'too large' : 'error');
    if (!error.status) console.error(error);
  }
});

// MARK: internal API

const send = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/// Files as sent: [{ path: "deck/index.html", data: base64 }]. Checked before anything is written.
/// The secrets scan runs here, so on every file a publish or an update brings in.
const checkFiles = (files, { allowEmpty = false } = {}) => {
  if (!Array.isArray(files) || (files.length === 0 && !allowEmpty)) throw bad('no files');
  if (files.length > MAX_FILES) throw bad(`at most ${MAX_FILES} files`);
  let total = 0;
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const rel = String(f && f.path).replace(/^\.\//, '');
    const segments = rel.split('/');
    if (!rel || rel.startsWith('/') || rel.includes('\\') || segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..') || segments[0].startsWith('_')) throw bad(`bad path: ${rel}`);
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!TYPES[ext]) throw bad(`not allowed: ${rel} (.${ext || '?'})`);
    if (seen.has(rel)) throw bad(`twice: ${rel}`);
    seen.add(rel);
    const data = Buffer.from(String(f.data || ''), 'base64');
    total += data.length;
    if (total > MAX_BYTES) throw bad('more than 50 MB', 413);
    if (TEXT.has(ext)) {
      const text = data.toString('utf8');
      for (const [re, what] of SECRETS) if (re.test(text)) throw bad(`refused: ${rel} contains ${what}`, 422);
    }
    out.push({ rel, data });
  }
  return out;
};

/// Where a version opens: one file that is not index.html is opened directly; a folder opens at its
/// index.html, else at its first HTML file.
const entryOf = (rels) => (rels.includes('index.html') ? '' : rels.length === 1 ? rels[0] : rels.find((r) => /\.html?$/.test(r)) || rels[0]);
const writeFiles = (dir, files) => {
  for (const { rel, data, from } of files) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (from) fs.copyFileSync(from, file);
    else fs.writeFileSync(file, data, { mode: 0o600 });
  }
};

const publish = (keyRec, body) => {
  const room = keyRec.room;
  const title = String(body.title || '').trim().slice(0, 120) || 'Untitled';
  const files = checkFiles(body.files);
  let id;
  do id = newId();
  while (fs.existsSync(artifactDir(room, id)));
  const dir = versionDir(room, id, 1);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFiles(dir, files);
  const entry = entryOf(files.map((f) => f.rel));
  const created = new Date().toISOString();
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  const perm = { title, room, by: keyRec.label, created, entry, revoked: false, ...(body.footer === false ? { footer: false } : {}), files: files.length, bytes, version: 1, versions: [{ n: 1, created, by: keyRec.label, note: 'published', files: files.length, bytes, entry }] };
  writeJson(path.join(artifactDir(room, id), 'permission.json'), perm);
  logArtifact(room, id, { event: 'published', by: keyRec.label, files: perm.files, bytes: perm.bytes });
  const session = createSession(room, id, { label: body.session || 'default', expires: body.expires, by: keyRec.label });
  return { id, room, title, files: perm.files, bytes: perm.bytes, session };
};

/// A new version of an artifact, made current: the same id, the same session links. "replace" takes
/// the files as the whole version; "merge" keeps the current files, overlays these and drops `remove`.
/// Everything here is synchronous, so two updates of one artifact can never interleave (one process).
const update = (keyRec, body) => {
  const room = keyRec.room;
  const id = String(body.id || '');
  const perm = artifactFor(room, id);
  if (perm.revoked) throw bad(`no artifact ${id} in ${room}`, 404);
  if (typeof body.footer === 'boolean') perm.footer = body.footer; // saved with the new version below
  const mode = body.mode || 'replace';
  if (mode !== 'replace' && mode !== 'merge') throw bad('mode: "replace" or "merge"');
  const remove = body.remove === undefined ? [] : body.remove;
  if (!Array.isArray(remove)) throw bad('remove: a list of paths');
  if (remove.length && mode !== 'merge') throw bad('remove works with mode "merge"');
  const incoming = checkFiles(body.files || [], { allowEmpty: mode === 'merge' && (remove.length > 0 || typeof body.footer === 'boolean') });
  const root = rootOf(room, id, perm);
  const current = filesOf(root);
  for (const r of remove) if (!current.includes(String(r))) throw bad(`not in the current version: ${r}`);

  // the resulting version: what is kept (merge), then what came in
  const byRel = new Map();
  if (mode === 'merge') for (const rel of current) if (!remove.includes(rel)) byRel.set(rel, { rel, from: path.join(root, ...rel.split('/')) });
  for (const f of incoming) byRel.set(f.rel, f);
  const files = [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  if (!files.length) throw bad('no files would be left');
  if (files.length > MAX_FILES) throw bad(`at most ${MAX_FILES} files`);
  const sizeOf = (f) => (f.from ? fs.statSync(f.from).size : f.data.length);
  const bytes = files.reduce((n, f) => n + sizeOf(f), 0);
  if (bytes > MAX_BYTES) throw bad('more than 50 MB', 413);
  const rels = files.map((f) => f.rel);
  let entry;
  if (body.entry !== undefined && body.entry !== null && body.entry !== '') {
    entry = String(body.entry);
    if (!rels.includes(entry)) throw bad(`entry: ${entry} is not in the new version`);
  } else entry = perm.entry === '' ? (rels.includes('index.html') ? '' : entryOf(rels)) : rels.includes(perm.entry) ? perm.entry : entryOf(rels);

  // what changed, for the log and the answer
  const before = new Set(current);
  const added = rels.filter((r) => !before.has(r));
  const removed = current.filter((r) => !byRel.has(r));
  const changed = incoming.filter((f) => before.has(f.rel) && !fs.readFileSync(path.join(root, ...f.rel.split('/'))).equals(f.data)).map((f) => f.rel);

  // written aside, then renamed into place, and only then made current: a crash leaves the old live
  const n = Math.max(perm.version || 1, ...(perm.versions || []).map((v) => v.n)) + 1;
  const final = versionDir(room, id, n);
  const tmp = `${final}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  writeFiles(tmp, files);
  fs.renameSync(tmp, final);
  const note = String(body.note || '').trim().slice(0, 200);
  const record = { n, created: new Date().toISOString(), by: keyRec.label, note, files: files.length, bytes, entry };
  Object.assign(perm, { version: n, versions: [...(perm.versions || []), record], files: files.length, bytes, entry, updated: record.created });
  prune(room, id, perm);
  writeJson(path.join(artifactDir(room, id), 'permission.json'), perm);
  logArtifact(room, id, { event: 'updated', version: n, mode, by: keyRec.label, note: note || undefined, added: added.length, changed: changed.length, removed: removed.length });
  return { id, title: perm.title, version: n, mode, added, changed, removed, files: files.length, bytes, entry };
};

/// Drops the oldest versions beyond KEEP_VERSIONS, never the current one; their records stay, marked.
const prune = (room, id, perm) => {
  const kept = perm.versions.filter((v) => !v.pruned);
  const drop = kept.slice(0, Math.max(0, kept.length - KEEP_VERSIONS)).filter((v) => v.n !== perm.version);
  for (const v of drop) {
    fs.rmSync(versionDir(room, id, v.n), { recursive: true, force: true });
    v.pruned = true;
  }
};

const versions = (room, id) => {
  const perm = artifactFor(room, id);
  return { id, title: perm.title, current: perm.version || 1, versions: (perm.versions || []).map((v) => ({ ...v, current: v.n === (perm.version || 1) })) };
};

const rollback = (keyRec, body) => {
  const room = keyRec.room;
  const id = String(body.id || '');
  const perm = artifactFor(room, id);
  if (perm.revoked) throw bad(`no artifact ${id} in ${room}`, 404);
  const n = Number(body.version);
  const v = (perm.versions || []).find((x) => x.n === n);
  if (!v || v.pruned || !fs.existsSync(versionDir(room, id, n))) throw bad(`no version ${body.version} of ${id}${v && v.pruned ? ' (pruned)' : ''}`, 404);
  const from = perm.version;
  Object.assign(perm, { version: n, files: v.files, bytes: v.bytes, entry: v.entry, updated: new Date().toISOString() });
  writeJson(path.join(artifactDir(room, id), 'permission.json'), perm);
  logArtifact(room, id, { event: 'rolled back', from, to: n, by: keyRec.label });
  return { id, title: perm.title, version: n, from };
};

/// At start: the old layout's static/ becomes versions/1 (idempotent), and a leftover versions/*.tmp
/// from an update cut short is removed (it was never current).
const migrate = () => {
  if (!fs.existsSync(ART)) return 0;
  let moved = 0;
  for (const room of fs.readdirSync(ART).filter((r) => ROOM.test(r))) {
    for (const id of fs.readdirSync(path.join(ART, room)).filter((x) => ID.test(x))) {
      const dir = artifactDir(room, id);
      const perm = permissionOf(room, id);
      if (!perm) continue;
      const vdir = path.join(dir, 'versions');
      if (fs.existsSync(vdir)) for (const e of fs.readdirSync(vdir)) if (e.endsWith('.tmp')) fs.rmSync(path.join(vdir, e), { recursive: true, force: true });
      if (perm.version) continue;
      const old = path.join(dir, 'static');
      if (fs.existsSync(old)) {
        fs.mkdirSync(vdir, { recursive: true, mode: 0o700 });
        fs.renameSync(old, versionDir(room, id, 1));
      }
      Object.assign(perm, { version: 1, versions: [{ n: 1, created: perm.created, by: perm.by, note: 'published', files: perm.files, bytes: perm.bytes, entry: perm.entry }] });
      writeJson(path.join(dir, 'permission.json'), perm);
      moved += 1;
    }
  }
  return moved;
};

const sessionStats = (room, id, s) => {
  const users = readJson(path.join(sessionDir(room, id, s.sid), 'users.json'), { users: [] }).users;
  const now = Date.now();
  const online = users.filter((u) => onlineNow(u, now)).length;
  const last = users.reduce((t, u) => (u.last > t ? u.last : t), '');
  return { ...publicSession(s), visitors: users.length, humans: users.filter((u) => u.kind === 'human').length, agents: users.filter((u) => u.kind === 'agent').length, online, lastSeen: last || null };
};

const list = (room) => {
  const dir = path.join(ART, room);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => ID.test(id))
    .map((id) => {
      const perm = permissionOf(room, id);
      if (!perm) return null;
      const sessions = sessionsOf(room, id).map((s) => sessionStats(room, id, s));
      return { id, title: perm.title, by: perm.by, created: perm.created, updated: perm.updated || null, version: perm.version || 1, revoked: perm.revoked, files: perm.files, sessions: sessions.length, live: sessions.filter((s) => s.status === 'live').length, visitors: sessions.reduce((n, s) => n + s.visitors, 0), online: sessions.reduce((n, s) => n + s.online, 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.created.localeCompare(a.created));
};

const artifactFor = (room, id) => {
  const perm = permissionOf(room, String(id || ''));
  if (!perm) throw bad(`no artifact ${id} in ${room}`, 404);
  return perm;
};
const sessionFor = (room, id, ref) => {
  const s = findSession(room, id, String(ref || ''));
  if (!s) throw bad(`no session ${ref} on ${id}`, 404);
  return s;
};

const visitors = (room, id, sessionRef) => {
  const sessions = sessionRef ? [sessionFor(room, id, sessionRef)] : sessionsOf(room, id);
  const now = Date.now();
  return sessions.map((s) => ({
    sid: s.sid,
    label: s.label,
    users: readJson(path.join(sessionDir(room, id, s.sid), 'users.json'), { users: [] }).users.map((u) => ({ ...u, onlineNow: onlineNow(u, now) })),
  }));
};

/// Everyone watching something of this room right now, newest arrival first.
const online = (room) => {
  const now = Date.now();
  const out = [];
  const dir = path.join(ART, room);
  if (!fs.existsSync(dir)) return out;
  for (const id of fs.readdirSync(dir).filter((x) => ID.test(x))) {
    const perm = permissionOf(room, id);
    if (!perm || perm.revoked) continue;
    for (const s of sessionsOf(room, id)) {
      for (const u of readJson(path.join(sessionDir(room, id, s.sid), 'users.json'), { users: [] }).users) {
        if (!onlineNow(u, now)) continue;
        out.push({ id, title: perm.title, sid: s.sid, session: s.label, uid: u.uid, kind: u.kind, browser: u.browser, os: u.os, device: u.device, country: u.country, city: u.city, ip: u.ip, screen: u.screen, window: u.window, since: u.onlineSince || u.last, page: u.page, hash: u.hash });
      }
    }
  }
  return out.sort((a, b) => String(b.since).localeCompare(String(a.since)));
};

const activity = (room, id, sessionRef, uid, limit) => {
  const s = sessionFor(room, id, sessionRef);
  const dir = path.join(sessionDir(room, id, s.sid), 'events');
  const files = uid ? [`${uid}.jsonl`] : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  const events = [];
  for (const f of files) {
    if (!UID.test(f.replace(/\.jsonl$/, ''))) continue;
    const lines = (() => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    })();
    for (const l of lines) if (l) events.push({ uid: f.replace(/\.jsonl$/, ''), ...JSON.parse(l) });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { sid: s.sid, label: s.label, events: events.slice(-Math.min(Number(limit) || 200, 2000)) };
};

const internalServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    const auth = String(req.headers.authorization || '');
    const keyRec = roomOfKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (!keyRec) return send(res, 401, { error: 'bad key' });
    const room = keyRec.room;
    const q = (k) => url.searchParams.get(k);
    const body = async (limit = 16384) => JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/publish') {
      const result = publish(keyRec, await body(MAX_BODY));
      console.log(`share: ${keyRec.label} published ${room}/${result.id} (${result.files} files, ${result.bytes} bytes)`);
      return send(res, 200, result);
    }
    if (route === 'POST /api/update') {
      const result = update(keyRec, await body(MAX_BODY));
      console.log(`share: ${keyRec.label} updated ${room}/${result.id} to v${result.version} (${result.files} files, ${result.bytes} bytes)`);
      return send(res, 200, result);
    }
    if (route === 'GET /api/versions') return send(res, 200, versions(room, q('id')));
    if (route === 'POST /api/rollback') return send(res, 200, rollback(keyRec, await body()));
    if (route === 'GET /api/list') return send(res, 200, { room, artifacts: list(room) });
    if (route === 'POST /api/revoke') {
      const { id } = await body();
      const perm = artifactFor(room, id);
      Object.assign(perm, { revoked: true, revokedAt: new Date().toISOString() });
      writeJson(path.join(artifactDir(room, id), 'permission.json'), perm);
      logArtifact(room, id, { event: 'revoked', by: keyRec.label });
      return send(res, 200, { id, revoked: true });
    }
    if (route === 'GET /api/sessions') {
      const id = q('id');
      const perm = artifactFor(room, id);
      return send(res, 200, { id, title: perm.title, sessions: sessionsOf(room, id).map((s) => sessionStats(room, id, s)) });
    }
    if (route === 'POST /api/sessions/create') {
      const { id, label, expires } = await body();
      artifactFor(room, id);
      return send(res, 200, createSession(room, id, { label, expires, by: keyRec.label }));
    }
    if (route === 'GET /api/online') return send(res, 200, { room, online: online(room) });
    if (route === 'POST /api/sessions/rename') {
      const { id, session, label } = await body();
      artifactFor(room, id);
      const s = sessionFor(room, id, session);
      const name = String(label || '').trim().slice(0, 60);
      if (!name) throw bad('label: the new name');
      const was = s.label;
      s.label = name;
      writeJson(path.join(sessionDir(room, id, s.sid), 'session.json'), s);
      logArtifact(room, id, { event: 'session renamed', sid: s.sid, from: was, to: name, by: keyRec.label });
      return send(res, 200, { ...publicSession(s), was });
    }
    if (route === 'POST /api/sessions/expire') {
      const { id, session } = await body();
      artifactFor(room, id);
      const s = sessionFor(room, id, session);
      Object.assign(s, { expired: true, expiredAt: new Date().toISOString() });
      writeJson(path.join(sessionDir(room, id, s.sid), 'session.json'), s);
      logArtifact(room, id, { event: 'session expired', sid: s.sid, label: s.label, by: keyRec.label });
      return send(res, 200, publicSession(s));
    }
    if (route === 'GET /api/visitors') {
      artifactFor(room, q('id'));
      return send(res, 200, { id: q('id'), sessions: visitors(room, q('id'), q('session')) });
    }
    if (route === 'GET /api/activity') {
      artifactFor(room, q('id'));
      if (q('user') && !UID.test(q('user'))) throw bad('user: a 12-character visitor id');
      return send(res, 200, activity(room, q('id'), q('session'), q('user'), q('limit')));
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    const known = error.status || error instanceof SyntaxError;
    send(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: known ? error.message : 'error' });
    if (!known) console.error(error);
  }
});

// MARK: main

const mintKey = (room, label) => {
  if (!ROOM.test(room || '')) throw new Error('usage: node server.js key <room> <label>');
  const key = `sk_share_${crypto.randomBytes(24).toString('base64url')}`;
  const keys = readJson(keysFile(), { keys: [] });
  keys.keys.push({ id: crypto.randomBytes(4).toString('hex'), room, label: label || room, hash: sha256(key), created: new Date().toISOString() });
  writeJson(keysFile(), keys);
  return key;
};

if (require.main === module) {
  fs.mkdirSync(ART, { recursive: true, mode: 0o700 });
  const moved = migrate();
  if (moved) console.log(`share: ${moved} artifact(s) moved to versions/1`);
  if (process.argv[2] === 'key') {
    const key = mintKey(process.argv[3], process.argv[4]);
    process.stdout.write(`publish key for room ${process.argv[3]} (shown once):\n${key}\n`);
    process.exit(0);
  }
  publicServer.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`share: public on :${PUBLIC_PORT} as ${ORIGIN}`));
  internalServer.listen(INTERNAL_PORT, '0.0.0.0', () => console.log(`share: internal API on :${INTERNAL_PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}

module.exports = { publicServer, internalServer, mintKey, migrate, describeAgent, zip, crc32, newId };
