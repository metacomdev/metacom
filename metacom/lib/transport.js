'use strict';

const http = require('node:http');

const { Emitter, parseCookies, parseHost } = require('metautil');

const HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const buildHeaders = (cors) => {
  if (!cors || !cors.origin) return HEADERS;
  return { ...HEADERS, 'Access-Control-Allow-Origin': cors.origin };
};

const TOKEN = 'token';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';
const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
const LOCATION = 'Path=/; Domain';
const COOKIE_DELETE = `${TOKEN}=deleted; Expires=${EPOCH}; ${LOCATION}=`;
const COOKIE_HOST = `Expires=${FUTURE}; ${LOCATION}`;

/// The client's address. Behind a reverse proxy or tunnel every peer is the proxy itself, so with
/// HUB_TRUST_PROXY=1 the proxy's header names the client (Cloudflare's CF-Connecting-IP, else the
/// first X-Forwarded-For entry). Never set it without a proxy in front: the headers are spoofable.
const sourceOf = (req) => {
  if (process.env.HUB_TRUST_PROXY === '1') {
    const cf = req.headers['cf-connecting-ip'];
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (cf || xff) return String(cf || xff);
  }
  return req.socket.remoteAddress;
};

class ServerTransport extends Emitter {
  constructor(source) {
    super();
    this.source = source;
  }

  error(code = 500, { id = '', error = null } = {}) {
    const status = http.STATUS_CODES[code] || 'Unknown error';
    const info = error ? error.message : status;
    const packet = { type: 'callback', id, error: { message: info, code } };
    this.send(packet, code);
  }

  send(obj, code = 200) {
    this.write(JSON.stringify(obj), code);
  }
}

class ServerHttpTransport extends ServerTransport {
  constructor(req, res, options = {}) {
    super(sourceOf(req));
    this.req = req;
    this.res = res;
    this.headers = options.headers ?? HEADERS;
    if (req.method === 'OPTIONS') this.options();
    req.on('close', () => void this.emit('close'));
  }

  write(data, httpCode = 200) {
    const { res } = this;
    if (res.writableEnded) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const headers = { ...this.headers, 'Content-Length': buf.length };
    res.writeHead(httpCode, headers);
    res.end(buf);
  }

  options() {
    const { res } = this;
    if (res.headersSent) return;
    res.writeHead(200, this.headers);
    res.end();
  }

  getCookies() {
    const { cookie } = this.req.headers;
    if (!cookie) return {};
    return parseCookies(cookie);
  }

  sendSessionCookie(token) {
    const host = parseHost(this.req.headers.host);
    const cookie = `${TOKEN}=${token}; ${COOKIE_HOST}=${host}`;
    this.res.setHeader('Set-Cookie', cookie);
  }

  removeSessionCookie() {
    const host = parseHost(this.req.headers.host);
    this.res.setHeader('Set-Cookie', COOKIE_DELETE + host);
  }

  close() {
    this.error(503);
    this.req.socket.destroy();
  }
}

class ServerWsTransport extends ServerTransport {
  constructor(req, connection) {
    super(sourceOf(req));
    this.connection = connection;
    connection.on('close', () => void this.emit('close'));
  }

  write(data) {
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
      data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    this.connection.send(data);
  }

  close() {
    this.connection.terminate();
  }
}

class ServerEventTransport extends ServerTransport {
  constructor(port) {
    super('event transport');
    this.port = port;
    port.on('close', () => void this.emit('close'));
  }

  write(data) {
    this.port.postMessage(data);
  }

  close() {
    this.port.close();
  }
}

ServerTransport.transport = {
  http: ServerHttpTransport,
  ws: ServerWsTransport,
  event: ServerEventTransport,
};

module.exports = {
  sourceOf,
  ServerTransport,
  buildHeaders,
};
