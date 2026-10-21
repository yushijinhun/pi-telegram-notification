import { readFile } from "node:fs/promises";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export async function readTelegramConfig(path: string): Promise<TelegramConfig> {
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

  const config = value as Partial<TelegramConfig> | null;
  if (
    typeof config?.botToken !== "string" ||
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

  return { botToken: config.botToken.trim(), chatId: String(config.chatId).trim() };
}

export async function sendTelegram(config: TelegramConfig, text: string): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: Array.from(text).slice(0, 4000).join(""),
        link_preview_options: { is_disabled: true },
      }),
      // The agent's own signal is aborted on Escape. Notifications must still send.
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as { ok?: boolean; description?: string };
    if (!response.ok || result.ok !== true) {
      throw new Error(result.description || `Telegram request failed (HTTP ${response.status}).`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown Telegram error";
    throw new Error(reason.split(config.botToken).join("[redacted]"));
  }
}
