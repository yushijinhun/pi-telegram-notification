import { hostname } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type AgentActivityOutcome,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { installNotificationFooter } from "./src/footer.ts";
import { formatNotification, type NotificationContent } from "./src/format.ts";
import { formatRichMessage } from "./src/rich.ts";
import { readTelegramConfig, sendTelegram } from "./src/telegram.ts";

const ENTRY_TYPE = "telegram-notification";

interface NotificationReceipt {
  sent: boolean;
  message: string;
  notification: string;
  timestamp: number;
}

export default function (pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "telegram-notification.json");
  const setFooterEnabled = installNotificationFooter();
  let enabled = false;
  let lastAssistant: AssistantMessage | undefined;
  let outcome: AgentActivityOutcome | undefined;

  function updateFooter(ctx: ExtensionContext): void {
    setFooterEnabled(enabled && ctx.mode === "tui");
    // setStatus also requests a render. Clearing this key adds no extra line.
    ctx.ui.setStatus(ENTRY_TYPE, undefined);
  }

  pi.registerEntryRenderer<NotificationReceipt>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    let text = theme.fg(data.sent ? "success" : "error", `[Telegram] ${data.message}`);
    if (expanded) {
      text += `\n${theme.fg("dim", new Date(data.timestamp).toLocaleString())}\n${data.notification}`;
    }
    return new Text(text, 0, 0);
  });

  pi.registerCommand("notify", {
    description: "Toggle Telegram notifications: /notify [on|off] (default off)",
    getArgumentCompletions: (prefix) => ["on", "off"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument && argument !== "on" && argument !== "off") {
        ctx.ui.notify("Usage: /notify [on|off]", "error");
        return;
      }

      try {
        await readTelegramConfig(configPath);
      } catch (error) {
        enabled = false;
        updateFooter(ctx);
        ctx.ui.notify((error as Error).message, "error");
        return;
      }

      enabled = argument ? argument === "on" : !enabled;
      updateFooter(ctx);
      ctx.ui.notify(`Telegram notifications ${enabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    lastAssistant = undefined;
    outcome = undefined;
    updateFooter(ctx);
  });

  pi.on("before_agent_start", () => {
    lastAssistant = undefined;
    outcome = undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistant = event.message;
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });

  // agent_end can be followed by retries, compaction, or queued follow-ups.
  pi.on("agent_settled", async (event, ctx) => {
    if (!enabled) return;

    const status = event.aborted || lastAssistant?.stopReason === "aborted"
      ? "aborted"
      : outcome ?? (lastAssistant?.stopReason === "error" ? "error" : "stopped");
    const detail = status === "error"
      ? lastAssistant?.errorMessage || "The agent stopped with an error."
      : lastAssistant?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
    const name = ctx.sessionManager.getSessionName() || ctx.sessionManager.getSessionId().slice(0, 8);
    const content: NotificationContent = {
      host: hostname(),
      status,
      session: name,
      cwd: ctx.cwd,
      detail,
      markdown: status !== "error",
    };
    const { text: notification, html } = formatNotification(content);

    let sent = false;
    let message: string;
    try {
      const config = await readTelegramConfig(configPath);
      const rich = await formatRichMessage(content);
      const delivery = await sendTelegram(config, { rich, html, text: notification });
      sent = true;
      message = delivery.rejection
        ? `Notification sent as ${delivery.format} (${status}). Telegram rejected the rich message: ${delivery.rejection}`
        : `Notification sent (${status}).`;
    } catch (error) {
      message = `Notification failed: ${(error as Error).message}`;
    }
    // Durable thread receipt, outside model context, without starting another turn.
    pi.appendEntry<NotificationReceipt>(ENTRY_TYPE, {
      sent,
      message,
      notification,
      timestamp: Date.now(),
    });
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    setFooterEnabled(false);
  });
}
