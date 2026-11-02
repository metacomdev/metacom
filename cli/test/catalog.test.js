'use strict';

// Shared templates (lib/catalog.js): `template share` lays a folder out as github.com/metacomdev/
// templates will be, refuses what must not go out, and `--from` reads that index from a folder or
// a URL, checking each file against its sha256.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
const templates = require('../lib/templates.js');
const catalog = require('../lib/catalog.js');

const mine = (name, extra = {}) => {
  fs.mkdirSync(templates.USER, { recursive: true });
  const t = {
    name,
    summary: 'A changelog from the last release: one agent reads the commits, one writes.',
    room: 'notes',
    roles: [
      { name: 'reader', agent: 'codex', instructions: 'Read git log since the last tag and list what changed for users.' },
      { name: 'writer', agent: 'claude', accept: 'owner,reader', instructions: 'Write CHANGELOG.md from the list.' },
    ],
    ...extra,
  };
  fs.writeFileSync(path.join(templates.USER, `${name}.json`), JSON.stringify(t));
};

test('share: the repository layout, README and index rebuilt from every file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-repo-'));
  mine('changelog');
  const r = catalog.share('changelog', dir);
  assert.deepStrictEqual([r.changed, r.count], [true, 1]);
  catalog.share('research-report', dir);
  assert.strictEqual(catalog.share('changelog', dir).changed, false, 'the same again changes nothing');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepStrictEqual(index.templates.map((e) => [e.name, e.file]), [['changelog', 'templates/changelog.json'], ['research-report', 'templates/research-report.json']]);
  assert.deepStrictEqual(index.templates[0].roles, [{ name: 'reader', agent: 'codex' }, { name: 'writer', agent: 'claude' }]);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /\| \[changelog\]\(templates\/changelog\.json\) \| reader \(codex\), writer \(claude\) \| A changelog/);
  assert.match(readme, /metacom template use <name> --from metacomdev/);
  // only the template's own fields go out, not where it was found here
  const shared = JSON.parse(fs.readFileSync(path.join(dir, 'templates', 'changelog.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(shared), ['name', 'summary', 'room', 'roles']);
});

test('share refuses a path on this machine or a key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-repo-'));
  mine('leaky', { rules: ['Work only in /home/alex/clients/acme.'] });
  assert.throws(() => catalog.share('leaky', dir), /a path on this machine/);
  mine('leaky', { rules: [`Post with the token ${require('node:crypto').randomBytes(32).toString('base64url').replace(/^\D/, '7')}`] });
  assert.throws(() => catalog.share('leaky', dir), /shaped like a hub token/);
  mine('leaky', { rules: ['Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'] });
  assert.throws(() => catalog.share('leaky', dir), /shaped like a key/);
  assert.ok(!fs.existsSync(path.join(dir, 'templates', 'leaky.json')));
});

test('--from a folder and from a URL: checked against the index sha256', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-repo-'));
  mine('changelog');
  catalog.share('changelog', dir);
  const t = await catalog.get('changelog', dir);
  assert.deepStrictEqual([t.name, t.roles.length, t.source], ['changelog', 2, path.join(dir, 'index.json')]);
  await assert.rejects(catalog.get('nope', dir), /no template nope in/);

  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/repo\//, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/repo/index.json`;
  try {
    const { entries } = await catalog.list(url);
    assert.deepStrictEqual(entries.map((e) => e.name), ['changelog']);
    assert.strictEqual((await catalog.get('changelog', url)).file, url.replace('index.json', 'templates/changelog.json'));
    // a file changed after the index was made is refused
    fs.appendFileSync(path.join(dir, 'templates', 'changelog.json'), ' ');
    await assert.rejects(catalog.get('changelog', url), /does not match the sha256/);
  } finally {
    server.close();
  }
  await assert.rejects(catalog.list('http://example.com/index.json'), /only https/);
});

test('the CLI: share, list --from, and use --from shows the team and wants --yes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-repo-'));
  mine('changelog');
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), ...args], { encoding: 'utf8', env: { ...process.env } });
  assert.match(cli('template', 'share', 'changelog', '--to', dir).stdout, /wrote .*changelog\.json\n.*1 template$/m);
  assert.match(cli('template', 'list', '--from', dir).stdout, /^changelog\s+reader, writer\s+A changelog/m);
  const use = cli('template', 'use', 'changelog', '--from', dir, '--goal', 'notes for 0.2');
  assert.strictEqual(use.status, 1);
  assert.match(use.stdout, /reader {2}\(codex\)/);
  assert.match(use.stdout, /Start it with --yes/);
});
