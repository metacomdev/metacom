'use strict';

// Alerts to the owner's phone when an agent needs them (blocked on a question) or has finished a
// turn they gave it (done), with the question's numbered options answerable in one tap.
//
// Web push (the web chat installed as an app, docs/push.md): Web Push with VAPID (RFC 8292) and
// aes128gcm payload encryption (RFC 8291), done here with node:crypto, no dependency. The hub makes
// its VAPID key pair on first use and keeps it, with the subscriptions, in push.json.
//
// ntfy (HUB_NTFY_URL, a topic URL on ntfy.sh or your own server; HUB_NTFY_TOKEN if it needs one):
// the same alert, with the options as ntfy "http" action buttons.
//
// A one-tap answer carries a capability, not a token: a random id the hub maps to that agent's
// question, valid while the question is the one on screen and for a day at most.

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const CAP_TTL_MS = 24 * 3600_000;
const MAX_ACTIONS = 3;

/// The Web Push payload for one subscription: aes128gcm, one record (RFC 8188, RFC 8291).
const encrypt = (payload, keys) => {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
};

// every room alerts when an agent is stuck; "done" only where it is turned on
const DEFAULT_EVENTS = ['blocked'];

class Push {
  constructor({ store, console, env = process.env }) {
    this.store = store;
    this.console = console;
    this.publicUrl = (env.HUB_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
    this.ntfy = (env.HUB_NTFY_URL || '').trim() || null;
    this.ntfyToken = env.HUB_NTFY_TOKEN || null;
    this.caps = new Map(); // capability id -> { key, qid, exp }
    this.fetch = (...a) => fetch(...a);
    const saved = store.loadJson('push.json', null);
    if (saved && saved.vapid) {
      this.state = saved;
      // alerts per room (2026-10-12): every room alerts when an agent is stuck; "done" only where
      // it was turned on. Subscriptions from before: stuck everywhere, and done in dev, as misha had.
      if (!this.state.rooms) {
        this.state.rooms = {};
        for (const s of this.state.subscriptions || []) if ((s.events || []).includes('done')) this.state.rooms[s.tokenId] = { dev: ['blocked', 'done'] };
        this.save();
      }
    }
    else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const raw = publicKey.export({ format: 'jwk' });
      this.state = {
        vapid: { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(raw.x), unb64u(raw.y)])), privateKey: privateKey.export({ format: 'jwk' }) },
        subscriptions: [],
        rooms: {}, // tokenId -> room -> the events that alert there ([] = off); a room not listed: stuck only
      };
      this.save();
    }
  }

  save() {
    this.store.saveJson('push.json', this.state);
  }

  get publicKey() {
    return this.state.vapid.publicKey;
  }

  /// A browser's subscription, for an owner token. The same endpoint again replaces the old one.
  subscribe(record, subscription, events = ['blocked', 'done']) {
    const { endpoint, keys } = subscription || {};
    if (!/^https:\/\//.test(endpoint || '') || !keys || !keys.p256dh || !keys.auth) throw new Error('not a push subscription');
    const list = this.state.subscriptions.filter((s) => s.endpoint !== endpoint);
    list.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, tokenId: record.id, owner: record.name, events: events.filter((e) => e === 'blocked' || e === 'done'), created: new Date().toISOString() });
    this.state.subscriptions = list;
    this.save();
    return { subscriptions: list.filter((s) => s.tokenId === record.id).length };
  }

  unsubscribe(record, endpoint) {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((s) => !(s.endpoint === endpoint && s.tokenId === record.id));
    this.save();
    return { removed: before - this.state.subscriptions.length };
  }

  // MARK: per room

  /// The events that alert this person for this room: stuck (blocked) unless they chose otherwise.
  eventsFor(tokenId, room) {
    const mine = (this.state.rooms || {})[tokenId] || {};
    return mine[room] || DEFAULT_EVENTS;
  }

  /// `/alerts on|off|stuck|done|all` in a room: what alerts this person there. `on` turns a room
  /// that was off back to stuck, and leaves one that alerts as it is.
  setRoom(record, room, choice) {
    const now = this.eventsFor(record.id, room);
    const events = { off: [], stuck: ['blocked'], done: ['done'], all: ['blocked', 'done'], on: now.length ? now : DEFAULT_EVENTS }[choice];
    if (!events) throw new Error('alerts: on, off, stuck, done or all');
    this.state.rooms = this.state.rooms || {};
    const mine = (this.state.rooms[record.id] = this.state.rooms[record.id] || {});
    if (events.length === DEFAULT_EVENTS.length && events.every((e, i) => e === DEFAULT_EVENTS[i])) delete mine[room];
    else mine[room] = events;
    this.save();
    return this.settings(record, room);
  }

  /// This room's setting, the rooms set otherwise, and this person's devices.
  settings(record, room) {
    const mine = (this.state.rooms || {})[record.id] || {};
    return {
      room,
      events: this.eventsFor(record.id, room),
      others: Object.fromEntries(Object.entries(mine).filter(([r]) => r !== room)),
      default: DEFAULT_EVENTS,
      devices: this.state.subscriptions.filter((s) => s.tokenId === record.id).length,
    };
  }

  /// VAPID: a short-lived ES256 JWT for the push service's origin.
  vapid(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.publicUrl || 'mailto:hub@localhost' }));
    const key = crypto.createPrivateKey({ key: this.state.vapid.privateKey, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${this.publicKey}`;
  }

  /// One-tap answers for a question: a capability per alert, kept until it expires or is used.
  capFor(member) {
    const now = Date.now();
    for (const [id, c] of this.caps) if (c.exp < now) this.caps.delete(id);
    const id = b64u(crypto.randomBytes(18));
    const by = (this.state.subscriptions[0] || {}).owner || 'owner';
    this.caps.set(id, { key: member.key, qid: member.question.id, exp: now + CAP_TTL_MS, by });
    return id;
  }

  /// The capability's question, if it is still the one asked; used up when it answers.
  redeem(cap) {
    const c = this.caps.get(String(cap || ''));
    if (!c || c.exp < Date.now()) return null;
    this.caps.delete(String(cap));
    return c;
  }

  /// What an alert says: who and where as the title ("leader@dev"), and only what happened as
  /// the body: "Needs your answer", "You have unread message", "Finished". No message text, so
  /// nothing anyone wrote shows on a lock screen. A question's options are the one-tap buttons.
  message(kind, member, unread = false) {
    const title = `${member.name}@${member.room}`;
    const url = `${this.publicUrl || ''}/${member.room}`;
    if (kind === 'blocked') {
      const options = member.question.options.map((o, i) => `${i + 1}. ${o.label}`);
      return { kind, title, body: 'Needs your answer', url, tag: `q-${member.key}`, options: options.slice(0, MAX_ACTIONS) };
    }
    return { kind, title, body: unread ? 'You have unread message' : 'Finished', url, tag: `d-${member.key}`, options: [] };
  }

  /// Send an alert to every owner subscription that wants it, and to ntfy. Never throws.
  async alert(kind, member, unread = false) {
    // An unread message for you alerts wherever alerts are on at all (stuck, done or all), like a
    // question does; a turn done with nothing for you only where "done" is turned on.
    const wants = (events) => (kind === 'done' && unread ? events.length > 0 : events.includes(kind));
    // the device has to want the event, and its person has to want it from this room
    const subs = this.state.subscriptions.filter((s) => wants(s.events) && wants(this.eventsFor(s.tokenId, member.room)));
    // ntfy belongs to nobody in particular: it alerts for a room when any owner's setting there does
    const owners = [...new Set(this.state.subscriptions.map((s) => s.tokenId)), ...Object.keys(this.state.rooms || {})];
    const ntfyWants = this.ntfy && (owners.length ? owners.some((t) => wants(this.eventsFor(t, member.room))) : wants(DEFAULT_EVENTS));
    if (!subs.length && !ntfyWants) return { sent: 0 };
    const msg = this.message(kind, member, unread);
    const cap = kind === 'blocked' && msg.options.length ? this.capFor(member) : null;
    let sent = 0;
    const gone = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          const body = encrypt(JSON.stringify({ ...msg, cap }), s.keys);
          const res = await this.fetch(s.endpoint, {
            method: 'POST',
            headers: { Authorization: this.vapid(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: kind === 'blocked' ? 'high' : 'normal', Topic: msg.tag.replace(/[^\w-]/g, '').slice(0, 32) },
            body,
          });
          if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
          else if (res.ok) sent++;
          else this.console.warn(`push: ${new URL(s.endpoint).host} answered ${res.status}`);
        } catch (error) {
          this.console.warn(`push: ${error.message}`);
        }
      }),
    );
    if (gone.length) {
      this.state.subscriptions = this.state.subscriptions.filter((s) => !gone.includes(s.endpoint));
      this.save();
    }
    if (ntfyWants) sent += await this.toNtfy(msg, cap);
    return { sent };
  }

  /// ntfy: title, body, the room as the click target, and the options as one-tap http actions
  /// (they need HUB_PUBLIC_URL, the address the phone reaches the hub at). Published as JSON to the
  /// server with the topic in it, so labels and titles may be any text.
  async toNtfy(msg, cap) {
    const url = new URL(this.ntfy);
    const topic = url.pathname.replace(/^\/+|\/+$/g, '');
    const note = {
      topic,
      title: msg.title,
      message: msg.body,
      tags: [msg.kind === 'blocked' ? 'question' : 'white_check_mark'],
      priority: msg.kind === 'blocked' ? 4 : 3,
    };
    if (this.publicUrl) note.click = msg.url;
    if (cap && this.publicUrl) note.actions = msg.options.map((label, i) => ({ action: 'http', label: label.slice(0, 40), url: `${this.publicUrl}/push/answer?c=${cap}&n=${i + 1}`, method: 'POST', clear: true }));
    const headers = { 'Content-Type': 'application/json' };
    if (this.ntfyToken) headers.Authorization = `Bearer ${this.ntfyToken}`;
    try {
      const res = await this.fetch(url.origin + '/', { method: 'POST', headers, body: JSON.stringify(note) });
      if (!res.ok) this.console.warn(`push: ntfy answered ${res.status}`);
      return res.ok ? 1 : 0;
    } catch (error) {
      this.console.warn(`push: ntfy: ${error.message}`);
      return 0;
    }
  }
}

module.exports = { Push, encrypt };
