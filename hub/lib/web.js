'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// a room name as the hub takes it, as the whole path: /sales, /dev
const ROOM_PATH = /^\/[\w][\w.-]{0,63}$/;
// an invite link: /opn/invite/<token>, the page (which takes the token out of the address)
const INVITE_PATH = /^\/[\w][\w.-]{0,63}\/invite\/[\w-]{16,128}\/?$/;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

/// Serves the phone web client from the same port as the API. metacom's own handler only
/// answers /api paths and leaves everything else untouched, so this second listener
/// completes those requests.
/// A short hash of the web chat's files as served (app.js, index.html, sw.js), read again only
/// when one of them changed on disk.
let versionCache = { key: '', value: '' };
const webVersion = (dir) => {
  const files = ['app.js', 'index.html', 'sw.js'].map((f) => path.join(dir, f));
  const key = files.map((f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
  if (key !== versionCache.key) {
    const h = require('node:crypto').createHash('sha256');
    for (const f of files) { try { h.update(fs.readFileSync(f)); } catch {} }
    versionCache = { key, value: h.digest('hex').slice(0, 12) };
  }
  return versionCache.value;
};

const serveWeb = (httpServer, dir, hub = null) => {
  httpServer.on('request', (req, res) => {
    // the RPC's and the file store's paths; a GET of /api or /media itself is a room's page
    const path0 = req.url.split('?')[0];
    const page = (req.method === 'GET' || req.method === 'HEAD') && (path0 === '/api' || path0 === '/media');
    if (!page && (path0 === '/api' || path0.startsWith('/api/') || path0 === '/media' || path0.startsWith('/media/'))) return;
    // a one-tap answer from a push alert (lib/push.js): the capability in it is the permission
    // ntfy's web app sends an alert's button from the page, so the route answers any origin: the
    // capability in the request is all it goes by, never a cookie
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS' && req.url.split('?')[0] === '/push/answer' && hub) {
      res.writeHead(204, { ...SECURITY, ...CORS, 'Access-Control-Max-Age': '600' }).end();
      return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/push/answer' && hub) {
      const q = new URL(req.url, 'http://hub').searchParams;
      let raw = '';
      req.on('data', (d) => {
        if (raw.length < 2048) raw += d;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {}
        const r = hub.answerByCap(body.c || q.get('c'), Number(body.n || q.get('n')));
        res.writeHead(r.ok ? 200 : 410, { ...SECURITY, ...CORS, 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify(r));
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY).end();
      return;
    }
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    // which web chat this is: a page that was left open (a phone's Home Screen app resumes without
    // reloading) asks when it comes back, and reloads itself when the chat has changed
    if (pathname === '/version') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ web: webVersion(dir) }));
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.json'] });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }
    // the terminal-style client lived at /tui/ before it became the page: old links land on it
    if (pathname === '/tui' || pathname.startsWith('/tui/')) {
      res.writeHead(301, { ...SECURITY, Location: '/' }).end();
      return;
    }
    // a folder is its index.html; /name goes to /name/
    if (/^\/[a-z]+$/.test(pathname) && fs.existsSync(path.join(dir, pathname.slice(1), 'index.html'))) {
      res.writeHead(301, { ...SECURITY, Location: pathname + '/' }).end();
      return;
    }
    if (INVITE_PATH.test(pathname)) {
      return fs.readFile(path.resolve(dir, 'index.html'), (e, page) => {
        if (e) return void res.writeHead(404, SECURITY).end();
        res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.html'], 'Content-Length': page.length });
        res.end(req.method === 'HEAD' ? undefined : page);
      });
    }
    const rel = pathname === '/' ? 'index.html' : pathname.endsWith('/') ? pathname.slice(1) + 'index.html' : pathname.slice(1);
    let file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir, 'index.html')) {
      res.writeHead(403, SECURITY).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      // /sales, /dev: a room's own address is the page, which opens that room
      // (a missing file keeps its 404: a room is never named like app.js or logo.png)
      const asset = TYPES[path.extname(pathname).toLowerCase()] || /\.(ico|map|txt|jpe?g|gif|webp|woff|ttf)$/i.test(pathname);
      if (error && ROOM_PATH.test(pathname) && !asset) {
        file = path.resolve(dir, 'index.html');
        return fs.readFile(file, (e2, page) => {
          if (e2) return void res.writeHead(404, SECURITY).end();
          res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.html'], 'Content-Length': page.length });
          res.end(req.method === 'HEAD' ? undefined : page);
        });
      }
      if (error) {
        res.writeHead(404, SECURITY).end();
        return;
      }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
};

module.exports = { serveWeb };
