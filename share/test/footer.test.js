'use strict';

// "Made by agents in a metacom room · metacom.dev" at the end of shared HTML pages: on by default,
// off per artifact (footer: false on publish or update), never on other files.
//   node --test share/test/*.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'share-footer-'));
process.env.SHARE_DATA = DATA;
process.env.SHARE_ORIGIN = 'http://share.test';
const { publicServer, internalServer, mintKey } = require('../server.js');

fs.mkdirSync(path.join(DATA, 'artifacts'), { recursive: true });
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
const call = async (route, body) => (await fetch(api + route, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const base = (link) => {
  const u = new URL(link);
  return `${pub}${u.pathname}s/${u.searchParams.get('session')}/`;
};
const page = async (url) => (await fetch(url)).text();
const LINE = /<div data-metacom-footer[^>]*>Made by agents in a metacom room · <a href="https:\/\/metacom\.dev" target="_blank" rel="noopener"/;

test('on by default: one line before </body>, after the page itself; not on other files', async () => {
  const a = await call('/api/publish', { title: 't', files: files({ 'index.html': '<html><body><p>hi</p></body></html>', 'data.txt': 'plain' }) });
  const html = await page(base(a.session.link));
  assert.match(html, LINE);
  assert.ok(html.indexOf('<p>hi</p>') < html.indexOf('data-metacom-footer') && html.indexOf('data-metacom-footer') < html.indexOf('</body>'));
  assert.equal((html.match(/data-metacom-footer/g) || []).length, 1);
  assert.equal(await page(base(a.session.link) + 'data.txt'), 'plain');
});

test('footer: false on publish leaves it out; an update can bring it back without new files', async () => {
  const a = await call('/api/publish', { title: 't', footer: false, files: files({ 'index.html': '<p>quiet</p>' }) });
  const link = base(a.session.link);
  assert.doesNotMatch(await page(link), /data-metacom-footer/);
  const r = await call('/api/update', { id: a.id, mode: 'merge', footer: true });
  assert.ok(r.version, JSON.stringify(r));
  assert.match(await page(link), LINE);
  await call('/api/update', { id: a.id, mode: 'merge', footer: false });
  assert.doesNotMatch(await page(link), /data-metacom-footer/);
});
