'use strict';

// Push alerts (lib/push.js): an agent blocked on a question, or done with a turn the owner gave it,
// reaches the owner's subscribed devices as Web Push (encrypted to the device, signed with the
// hub's VAPID key) and ntfy, and a one-tap answer from the alert answers the question once.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { Push } = require('../lib/push.js');
const { serveWeb } = require('../lib/web.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => ({ events: [], source: '127.0.0.1', on() {}, emit(name, data) { this.events.push([name, data]); }, close() {} });
const QUESTION = { id: 'a1a1a1a1a1a1', text: 'Quick safety check: trust this folder?', options: [{ label: 'No, exit' }, { label: 'Yes, I trust this folder' }] };

/// A browser's side of Web Push: its key pair and auth secret, and the decryption (RFC 8291).
const device = () => {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: 'https://push.example.test/send/abc', keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (body) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    assert.strictEqual(plain[plain.length - 1], 2, 'the last record ends with the delimiter 0x02');
    return JSON.parse(plain.subarray(0, plain.length - 1));
  };
  return { subscription, decrypt };
};

const setup = (env = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-push-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  hub.push = new Push({ store: hub.store, console: quiet, env });
  const sent = [];
  hub.push.fetch = async (url, init) => {
    sent.push({ url, init });
    return { ok: true, status: 201 };
  };
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  const client = fakeClient();
  const conn = hub.bind(client, auth.verify(auth.create({ name: 'a', role: 'agent' }).token), '127.0.0.1');
  hub.register(conn, { name: 'builder', room: 'dev' });
  hub.setStatus(conn, 'waiting', 'idle');
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const controls = () => client.events.filter(([e, m]) => e === 'agents/message' && m.kind === 'control').map(([, m]) => m.text);
  return { hub, owner, ownerConn, conn, sent, settle, controls, dir };
};

test('blocked: the alert is encrypted to the device, signed with VAPID, and carries the options and a capability', async () => {
  const { hub, owner, conn, sent, settle } = setup();
  const d = device();
  hub.push.subscribe(owner, d.subscription);
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  assert.strictEqual(sent.length, 1);
  const { url, init } = sent[0];
  assert.strictEqual(url, d.subscription.endpoint);
  assert.strictEqual(init.headers['Content-Encoding'], 'aes128gcm');
  assert.strictEqual(init.headers.Urgency, 'high');
  // VAPID: a JWT for the push service's origin, signed with the key the browser subscribed with
  const [, jwt, k] = init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, c, sig] = jwt.split('.');
  assert.strictEqual(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://push.example.test');
  const raw = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.strictEqual(k, hub.push.publicKey);
  const msg = d.decrypt(init.body);
  assert.deepStrictEqual([msg.kind, msg.title, msg.options], ['blocked', 'builder@dev', ['1. No, exit', '2. Yes, I trust this folder']]);
  assert.strictEqual(msg.body, 'Needs your answer');
  assert.ok(msg.cap && msg.cap.length >= 20);
  // the same question again is no new alert
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  assert.strictEqual(sent.length, 1);
});

test('one tap answers once, only while that question is on screen', async () => {
  const { hub, owner, conn, sent, settle, controls } = setup();
  const d = device();
  hub.push.subscribe(owner, d.subscription);
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  const { cap } = d.decrypt(sent[0].init.body);
  assert.deepStrictEqual(hub.answerByCap(cap, 2), { ok: true, text: 'builder: 2. Yes, I trust this folder' });
  assert.deepStrictEqual(controls(), [`!answer ${QUESTION.id} 2`]);
  assert.strictEqual(hub.answerByCap(cap, 2).ok, false, 'used up');
  assert.strictEqual(hub.answerByCap('made-up', 1).ok, false);
  // a capability for a question the agent has moved on from answers nothing
  hub.setStatus(conn, 'blocked', 'screen: trust', { ...QUESTION, id: 'b2b2b2b2b2b2' });
  await settle();
  const second = d.decrypt(sent[1].init.body).cap;
  hub.setStatus(conn, 'blocked', 'screen: other', { ...QUESTION, id: 'c3c3c3c3c3c3' });
  assert.deepStrictEqual(hub.answerByCap(second, 1), { ok: false, text: 'That question is no longer asked.' });
});

test('done: after a turn the owner gave, "Finished" when it left no message for anyone', async () => {
  const { hub, owner, ownerConn, conn, sent, settle } = setup();
  const d = device();
  hub.push.subscribe(owner, d.subscription);
  hub.push.setRoom(owner, 'dev', 'all'); // "done" alerts only where it is turned on
  await hub.send(ownerConn, 'builder', 'make the page', 'command');
  hub.setStatus(conn, 'working', 'busy');
  hub.say(conn, 'dev', 'offer.html is built, 3 packages');
  hub.setStatus(conn, 'waiting', 'idle');
  await settle();
  const msg = d.decrypt(sent[0].init.body);
  assert.deepStrictEqual([msg.kind, msg.title, msg.body, msg.cap], ['done', 'builder@dev', 'Finished', null]);
  // a device that asked for blocked only is not told
  const quietDevice = device();
  quietDevice.subscription.endpoint = 'https://push.example.test/send/quiet';
  hub.push.subscribe(owner, quietDevice.subscription, ['blocked']);
  await hub.send(ownerConn, 'builder', 'again', 'command');
  hub.setStatus(conn, 'working', 'busy');
  hub.setStatus(conn, 'waiting', 'idle');
  await settle();
  assert.deepStrictEqual(sent.map((s) => s.url), [d.subscription.endpoint, d.subscription.endpoint]);
});

test('ntfy: the alert as JSON to the topic, options as one-tap http actions on the public address', async () => {
  const { hub, conn, sent, settle } = setup({ HUB_NTFY_URL: 'https://ntfy.example.test/metacom-secret', HUB_PUBLIC_URL: 'https://hub.example.test' });
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  assert.strictEqual(sent[0].url, 'https://ntfy.example.test/');
  const note = JSON.parse(sent[0].init.body);
  assert.strictEqual(note.topic, 'metacom-secret');
  assert.strictEqual(note.click, 'https://hub.example.test/dev');
  assert.deepStrictEqual(note.actions.map((a) => [a.label, a.method]), [['1. No, exit', 'POST'], ['2. Yes, I trust this folder', 'POST']]);
  assert.match(note.actions[1].url, /^https:\/\/hub\.example\.test\/push\/answer\?c=[\w-]+&n=2$/);
});

test('POST /push/answer: the route the alert buttons call', async () => {
  const { hub, owner, conn, sent, settle, controls } = setup();
  const d = device();
  hub.push.subscribe(owner, d.subscription);
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  const { cap } = d.decrypt(sent[0].init.body);
  const server = http.createServer();
  serveWeb(server, path.join(__dirname, '..', 'web'), hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/push/answer?c=${cap}&n=1`, { method: 'POST' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), '*', "ntfy's web app sends it from its own page");
    const pre = await fetch(`${base}/push/answer?c=x&n=1`, { method: 'OPTIONS', headers: { Origin: 'https://ntfy.example.test', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.status, 204);
    assert.deepStrictEqual(controls(), [`!answer ${QUESTION.id} 1`]);
    const again = await fetch(`${base}/push/answer`, { method: 'POST', body: JSON.stringify({ c: cap, n: 1 }) });
    assert.strictEqual(again.status, 410);
    const sw = await fetch(`${base}/sw.js`);
    assert.match(sw.headers.get('content-type'), /javascript/);
  } finally {
    server.close();
  }
});

test('the VAPID key is made once and kept; a gone subscription is dropped', async () => {
  const { hub, owner, conn, sent, settle } = setup();
  const again = new Push({ store: hub.store, console: quiet, env: {} });
  assert.strictEqual(again.publicKey, hub.push.publicKey);
  hub.push.subscribe(owner, device().subscription);
  hub.push.fetch = async (url, init) => {
    sent.push({ url, init });
    return { ok: false, status: 410 };
  };
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  assert.strictEqual(hub.push.state.subscriptions.length, 0);
});

test('per room: stuck alerts by default, done only where on, off is quiet', async () => {
  const { hub, owner, sent, settle } = setup();
  hub.push.subscribe(owner, device().subscription);
  const agentIn = (name, room) => {
    const client = fakeClient();
    const c = hub.bind(client, hub.auth.verify(hub.auth.create({ name: `t-${name}`, role: 'agent' }).token), '127.0.0.1');
    hub.register(c, { name, room });
    hub.setStatus(c, 'waiting', 'idle');
    return c;
  };
  const a = agentIn('alpha', 'roomA');
  const b = agentIn('beta', 'roomB');
  const c = agentIn('gamma', 'roomC');
  hub.push.setRoom(owner, 'roomC', 'off');
  // stuck in A (default): an alert
  hub.setStatus(a, 'blocked', 'screen: trust', { ...QUESTION, id: 'a0a0a0a0a0a1' });
  await settle();
  assert.strictEqual(sent.length, 1);
  // done in B (stuck only by default): none
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  await hub.send(ownerConn, 'beta@roomB', 'do it', 'command');
  hub.setStatus(b, 'working', 'busy');
  hub.setStatus(b, 'waiting', 'idle');
  await settle();
  assert.strictEqual(sent.length, 1);
  // C is off: stuck there is quiet too
  hub.setStatus(c, 'blocked', 'screen: trust', { ...QUESTION, id: 'c0c0c0c0c0c1' });
  await settle();
  assert.strictEqual(sent.length, 1);
  // done turned on in B: now it alerts
  assert.deepStrictEqual(hub.push.setRoom(owner, 'roomB', 'done').events, ['done']);
  await hub.send(ownerConn, 'beta@roomB', 'again', 'command');
  hub.setStatus(b, 'working', 'busy');
  hub.setStatus(b, 'waiting', 'idle');
  await settle();
  assert.strictEqual(sent.length, 2);
  // the settings, as /alerts shows them
  const s = hub.push.settings(owner, 'roomA');
  assert.deepStrictEqual([s.events, s.others, s.devices], [['blocked'], { roomC: [], roomB: ['done'] }, 1]);
  assert.deepStrictEqual(hub.push.setRoom(owner, 'roomC', 'on').events, ['blocked'], 'on: an off room back to stuck');
  assert.throws(() => hub.push.setRoom(owner, 'roomA', 'loud'), /on, off, stuck, done or all/);
});

test('an existing subscription with done: stuck everywhere, and done in dev', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-push-migrate-'));
  const { Store } = require('../lib/store.js');
  const store = new Store(dir);
  const first = new Push({ store, console: quiet, env: {} });
  first.state.subscriptions.push({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' }, tokenId: 'misha-token', owner: 'misha', events: ['blocked', 'done'] });
  delete first.state.rooms;
  first.save();
  const again = new Push({ store, console: quiet, env: {} });
  assert.deepStrictEqual(again.eventsFor('misha-token', 'dev'), ['blocked', 'done']);
  assert.deepStrictEqual(again.eventsFor('misha-token', 'opn'), ['blocked']);
});

test('the alert: "<agent>@<room>", and only what happened: no message text on the lock screen', async () => {
  const { hub, owner, ownerConn, conn, sent, settle } = setup({ HUB_NTFY_URL: 'https://ntfy.example.test/metacom-topic' });
  hub.register(ownerConn, { name: 'misha', kind: 'human', room: 'dev' });
  const d = device();
  hub.push.subscribe(owner, d.subscription);
  // the room as it is by default: stuck alerts only
  const turn = async (fn) => {
    await hub.send(ownerConn, 'builder', 'go on', 'command');
    hub.setStatus(conn, 'working', 'busy');
    await fn();
    hub.setStatus(conn, 'waiting', 'idle');
    await settle();
  };
  const last = () => d.decrypt(sent.filter((x) => x.url === d.subscription.endpoint).at(-1).init.body);
  const ntfy = () => JSON.parse(sent.filter((x) => x.url.startsWith('https://ntfy.example.test')).at(-1).init.body);
  const SECRET_WORDS = 'Test 8: OK if I keep both?';
  // a message to him: "You have unread message", nothing of what it says
  await turn(() => hub.send(conn, 'misha', SECRET_WORDS, 'info', null, null, { suggest: 'yes, keep both' }));
  assert.deepStrictEqual([last().title, last().body, last().where], ['builder@dev', 'You have unread message', undefined]);
  assert.deepStrictEqual([ntfy().title, ntfy().message], ['builder@dev', 'You have unread message']);
  assert.ok(!sent.some((x) => x.url.startsWith('https://ntfy') && String(x.init.body).includes('keep both')), 'no text, no suggestion');
  // an @mention to him, unread, counts too
  hub.markRead(ownerConn, 'dev');
  await settle(); // read a moment before it comes
  await turn(() => hub.say(conn, 'dev', '@misha the logo is in'));
  assert.strictEqual(last().body, 'You have unread message');
  // read, and nothing new to him: no alert at all (every turn would buzz the phone)…
  hub.markRead(ownerConn, 'dev');
  const before = sent.length;
  await turn(() => hub.say(conn, 'dev', 'cleaned up the build folder'));
  assert.strictEqual(sent.length, before, 'a turn done with nothing for him: quiet');
  // …unless "done" is turned on in the room: then "Finished"
  hub.push.setRoom(owner, 'dev', 'all');
  await turn(() => hub.say(conn, 'dev', 'and the cache'));
  assert.deepStrictEqual([last().title, last().body], ['builder@dev', 'Finished']);
  // off: not even an unread message
  hub.push.setRoom(owner, 'dev', 'off');
  const quiet = sent.length;
  await turn(() => hub.send(conn, 'misha', 'one more?', 'info'));
  assert.strictEqual(sent.length, quiet, 'off is off');
  hub.push.setRoom(owner, 'dev', 'stuck');
  // stuck: "Needs your answer", the options still the one-tap buttons
  hub.setStatus(conn, 'blocked', 'screen: trust', QUESTION);
  await settle();
  assert.deepStrictEqual([last().title, last().body, last().options], ['builder@dev', 'Needs your answer', ['1. No, exit', '2. Yes, I trust this folder']]);
});
