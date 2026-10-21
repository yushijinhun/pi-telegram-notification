import { readFile } from "node:fs/promises";
import { MESSAGE_LIMIT, truncate } from "./format.ts";
import type { RichFile, RichMessage } from "./rich.ts";

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

export interface TelegramMessage {
  rich: RichMessage;
  /** Telegram HTML for sendMessage, sent if Telegram rejects the rich message. */
  html: string;
  /** Plain text, sent if Telegram rejects the HTML. */
  text: string;
}

export interface Delivery {
  /** "rich message", "rich message without images", "HTML" or "plain text". */
  format: string;
  /** Telegram's reason for rejecting the rich message, when another format was sent. */
  rejection?: string;
}

/** Telegram answered 400, so nothing was sent. */
class RejectedError extends Error {}

/** Send the rich message, or the next format each time Telegram rejects one. */
export async function sendTelegram(config: TelegramConfig, message: TelegramMessage): Promise<Delivery> {
  const { rich } = message;
  const preview = { link_preview_options: { is_disabled: true } };
  const attempts: Array<[string, () => Promise<void>]> = [
    ["rich message", () => postRich(config, rich.markdown, rich.files, rich.withoutImages !== undefined)],
  ];
  if (rich.withoutImages !== undefined) {
    const markdown = rich.withoutImages;
    attempts.push(["rich message without images", () => postRich(config, markdown, [], false)]);
  }
  attempts.push(
    ["HTML", () => post(config, "sendMessage", { text: message.html, parse_mode: "HTML", ...preview })],
    ["plain text", () => post(config, "sendMessage", { text: truncate(message.text, MESSAGE_LIMIT), ...preview })],
  );

  let rejection: string | undefined;
  for (const [index, [format, send]] of attempts.entries()) {
    try {
      await send();
      return { format, rejection };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : "Unknown Telegram error")
        .split(config.botToken).join("[redacted]");
      if (!(error instanceof RejectedError) || index === attempts.length - 1) throw new Error(reason);
      rejection ??= reason;
    }
  }
  throw new Error("No message format left to send.");
}

async function postRich(config: TelegramConfig, markdown: string, files: RichFile[], images: boolean): Promise<void> {
  const media = files.map((file) => ({ id: file.id, media: { type: file.kind, media: `attach://${file.id}` } }));
  const richMessage = files.length ? { markdown, media } : { markdown };
  let body: Record<string, unknown> | FormData = { rich_message: richMessage };
  if (files.length) {
    body = new FormData();
    body.append("chat_id", config.chatId);
    body.append("rich_message", JSON.stringify(richMessage));
    for (const file of files) body.append(file.id, new Blob([file.data], { type: file.type }), file.name);
  }
  // Telegram downloads or receives the images before it answers.
  await post(config, "sendRichMessage", body, images ? 60_000 : 15_000);
}

async function post(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown> | FormData,
  timeout = 15_000,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    ...(body instanceof FormData
      ? { body }
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: config.chatId, ...body }) }),
    // The agent's own signal is aborted on Escape. Notifications must still send.
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || result.ok !== true) {
    const reason = result.description || `Telegram request failed (HTTP ${response.status}).`;
    throw response.status === 400 ? new RejectedError(reason) : new Error(reason);
  }
}
