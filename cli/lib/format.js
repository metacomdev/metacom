'use strict';

const time = (ts) => (ts || '').slice(11, 19);

/// One message on one line. `base` (the hub's http url) makes attachments fetchable links.
const line = (msg, base = '') => {
  if (msg.kind === 'system') return `${time(msg.ts)} · ${msg.text}`;
  const to = msg.to ? ` → ${msg.to}` : '';
  const kind = msg.kind === 'say' ? '' : ` [${msg.kind}]`;
  const files = Array.isArray(msg.media) ? msg.media.map((m) => `[${m.name}: ${base}${m.url}]`).join(' ') : '';
  const edited = (msg.edited ? ` (edited v${msg.rev || 2})` : '') + (msg.pinned ? ' (pinned)' : '');
  return `${time(msg.ts)}${edited} ${msg.from.name}${to}${kind}: ${[msg.text, files].filter(Boolean).join(' ')}`;
};

const member = (m) => {
  const repo = m.repo ? ` ${m.repo}` : '';
  const caps = m.caps && m.caps.length ? ` [${m.caps.join(',')}]` : '';
  const host = m.host ? ` @${m.host}` : '';
  const status = m.connected ? (m.attention && m.status !== 'blocked' ? 'done' : m.status) : 'stopped';
  const mark = status === 'blocked' ? '!' : m.attention ? '*' : m.connected ? '●' : '○';
  const why = m.reason && status !== 'stopped' && (status === 'blocked' || status === 'working') ? ` (${m.reason})` : '';
  return `${mark} ${(m.owner ? `${m.name} · ${m.owner}` : m.name).padEnd(14)} ${status.padEnd(8)} ${m.room}${host}${repo}${caps}${why}`;
};

const ago = (ts) => {
  if (!ts) return 'never used';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/// Tokens as /tokens and `metacom tokens` show them: who, what kind, where, whether in use now,
/// and which agents and people are online through it.
const tokensTable = (list) => {
  const rows = list.map((t) => [
    t.label ? `${t.name} (${t.label})` : t.name,
    t.role === 'member' && t.bringsAgents ? 'user' : t.role,
    t.rooms ? t.rooms.join(',') : 'all rooms',
    t.connections ? `online · ${t.connections} conn` : `offline · ${ago(t.lastUsed)}`,
    (t.agents || []).length ? `${t.agents.length} agent${t.agents.length === 1 ? '' : 's'}: ${t.agents.join(' ')}` : (t.people || []).length ? `as ${t.people.join(' ')}` : '-',
  ]);
  const head = ['name', 'role', 'rooms', 'status', 'running'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  return [fmt(head), ...rows.map(fmt)].join('\n');
};

module.exports = { line, member, time, ago, tokensTable };
