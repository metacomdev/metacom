'use strict';

// Room templates: the bundled ones are valid, a bad one is refused with its file, and each role's
// briefing and command carry what the template says.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-test-'));
const t = require('../lib/templates.js');

test('the bundled templates load: three job teams and five company templates', () => {
  assert.deepStrictEqual([...t.all().keys()].sort(), ['agency', 'content-studio', 'dev-studio', 'landing-review', 'launch-offer', 'research-report', 'sales-desk', 'tender-office']);
  for (const name of t.all().keys()) assert.ok(t.load(name).roles.length >= 3);
});

test('yours replace a bundled one; a bad one names its file and what is wrong', () => {
  fs.mkdirSync(t.USER, { recursive: true });
  const mine = { ...JSON.parse(fs.readFileSync(path.join(t.BUNDLED, 'research-report.json'), 'utf8')), summary: 'mine.' };
  fs.writeFileSync(path.join(t.USER, 'research-report.json'), JSON.stringify(mine));
  assert.equal(t.load('research-report').source, 'yours');
  mine.roles[0].name = 'Bad Name';
  fs.writeFileSync(path.join(t.USER, 'research-report.json'), JSON.stringify(mine));
  assert.throws(() => t.load('research-report'), /research-report\.json: role "Bad Name": a name is lowercase/);
  fs.rmSync(path.join(t.USER, 'research-report.json'));
});

test('a role is briefed with its name, room, goal, the team, its part and the rules', () => {
  const tpl = t.load('launch-offer');
  const brief = t.briefFor(tpl, tpl.roles[3], 'launch', 'a catering offer');
  assert.match(brief, /^You are reviewer in room launch/);
  assert.match(brief, /Goal: a catering offer/);
  assert.match(brief, /- research: finds real competitor offers/);
  assert.match(brief, /- reviewer \(you\):/);
  assert.match(brief, /Rules:\n- Work only in this folder/);
});

test('the command joins the room under the role name, with its agent', () => {
  const role = t.load('research-report').roles[1];
  const cmd = t.commandFor({ ...role, args: ['--permission-mode', 'auto'] }, 'report');
  assert.deepStrictEqual(cmd.slice(2), ['report', '-n', 'writer', 'claude', '--permission-mode', 'auto']);
});

test('company templates: lead, review, loops and budgets check out; rigor scales them; the README has each one\'s section', () => {
  const names = ['agency', 'tender-office', 'content-studio', 'dev-studio', 'sales-desk'];
  const readme = fs.readFileSync(path.join(__dirname, '..', 'templates', 'README.md'), 'utf8');
  for (const n of names) {
    const c = t.load(n);
    assert.ok(c.lead && c.roles.some((r) => r.name === c.lead), `${n}: a lead among its roles`);
    assert.ok(c.review && c.approve.length && c.goal && c.loops.length, `${n}: review, approve, goal, loops`);
    assert.ok(c.roles.every((r) => r.budget > 0), `${n}: every role has a budget`);
    assert.ok(readme.includes(t.readme(c)), `${n}: its section in the README is current`);
    const strict = t.withRigor(c, 'strict');
    const light = t.withRigor(c, 'light');
    assert.ok(strict.roles.every((r, i) => r.budget <= c.roles[i].budget) && light.roles.every((r, i) => r.budget >= c.roles[i].budget));
    assert.ok(strict.rules.some((r) => /hub_request first/.test(r)) && strict.rules.some((r) => /^Review: /.test(r)));
    const brief = t.briefFor(strict, strict.roles.find((r) => r.name === c.lead), c.room, 'the goal');
    assert.match(brief, /You lead this team/);
    assert.match(t.briefFor(strict, strict.roles.find((r) => r.name !== c.lead), c.room, 'the goal'), new RegExp(`${c.lead} leads this team`));
  }
  assert.throws(() => t.withRigor(t.load('agency'), 'wild'), /light, standard or strict/);
  assert.throws(() => t.check({ name: 'x', summary: 's', room: 'x', lead: 'nobody', roles: [{ name: 'a', agent: 'claude', instructions: 'i' }] }, 'x', 'f'), /"lead"/);
  assert.throws(() => t.check({ name: 'x', summary: 's', room: 'x', loops: [{ target: 'a', every: '1h', prompt: 'p' }], roles: [{ name: 'a', agent: 'claude', instructions: 'i' }] }, 'x', 'f'), /need a "lead"/);
});

test('the web chat\'s /start knows every company template and its goal question', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'hub', 'web', 'app.js'), 'utf8');
  const teams = JSON.parse(/const TEAMS = (\{.*\});/.exec(app)[1]);
  assert.deepStrictEqual(teams, Object.fromEntries(t.companies().map((n) => [n, t.load(n).goal])));
});
