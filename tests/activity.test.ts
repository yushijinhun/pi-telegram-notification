import assert from "node:assert/strict";
import { test } from "node:test";
import { hintOf, parseActivity } from "../src/daemon/activity.ts";

/** One JSONL record per entry, the way Pi writes them. */
function lines(...records: Array<Record<string, unknown>>): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function user(text: string, at = 1_000): Record<string, unknown> {
  return { type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: text, timestamp: at } };
}

function assistant(content: unknown[], at: number, model = "deepseek-flash"): Record<string, unknown> {
  return {
    type: "message",
    timestamp: new Date(at).toISOString(),
    message: { role: "assistant", content, model, timestamp: at },
  };
}

function result(toolCallId: string, toolName: string, at: number, isError = false): Record<string, unknown> {
  return {
    type: "message",
    timestamp: new Date(at).toISOString(),
    message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "out" }], isError, timestamp: at },
  };
}

test("a tool call without a result is what the session is doing now", () => {
  const activity = parseActivity(lines(
    user("rerun the benchmark"),
    assistant([{ type: "text", text: "Running it now." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "cargo run --release\n  --bin bfv" } }], 2_000),
  ));
  assert.equal(activity.running.length, 1);
  assert.equal(activity.running[0]?.tool, "bash");
  assert.equal(activity.running[0]?.hint, "cargo run --release --bin bfv");
  assert.equal(activity.running[0]?.since, 2_000);
  assert.equal(activity.lastUser, "rerun the benchmark");
  assert.equal(activity.turnStartedAt, 1_000);
});

test("one of two parallel calls finishing leaves the other running", () => {
  const activity = parseActivity(lines(
    user("look at both"),
    assistant([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a/main.tex" } },
      { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "N=1024" } },
    ], 2_000),
    result("c1", "read", 3_000),
  ));
  assert.deepEqual(activity.running.map((run) => run.tool), ["grep"]);
  assert.equal(activity.lastTool?.tool, "read");
  assert.equal(activity.lastTool?.ok, true);
});

test("failed tools are counted, and the newest one is remembered", () => {
  const activity = parseActivity(lines(
    user("build"),
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }], 2_000),
    result("c1", "bash", 3_000, true),
    assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "/a/main.tex" } }], 4_000),
    result("c2", "edit", 5_000, true),
  ));
  assert.equal(activity.errors, 2);
  assert.equal(activity.toolCalls, 2);
  assert.equal(activity.lastTool?.ok, false);
  assert.equal(activity.lastTool?.tool, "edit");
});

test("a call whose result fell outside the tail is not reported as running", () => {
  // The turn began at 2_000_000; this call started earlier, so its result is in
  // the part of the file that was not read.
  const activity = parseActivity(lines(
    assistant([{ type: "toolCall", id: "old", name: "bash", arguments: { command: "sleep 999" } }], 1_500_000),
    user("still there?", 2_000_000),
  ));
  assert.deepEqual(activity.running, []);
});

test("progress keeps the newest three things the assistant said, oldest first", () => {
  const activity = parseActivity(lines(
    user("go"),
    assistant([{ type: "text", text: "one" }], 2_000),
    assistant([{ type: "text", text: "two\nwith a second line" }], 3_000),
    assistant([{ type: "text", text: "three" }], 4_000),
    assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "four" }], 5_000),
  ));
  assert.deepEqual(activity.progress, ["two with a second line", "three", "four"]);
  assert.equal(activity.lastAssistant, "four");
  assert.equal(activity.lastEventAt, 5_000);
});

test("thinking blocks are not text, and a model change wins over the message model", () => {
  const activity = parseActivity(lines(
    { type: "model_change", timestamp: new Date(2_000).toISOString(), provider: "openai", modelId: "gpt-6.2" },
    user("hi"),
    assistant([{ type: "thinking", thinking: "let me think" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }], 3_000, "gpt-6.2-sol"),
  ));
  assert.equal(activity.progress.length, 0);
  assert.equal(activity.lastAssistant, undefined);
  assert.equal(activity.model, "gpt-6.2-sol");
});

test("a broken or foreign line is skipped, not fatal", () => {
  const activity = parseActivity(["not json", "", "{\"type\":\"message\"}", lines(user("ok"))].join("\n"));
  assert.equal(activity.lastUser, "ok");
  assert.deepEqual(activity.running, []);
});

test("tool hints prefer the arguments that say what the call does", () => {
  assert.equal(hintOf({ command: "ls -la\npwd" }), "ls -la pwd");
  assert.equal(hintOf({ pattern: "N=1024", path: "/a" }), "N=1024");
  assert.equal(hintOf({ url: "https://eprint.iacr.org/2023/910" }), "https://eprint.iacr.org/2023/910");
  assert.equal(hintOf({ unrelated: "value" }), "value");
  assert.equal(hintOf("<xml/>"), "<xml/>");
  assert.equal(hintOf(undefined), "");
  const long = "x".repeat(400);
  assert.equal(hintOf({ command: long }).length, 90);
});

import { describeActivity } from "../src/daemon/daemon.ts";
import type { LiveSession } from "../src/daemon/hub.ts";

function live(state: "idle" | "working" | "waiting" = "working"): LiveSession {
  return {
    pid: 1,
    host: "test",
    session: { id: "01a212ba", name: "hienaa", cwd: "/home/zhenghongren/bts-theory/gz-bfv/hienaa-a2b" },
    state,
    notify: true,
    since: Date.now() - 60_000,
  } as unknown as LiveSession;
}

test("a dashboard entry shows the tool, its command and the time spent in it", () => {
  const now = Date.now();
  const html = describeActivity(live(), {
    lastUser: "rerun with matched security params",
    turnStartedAt: now - 43 * 60_000,
    running: [{ tool: "bash", hint: "cargo run --release --bin bfv", since: now - 12 * 60_000 }],
    progress: ["digit extraction done at t=65537", "rerunning the 256-bit case"],
    toolCalls: 14,
    errors: 2,
    lastEventAt: now - 12 * 60_000,
    model: "claude-fable-5-2",
  });
  assert.match(html, /<b>hienaa<\/b> · working 43m/);
  assert.match(html, /🛠 <b>bash<\/b> · <code>cargo run --release --bin bfv<\/code> · 12m ⚠️ 12 min in this tool/);
  assert.match(html, /digit extraction done at t=65537/);
  assert.match(html, /you: <i>“rerun with matched security params”<\/i>/);
  assert.match(html, /14 tool calls · 2 failed · last activity 12m ago · claude-fable-5-2/);
});

test("an idle session with no activity still renders, and says it waits for you", () => {
  const html = describeActivity(live("waiting"), undefined);
  assert.match(html, /❓ <b>hienaa<\/b> · waiting for you on the computer/);
  assert.ok(!html.includes("🛠"));
});
