// A click on a task box in the input box: which line it lands on, also when the box has scrolled
// ("↑ N more lines" above) and when a long line wraps (only its first row has the box).
import { test } from "node:test";
import assert from "node:assert";
import { taskLineAt, toggleTaskLine } from "../src/chat/input-layout.ts";

const W = 40; // the box width; text starts 4 columns in (border, padding, prompt)

test("a box in the first rows", () => {
  const text = "plan:\n- [ ] page\n- [x] email";
  // row 0 is the top border; text row 1 is box row 2
  assert.strictEqual(taskLineAt(text, text.length, W, 2, 4 + 3), 1);
  assert.strictEqual(taskLineAt(text, text.length, W, 3, 4 + 2), 2);
  assert.strictEqual(taskLineAt(text, text.length, W, 2, 4 + 8), -1, "the text beside it");
  assert.strictEqual(taskLineAt(text, text.length, W, 1, 4 + 3), -1, "a line without a box");
  assert.strictEqual(toggleTaskLine(text, 1), "plan:\n- [x] page\n- [x] email");
  assert.strictEqual(toggleTaskLine(text, 2), "plan:\n- [ ] page\n- [ ] email");
});

test("scrolled: the '↑ more lines' row shifts the rows down by one", () => {
  const text = ["a", "b", "c", "d", "e", "f", "g", "- [ ] last"].join("\n");
  // 8 rows, the window shows the last 6 (c..last) below the "↑ 2 more lines" row
  assert.strictEqual(taskLineAt(text, text.length, W, 1 + 1 + 5, 4 + 3), 7);
  assert.strictEqual(taskLineAt(text, text.length, W, 1 + 5, 4 + 3), -1);
});

test("a wrapped task line has its box on its first row only", () => {
  const long = "- [ ] " + "word ".repeat(20);
  const text = `${long}\n- [ ] next`;
  assert.strictEqual(taskLineAt(text, 0, W, 1, 4 + 3), 0);
  assert.strictEqual(taskLineAt(text, 0, W, 2, 4 + 3), -1, "its second row");
});

test("a bare [ ] at the start of a line is a task too", () => {
  const text = "todo:\n[ ] page\n  [x] email";
  assert.strictEqual(taskLineAt(text, text.length, W, 2, 4 + 1), 1);
  assert.strictEqual(taskLineAt(text, text.length, W, 3, 4 + 3), 2);
  assert.strictEqual(toggleTaskLine(text, 1), "todo:\n[x] page\n  [x] email");
  assert.strictEqual(toggleTaskLine(text, 2), "todo:\n[ ] page\n  [ ] email");
  assert.strictEqual(taskLineAt("see [ ] here", 0, W, 1, 4 + 5), -1, "not at the start of its line");
});
