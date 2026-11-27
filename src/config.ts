import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** The model that writes status summaries, as "provider/modelId". Work stays on the session's model. */
  summaryModel?: string;
}

export interface RemoteSettings {
  /** The Telegram user ID of the only person who can control Pi, or undefined if it is not set. */
  userId: string | undefined;
  /** Notify for every session while the GNOME screen is locked. */
  awayOnLock: boolean;
  /** Ask before running a message that arrives this late, such as after the computer wakes up. */
  staleMinutes: number;
}

/** Pi's agent directory, found the way Pi's getAgentDir() finds it, so the daemon need not load Pi. */
export function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".pi", "agent");
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

export function configPath(): string {
  return join(agentDir(), "telegram-notification.json");
}

async function readConfigObject(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read ${path}. Configure botToken and chatId first.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    // JSON parser errors can include a snippet of the secret. Do not show them.
    throw new Error(`Invalid JSON in ${path}.`);
  }
  if (typeof value !== "object" || value === null) throw new Error(`Invalid JSON in ${path}.`);
  return value as Record<string, unknown>;
}

export async function readTelegramConfig(path: string): Promise<TelegramConfig> {
  const config = await readConfigObject(path) as Partial<TelegramConfig>;
  if (
    typeof config.botToken !== "string" ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken.trim())
  ) {
    throw new Error(`Telegram botToken is missing or invalid in ${path}.`);
  }
  if (
    (typeof config.chatId !== "string" && typeof config.chatId !== "number") ||
    !String(config.chatId).trim()
  ) {
    throw new Error(`Telegram chatId is missing in ${path}.`);
  }

  const summaryModel = typeof config.summaryModel === "string" ? config.summaryModel.trim() : "";
  return {
    botToken: config.botToken.trim(),
    chatId: String(config.chatId).trim(),
    ...(summaryModel ? { summaryModel } : {}),
  };
}

/** The "remote" object of the same file, which only the daemon reads. */
export async function readRemoteSettings(path: string): Promise<RemoteSettings> {
  const config = await readConfigObject(path);
  const remote = (typeof config.remote === "object" && config.remote !== null ? config.remote : {}) as Record<string, unknown>;
  const userId = typeof remote.userId === "number" || typeof remote.userId === "string" ? String(remote.userId).trim() : "";
  return {
    userId: /^\d+$/.test(userId) ? userId : undefined,
    awayOnLock: typeof remote.awayOnLock === "boolean" ? remote.awayOnLock : true,
    staleMinutes: typeof remote.staleMinutes === "number" && remote.staleMinutes > 0 ? remote.staleMinutes : 10,
  };
}
