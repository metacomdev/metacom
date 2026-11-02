// Tables in the terminal chat: box-drawn, fitted to the width, bands inverted, negative numbers in the accent colour.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { renderBody } from "../src/chat/markdown.ts";

const SHEET = `**Goals**

| Goal | Target | Remaining |
|---|--:|--:|
| Weekly active rooms | 50 | -49 |
| GitHub stars | 500 | 0 |

| Release | Bet | Cost |
|---|---|--:|
| **Wk 42 · this week** | | |
| | Editable messages + checklists, one living task list per job | 0.5 |`;

test("a table: borders, bold header, numbers right, a negative and a band inverted", () => {
  const lines = renderBody(SHEET, 80);
  const text = lines.map((l) => l.text);
  assert.ok(text.includes("┌─────────────────────┬────────┬───────────┐"));
  assert.ok(text.some((t) => /^│ Weekly active rooms │ +50 │ +-49 │$/.test(t)), text.join("\n"));
  const neg = lines.find((l) => l.text.includes("-49"))!;
  assert.ok(neg.spans.some((s) => s.tone === "accent" && s.bold && s.text === "-49"));
  assert.ok(!lines.find((l) => l.text.includes("500"))!.spans.some((s) => s.tone === "accent"), "0 is not negative");
  const band = lines.find((l) => l.text.includes("Wk 42"))!;
  assert.ok(band.spans.some((s) => s.inverse && /Wk 42 · this week/.test(s.text)));
  assert.ok(lines.find((l) => l.text.startsWith("│ Goal "))!.spans.some((s) => s.bold && s.text === "Goal"));
});

test("fitted to the width: no line wider, long cells wrap", () => {
  for (const w of [50, 70, 120]) {
    const lines = renderBody(SHEET, w);
    for (const l of lines) assert.ok([...l.text].length <= w, `${w}: ${l.text}`);
  }
  const narrow = renderBody(SHEET, 50).map((l) => l.text);
  assert.ok(narrow.includes("│         │ list per job                  │      │"), "a long cell wraps onto its own lines");
});

// a real sheet from our own team's notes: only where that file is (skipped elsewhere)
const REAL_SHEET = `${process.env.HOME}/leader/blue-sheet-sample.md`;
test("the real Blue Sheet renders", { skip: !existsSync(REAL_SHEET) && "no sample sheet on this machine" }, () => {
  const md = readFileSync(REAL_SHEET, "utf8");
  const lines = renderBody(md, 120);
  assert.strictEqual(lines.filter((l) => l.spans.some((s) => s.inverse && /^ Wk \d\d/.test(s.text))).length, 3);
  assert.strictEqual(lines.filter((l) => l.spans.some((s) => s.tone === "accent" && /^-\d/.test(s.text))).length, 3);
});
