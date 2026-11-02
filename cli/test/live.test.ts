// Live mode keys: what the chat's terminal sends → what the agent gets. Run: npx tsx --test test/live.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { liveInput, liveWindow } from "../src/chat/live.ts";

test("live: Esc leaves; ctrl+Esc (and ctrl+]) send Esc to the agent", () => {
  assert.deepStrictEqual(liveInput("\u001b"), { leave: true, keys: "" });
  assert.deepStrictEqual(liveInput("\u001b[27u"), { leave: true, keys: "" });
  assert.deepStrictEqual(liveInput("\u001b[27;5u"), { leave: false, keys: "\u001b" });
  assert.deepStrictEqual(liveInput("\u001b[27;2u"), { leave: true, keys: "" });
  assert.deepStrictEqual(liveInput("\u001d"), { leave: false, keys: "\u001b" });
  assert.deepStrictEqual(liveInput("\u001b[93;5u"), { leave: false, keys: "\u001b" });
});

test("live: typing, arrows, Enter, Tab and a paste pass through as typed", () => {
  assert.strictEqual(liveInput("hello").keys, "hello");
  assert.strictEqual(liveInput("\u001b[A").keys, "\u001b[A");
  assert.strictEqual(liveInput("\u001b[B\u001b[B\r").keys, "\u001b[B\u001b[B\r");
  assert.strictEqual(liveInput("\t").keys, "\t");
  assert.strictEqual(liveInput("\u001b[200~two\nlines\u001b[201~").keys, "\u001b[200~two\nlines\u001b[201~");
  // alt+b (word left in most shells and in Claude Code's input)
  assert.strictEqual(liveInput("\u001bb").keys, "\u001bb");
});

test("live: kitty-encoded keys become the legacy bytes an agent's terminal expects", () => {
  assert.strictEqual(liveInput("\u001b[99;5u").keys, "\u0003"); // ctrl+c
  assert.strictEqual(liveInput("\u001b[13u").keys, "\r");
  assert.strictEqual(liveInput("\u001b[13;2u").keys, "\r"); // shift+enter
  assert.strictEqual(liveInput("\u001b[9;2u").keys, "\u001b[Z"); // shift+tab
  assert.strictEqual(liveInput("\u001b[127u").keys, "\u007f");
  assert.strictEqual(liveInput("\u001b[98;3u").keys, "\u001bb"); // alt+b
  assert.strictEqual(liveInput("\u001b[97;2u").keys, "A");
});

test("live: mouse reports are the chat's own and never reach the agent", () => {
  assert.strictEqual(liveInput("\u001b[<0;10;5M\u001b[<0;10;5m").keys, "");
  assert.strictEqual(liveInput("\u001b[<64;3;3Mx").keys, "x");
});

test("live: a screen taller than the view shows the part with the cursor, the bottom by default", () => {
  assert.deepStrictEqual(liveWindow(30, 40, 5), [0, 30]);
  assert.deepStrictEqual(liveWindow(50, 30, 48), [20, 50]);
  assert.deepStrictEqual(liveWindow(50, 30, null), [20, 50]);
  assert.deepStrictEqual(liveWindow(50, 30, 3), [0, 30]);
});

test("live: scrolling back is shift+↑↓ (a row), shift+PgUp/PgDn (a page) and the wheel; other keys are not", async () => {
  const { liveScrollOf } = await import("../src/chat/live.ts");
  assert.strictEqual(liveScrollOf("\u001b[1;2A", 20), 1);
  assert.strictEqual(liveScrollOf("\u001b[1;2B", 20), -1);
  assert.strictEqual(liveScrollOf("\u001b[5;2~", 20), 20);
  assert.strictEqual(liveScrollOf("\u001b[6;2~", 20), -20);
  assert.strictEqual(liveScrollOf("\u001b[<64;10;5M\u001b[<64;10;5M", 20), 6);
  assert.strictEqual(liveScrollOf("\u001b[<65;10;5M", 20), -3);
  for (const k of ["\u001b[A", "\u001b[5~", "a", "\u001b[<0;10;5M"]) assert.strictEqual(liveScrollOf(k, 20), 0, JSON.stringify(k));
});
