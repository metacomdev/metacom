'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./errors.js');

const MAX_BYTES = 20 * 1024 * 1024;
// Videos get more room; 100 MB is also what a Cloudflare tunnel lets through in one request.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_PER_MESSAGE = 8;
const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'video/mpeg': 'mpeg',
};
// other names browsers and tools give the same formats
const ALIASES = { 'video/avi': 'video/x-msvideo', 'video/msvideo': 'video/x-msvideo', 'video/mkv': 'video/x-matroska', 'video/mov': 'video/quicktime' };
const typeName = (value) => {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return ALIASES[type] || type;
};
const limitOf = (type) => (type.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_BYTES);
const mb = (bytes) => `${bytes / 1024 / 1024} MB`;
const EXTS = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]));
const FILE = /^\/media\/([0-9a-f]{32})\.([a-z0-9]{1,5})$/;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

const safeName = (value) => String(value || '').replace(/[^\w.() -]/g, '_').slice(0, 120) || 'file';

/// Files attached to messages: images pasted into the phone or terminal chat, and reports
/// agents send back.
/// Stored under <data>/media/<id>.<ext> with a random id; the id is the only thing that
/// grants a read, so an agent on another machine can fetch it with a plain GET.
class Media {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'media');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(buffer, type, name) {
    const ext = this.check(type, buffer.length);
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(this.dir, `${id}.${ext}`), buffer, { mode: 0o600 });
    return { url: `/media/${id}.${ext}`, type, size: buffer.length, name: safeName(name || `${id.slice(0, 8)}.${ext}`) };
  }

  /// Like save(), for a file already written to `tmp` (an upload streamed to disk): moved in place.
  adopt(tmp, type, name) {
    const size = fs.statSync(tmp).size;
    const ext = this.check(type, size);
    const id = crypto.randomBytes(16).toString('hex');
    fs.renameSync(tmp, path.join(this.dir, `${id}.${ext}`));
    return { url: `/media/${id}.${ext}`, type, size, name: safeName(name || `${id.slice(0, 8)}.${ext}`) };
  }

  /// A temporary file in the media directory for an upload in progress.
  tmp() {
    return path.join(this.dir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
  }

  check(type, size) {
    const ext = TYPES[type];
    if (!ext) throw fail(415, `unsupported type ${type}; one of ${Object.keys(TYPES).join(', ')}`);
    if (size === 0) throw fail(400, 'empty file');
    if (size > limitOf(type)) throw fail(413, `file is larger than ${mb(limitOf(type))}`);
    return ext;
  }

  /// The stored file behind a /media url, or null.
  file(url) {
    const m = FILE.exec(String(url || ''));
    if (!m || !EXTS[m[2]]) return null;
    const file = path.join(this.dir, `${m[1]}.${m[2]}`);
    return fs.existsSync(file) ? { file, type: EXTS[m[2]] } : null;
  }

  /// The `media` field of a message as the hub stores it: a short list of known files.
  attachments(list) {
    if (list === undefined || list === null) return null;
    if (!Array.isArray(list)) throw fail(400, 'media must be a list');
    if (list.length > MAX_PER_MESSAGE) throw fail(400, `at most ${MAX_PER_MESSAGE} files per message`);
    const out = [];
    for (const item of list) {
      const url = item && typeof item === 'object' ? item.url : item;
      const stored = this.file(url);
      if (!stored) throw fail(400, `unknown media ${url}`);
      const size = Number(item.size) || fs.statSync(stored.file).size;
      out.push({ url, type: stored.type, size, name: safeName(item.name) });
    }
    return out.length ? out : null;
  }
}

/// POST /media (Authorization: Bearer <token>, Content-Type, X-Name) stores a file and
/// answers with its {url, type, size, name}; GET /media/<id>.<ext> serves it.
const serveMedia = (httpServer, { media, auth, console }) => {
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  httpServer.on('request', (req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname !== '/media' && !pathname.startsWith('/media/')) return;
    // GET /media is the page of a room named "media"; uploads are POSTed here
    if (pathname === '/media' && req.method !== 'POST') return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const stored = media.file(pathname);
      if (!stored) return send(res, 404, { error: 'not found' });
      // streamed, and in byte ranges when asked: browsers play and seek video that way
      const size = fs.statSync(stored.file).size;
      // text says its encoding, or a browser falls back to Latin-1 and an em dash shows as "â€”"
      const type = /^text\//.test(stored.type) && !/charset=/i.test(stored.type) ? `${stored.type}; charset=utf-8` : stored.type;
      const headers = { ...SECURITY, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
      let start = 0;
      let end = size - 1;
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(Number(range[2]), size - 1);
        } else start = Math.max(0, size - Number(range[2]));
        if (start > end || start >= size) {
          res.writeHead(416, { ...SECURITY, 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      } else res.writeHead(200, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(stored.file, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    if (req.method !== 'POST' || pathname !== '/media') return send(res, 405, { error: 'method not allowed' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const record = token ? auth.verify(token) : null;
    if (!record) return send(res, 401, { error: 'bad token' });
    const type = typeName(req.headers['content-type']);
    if (!TYPES[type]) return send(res, 415, { error: `unsupported type ${type || '(none)'}` });
    const limit = limitOf(type);
    if (Number(req.headers['content-length']) > limit) {
      send(res, 413, { error: `file is larger than ${mb(limit)}` }, { Connection: 'close' });
      req.destroy();
      return;
    }
    // to disk as it arrives, so a video never sits in memory whole
    const tmp = media.tmp();
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    const drop = () => fs.rm(tmp, { force: true }, () => {});
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit && !res.writableEnded) {
        send(res, 413, { error: `file is larger than ${mb(limit)}` }, { Connection: 'close' });
        out.destroy();
        drop();
        req.destroy();
      }
    });
    req.on('aborted', () => {
      out.destroy();
      drop();
    });
    req.pipe(out);
    out.on('finish', () => {
      if (res.writableEnded) return drop();
      try {
        const name = decodeURIComponent(String(req.headers['x-name'] || ''));
        const saved = media.adopt(tmp, type, name);
        console.log(`media: ${record.name} uploaded ${saved.name} (${saved.size} bytes)`);
        send(res, 200, saved);
      } catch (error) {
        drop();
        send(res, error.code || 500, { error: error.message });
      }
    });
  });
};

module.exports = { Media, serveMedia, TYPES, MAX_BYTES, MAX_VIDEO_BYTES };
