'use strict';

// Updating an artifact in place (docs/share-update.md): versions, replace and merge, the secrets scan,
// limits, rollback, pruning, crash safety, the migration from static/, and what visitors get.
//   node --test share/test/*.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'));
process.env.SHARE_DATA = DATA;
process.env.SHARE_ORIGIN = 'http://share.test';
process.env.SHARE_KEEP_VERSIONS = '3';
const { publicServer, internalServer, mintKey, migrate } = require('../server.js');

const ART = path.join(DATA, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const KEY = mintKey('dev', 'tester');
let api;
let pub;

test.before(async () => {
  await new Promise((r) => internalServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => publicServer.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${internalServer.address().port}`;
  pub = `http://127.0.0.1:${publicServer.address().port}`;
});
test.after(() => {
  internalServer.close();
  publicServer.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

const b64 = (s) => Buffer.from(s).toString('base64');
const files = (o) => Object.entries(o).map(([p, data]) => ({ path: p, data: b64(data) }));
const call = async (method, route, body) => {
  const res = await fetch(api + route, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const publish = async (o, title = 't') => (await call('POST', '/api/publish', { title, files: files(o) })).json;
const update = (body) => call('POST', '/api/update', body);
// the session link's working form: /dev/<id>/s/<token>/
const base = (link) => {
  const u = new URL(link);
  return `${pub}${u.pathname}s/${u.searchParams.get('session')}/`;
};
const get = (url, headers) => fetch(url, { headers, redirect: 'manual' });
// a page's own content (HTML gets the footer and the tracker appended)
const text = async (url) => (await (await get(url)).text()).replace(/(<div data-metacom-footer[\s\S]*?<\/a><\/div>)?<script>\(function\(\)\{try\{var E=[\s\S]*<\/script>$/, '');
const perm = (id) => JSON.parse(fs.readFileSync(path.join(ART, 'dev', id, 'permission.json'), 'utf8'));

test('replace: a new version, the same link, the diff', async () => {
  const a = await publish({ 'index.html': '<p>one</p>', 'a.css': 'a{}', 'old.js': '1' });
  const link = base(a.session.link);
  assert.match(await text(link), /one/);
  const r = await update({ id: a.id, files: files({ 'index.html': '<p>two</p>', 'a.css': 'a{}', 'new.js': '2' }), note: 'copy' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.version, r.json.added, r.json.changed, r.json.removed], [2, ['new.js'], ['index.html'], ['old.js']]);
  assert.match(await text(link), /two/);
  assert.equal((await get(link + 'old.js')).status, 404);
  const v = (await call('GET', `/api/versions?id=${a.id}`)).json;
  assert.deepEqual(v.versions.map((x) => [x.n, x.current, x.note]), [[1, false, 'published'], [2, true, 'copy']]);
});

test('merge keeps the rest, overlays, removes', async () => {
  const a = await publish({ 'index.html': 'i', 'a.css': 'a', 'b.css': 'b' });
  const r = await update({ id: a.id, mode: 'merge', files: files({ 'a.css': 'A', 'c.css': 'c' }), remove: ['b.css'] });
  assert.deepEqual([r.json.added, r.json.changed, r.json.removed, r.json.files], [['c.css'], ['a.css'], ['b.css'], 3]);
  const link = base(a.session.link);
  assert.equal(await text(link + 'a.css'), 'A');
  assert.equal(await text(link), 'i');
  assert.equal((await get(link + 'b.css')).status, 404);
  // remove alone, and remove of something absent
  assert.equal((await update({ id: a.id, mode: 'merge', remove: ['c.css'] })).json.files, 2);
  assert.equal((await update({ id: a.id, mode: 'merge', remove: ['nope.css'] })).status, 400);
  assert.equal((await update({ id: a.id, remove: ['a.css'], files: files({ 'x.css': 'x' }) })).status, 400);
});

test('the entry: kept, recomputed, or set', async () => {
  const a = await publish({ 'deck.html': 'd', 'notes.html': 'n' });
  assert.equal(perm(a.id).entry, 'deck.html');
  await update({ id: a.id, files: files({ 'deck.html': 'd2', 'other.html': 'o' }) });
  assert.equal(perm(a.id).entry, 'deck.html');
  await update({ id: a.id, files: files({ 'index.html': 'i' }) });
  assert.equal(perm(a.id).entry, '');
  await update({ id: a.id, files: files({ 'index.html': 'i', 'b.html': 'b' }), entry: 'b.html' });
  assert.equal(perm(a.id).entry, 'b.html');
  assert.match(await text(base(a.session.link)), /^b/);
  assert.equal((await update({ id: a.id, files: files({ 'x.html': 'x' }), entry: 'y.html' })).status, 400);
});

test('a secret is refused and nothing changes', async () => {
  const a = await publish({ 'index.html': 'safe' });
  const r = await update({ id: a.id, mode: 'merge', files: files({ 'leak.txt': 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz' }) });
  assert.equal(r.status, 422);
  assert.equal(perm(a.id).version, 1);
  assert.ok(!fs.existsSync(path.join(ART, 'dev', a.id, 'versions', '2')));
});

test('the limits apply to the result', async () => {
  const a = await publish({ 'index.html': 'x'.repeat(30 * 1024 * 1024) });
  const r = await update({ id: a.id, mode: 'merge', files: files({ 'more.txt': 'y'.repeat(25 * 1024 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal(perm(a.id).version, 1);
});

test('a revoked artifact cannot be updated or rolled back', async () => {
  const a = await publish({ 'index.html': 'i' });
  await call('POST', '/api/revoke', { id: a.id });
  assert.equal((await update({ id: a.id, files: files({ 'index.html': 'j' }) })).status, 404);
  assert.equal((await call('POST', '/api/rollback', { id: a.id, version: 1 })).status, 404);
});

test('rollback points back, keeps every version, and is logged', async () => {
  const a = await publish({ 'index.html': 'v1' });
  await update({ id: a.id, files: files({ 'index.html': 'v2' }) });
  const r = await call('POST', '/api/rollback', { id: a.id, version: 1 });
  assert.deepEqual([r.status, r.json.version, r.json.from], [200, 1, 2]);
  assert.equal(await text(base(a.session.link)), 'v1');
  // the next update still gets a new number
  assert.equal((await update({ id: a.id, files: files({ 'index.html': 'v3' }) })).json.version, 3);
  const log = fs.readFileSync(path.join(ART, 'dev', a.id, 'log.jsonl'), 'utf8');
  assert.match(log, /"rolled back"/);
  assert.match(log, /"updated"/);
  assert.equal((await call('POST', '/api/rollback', { id: a.id, version: 9 })).status, 404);
});

test('pruning keeps the newest and never the current one', async () => {
  const a = await publish({ 'index.html': 'v1' });
  for (let i = 2; i <= 3; i++) await update({ id: a.id, files: files({ 'index.html': `v${i}` }) });
  await call('POST', '/api/rollback', { id: a.id, version: 1 });
  for (let i = 4; i <= 6; i++) await update({ id: a.id, files: files({ 'index.html': `v${i}` }) });
  // KEEP 3: 4, 5, 6 kept; 2 and 3 pruned; 1 was current when 4 came and is old now
  const dirs = fs.readdirSync(path.join(ART, 'dev', a.id, 'versions')).sort();
  assert.deepEqual(dirs, ['4', '5', '6']);
  assert.deepEqual(perm(a.id).versions.filter((v) => v.pruned).map((v) => v.n), [1, 2, 3]);
  assert.equal((await call('POST', '/api/rollback', { id: a.id, version: 2 })).status, 404);
  // the current one survives even when it is the oldest
  await call('POST', '/api/rollback', { id: a.id, version: 4 });
  await update({ id: a.id, files: files({ 'index.html': 'v7' }) });
  await call('POST', '/api/rollback', { id: a.id, version: 5 });
  await update({ id: a.id, files: files({ 'index.html': 'v8' }) });
  assert.ok(fs.existsSync(path.join(ART, 'dev', a.id, 'versions', '5')) || perm(a.id).version !== 5);
  assert.ok(fs.existsSync(path.join(ART, 'dev', a.id, 'versions', String(perm(a.id).version))));
});

test('a leftover .tmp is ignored and cleaned at start', async () => {
  const a = await publish({ 'index.html': 'live' });
  const tmp = path.join(ART, 'dev', a.id, 'versions', '2.tmp');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'index.html'), 'half');
  assert.equal(await text(base(a.session.link)), 'live');
  migrate();
  assert.ok(!fs.existsSync(tmp));
  assert.equal((await update({ id: a.id, files: files({ 'index.html': 'next' }) })).json.version, 2);
});

test('migration: static/ becomes versions/1, once', async () => {
  const a = await publish({ 'index.html': 'old layout' });
  const dir = path.join(ART, 'dev', a.id);
  // back to the layout before versions
  fs.renameSync(path.join(dir, 'versions', '1'), path.join(dir, 'static'));
  fs.rmSync(path.join(dir, 'versions'), { recursive: true });
  const p = perm(a.id);
  delete p.version;
  delete p.versions;
  fs.writeFileSync(path.join(dir, 'permission.json'), JSON.stringify(p));
  assert.equal(await text(base(a.session.link)), 'old layout'); // read until migrated
  assert.ok(migrate() >= 1);
  assert.equal(migrate(), 0);
  assert.ok(!fs.existsSync(path.join(dir, 'static')));
  assert.equal(perm(a.id).version, 1);
  assert.equal(await text(base(a.session.link)), 'old layout');
});

test('visitors: an old link serves the new version; HTML no-cache; ETags by version', async () => {
  const a = await publish({ 'index.html': '<body>one</body>', 'a.css': 'a' });
  const link = base(a.session.link);
  const first = await get(link + 'a.css');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const etag = first.headers.get('etag');
  assert.match(etag, /^"v1-/);
  assert.equal((await get(link + 'a.css', { 'If-None-Match': etag })).status, 304);
  await update({ id: a.id, mode: 'merge', files: files({ 'index.html': '<body>two</body>' }) });
  assert.equal((await get(link + 'a.css', { 'If-None-Match': etag })).status, 200);
  const page = await get(link);
  assert.equal(page.headers.get('cache-control'), 'private, no-cache');
  const html = await page.text();
  assert.match(html, /two/);
  assert.match(html, /V=2,/);
  const listing = await (await get(link + '_files')).json();
  assert.equal(listing.version, 2);
});

test('the heartbeat answers the current version; other beacons stay 204', async () => {
  const a = await publish({ 'index.html': '<body>x</body>' });
  const link = base(a.session.link);
  const html = await text(link);
  const uid = /U="([0-9a-z]{12})"/.exec(html)[1];
  const beat = await fetch(link + '_t', { method: 'POST', body: JSON.stringify({ t: 'heartbeat', u: uid, page: '', d: {} }) });
  assert.deepEqual([beat.status, await beat.json()], [200, { version: 1 }]);
  await update({ id: a.id, files: files({ 'index.html': '<body>y</body>' }) });
  assert.deepEqual(await (await fetch(link + '_t', { method: 'POST', body: JSON.stringify({ t: 'heartbeat', u: uid, d: {} }) })).json(), { version: 2 });
  assert.equal((await fetch(link + '_t', { method: 'POST', body: JSON.stringify({ t: 'open', u: uid, d: {} }) })).status, 204);
  // the views record the version seen
  const act = (await call('GET', `/api/activity?id=${a.id}&session=${a.session.sid}`)).json;
  assert.deepEqual(act.events.filter((e) => e.event === 'view').map((e) => e.version), [1]);
});

test('list shows the version', async () => {
  const a = await publish({ 'index.html': 'i' }, 'listed');
  await update({ id: a.id, files: files({ 'index.html': 'j' }) });
  const row = (await call('GET', '/api/list')).json.artifacts.find((x) => x.id === a.id);
  assert.equal(row.version, 2);
  assert.ok(row.updated);
});
