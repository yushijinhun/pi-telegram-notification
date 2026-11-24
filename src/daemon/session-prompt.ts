import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { promptLine } from "../remote/prompt.ts";

/**
 * The first prompt in a session file. Pi appends to the file, so the first user
 * message is the session's first prompt. Reads only as far as that message.
 */
export async function readFirstPrompt(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const content = userContent(line);
      if (content !== undefined) return promptLine(content);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * The content of a user message record, or undefined for other records.
 * A user message with unrecognized content has empty content, so it ends the search.
 */
function userContent(line: string): string | Array<{ type: string; text?: string }> | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { type, message } = record as { type?: unknown; message?: unknown };
  if (type !== "message" || typeof message !== "object" || message === null) return undefined;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content as Array<{ type: string; text?: string }>;
  return "";
}
