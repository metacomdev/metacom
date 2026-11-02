'use strict';

const SIGNIN_TIMEOUT = 10_000;
// per address: a machine running agents opens two sockets per agent (wrapper and MCP bridge), and
// without HUB_TRUST_PROXY every visitor through a tunnel arrives from 127.0.0.1 too
const MAX_PER_IP = Number(process.env.HUB_MAX_PER_IP) || 64;
const MAX_LOOPBACK = Number(process.env.HUB_MAX_LOOPBACK) || 1024;
const loopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const BEFORE_SIGNIN = new Set(['auth/signin', 'system/introspect']);
// the client behind a proxy when HUB_TRUST_PROXY=1 (metacom/lib/transport.js), so one visitor's
// sockets never count against everyone who arrives through the same tunnel
const { sourceOf } = require('../../metacom/lib/transport.js');

/// Closes websocket connections that do not sign in: a socket has ten seconds to send an
/// `auth/signin` call, and until then the only other packet it may send is the
/// `system/introspect` the metacom client uses to scaffold its API.
const guardSockets = (wsServer, console) => {
  const perIp = new Map();
  wsServer.on('connection', (ws, req) => {
    const ip = sourceOf(req);
    const count = (perIp.get(ip) || 0) + 1;
    const max = loopback(ip) ? MAX_LOOPBACK : MAX_PER_IP;
    // a refused socket is never counted: counting it, with no close to take it back, kept an
    // address over its limit for good, every retry pushing it further
    if (count > max) {
      console.warn(`guard: ${ip} has ${count - 1} sockets, refusing`);
      ws.terminate();
      return;
    }
    perIp.set(ip, count);
    let signedIn = false;
    const timer = setTimeout(() => {
      if (signedIn) return;
      console.warn(`guard: ${ip} did not sign in within 10s, closing`);
      ws.terminate();
    }, SIGNIN_TIMEOUT);
    ws.on('message', (data) => {
      if (signedIn) return;
      let packet = null;
      try {
        packet = JSON.parse(data.toString());
      } catch {
        packet = null;
      }
      const method = packet && packet.type === 'call' ? packet.method : null;
      if (method === 'auth/signin') {
        signedIn = true;
        clearTimeout(timer);
        return;
      }
      if (BEFORE_SIGNIN.has(method)) return;
      console.warn(`guard: ${ip} sent ${method || 'junk'} before signing in, closing`);
      ws.terminate();
    });
    ws.on('close', () => {
      clearTimeout(timer);
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  });
};

module.exports = { guardSockets };
