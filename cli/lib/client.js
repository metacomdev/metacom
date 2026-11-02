'use strict';

const { Metacom } = require('metacom');

/// Connects, scaffolds the hub API, signs in, and signs in again after every reconnect.
/// `onOpen` runs after each re-sign-in, so a wrapper can re-register its member.
const connect = async ({ url, token, onOpen = null, callTimeout = 620_000 }) => {
  if (!token) throw new Error('No token. Run: metacom connect <url> <token>');
  // Metacom.connect, with the error listener in place before the socket opens: a hub that is
  // down emits 'error' while opening, and an emitter with no listener throws it out of the process
  const Transport = url.startsWith('http') ? Metacom.transport.http : Metacom.transport.ws;
  const m = new Metacom(url, new Transport(url), { callTimeout, reconnectTimeout: 2_000 });
  m.on('error', () => {});
  try {
    await m.open();
  } catch (error) {
    m.close(); // no retrying in the background for a hub we could not reach
    throw error;
  }
  await m.load('auth', 'agents', 'room', 'admin', 'push', 'loops');
  const me = await m.api.auth.signin({ token });
  m.on('open', async () => {
    try {
      await m.api.auth.signin({ token });
      if (onOpen) await onOpen();
    } catch (error) {
      process.stderr.write(`metacom: reconnect failed: ${error.message}\n`);
    }
  });
  return { m, api: m.api, me };
};

module.exports = { connect };
