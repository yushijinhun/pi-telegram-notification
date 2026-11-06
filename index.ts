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

  function notificationContent(
    ctx: ExtensionContext,
    status: string,
    response: AssistantMessage | undefined,
  ): NotificationContent {
    const detail = status === "error"
      ? response?.errorMessage || "The agent stopped with an error."
      : response?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
    const name = ctx.sessionManager.getSessionName() || ctx.sessionManager.getSessionId().slice(0, 8);
    return {
      host: hostname(),
      status,
      session: name,
      cwd: ctx.cwd,
      detail,
      markdown: status !== "error",
    };
  }

  async function deliver(content: NotificationContent): Promise<void> {
    const { text: notification, html } = formatNotification(content);
    let sent = false;
    let message: string;
    try {
      const config = await readTelegramConfig(configPath);
      const rich = await formatRichMessage(content);
      const delivery = await sendTelegram(config, { rich, html, text: notification });
      sent = true;
      message = delivery.rejection
        ? `Notification sent as ${delivery.format} (${content.status}). Telegram rejected the rich message: ${delivery.rejection}`
        : `Notification sent (${content.status}).`;
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
  }

  pi.registerCommand("notify", {
    description: "Toggle Telegram notifications: /notify [on|off] (default off). /notify last sends the last response.",
    getArgumentCompletions: (prefix) => ["on", "off", "last"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument && argument !== "on" && argument !== "off" && argument !== "last") {
        ctx.ui.notify("Usage: /notify [on|off|last]", "error");
        return;
      }

      if (argument === "last") {
        // Commands run while the agent works. Its latest message is not a final response yet.
        if (!ctx.isIdle()) {
          ctx.ui.notify("Pi is still working. Use /notify on to be notified when it stops.", "error");
          return;
        }
        // Read the session, so this also works after /reload, /resume, and /tree.
        const response = ctx.sessionManager.getBranch()
          .flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [])
          .at(-1);
        if (!response) {
          ctx.ui.notify("No response to send.", "error");
          return;
        }
        const status = response.stopReason === "error" || response.stopReason === "aborted"
          ? response.stopReason
          // The run stopped before the requested tools returned.
          : response.stopReason === "toolUse" ? "aborted" : "completed";
        await deliver(notificationContent(ctx, status, response));
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
    await deliver(notificationContent(ctx, status, lastAssistant));
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    setFooterEnabled(false);
  });
}
