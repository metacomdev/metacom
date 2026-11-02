'use strict';

const path = require('node:path');

const WORD = /[a-z0-9_-]{3,}/gi;

const words = (text) => new Set((text.toLowerCase().match(WORD) || []));

/// Picks the agent for a task from live members. Heuristic first: name mentioned, repo
/// name mentioned, capability words, then prefer an idle agent. Returns null when no
/// agent is connected. Ties go to the most recently active.
const heuristic = (text, members) => {
  const lower = text.toLowerCase();
  const tokens = words(text);
  const candidates = members.filter((m) => m.kind === 'agent' && m.connected && m.status !== 'stopped' && m.status !== 'blocked');
  if (candidates.length === 0) return null;
  const scored = candidates.map((m) => {
    let score = 0;
    const reasons = [];
    const name = m.name.toLowerCase();
    if (lower.includes(name)) {
      score += 10;
      reasons.push(`named "${m.name}"`);
    }
    const repo = m.repo ? path.basename(m.repo).toLowerCase() : '';
    if (repo && lower.includes(repo)) {
      score += 6;
      reasons.push(`repo "${repo}"`);
    }
    for (const cap of m.caps || []) {
      const c = String(cap).toLowerCase();
      if (tokens.has(c) || lower.includes(c)) {
        score += 3;
        reasons.push(`capability "${cap}"`);
      }
    }
    if (m.status === 'waiting') {
      score += 1;
      reasons.push('idle');
    }
    return { member: m, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score || (b.member.lastSeen || '').localeCompare(a.member.lastSeen || ''));
  const best = scored[0];
  const tied = scored.filter((s) => s.score === best.score);
  return {
    agent: best.member.name,
    reason: best.reasons.length ? best.reasons.join(', ') : 'only or most recently active agent',
    confident: best.score > 1 && tied.length === 1,
    candidates: scored.map((s) => ({ name: s.member.name, score: s.score })),
  };
};

/// The agent for a task sent to "auto": the heuristic's pick (no model is asked).
const route = async (text, members) => heuristic(text, members);

module.exports = { route, heuristic };
