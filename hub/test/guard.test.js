'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { guardSockets } = require('../lib/guard.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const socket = () => {
  const ws = new EventEmitter();
  ws.terminated = false;
  ws.terminate = () => {
    ws.terminated = true;
    ws.emit('close');
  };
  return ws;
};
const req = (ip) => ({ headers: {}, socket: { remoteAddress: ip } });

test('guard: an address over its limit is refused, refusals are not counted, and it gets in again once one closes', () => {
  const server = new EventEmitter();
  guardSockets(server, quiet);
  const open = [];
  for (let i = 0; i < 64; i++) {
    const ws = socket();
    server.emit('connection', ws, req('10.0.0.5'));
    open.push(ws);
  }
  assert.ok(open.every((ws) => !ws.terminated), '64 from one address');
  // retries over the limit: each refused, none counted (they used to keep it locked out for good)
  for (let i = 0; i < 300; i++) {
    const ws = socket();
    server.emit('connection', ws, req('10.0.0.5'));
    assert.ok(ws.terminated);
  }
  open.pop().emit('close');
  const again = socket();
  server.emit('connection', again, req('10.0.0.5'));
  assert.ok(!again.terminated, 'one closed: the next gets in');
  // this machine's own agents and the tunnel's visitors arrive from 127.0.0.1: a far higher limit
  for (let i = 0; i < 200; i++) {
    const ws = socket();
    server.emit('connection', ws, req('127.0.0.1'));
    assert.ok(!ws.terminated, `loopback socket ${i + 1}`);
  }
});
