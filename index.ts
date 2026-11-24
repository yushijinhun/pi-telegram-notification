import { execFile } from "node:child_process";
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
import { readTelegramConfig } from "./src/config.ts";
import { installNotificationFooter } from "./src/footer.ts";
import { formatNotification, type NotificationContent } from "./src/format.ts";
import { RemoteClient } from "./src/remote/client.ts";
import { appendLinks, type MessageLink } from "./src/remote/links.ts";
import { promptLine } from "./src/remote/prompt.ts";
import {
  linksPath,
  PROTOCOL_VERSION,
  socketPath,
  type DaemonMessage,
  type Hello,
  type ModelChoice,
  type Request,
  type SessionInfo,
  type SessionState,
} from "./src/remote/protocol.ts";
import { formatRichMessage } from "./src/rich.ts";
import { sendTelegram } from "./src/telegram.ts";

const ENTRY_TYPE = "telegram-notification";
/** How long a prompt from Telegram may take to start a run before it counts as failed. */
const RUN_START_MS = 10_000;
/** How long a prompt from Telegram waits for compaction to finish. */
const COMPACTION_WAIT_MS = 10 * 60_000;
/** Only a command handler can reload Pi, so /reload from Telegram runs this command. */
const RELOAD_COMMAND = "telegram-reload";

/** Press Enter in a WezTerm pane, such as this session's own. */
function pressEnter(pane: string): Promise<void> {
  const wezterm = process.env.PI_TELEGRAM_WEZTERM ?? "wezterm";
  return new Promise((resolve, reject) => {
    execFile(wezterm, ["cli", "send-text", "--pane-id", pane, "--no-paste", "\r"], { timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

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

  // Remote control through the daemon (daemon.ts).
  /** The current session, from session_start until session_shutdown. */
  let current: ExtensionContext | undefined;
  let remote: RemoteClient | undefined;
  let state: SessionState = "idle";
  /** The daemon reports that the screen is locked. Every run then notifies. */
  let away = false;
  /** The Telegram message that the current run's answer replies to. */
  let replyTo: number | undefined;
  /**
   * A prompt from Telegram, sent while idle, whose run has not started yet.
   * request is the daemon's request, answered once Pi takes the prompt or fails to.
   */
  /** /reload came from Telegram while Pi was working. */
  let reloadWhenIdle = false;
  let expected: {
    replyTo: number;
    request?: string;
    /** Pi took the prompt, and may compact before the run starts. */
    busy: boolean;
    deadline: number;
    timer: NodeJS.Timeout;
  } | undefined;

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

  function sessionInfo(ctx: ExtensionContext): SessionInfo {
    return {
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      name: ctx.sessionManager.getSessionName(),
      cwd: ctx.cwd,
      firstPrompt: firstPrompt(ctx),
    };
  }

  /**
   * The session's first user message, on one line and shortened. The daemon shows it in /ls,
   * where sessions of the same directory would otherwise have the same name.
   */
  function firstPrompt(ctx: ExtensionContext): string | undefined {
    const entry = ctx.sessionManager.getEntries()
      .find((item) => item.type === "message" && item.message.role === "user");
    if (!entry || entry.type !== "message" || entry.message.role !== "user") return undefined;
    return promptLine(entry.message.content);
  }

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
      status,
      session: name,
      cwd: ctx.cwd,
      detail,
      markdown: status !== "error",
    };
  }

  /** Send a notification. Returns the error, or undefined when it was sent. */
  async function deliver(
    ctx: ExtensionContext,
    content: NotificationContent,
    replyTarget?: number,
  ): Promise<string | undefined> {
    const { text: notification, html } = formatNotification(content);
    let sent = false;
    let message: string;
    try {
      const config = await readTelegramConfig(configPath);
      const rich = await formatRichMessage(content);
      const delivery = await sendTelegram(config, { rich, html, text: notification }, replyTarget);
      sent = true;
      message = delivery.rejection
        ? `Notification sent as ${delivery.format} (${content.status}). Telegram rejected the rich message: ${delivery.rejection}`
        : `Notification sent (${content.status}).`;
      // A reply to the notification in Telegram reaches this session.
      const info = sessionInfo(ctx);
      const link: MessageLink = { message: delivery.messageId, session: info.id, file: info.file, cwd: info.cwd };
      await appendLinks(linksPath(), [link]).catch(() => {});
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
    return sent ? undefined : message;
  }

  /** The last response on the current branch, read from the session, so it survives /reload, /resume, and /tree. */
  function lastResponse(ctx: ExtensionContext): { status: string; response: AssistantMessage } | undefined {
    const response = ctx.sessionManager.getBranch()
      .flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [])
      .at(-1);
    if (!response) return undefined;
    const status = response.stopReason === "error" || response.stopReason === "aborted"
      ? response.stopReason
      // The run stopped before the requested tools returned.
      : response.stopReason === "toolUse" ? "aborted" : "completed";
    return { status, response };
  }

  pi.registerCommand(RELOAD_COMMAND, {
    description: "Reload extensions, skills, prompts, themes, and context files, like /reload. /reload from Telegram runs it.",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  function reload(): void {
    pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
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
        const last = lastResponse(ctx);
        if (!last) {
          ctx.ui.notify("No response to send.", "error");
          return;
        }
        await deliver(ctx, notificationContent(ctx, last.status, last.response));
        return;
      }

      try {
        await readTelegramConfig(configPath);
      } catch (error) {
        enabled = false;
        updateFooter(ctx);
        remote?.send({ type: "update", notify: enabled });
        ctx.ui.notify((error as Error).message, "error");
        return;
      }

      enabled = argument ? argument === "on" : !enabled;
      updateFooter(ctx);
      remote?.send({ type: "update", notify: enabled });
      ctx.ui.notify(`Telegram notifications ${enabled ? "on" : "off"}.`, "info");
    },
  });

  function setState(next: SessionState): void {
    if (state === next) return;
    state = next;
    // Include the session, so the first prompt reaches the daemon once Pi starts on it.
    remote?.send({ type: "update", state, session: current ? sessionInfo(current) : undefined });
  }

  function hello(ctx: ExtensionContext): Hello {
    return {
      type: "hello",
      version: PROTOCOL_VERSION,
      pid: process.pid,
      host: hostname(),
      pane: process.env.WEZTERM_PANE,
      session: sessionInfo(ctx),
      state,
      notify: enabled,
    };
  }

  /**
   * Wait for the run of a prompt from Telegram. pi.sendUserMessage() reports no errors,
   * such as a missing API key, to the extension, so a prompt that leaves Pi idle has failed.
   */
  function expectRun(ctx: ExtensionContext, target: number, request?: string): void {
    clearExpected({ ok: false, message: "Another message from Telegram came first." });
    const timer = setInterval(() => {
      const waiting = expected;
      if (waiting?.timer !== timer) {
        clearInterval(timer);
        return;
      }
      let idle: boolean;
      try {
        idle = ctx.isIdle();
      } catch {
        // The session was replaced or closed.
        clearExpected();
        return;
      }
      if (!idle) {
        waiting.busy = true;
        if (waiting.request) answer(waiting.request, true);
        waiting.request = undefined;
      } else if (waiting.busy) {
        // The run ended before it started, for example when compaction failed.
        clearExpected();
      } else if (Date.now() > waiting.deadline) {
        clearExpected({
          ok: false,
          message: "Pi did not start working on this message. Look at the session on the computer: " +
            "for example, its model may have no API key.",
        });
      }
    }, 100);
    timer.unref();
    expected = { replyTo: target, request, busy: false, deadline: Date.now() + RUN_START_MS, timer };
  }

  /** Stop waiting for the run, and give the daemon the result, if it still waits. */
  function clearExpected(result?: { ok: boolean; message?: string }): void {
    if (!expected) return;
    clearInterval(expected.timer);
    if (expected.request && result) answer(expected.request, result.ok, result.message);
    expected = undefined;
  }

  function answer(id: string, ok: boolean, message?: string, models?: ModelChoice[]): void {
    remote?.send({
      type: "result",
      id,
      ok,
      ...(message ? { message } : {}),
      ...(models ? { models } : {}),
    });
  }

  /** Models the session can use, the same set Pi's /model picker offers. */
  function modelChoices(ctx: ExtensionContext): ModelChoice[] {
    const scoped = ctx.scopedModels.map((entry) => entry.model);
    const seen = new Set<string>();
    const choices: ModelChoice[] = [];
    for (const model of scoped.length ? scoped : ctx.modelRegistry.getAvailable()) {
      const key = `${model.provider}\0${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push({
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...(ctx.model?.provider === model.provider && ctx.model.id === model.id ? { current: true } : {}),
      });
    }
    return choices;
  }

  function modelLabel(ctx: ExtensionContext): string {
    return `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"} (${pi.getThinkingLevel()})`;
  }

  /**
   * Submit text as if typed in this session's editor: set the editor text, then press Enter
   * through WezTerm, because extensions cannot submit the editor. Text already in the editor is
   * put back afterwards. Returns false if the editor kept the text.
   */
  async function typeIntoEditor(ctx: ExtensionContext, pane: string, text: string): Promise<boolean> {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText(text);
    try {
      await pressEnter(pane);
    } catch {
      ctx.ui.setEditorText(draft);
      return false;
    }
    // The editor clears when it submits.
    const submitted = await until(() => ctx.ui.getEditorText() !== text, 3_000);
    if (!submitted || (draft && !ctx.ui.getEditorText())) {
      ctx.ui.setEditorText(draft);
      // setEditorText does not redraw the screen. setStatus does.
      ctx.ui.setStatus(ENTRY_TYPE, undefined);
    }
    return submitted;
  }

  /** Idle, or streaming a run that can take a steering message. */
  function acceptsPrompt(ctx: ExtensionContext): boolean {
    return ctx.isIdle() || ctx.signal !== undefined;
  }

  /** Poll until check() is true. False on timeout, or when the session is gone. */
  async function until(check: () => boolean, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (check()) return true;
      } catch {
        return false;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200).unref());
    }
  }

  async function handleRequest(ctx: ExtensionContext, request: Request): Promise<void> {
    switch (request.type) {
      case "prompt": {
        let pending: string | undefined = request.id;
        // Pi rejects prompts while it compacts the conversation. It is then busy without streaming.
        if (!acceptsPrompt(ctx) && !(await until(() => acceptsPrompt(ctx), 2_000))) {
          answer(pending, true, "Pi is compacting the conversation. Your message goes in when that finishes.");
          pending = undefined;
          await until(() => acceptsPrompt(ctx), COMPACTION_WAIT_MS);
        }
        if (ctx.isIdle()) {
          expectRun(ctx, request.replyTo, pending);
          pi.sendUserMessage(request.text);
        } else {
          // The running task takes the message, like Enter in the editor, and its answer replies to it.
          replyTo = request.replyTo;
          pi.sendUserMessage(request.text, { deliverAs: "steer" });
          if (pending) {
            answer(pending, true, state === "waiting"
              ? "Queued. Pi is waiting for an answer in a dialog on the computer."
              : undefined);
          }
        }
        return;
      }

      case "command": {
        const [, name = "", args = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(request.text) ?? [];
        if (name === "reload") {
          // The answer goes out before the reload closes the connection.
          if (ctx.isIdle()) {
            answer(request.id, true, "Reloading.");
            reload();
          } else {
            reloadWhenIdle = true;
            answer(request.id, true, "Pi reloads when it stops working.");
          }
          return;
        }
        // Built-in commands such as /model only run from the editor, so type the command there,
        // the same as at the computer. This runs every command, while idle or working.
        const pane = process.env.WEZTERM_PANE;
        if (pane) {
          const model = modelLabel(ctx);
          if (ctx.isIdle()) expectRun(ctx, request.replyTo);
          if (!(await typeIntoEditor(ctx, pane, request.text))) {
            clearExpected();
            answer(request.id, false, `Pi's editor did not take /${name}.`);
            return;
          }
          // /model switches after the editor clears, so look for a change for a moment.
          await until(() => modelLabel(ctx) !== model, 2_000);
          const changed = modelLabel(ctx) !== model ? ` Model: ${modelLabel(ctx)}.` : "";
          answer(request.id, true, `Ran /${name} on the computer.${changed}`);
          return;
        }

        // Without WezTerm, run what the extension API can. Queued text would reach the model
        // as a plain message, so the session must be idle.
        if (!ctx.isIdle()) {
          answer(request.id, false, "Pi is working. Stop it or wait, then send the command again.");
          return;
        }
        if (name === "compact") {
          ctx.compact(args.trim() ? { customInstructions: args.trim() } : undefined);
          answer(request.id, true, "Compacting.");
          return;
        }
        const found = pi.getCommands().find((command) => command.name === name);
        if (!found) {
          answer(request.id, false, `/${name} only runs from Pi's editor, and this session does not run in WezTerm, ` +
            "so it cannot be typed there.");
          return;
        }
        // A skill or prompt template starts a run, whose answer replies in Telegram.
        if (found.source !== "extension") expectRun(ctx, request.replyTo);
        pi.sendUserMessage(request.text, { expandPromptTemplates: true });
        answer(request.id, true);
        return;
      }

      case "models": {
        const models = modelChoices(ctx);
        answer(request.id, models.length > 0, models.length ? undefined : "No model has credentials configured.", models);
        return;
      }

      case "model": {
        const model = ctx.modelRegistry.find(request.provider, request.modelId);
        if (!model) {
          answer(request.id, false, "That model is not available.");
          return;
        }
        const ok = await pi.setModel(model);
        answer(request.id, ok, ok
          ? `Model: ${modelLabel(ctx)}.`
          : `${model.provider}/${model.id} has no credentials configured.`);
        return;
      }

      case "stop":
        if (ctx.isIdle()) {
          answer(request.id, true, "Pi is not working.");
          return;
        }
        clearExpected({ ok: true });
        ctx.abort();
        answer(request.id, true);
        return;

      case "notify":
        if (request.enabled) await readTelegramConfig(configPath);
        enabled = request.enabled;
        updateFooter(ctx);
        remote?.send({ type: "update", notify: enabled });
        answer(request.id, true);
        return;

      case "last": {
        if (!ctx.isIdle()) {
          answer(request.id, false, "Pi is still working.");
          return;
        }
        const last = lastResponse(ctx);
        if (!last) {
          answer(request.id, false, "No response to send.");
          return;
        }
        const failure = await deliver(ctx, notificationContent(ctx, last.status, last.response), request.replyTo);
        answer(request.id, !failure, failure);
        return;
      }
    }
  }

  async function onDaemonMessage(message: DaemonMessage): Promise<void> {
    if (message.type === "away") {
      away = message.away;
      return;
    }
    const ctx = current;
    if (!ctx) {
      answer(message.id, false, "The session is closing.");
      return;
    }
    try {
      await handleRequest(ctx, message);
    } catch (error) {
      answer(message.id, false, (error as Error).message);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    lastAssistant = undefined;
    outcome = undefined;
    away = false;
    replyTo = undefined;
    clearExpected();
    state = ctx.isIdle() ? "idle" : "working";
    current = ctx;
    updateFooter(ctx);

    remote?.close();
    remote = undefined;
    // Only interactive sessions take messages from Telegram, not `pi -p` or RPC subprocesses.
    if (ctx.mode === "tui") {
      remote = new RemoteClient({
        path: socketPath(),
        hello: () => hello(ctx),
        onMessage: (message) => { void onDaemonMessage(message); },
      });
      remote.start();
    }
  });

  pi.on("session_info_changed", (_event, ctx) => {
    remote?.send({ type: "update", session: sessionInfo(ctx) });
  });

  // A prompt typed on the computer replaces one from Telegram that has not started.
  pi.on("input", (event) => {
    if (event.source === "interactive") clearExpected({ ok: false, message: "A prompt typed on the computer came first." });
  });

  pi.on("before_agent_start", () => {
    lastAssistant = undefined;
    outcome = undefined;
  });

  pi.on("agent_start", () => {
    if (expected) {
      replyTo = expected.replyTo;
      clearExpected({ ok: true });
    }
    setState("working");
  });

  pi.on("ui_prompt_start", () => {
    setState("waiting");
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    setState(ctx.isIdle() ? "idle" : "working");
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistant = event.message;
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });

  // agent_end can be followed by retries, compaction, or queued follow-ups.
  pi.on("agent_settled", async (event, ctx) => {
    const target = replyTo;
    replyTo = undefined;
    setState("idle");
    // A run started from Telegram answers there, even with notifications off.
    if (enabled || away || target !== undefined) {
      const status = event.aborted || lastAssistant?.stopReason === "aborted"
        ? "aborted"
        : outcome ?? (lastAssistant?.stopReason === "error" ? "error" : "stopped");
      await deliver(ctx, notificationContent(ctx, status, lastAssistant), target);
    }
    // Sent from agent_settled, the command runs once every settled handler has finished.
    if (reloadWhenIdle) {
      reloadWhenIdle = false;
      reload();
    }
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    setFooterEnabled(false);
    clearExpected();
    remote?.close();
    remote = undefined;
    current = undefined;
  });
}
