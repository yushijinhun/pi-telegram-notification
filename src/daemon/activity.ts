import { open } from "node:fs/promises";

/**
 * What a running Pi session is doing right now, read from the end of its
 * session file. Nothing here asks the session, so it works for a session that is
 * busy in a long tool call and for one whose extension is out of date.
 *
 * The file is JSONL and only its tail matters: the last user message, the
 * assistant messages since then, and the tool calls that have no result yet.
 */

/** How much of the file to read. A long tool output can be megabytes. */
const TAIL_BYTES = 512 * 1024;

/** How many one-line progress entries to keep, oldest first. */
const PROGRESS_LINES = 3;

/** Longer hints are cut: Telegram shows a line or two, and a command can be huge. */
const HINT_CHARS = 90;

const TEXT_CHARS = 300;

/** A tool call that has started and has no result yet. */
export interface RunningTool {
  tool: string;
  hint: string;
  /** Unix milliseconds. */
  since: number;
}

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  /** Unix milliseconds. */
  at: number;
}

export interface Activity {
  /** From the newest assistant message or model change, such as "deepseek-flash". */
  model?: string;
  /** The last prompt a person sent. */
  lastUser?: string;
  /** Unix milliseconds, when that prompt was sent: the current turn started then. */
  turnStartedAt?: number;
  /** The newest assistant text. */
  lastAssistant?: string;
  /** One line each, oldest first, from the assistant messages of this turn. */
  progress: string[];
  /** Tool calls without a result, in the order they started. Empty when Pi is thinking. */
  running: RunningTool[];
  /** The newest finished tool call. */
  lastTool?: ToolOutcome;
  /** Tool calls in the tail. */
  toolCalls: number;
  /** Failed tool results in the tail. */
  errors: number;
  /** Unix milliseconds of the newest record in the file. */
  lastEventAt?: number;
}

/**
 * The activity of the session stored in file, or undefined when it cannot be read.
 * A file that is not JSONL at all still yields an Activity: the caller shows
 * what it has.
 */
export async function readActivity(file: string): Promise<Activity | undefined> {
  try {
    return parseActivity(await readTail(file, TAIL_BYTES));
  } catch {
    return undefined;
  }
}

/** Read at most `bytes` from the end of the file, without the partial first line. */
async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // When the read starts mid-file, its first line is a fragment: a drop of a
    // JSON object parses as nothing, so it costs one line, not a wrong record.
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

/** Derive the activity from JSONL text. Split out so tests need no file. */
export function parseActivity(text: string): Activity {
  const activity: Activity = { progress: [], running: [], toolCalls: 0, errors: 0 };
  const pending = new Map<string, RunningTool>();

  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    const at = recordTime(record);
    if (at !== undefined) activity.lastEventAt = at;

    if (record.type === "model_change") {
      const provider = string(record.provider);
      const modelId = string(record.modelId);
      if (modelId) activity.model = provider ? `${provider}/${modelId}` : modelId;
      continue;
    }
    if (record.type !== "message") continue;

    const message = record.message;
    if (!isRecord(message)) continue;
    switch (message.role) {
      case "user": {
        const text = blockText(message.content);
        if (!text) break;
        activity.lastUser = truncate(oneLine(text), TEXT_CHARS);
        activity.turnStartedAt = number(message.timestamp) ?? at;
        break;
      }
      case "assistant": {
        const model = string(message.model);
        if (model) activity.model = model;
        const said = blockText(message.content);
        if (said) {
          activity.lastAssistant = truncate(oneLine(said), TEXT_CHARS);
          activity.progress.push(truncate(oneLine(said), HINT_CHARS));
          if (activity.progress.length > PROGRESS_LINES) activity.progress.shift();
        }
        for (const block of blocks(message.content)) {
          if (block.type !== "toolCall") continue;
          const tool = string(block.name) ?? "tool";
          activity.toolCalls += 1;
          const id = string(block.id) ?? `${tool}-${activity.toolCalls}`;
          pending.set(id, { tool, hint: hintOf(block.arguments), since: number(message.timestamp) ?? at ?? Date.now() });
        }
        break;
      }
      case "toolResult": {
        const id = string(message.toolCallId);
        const run = id === undefined ? undefined : pending.get(id);
        if (id !== undefined) pending.delete(id);
        const ok = message.isError !== true;
        if (!ok) activity.errors += 1;
        activity.lastTool = {
          tool: string(message.toolName) ?? run?.tool ?? "tool",
          ok,
          at: number(message.timestamp) ?? at ?? Date.now(),
        };
        break;
      }
    }
  }

  // A tool call from before the tail we read has its result outside the window,
  // so it looks unfinished forever. A real running call always starts after the
  // prompt that began this turn.
  const turn = activity.turnStartedAt;
  activity.running = [...pending.values()]
    .filter((run) => turn === undefined || run.since >= turn)
    .slice(-PROGRESS_LINES);
  return activity;
}

/** A one-line hint of what a tool call is doing: the command, the path, the query. */
export function hintOf(arguments_: unknown): string {
  if (typeof arguments_ === "string") return truncate(oneLine(arguments_), HINT_CHARS);
  if (!isRecord(arguments_)) return "";
  const keys = ["command", "cmd", "query", "pattern", "path", "file_path", "filePath", "url", "prompt", "text", "description"];
  for (const key of keys) {
    const value = arguments_[key];
    if (typeof value === "string" && value.trim()) return truncate(oneLine(value), HINT_CHARS);
  }
  for (const value of Object.values(arguments_)) {
    if (typeof value === "string" && value.trim()) return truncate(oneLine(value), HINT_CHARS);
  }
  return "";
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isRecord(record) ? record : undefined;
}

function recordTime(record: Record<string, unknown>): number | undefined {
  const message = record.message;
  const fromMessage = isRecord(message) ? number(message.timestamp) : undefined;
  if (fromMessage !== undefined) return fromMessage;
  const timestamp = string(record.timestamp);
  if (timestamp === undefined) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function blocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

/** The text of a message or content blocks, without thinking and tool blocks. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return blocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function oneLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cut text to at most `length` characters. Kept local: the daemon must not pull in Pi's TUI packages. */
function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}
