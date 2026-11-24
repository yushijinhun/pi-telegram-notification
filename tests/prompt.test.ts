import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, FIRST_PROMPT_CHARS, promptLine } from "../src/remote/prompt.ts";

test("clip counts Unicode code points, so it never splits an emoji", () => {
  // 61 code points, but 62 UTF-16 code units.
  const text = `${"a".repeat(58)}😀bc`;
  assert.equal(clip(text, 60), `${"a".repeat(58)}😀…`);
  assert.equal(clip("short", 60), "short");
});

test("/ls prompt previews cut at an emoji boundary", () => {
  const text = `${"a".repeat(FIRST_PROMPT_CHARS - 2)}😀bc`;
  const line = promptLine(text);
  assert.equal(line, `${"a".repeat(FIRST_PROMPT_CHARS - 2)}😀…`);
  assert.equal(Array.from(line ?? "").length, FIRST_PROMPT_CHARS);
});
