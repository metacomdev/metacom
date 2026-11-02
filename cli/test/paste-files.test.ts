// Files copied in Finder (or a file manager) and pasted into the terminal chat go as the files: cmd/ctrl+V
// asks the clipboard for copied files before its image (Finder also puts the file's icon there as a
// picture), and a terminal's paste of just their names ("report.pdf") becomes the same attachments.
// Linux: the file manager's text/uri-list, read through xclip (a stand-in on PATH here).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Store } from "../src/chat/store.ts";

const require = createRequire(import.meta.url);
const media = require("../lib/media.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-paste-files-"));
const pdf = path.join(dir, "report 10x.pdf");
const deck = path.join(dir, "deck.pdf");
const exe = path.join(dir, "tool.exe");
for (const f of [pdf, deck, exe]) fs.writeFileSync(f, "%PDF-1.7 x");

const store = () => new Store({ name: "misha", room: "dev", config: { url: "ws://127.0.0.1:1/", http: "http://127.0.0.1:1" } as never });
const stub = (files: string[], image: string | null = null) => {
  const was = { files: media.clipboardFiles, image: media.clipboardImage, text: media.clipboardText };
  media.clipboardFiles = () => files;
  media.clipboardImage = () => image;
  media.clipboardText = () => files.map((f) => path.basename(f)).join("\n");
  return () => Object.assign(media, { clipboardFiles: was.files, clipboardImage: was.image, clipboardText: was.text });
};

test("ctrl+V with a PDF copied in Finder attaches the PDF, not its icon", () => {
  const icon = path.join(dir, "icon.png");
  fs.writeFileSync(icon, "png");
  const undo = stub([pdf], icon);
  try {
    const s = store();
    assert.strictEqual(s.pasteClipboard(), "[report 10x.pdf] ");
    assert.deepStrictEqual(s.state.attachments.map((a) => [a.file, a.type]), [[pdf, "application/pdf"]]);
  } finally {
    undo();
  }
});

test("several copied files: each one; a type the hub refuses is said, the rest still go", () => {
  const undo = stub([pdf, exe, deck]);
  try {
    const s = store();
    assert.strictEqual(s.pasteClipboard(), "[report 10x.pdf] [deck.pdf] ");
    assert.ok(s.state.log.some((e) => JSON.stringify(e).includes("can't send tool.exe")), JSON.stringify(s.state.log));
  } finally {
    undo();
  }
});

test("a terminal's paste of the copied files' names becomes those files", () => {
  const undo = stub([pdf, deck]);
  try {
    const s = store();
    assert.strictEqual(s.attachNamed("report 10x.pdf\ndeck.pdf"), "[report 10x.pdf] [deck.pdf]");
    assert.strictEqual(store().attachNamed("a sentence about report 10x.pdf"), null, "text that only mentions a name stays text");
    assert.strictEqual(store().attachNamed("other.pdf"), null, "a name not on the clipboard stays text");
  } finally {
    undo();
  }
});

test("nothing copied: an image on the clipboard is still pasted as before", () => {
  const shot = path.join(dir, "shot.png");
  fs.writeFileSync(shot, "png");
  const undo = stub([], shot);
  try {
    const s = store();
    assert.strictEqual(s.pasteClipboard(), "[image 1.png] ");
  } finally {
    undo();
  }
});

test("Linux: copied files come from the file manager's text/uri-list", () => {
  if (process.platform === "darwin") return;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mc-xclip-"));
  const uri = "file://" + pdf.split("/").map(encodeURIComponent).join("/");
  fs.writeFileSync(path.join(bin, "xclip"), `#!/bin/sh\ncase "$*" in *TARGETS*) printf 'TARGETS\\ntext/uri-list\\n';; *uri-list*) printf '%s\\r\\n' '${uri}' 'file:///nonexistent/x.pdf';; esac\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.WAYLAND_DISPLAY;
  try {
    assert.deepStrictEqual(media.clipboardFiles(), [pdf]);
  } finally {
    process.env.PATH = env.PATH;
    if (env.WAYLAND_DISPLAY !== undefined) process.env.WAYLAND_DISPLAY = env.WAYLAND_DISPLAY;
  }
});
