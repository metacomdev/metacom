'use strict';

const { fail } = require('../lib/errors.js');

/// Every method is `public` for metacom and authenticates itself through hub.identify():
/// websocket callers sign in once, HTTP callers pass `token` in every call.
const buildApi = ({ hub, auth, console }) => {
  // the address people reach this hub at (a tunnel or proxy in front of 127.0.0.1), told to
  // every client that signs in so the chat can show it instead of the address it dialled
  const publicUrl = (process.env.HUB_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
  const me = (conn) => ({ ...hub.from(conn), ...(publicUrl ? { url: publicUrl } : {}), previews: hub.prefs.previews !== false });
  const method = (handler) => ({ access: 'public', handler });
  const found = (which) => {
    try {
      return auth.find(which);
    } catch (error) {
      throw fail(404, error.message);
    }
  };
  const units = {
    system: {
      introspect: method(async (unitNames) => {
        const result = {};
        for (const unit of Array.isArray(unitNames) ? unitNames : []) {
          if (!units[unit]) continue;
          result[unit] = Object.fromEntries(Object.keys(units[unit]).map((m) => [m, {}]));
        }
        return result;
      }),
    },
    auth: {
      signin: method(async ({ token } = {}, context) => {
        const { client } = context;
        const ip = client.source;
        if (auth.blocked(ip)) throw fail(429, 'Too many failed sign-ins, try later');
        const record = auth.verify(token);
        if (!record) {
          auth.recordFailure(ip);
          setTimeout(() => client.close(), 200);
          throw fail(401, 'Bad token');
        }
        if (hub.conns.has(client)) return me(hub.conns.get(client));
        const conn = hub.bind(client, record, ip);
        return me(conn);
      }),
      whoami: method(async (args, context) => hub.from(hub.identify(context, args))),
    },
    // push alerts to the owner's devices (lib/push.js): the key to subscribe with, subscribe, test
    push: {
      key: method(async (args = {}, context) => {
        hub.identify(context, args);
        return { publicKey: hub.push ? hub.push.publicKey : null, ntfy: Boolean(hub.push && hub.push.ntfy) };
      }),
      // what alerts this person in a room: on, off, stuck, done, all; without a choice, the setting
      room: method(async ({ room, choice, ...rest } = {}, context) => {
        const conn = hub.identify(context, rest);
        hub.owner(conn);
        if (!room) throw new Error('room is required');
        try {
          return choice ? hub.push.setRoom(conn.record, String(room), String(choice)) : hub.push.settings(conn.record, String(room));
        } catch (error) {
          throw fail(400, error.message);
        }
      }),
      subscribe: method(async ({ subscription, events, ...rest } = {}, context) => {
        const conn = hub.identify(context, rest);
        hub.owner(conn);
        return hub.push.subscribe(conn.record, subscription, Array.isArray(events) ? events : undefined);
      }),
      unsubscribe: method(async ({ endpoint, ...rest } = {}, context) => hub.push.unsubscribe(hub.identify(context, rest).record, endpoint)),
      test: method(async (args = {}, context) => {
        const conn = hub.identify(context, args);
        hub.owner(conn);
        const fake = { key: 'test@hub', name: 'metacom', room: 'test' };
        return hub.push.alert('done', fake, 'Alerts work: this is what an agent finishing a turn looks like.');
      }),
    },
    agents: {
      register: method(async (args = {}, context) => hub.register(hub.identify(context, args), args)),
      status: method(async ({ status, reason, question, ...rest } = {}, context) => hub.setStatus(hub.identify(context, rest), status, reason, question)),
      wait: method(async ({ name, until, timeoutMs, ...rest } = {}, context) => hub.wait(hub.identify(context, rest), name, until, timeoutMs)),
      live: method(async ({ name, on, ...rest } = {}, context) => hub.live(hub.identify(context, rest), name, on !== false)),
      liveFrame: method(async ({ frame, ...rest } = {}, context) => hub.liveFrame(hub.identify(context, rest), frame)),
      liveScroll: method(async ({ name, offset, ...rest } = {}, context) => hub.liveScroll(hub.identify(context, rest), name, offset)),
      liveHistory: method(async ({ req, frame, ...rest } = {}, context) => hub.liveHistory(hub.identify(context, rest), req, frame)),
      liveKeys: method(async ({ name, data, ...rest } = {}, context) => hub.liveKeys(hub.identify(context, rest), name, data)),
      list: method(async ({ room, ...rest } = {}, context) => hub.list(hub.identify(context, rest), room)),
      send: method(async ({ to, text, kind, wait, media, suggest, suggestTtl, keepOlder, replyTo, ...rest } = {}, context) => hub.send(hub.identify(context, rest), to, text, kind, wait, media, { suggest, suggestTtl, keepOlder: Boolean(keepOlder), replyTo })),
      dispatch: method(async ({ text, room, media, ...rest } = {}, context) => hub.dispatch(hub.identify(context, rest), text, room, media)),
      // the wrapper: which secrets its agent holds (names only); and that it used them
      secretNames: method(async ({ names, ...rest } = {}, context) => hub.reportSecretNames(hub.identify(context, rest), names)),
      context: method(async ({ tokens, ...rest } = {}, context) => hub.contextReport(hub.identify(context, rest), tokens)),
      rotated: method(async ({ before, after, batch, skipped, ...rest } = {}, context) => hub.rotated(hub.identify(context, rest), before, after, batch, skipped)),
      secretsUsed: method(async ({ names, purpose, where, ...rest } = {}, context) => hub.secretsUsed(hub.identify(context, rest), names, purpose, where)),
      inbox: method(async ({ since, ...rest } = {}, context) => hub.inboxFor(hub.identify(context, rest), since)),
      ack: method(async ({ ids, ...rest } = {}, context) => hub.ack(hub.identify(context, rest), ids)),
      invite: method(async ({ name, room, ...rest } = {}, context) => hub.invite(hub.identify(context, rest), name, room)),
      request: method(async ({ room, action, detail, risk, ...rest } = {}, context) => hub.request(hub.identify(context, rest), room, action, detail, risk)),
      delegate: method(async ({ what, names, ...rest } = {}, context) => hub.delegate(hub.identify(context, rest), what, names)),
      spend: method(async ({ day, cost, tokens, ...rest } = {}, context) => hub.spend(hub.identify(context, rest), { day, cost, tokens })),
      resume: method(async ({ name, ...rest } = {}, context) => hub.resume(hub.identify(context, rest), name)),
      budget: method(async ({ name, dollars, ...rest } = {}, context) => hub.setBudget(hub.identify(context, rest), name, dollars)),
      budgets: method(async (args = {}, context) => hub.budgets(hub.identify(context, args))),
      decideAll: method(async ({ room, approve, ...rest } = {}, context) => hub.decideAll(hub.identify(context, rest), room, approve === true)),
      approvals: method(async (args = {}, context) => hub.pendingApprovals(hub.identify(context, args))),
      requests: method(async ({ room, ...rest } = {}, context) => hub.requests(hub.identify(context, rest), room)),
      requestStatus: method(async ({ id: rid, ...rest } = {}, context) => hub.requestStatus(hub.identify(context, rest), rid)),
      decide: method(async ({ id: rid, approve, ...rest } = {}, context) => hub.decide(hub.identify(context, rest), rid, approve === true)),
      kill: method(async ({ name, ...rest } = {}, context) => hub.kill(hub.identify(context, rest), name)),
      // the wrapper on a room session it was told to start: started, or failed and why
      sessionReport: method(async ({ room, ok, error, ...rest } = {}, context) => hub.sessionReport(hub.identify(context, rest), room, ok !== false, error)),
      uninvite: method(async ({ name, room, ...rest } = {}, context) => hub.uninvite(hub.identify(context, rest), name, room)),
      grant: method(async ({ name, rooms, ...rest } = {}, context) => hub.grant(hub.identify(context, rest), name, rooms)),
    },
    room: {
      join: method(async ({ room, ...rest } = {}, context) => hub.join(hub.identify(context, rest), room)),
      // the room's lead agent (owner): messages to nobody in particular go to it
      manage: method(async ({ room, names, ...rest } = {}, context) => hub.manage(hub.identify(context, rest), room, names)),
      lead: method(async ({ room, name, ...rest } = {}, context) => hub.setLead(hub.identify(context, rest), room, name)),
      say: method(async ({ room, text, media, suggest, suggestTtl, keepOlder, replyTo, share, ...rest } = {}, context) => hub.say(hub.identify(context, rest), room, text, media, { suggest, suggestTtl, keepOlder: Boolean(keepOlder), replyTo, share: share === true })),
      message: method(async ({ room, id, ...rest } = {}, context) => hub.message(hub.identify(context, rest), room, id)),
      history: method(async ({ room, limit, since, from, before, ...rest } = {}, context) => hub.history(hub.identify(context, rest), room, limit, since, from, before)),
      edit: method(async ({ id, text, suggest, ...rest } = {}, context) => hub.edit(hub.identify(context, rest), id, text, suggest)),
      secrets: method(async ({ room, ...rest } = {}, context) => hub.listSecrets(hub.identify(context, rest), room)),
      pin: method(async ({ id, on, ...rest } = {}, context) => hub.pin(hub.identify(context, rest), id, on !== false)),
      pins: method(async ({ room, ...rest } = {}, context) => hub.pins(hub.identify(context, rest), room)),
      suggestions: method(async ({ room, ...rest } = {}, context) => hub.suggestions(hub.identify(context, rest), room)),
      unsuggest: method(async ({ id, ...rest } = {}, context) => hub.unsuggest(hub.identify(context, rest), id)),
      dismiss: method(async ({ room, id, ...rest } = {}, context) => hub.dismiss(hub.identify(context, rest), room, id)),
      suggestStats: method(async (args = {}, context) => hub.suggestStats(hub.identify(context, args))),
      versions: method(async ({ id, ...rest } = {}, context) => hub.versions(hub.identify(context, rest), id)),
      list: method(async ({ archived, ...rest } = {}, context) => hub.rooms(hub.identify(context, rest), { archived: Boolean(archived) })),
      read: method(async ({ room, ...rest } = {}, context) => hub.markRead(hub.identify(context, rest), room)),
      // nothing is deleted any more: delete (from a client not yet updated) archives
      delete: method(async ({ room, ...rest } = {}, context) => hub.archiveRoom(hub.identify(context, rest), room)),
      archive: method(async ({ room, ...rest } = {}, context) => hub.archiveRoom(hub.identify(context, rest), room)),
      unarchive: method(async ({ room, ...rest } = {}, context) => hub.unarchiveRoom(hub.identify(context, rest), room)),
    },
    // the hub's own scheduled instructions to a room's agents (lib/loops.js, docs/loops.md)
    loops: {
      create: method(async ({ room, line, every, target, prompt, tz, ...rest } = {}, context) => hub.loops.create(hub.identify(context, rest), { room, line, every, target, prompt, tz })),
      list: method(async ({ room, all, ...rest } = {}, context) => hub.loops.list(hub.identify(context, rest), room, Boolean(all))),
      toggle: method(async ({ id, on, ...rest } = {}, context) => hub.loops.toggle(hub.identify(context, rest), id, on)),
      delete: method(async ({ id, ...rest } = {}, context) => hub.loops.remove(hub.identify(context, rest), id)),
      run: method(async ({ id, ...rest } = {}, context) => hub.loops.run(hub.identify(context, rest), id)),
    },
    admin: {
      previews: method(async ({ on, ...rest } = {}, context) => hub.setPreviews(hub.identify(context, rest), on === true)),
      createToken: method(async ({ name, role, rooms, steer, agents, label, owner, ...rest } = {}, context) => {
        const conn = hub.identify(context, rest);
        hub.owner(conn);
        try {
          // `owner`: who an agent's own token is for (the person who started it), as the room shows it
          const created = auth.create({ name, role, rooms, by: owner && /^[\w.-]{1,32}$/.test(String(owner)) ? String(owner) : hub.from(conn).name, steer: steer === 'answer' ? 'answer' : Boolean(steer), agents: Boolean(agents), label });
          console.log(`admin: token "${name}" (${role}${rooms ? ', only ' + rooms.join(' ') : ''}${steer ? ', steers' : ''}) created`);
          return created;
        } catch (error) {
          throw fail(400, error.message);
        }
      }),
      // every token, with what it is doing now: connections, agents and people online through it
      tokens: method(async (args = {}, context) => {
        hub.owner(hub.identify(context, args));
        return auth.list().map((t) => ({ ...t, ...hub.tokenUse(t.id) }));
      }),
      // `token` is a token's name (when unique) or id; `id` is still taken
      revokeToken: method(async ({ id, token, ...rest } = {}, context) => {
        hub.owner(hub.identify(context, rest));
        const record = found(token || id);
        const revoked = auth.revoke(record.id);
        // and whoever is connected with it now is cut off, not just refused next time
        const closed = revoked ? hub.cut(record.id) : 0;
        console.log(`admin: token "${record.name}" revoked, ${closed} connection(s) closed`);
        return { revoked, closed, name: record.name };
      }),
      // the rooms a token works in: `add` or `remove` some, `set` exactly, or `all` for every room
      setRooms: method(async ({ token, add, remove, set, all, ...rest } = {}, context) => {
        hub.owner(hub.identify(context, rest));
        const record = found(token);
        const list = (v) => (Array.isArray(v) ? v.map(String) : []);
        let rooms;
        if (all) rooms = null;
        else if (set) rooms = list(set);
        else if (!record.rooms) {
          throw fail(400, `${record.name} already works in every room; to limit it, set its rooms exactly`);
        } else {
          rooms = [...new Set([...record.rooms, ...list(add)])].filter((r) => !list(remove).includes(r));
          if (!rooms.length) throw fail(400, `that would leave ${record.name} no room; revoke it instead`);
        }
        let updated;
        try {
          updated = auth.setRooms(record.id, rooms);
        } catch (error) {
          throw fail(400, error.message);
        }
        const closed = hub.rescope(record.id, updated.rooms || null);
        console.log(`admin: token "${record.name}" now ${updated.rooms ? 'only ' + updated.rooms.join(' ') : 'every room'}`);
        return { ...updated, closed };
      }),
    },
  };
  return units;
};

module.exports = { buildApi };
