import { join } from "node:path";
import { agentDir } from "../config.ts";

/**
 * Pi sessions and the daemon talk over a Unix socket, one JSON object per line.
 * A session sends "hello" when it connects, then "update" when its state changes,
 * and "result" for each request. The daemon sends requests and the away state.
 */
export const PROTOCOL_VERSION = 1;

/** Files shared by the daemon and the extension. */
export function remoteDir(): string {
  return join(agentDir(), "telegram-remote");
}

/** Which session each Telegram message belongs to. */
export function linksPath(): string {
  return join(remoteDir(), "messages.jsonl");
}

export function socketPath(): string {
  if (process.env.PI_TELEGRAM_SOCKET) return process.env.PI_TELEGRAM_SOCKET;
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, "pi-telegram-remote.sock") : join(remoteDir(), "daemon.sock");
}

/** "waiting" means Pi waits for an answer in a dialog. */
export type SessionState = "idle" | "working" | "waiting";

export interface SessionInfo {
  id: string;
  /** Undefined for sessions that are not saved. */
  file?: string;
  name?: string;
  cwd: string;
}

export interface Hello {
  type: "hello";
  version: number;
  pid: number;
  host: string;
  /** WEZTERM_PANE, which matches the pane ID that `wezterm cli spawn` prints. */
  pane?: string;
  session: SessionInfo;
  state: SessionState;
  notify: boolean;
}

export interface Update {
  type: "update";
  session?: SessionInfo;
  state?: SessionState;
  notify?: boolean;
}

export interface Result {
  type: "result";
  id: string;
  ok: boolean;
  /** Shown to the user in Telegram. */
  message?: string;
}

export type ClientMessage = Hello | Update | Result;

/** replyTo is the Telegram message that Pi's answer replies to. */
export type Request =
  | { type: "prompt"; id: string; text: string; replyTo: number }
  | { type: "command"; id: string; text: string; replyTo: number }
  | { type: "stop"; id: string }
  | { type: "notify"; id: string; enabled: boolean }
  | { type: "summary"; id: string; replyTo: number }
  | { type: "last"; id: string; replyTo: number };

/** While away, every session notifies when it stops. */
export interface Away {
  type: "away";
  away: boolean;
}

export type DaemonMessage = Request | Away;

/**
 * Return a function that takes decoded socket data and calls onRecord for each line.
 * Only LF ends a record: JSON strings may contain U+2028, which some line readers split on.
 */
export function lineReader(onRecord: (value: unknown) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      onRecord(value);
    }
  };
}

export function encode(message: ClientMessage | DaemonMessage): string {
  return `${JSON.stringify(message)}\n`;
}
