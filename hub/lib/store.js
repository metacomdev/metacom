'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./errors.js');

/// Room names become file names, so they are kept to what cannot leave the rooms directory.
const ROOM = /^[\w][\w.-]{0,63}$/;

/// Append-only JSONL files under the data directory. One file per room for the stream,
/// one for directed messages, one JSON snapshot for members. Postgres can replace this
/// class later; the hub only calls append(), tail(), load() and save().
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true, mode: 0o700 });
  }

  roomFile(room) {
    if (!ROOM.test(String(room))) throw fail(400, 'room: letters, digits, dot, dash, underscore, up to 64');
    return path.join(this.dir, 'rooms', room + '.jsonl');
  }

  /// Every room that has a log.
  rooms() {
    try {
      return fs.readdirSync(path.join(this.dir, 'rooms')).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((r) => ROOM.test(r));
    } catch {
      return [];
    }
  }

  append(file, record) {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  appendRoom(room, record) {
    this.append(this.roomFile(room), record);
  }

  /// Last `limit` records of a JSONL file, optionally only those after `since` (ISO time).
  tail(file, limit = 50, since = null) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let rec = null;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (since && rec.ts <= since) break;
      out.push(rec);
    }
    return out.reverse();
  }

  /// Moves a room's log into rooms/.deleted/, stamped with the time, so a deletion can be undone
  /// by moving the file back. False when the room had no log.
  trashRoom(room) {
    const file = this.roomFile(room);
    if (!fs.existsSync(file)) return false;
    const trash = path.join(this.dir, 'rooms', '.deleted');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(trash, `${room}.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
    return true;
  }

  /// A message and its edits, wherever it is: { room, original, edits } or null. Edits are rare,
  /// so the logs are searched rather than indexed.
  thread(id) {
    // a whole id, or the start of one (8 characters or more) as people type it
    const whole = id.length === 36;
    const needle = whole ? `"${id}"` : `"${id}`;
    for (const room of this.rooms()) {
      let text = '';
      try {
        text = fs.readFileSync(this.roomFile(room), 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(needle)) continue;
      let original = null;
      const edits = [];
      for (const line of text.split('\n')) {
        if (!line.includes(needle)) continue;
        let rec = null;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!original && (whole ? rec.id === id : String(rec.id).startsWith(id)) && rec.kind !== 'edit') original = rec;
        else if (rec.kind === 'edit' && original && rec.target === original.id) edits.push(rec);
      }
      if (original) return { room, original, edits };
    }
    return null;
  }

  tailRoom(room, limit, since) {
    return this.tail(this.roomFile(room), limit, since);
  }

  loadJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  saveJson(name, data) {
    const file = path.join(this.dir, name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

module.exports = { ROOM, Store };
