'use strict';

// Secrets in messages. The hub keeps none (misha, 2026-10-12): a `$NAME=value$` in a message is
// handed, in memory, to the wrappers of the agents it is for, which keep it on their own machines
// (~/.config/metacom-hub/env/<agent>@<room>.env); what the hub logs and relays carries `$NAME`.
// The agents' own processes (wrapper, MCP bridge, CLI) mask the values they hold in what they
// send, so a value never comes back to the hub in any form, not even a hash.

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/// `$NAME=value$` anywhere in a message.
const INLINE = /\$([A-Z][A-Z0-9_]*)=([^$\n]+)\$/g;
/// `$NAME=$`: take it back from the agents it is for.
const REMOVE = /\$([A-Z][A-Z0-9_]*)=\$/g;
/// The whole input is a secret (the chats keep such a line out of their input history).
const SECRET_INPUT = /^\s*\$([A-Z][A-Z0-9_]*)=([\s\S]*)\$\s*$/;
const MAX_VALUE = 8 * 1024;
// shorter values would be found inside ordinary words; masking could not tell them apart
const MIN_VALUE = 4;
// names an agent's environment depends on: a secret never takes their place
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LC_\w+|TZ|PWD|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_\w+|DYLD_\w+|PYTHONPATH|MC_\w+|METACOM_\w+)$/;

/// The rules a name and a value keep; throws with what is wrong.
const check = (name, value) => {
  if (!NAME.test(name)) throw new Error('a secret name is capitals, digits and _, starting with a capital');
  if (RESERVED.test(name)) throw new Error(`$${name} is a name the agents' environment needs; pick another`);
  if (value.length > MAX_VALUE) throw new Error(`a secret is at most ${MAX_VALUE} characters`);
  if (value.length < MIN_VALUE) throw new Error(`a secret is at least ${MIN_VALUE} characters, so it can be kept out of messages`);
};

/// Where a message has code: ``` fenced blocks (to their closing fence, or the end) and `inline`
/// spans. A `$NAME=value$` written there is an example of the syntax, documented, not a secret.
const codeRanges = (text) => {
  const out = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  for (const m of text.matchAll(fence)) out.push([m.index, m.index + m[0].length]);
  const inFence = (i) => out.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(/`[^`\n]+`/g)) if (!inFence(m.index)) out.push([m.index, m.index + m[0].length]);
  return out;
};

/// The matches of `re` outside code (and passing `keep`), and the text with only those replaced.
const outsideCode = (text, re, keep = () => true) => {
  const code = codeRanges(text);
  const inCode = (m) => code.some(([a, b]) => m.index < b && m.index + m[0].length > a);
  const matches = [...text.matchAll(re)].filter((m) => !inCode(m) && keep(m));
  const replace = (fn) => {
    let out = '';
    let at = 0;
    for (const m of matches) {
      out += text.slice(at, m.index) + fn(...m);
      at = m.index + m[0].length;
    }
    return out + text.slice(at);
  };
  return { matches, replace };
};

/// A value written to show the syntax, not a secret: "…", "...", "<value>", "value", "xxx".
const PLACEHOLDER = /…|\.\.\.|[<>]|^(value|secret|token|key|xxx+|\*+)$/i;

/// `$NAME=value$` in code with what looks like a real value: neither handed over nor posted (it
/// would sit in the room's log in the clear). Throws, saying how to do either.
const checkCode = (text) => {
  const code = codeRanges(text);
  for (const m of text.matchAll(INLINE)) {
    const inCode = code.some(([a, b]) => m.index < b && m.index + m[0].length > a);
    if (inCode && !PLACEHOLDER.test(m[2].trim())) throw new Error(`$${m[1]}=…$ inside code looks like a real secret, and code is shown as it is: take the backticks away to hand it over, or write a placeholder (…) to show the syntax`);
  }
};

/// The `$NAME=value$` a message hands over: outside code, and not a placeholder ("sk-or-...",
/// "<key>"), which shows the syntax and so must never take the place of a real value.
const shares = (text) => outsideCode(text, INLINE, (m) => !PLACEHOLDER.test(m[2].trim()));

module.exports = { NAME, INLINE, REMOVE, SECRET_INPUT, check, outsideCode, checkCode, shares };
