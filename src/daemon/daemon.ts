import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { callTelegram, downloadTelegramFile, TelegramError } from "../api.ts";
import type { RemoteSettings, TelegramConfig } from "../config.ts";
import { LinkIndex, type MessageLink } from "../remote/links.ts";
import { readActivity, type Activity } from "./activity.ts";
import { watchScreenLock } from "./away.ts";
import { findSessionFile, isDirectory, matchDirectory, readSessionHeader, recentDirectories, tildify } from "./dirs.ts";
import { attachmentsOf, composePrompt, saveAttachments } from "./files.ts";
import { SessionHub, type LiveSession } from "./hub.ts";
import { spawnPi, type SpawnCommands } from "./spawn.ts";
import type { TgButton, TgCallbackQuery, TgChat, TgMessage, TgMessageReaction, TgUpdate } from "./types.ts";

/** Telegram sends each item of an album as its own message, close together. */
const ALBUM_WAIT_MS = 1_500;
/** How long buttons that hold a message keep working. */
const PENDING_MS = 60 * 60 * 1000;
/** How long a Pi opened in WezTerm may take to connect. */
const CONNECT_TIMEOUT_MS = 45_000;
const MAX_CHOICES = 8;
/** Summarizing asks a model, through the session, so it takes longer than a button round trip. */
const SUMMARY_TIMEOUT_MS = 120_000;

export interface DaemonOptions {
  telegram: TelegramConfig;
  remote: RemoteSettings;
  socket: string;
  /** Holds the update offset and the files sent from Telegram. */
  dataDir: string;
  linksPath: string;
  sessionsDir: string;
  commands: SpawnCommands;
  log?: (message: string) => void;
}

/** A message that waits for a button. */
type Pending =
  | { kind: "route"; message: number; prompt: string; sessions: string[]; created: number }
  | { kind: "new"; message: number; prompt: string; dirs: string[]; created: number }
  | { kind: "stale"; message: TgMessage; created: number };

type SendOptions = {
  keyboard?: TgButton[][];
  html?: boolean;
  /** Link the sent message to this session, so a reply to it reaches the session. */
  session?: LiveSession;
};

/**
 * The only process that polls the bot. It routes Telegram messages to Pi sessions
 * over a Unix socket, and opens new sessions in WezTerm.
 */
export class Daemon {
  private readonly options: DaemonOptions;
  private readonly hub = new SessionHub();
  private readonly links: LinkIndex;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<string, Pending>();
  private readonly albums = new Map<string, { messages: TgMessage[]; timer: NodeJS.Timeout }>();
  /** /ls entries, whose text shows the session's state. */
  private readonly entries = new Set<number>();
  /** /dashboard snapshots: a reaction to one of these refreshes it in place. */
  private readonly dashboards = new Set<number>();
  /** When an update from each stranger was last logged. */
  private readonly ignored = new Map<string, number>();
  private readonly halt = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private offset = 0;
  private polling: Promise<void> | undefined;
  private stopWatching: (() => void) | undefined;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.links = new LinkIndex(options.linksPath);
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Connected sessions. */
  sessions(): LiveSession[] {
    return this.hub.sessions();
  }

  async start(): Promise<void> {
    const owner = this.options.remote.userId;
    if (!owner) {
      throw new Error("Set remote.userId in telegram-notification.json to your Telegram user ID. Only that user can control Pi.");
    }
    // The daemon answers in chatId, so it must be the owner's private chat, whose ID is the user ID.
    if (this.options.telegram.chatId !== owner) {
      throw new Error(`chatId must be ${owner}, the private chat with remote.userId, so that the bot answers only that user.`);
    }
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    this.offset = await this.readOffset();
    await this.links.prune();
    await this.hub.listen(this.options.socket);
    void this.setCommands();
    if (this.options.remote.awayOnLock) {
      this.stopWatching = watchScreenLock((locked) => this.hub.setAway(locked), this.log);
    }
    this.polling = this.poll();
  }

  async stop(): Promise<void> {
    this.halt.abort();
    this.stopWatching?.();
    for (const album of this.albums.values()) clearTimeout(album.timer);
    await this.polling;
    await this.queue;
    await this.hub.close();
  }

  // Telegram updates

  private async poll(): Promise<void> {
    let delay = 0;
    while (!this.halt.signal.aborted) {
      if (delay) {
        try {
          await sleep(delay, undefined, { signal: this.halt.signal });
        } catch {
          break;
        }
      }
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query", "message_reaction"],
        }, 70_000);
        delay = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.accept(update);
        }
        if (updates.length) await this.writeOffset();
      } catch (error) {
        if (this.halt.signal.aborted) break;
        if (error instanceof TelegramError && error.status === 409) {
          // Another process polls this bot. Telegram allows one.
          delay = 30_000;
        } else if (error instanceof TelegramError && error.retryAfter) {
          delay = error.retryAfter * 1000;
        } else {
          delay = Math.min(Math.max(delay * 2, 2_000), 60_000);
        }
        this.log(`Cannot get Telegram updates: ${errorText(error)}`);
      }
    }
  }

  /**
   * The only way in from Telegram. getUpdates asks for nothing but messages and button presses,
   * and only the owner's reach Pi. Others get no answer at all.
   */
  private accept(update: TgUpdate): void {
    const { message, callback_query: query, message_reaction: reaction } = update;
    if (message) {
      if (!this.sentByOwner(message)) {
        this.ignore("message", message.from?.id, message.chat?.id);
        return;
      }
      if (message.media_group_id) this.collect(message.media_group_id, message);
      else this.enqueue(() => this.onMessage(message));
    } else if (query) {
      if (!this.pressedByOwner(query)) {
        this.ignore("button press", query.from?.id, query.message?.chat?.id);
        return;
      }
      this.enqueue(() => this.onCallback(query));
    } else if (reaction) {
      if (!this.reactedByOwner(reaction)) {
        this.ignore("reaction", reaction.user?.id, reaction.chat?.id);
        return;
      }
      this.enqueue(() => this.onReaction(reaction));
    }
  }

  /** A reaction of the owner in the owner's private chat with the bot. */
  private reactedByOwner(reaction: TgMessageReaction): boolean {
    return this.ownersChat(reaction.chat)
      && String(reaction.user?.id) === this.options.remote.userId
      && !reaction.user?.is_bot;
  }

  /** Sent by the owner, in the owner's private chat with the bot. */
  private sentByOwner(message: TgMessage): boolean {
    const owner = this.options.remote.userId;
    return this.ownersChat(message.chat)
      && String(message.from?.id) === owner
      && !message.from?.is_bot
      // Messages on behalf of a chat, of a business account, or to the bot as a guest elsewhere.
      && !message.sender_chat
      && !message.business_connection_id
      && !message.guest_query_id;
  }

  /** Pressed by the owner, on a message in the owner's private chat. Inline-mode messages have none. */
  private pressedByOwner(query: TgCallbackQuery): boolean {
    return String(query.from?.id) === this.options.remote.userId && this.ownersChat(query.message?.chat);
  }

  private ownersChat(chat: TgChat | undefined): boolean {
    return chat?.type === "private" && String(chat.id) === this.options.remote.userId;
  }

  /** Log updates from others, at most once a minute for each sender and chat. */
  private ignore(kind: string, from: number | undefined, chat: number | undefined): void {
    const key = `${from}:${chat}`;
    const now = Date.now();
    if (now - (this.ignored.get(key) ?? 0) < 60_000) return;
    if (this.ignored.size >= 1000) this.ignored.clear();
    this.ignored.set(key, now);
    this.log(`Ignored a ${kind} from user ${from ?? "unknown"} in chat ${chat ?? "unknown"}. Only user ${this.options.remote.userId} can use this bot.`);
  }

  /** Gather an album's messages into one. */
  private collect(group: string, message: TgMessage): void {
    const messages = [...(this.albums.get(group)?.messages ?? []), message];
    clearTimeout(this.albums.get(group)?.timer);
    const timer = setTimeout(() => {
      this.albums.delete(group);
      messages.sort((a, b) => a.message_id - b.message_id);
      const first = messages[0];
      const merged: TgMessage = {
        ...first,
        caption: messages.find((item) => item.caption)?.caption,
        reply_to_message: messages.find((item) => item.reply_to_message)?.reply_to_message,
        quote: messages.find((item) => item.quote)?.quote,
        album: messages,
      };
      this.enqueue(() => this.onMessage(merged));
    }, ALBUM_WAIT_MS);
    this.albums.set(group, { messages, timer });
  }

  /** Handle one update at a time, in order. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => this.log(`Cannot handle a Telegram update: ${errorText(error)}`));
  }

  // Messages

  private async onMessage(message: TgMessage, confirmed = false): Promise<void> {
    const id = message.message_id;
    if (!confirmed && Date.now() / 1000 - message.date > this.options.remote.staleMinutes * 60) {
      const key = this.remember({ kind: "stale", message, created: Date.now() });
      await this.say(id, `This message reached the computer ${age(message.date)} after you sent it. Send it to Pi now?`, {
        keyboard: [[button("Send", `y:${key}`), button("Discard", `z:${key}`)]],
      });
      return;
    }

    const text = message.text ?? message.caption ?? "";
    const command = parseCommand(text);
    const name = command?.name.toLowerCase();
    if (name === "start" || name === "help") return this.help(id);
    if (name === "ls") return this.list();
    if (name === "dashboard" || name === "d") return this.dashboard();

    const replied = message.reply_to_message?.message_id;
    const link = replied === undefined ? undefined : await this.links.lookup(replied);
    if (replied !== undefined && !link) {
      await this.say(id, "I don't know which Pi session that message belongs to. Reply to a notification or to an entry of /ls.");
      return;
    }
    if (command && name === "new") return this.newSession(message, command.args, link);
    if (name === "stop") return this.stopCommand(id, link);
    if (name === "reload") return this.reloadCommand(id, link);
    if (command) {
      if (!link) {
        await this.say(id, `To run /${command.name} in a session, send it as a reply to a message from that session. /help lists this bot's commands.`);
        return;
      }
      return this.forward(id, link, "command", `/${command.name}${command.args ? ` ${command.args}` : ""}`);
    }

    const prompt = await this.promptOf(message, text);
    if (!prompt) {
      await this.say(id, "Pi can't use this kind of message. Send text or files.");
      return;
    }
    if (link) return this.forward(id, link, "prompt", prompt);
    return this.chooseSession(id, prompt);
  }

  private async help(messageId: number): Promise<void> {
    const lines = [
      "Reply to a message about a session to send that session a prompt. If the session is closed, it opens again in a new WezTerm tab.",
      "Photos, files, voice messages and other attachments are saved on the computer, and Pi gets their paths.",
      "A message that is not a reply asks which session it is for.",
      "A command sent as a reply, such as /model or /notify on, runs in that session as if typed on the computer.",
      "",
      "/ls – running sessions, with buttons for the last answer, stopping, and notifications",
      "/dashboard – what each session is doing right now, where it is stuck, and for how long (alias /d). React to one of its messages with any emoji to refresh it.",
      "/new [directory] [prompt] – start a session. The directory can be the start of a project's name. As a reply, it starts in that session's directory.",
      "/stop – stop the session you reply to, or the only one working",
      "/reload – reload the session you reply to, or every session. A working session reloads when it stops.",
    ];
    if (this.options.remote.awayOnLock) lines.push("", "While the screen is locked, every session notifies when it stops.");
    await this.say(messageId, lines.join("\n"));
  }

  private async list(): Promise<void> {
    const sessions = this.hub.sessions();
    if (!sessions.length) {
      await this.say(undefined, "No Pi session is running. Send /new to start one.");
      return;
    }
    for (const live of sessions) {
      const sent = await this.say(undefined, describe(live), { html: true, keyboard: sessionKeyboard(live), session: live });
      if (sent !== undefined) this.entries.add(sent);
    }
    // Keep the newest entries. Older ones only lose their updated text.
    for (const old of this.entries) {
      if (this.entries.size <= 500) break;
      this.entries.delete(old);
    }
  }

  /**
   * One message per running session: the tool it is inside, the last things it
   * said, and how long ago anything happened. Read from the session files, so a
   * session in a long tool call still answers, and nothing is asked of the agent.
   */
  private async dashboard(): Promise<void> {
    const sessions = this.hub.sessions();
    if (!sessions.length) {
      await this.say(undefined, "No Pi session is running. Send /new to start one.");
      return;
    }
    for (const live of sessions) {
      const activity = await this.activityOf(live);
      const sent = await this.say(undefined, describeActivity(live, activity), { html: true, keyboard: dashboardKeyboard(live), session: live });
      if (sent === undefined) continue;
      this.dashboards.add(sent);
      for (const old of this.dashboards) {
        if (this.dashboards.size <= 200) break;
        this.dashboards.delete(old);
      }
    }
  }

  /** The activity of one session, or undefined when it has no session file yet. */
  private async activityOf(live: LiveSession): Promise<Activity | undefined> {
    const file = live.session.file ?? await findSessionFile(this.options.sessionsDir, live.session.id);
    return file ? readActivity(file) : undefined;
  }


  /** Save the attachments and build the prompt. Empty when the message has nothing for Pi. */
  private async promptOf(message: TgMessage, text: string): Promise<string> {
    const attachments = attachmentsOf(message);
    const { saved, failed } = attachments.length
      ? await saveAttachments(join(this.options.dataDir, "files"), attachments, (fileId) => this.download(fileId))
      : { saved: [], failed: [] };
    return composePrompt(text, message.quote?.text, saved, failed);
  }

  private async download(fileId: string): Promise<{ data: Uint8Array; filePath: string }> {
    const file = await this.api<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram gave no download path");
    const data = await downloadTelegramFile(this.options.telegram.botToken, file.file_path, this.halt.signal);
    return { data, filePath: file.file_path };
  }

  /** Send a prompt or command to the linked session, opening it again if it is closed. */
  private async forward(messageId: number, link: MessageLink, type: "prompt" | "command", text: string): Promise<void> {
    let live: LiveSession;
    try {
      live = await this.open(link, messageId);
    } catch (error) {
      await this.say(messageId, `Cannot open that session: ${errorText(error)}`);
      return;
    }
    await this.deliver(live, messageId, type, text);
  }

  private async deliver(live: LiveSession, messageId: number, type: "prompt" | "command", text: string): Promise<void> {
    await this.links.add([linkTo(messageId, live)]);
    const result = await this.hub.request(live, { type, text, replyTo: messageId });
    if (result.ok) await this.react(messageId, "👀");
    if (!result.ok || result.message) {
      await this.say(messageId, result.message ?? "Pi did not take the message.", { session: live });
    }
  }

  private async open(link: MessageLink, messageId: number): Promise<LiveSession> {
    const live = this.hub.find(link.session);
    if (live) return live;
    const file = link.file && existsSync(link.file)
      ? link.file
      : await findSessionFile(this.options.sessionsDir, link.session);
    if (!file) throw new Error("it is not running, and it has no session file to open.");
    const cwd = (await readSessionHeader(file))?.cwd ?? link.cwd;
    if (!cwd || !isDirectory(cwd)) throw new Error(`it is not running, and its directory ${cwd ?? ""} is gone.`);
    const reopened = await this.launch(cwd, ["--session", file]);
    await this.say(messageId, `Opened ${label(reopened)} again in a new WezTerm tab.`, { session: reopened });
    return reopened;
  }

  /** Start Pi in WezTerm and wait until it connects. */
  private async launch(cwd: string, args: string[]): Promise<LiveSession> {
    const pane = await spawnPi(this.options.commands, cwd, args);
    this.log(`Started Pi in WezTerm pane ${pane}, in ${cwd}.`);
    return this.hub.waitFor((live) => live.pane === pane, CONNECT_TIMEOUT_MS);
  }

  private async chooseSession(messageId: number, prompt: string): Promise<void> {
    const sessions = this.hub.sessions();
    if (!sessions.length) {
      await this.chooseDirectory(messageId, prompt, await this.directories(), "No Pi session is running. Start one in which directory?");
      return;
    }
    const key = this.remember({
      kind: "route",
      message: messageId,
      prompt,
      sessions: sessions.map((live) => live.session.id),
      created: Date.now(),
    });
    const keyboard = sessions.map((live, index) => [button(buttonLabel(live), `s:${key}:${index}`)]);
    keyboard.push([button("New session…", `n:${key}`)]);
    await this.say(messageId, "Send this to which session?", { keyboard });
  }

  private async chooseDirectory(messageId: number, prompt: string, dirs: string[], question: string, edit?: number): Promise<void> {
    if (!dirs.length) {
      await this.say(messageId, "I know no directories yet. Send /new with a path, such as /new ~/project.");
      return;
    }
    const choices = dirs.slice(0, MAX_CHOICES);
    const key = this.remember({ kind: "new", message: messageId, prompt, dirs: choices, created: Date.now() });
    const keyboard = choices.map((dir, index) => [button(tildify(dir), `d:${key}:${index}`)]);
    if (edit === undefined) await this.say(messageId, question, { keyboard });
    else await this.edit(edit, question, { keyboard });
  }

  /** Working directories of running sessions, then of past sessions. */
  private async directories(): Promise<string[]> {
    const running = this.hub.sessions().map((live) => live.session.cwd).reverse();
    const recent = await recentDirectories(this.options.sessionsDir);
    return [...new Set([...running, ...recent])].filter(isDirectory);
  }

  private async newSession(message: TgMessage, args: string, link: MessageLink | undefined): Promise<void> {
    const id = message.message_id;
    if (link) {
      const cwd = this.hub.find(link.session)?.session.cwd ?? link.cwd;
      if (!cwd || !isDirectory(cwd)) {
        await this.say(id, "That session's directory is gone.");
        return;
      }
      return this.begin(id, cwd, await this.promptOf(message, args));
    }
    const [, word = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
    const dirs = await this.directories();
    const matches = word ? matchDirectory(word, dirs) : [];
    if (!matches.length && (word.startsWith("/") || word.startsWith("~"))) {
      await this.say(id, `${word} is not a directory.`);
      return;
    }
    const prompt = await this.promptOf(message, matches.length ? rest : args);
    if (matches.length === 1) return this.begin(id, matches[0], prompt);
    await this.chooseDirectory(id, prompt, matches.length ? matches : dirs, "Start a session in which directory?");
  }

  private async begin(messageId: number, cwd: string, prompt: string): Promise<void> {
    let live: LiveSession;
    try {
      live = await this.launch(cwd, []);
    } catch (error) {
      await this.say(messageId, `Cannot start Pi: ${errorText(error)}`);
      return;
    }
    const where = tildify(cwd);
    await this.say(messageId, prompt
      ? `Started a session in ${where}.`
      : `Started a session in ${where}. Reply to this message to send it a prompt.`, { session: live });
    if (prompt) await this.deliver(live, messageId, "prompt", prompt);
  }

  /** Reload one session, or all of them, for example after updating an extension. */
  private async reloadCommand(messageId: number, link: MessageLink | undefined): Promise<void> {
    if (link) {
      const live = this.hub.find(link.session);
      if (!live) {
        await this.say(messageId, "That session is not running.");
        return;
      }
      return this.deliver(live, messageId, "command", "/reload");
    }
    const sessions = this.hub.sessions();
    if (!sessions.length) {
      await this.say(messageId, "No Pi session is running.");
      return;
    }
    const lines: string[] = [];
    for (const live of sessions) {
      const result = await this.hub.request(live, { type: "command", text: "/reload", replyTo: messageId });
      lines.push(`${result.ok ? "✓" : "✗"} ${label(live)}: ${result.message ?? (result.ok ? "Reloading." : "Pi did not answer.")}`);
    }
    await this.say(messageId, lines.join("\n"));
  }

  private async stopCommand(messageId: number, link: MessageLink | undefined): Promise<void> {
    if (link) {
      const live = this.hub.find(link.session);
      if (!live) {
        await this.say(messageId, "That session is not running.");
        return;
      }
      return this.stopSession(live, messageId);
    }
    const working = this.hub.sessions().filter((live) => live.state !== "idle");
    if (!working.length) {
      await this.say(messageId, "No session is working.");
      return;
    }
    if (working.length === 1) return this.stopSession(working[0], messageId);
    const keyboard = working.map((live) => [button(buttonLabel(live), `x:${live.session.id}`)]);
    await this.say(messageId, "Stop which session?", { keyboard });
  }

  private async stopSession(live: LiveSession, messageId: number): Promise<void> {
    const result = await this.hub.request(live, { type: "stop" });
    if (result.ok && !result.message) await this.react(messageId, "👌");
    else await this.say(messageId, result.message ?? "Pi did not stop.", { session: live });
  }

  // Buttons

  private async onCallback(query: TgCallbackQuery): Promise<void> {
    const [action = "", key = "", index = "0"] = (query.data ?? "").split(":");
    const where = query.message?.message_id;
    if ("lxofap".includes(action) && action.length === 1) return this.onSessionButton(query, action, key);

    const pending = this.recall(key);
    if (!pending) {
      await this.answer(query.id, "This choice has expired.");
      if (where !== undefined) await this.edit(where, "This choice has expired.");
      return;
    }
    if (action === "s" && pending.kind === "route") {
      const live = this.hub.find(pending.sessions[Number(index)] ?? "");
      if (!live) {
        await this.answer(query.id, "That session has closed.");
        return;
      }
      this.pending.delete(key);
      await this.answer(query.id);
      if (where !== undefined) await this.edit(where, `Sent to ${label(live)}.`);
      await this.deliver(live, pending.message, "prompt", pending.prompt);
    } else if (action === "n" && pending.kind === "route") {
      this.pending.delete(key);
      await this.answer(query.id);
      await this.chooseDirectory(pending.message, pending.prompt, await this.directories(), "Start a session in which directory?", where);
    } else if (action === "d" && pending.kind === "new") {
      const dir = pending.dirs[Number(index)];
      if (!dir) return this.answer(query.id);
      this.pending.delete(key);
      await this.answer(query.id);
      if (where !== undefined) await this.edit(where, `Starting a session in ${tildify(dir)}…`);
      await this.begin(pending.message, dir, pending.prompt);
    } else if ((action === "y" || action === "z") && pending.kind === "stale") {
      this.pending.delete(key);
      await this.answer(query.id);
      if (where !== undefined) await this.edit(where, action === "y" ? "Sent to Pi." : "Discarded.");
      if (action === "y") await this.onMessage(pending.message, true);
    } else {
      await this.answer(query.id);
    }
  }

  /** Buttons of /ls entries and of the stop question. */
  private async onSessionButton(query: TgCallbackQuery, action: string, sessionId: string): Promise<void> {
    const live = this.hub.find(sessionId);
    if (!live) {
      await this.answer(query.id, "That session is not running.");
      return;
    }
    const where = query.message?.message_id;
    if (action === "a") {
      if (where === undefined) return this.answer(query.id, "This message is gone.");
      const activity = await this.activityOf(live);
      await this.edit(where, describeActivity(live, activity), { html: true, keyboard: dashboardKeyboard(live) });
      return this.answer(query.id, "Refreshed.");
    }
    if (action === "p") {
      // The session writes the summary and sends it, so this returns at once and
      // the queue is free for other Telegram messages while the model answers.
      await this.answer(query.id, "Asking for a summary…");
      void this.requestSummary(live, where);
      return;
    }
    const result = action === "l"
      ? await this.hub.request(live, { type: "last", replyTo: where ?? 0 })
      : action === "x"
        ? await this.hub.request(live, { type: "stop" })
        : await this.hub.request(live, { type: "notify", enabled: action === "o" });
    const done = action === "l" ? "Sent." : action === "x" ? "Stopping." : `Notifications ${action === "o" ? "on" : "off"}.`;
    await this.answer(query.id, result.message ?? (result.ok ? done : "Pi did not answer."));
    if (where === undefined || !result.ok) return;
    if (this.entries.has(where)) await this.edit(where, describe(live), { html: true, keyboard: sessionKeyboard(live) });
    else if (action === "x") await this.edit(where, `Stopping ${label(live)}.`);
  }

  /**
   * Any reaction to a /dashboard snapshot refreshes it: a tap is one update, so the
   * entry is rewritten in place with the fresh state. The reaction stays, and the
   * bot leaves the message otherwise untouched, so this costs no chat message.
   */
  private async onReaction(reaction: TgMessageReaction): Promise<void> {
    // Removing a reaction is not a request; adding or replacing one is.
    if (!reaction.new_reaction?.length) return;
    if (!this.dashboards.has(reaction.message_id)) return;
    const link = await this.links.lookup(reaction.message_id);
    const live = link ? this.hub.find(link.session) : undefined;
    if (!live) {
      await this.edit(reaction.message_id, "💤 That session is not running.");
      this.dashboards.delete(reaction.message_id);
      return;
    }
    const activity = await this.activityOf(live);
    await this.edit(reaction.message_id, describeActivity(live, activity), { html: true, keyboard: dashboardKeyboard(live) });
  }

  /** Ask the session for a status summary; the reply arrives as its own Telegram message. */
  private async requestSummary(live: LiveSession, replyTo: number | undefined): Promise<void> {
    try {
      const result = await this.hub.request(live, { type: "summary", replyTo: replyTo ?? 0 }, SUMMARY_TIMEOUT_MS);
      if (!result.ok) await this.say(replyTo, `No summary: ${result.message ?? "Pi did not answer."}`, { session: live });
    } catch (error) {
      await this.say(replyTo, `No summary: ${errorText(error)}`, { session: live });
    }
  }

  private remember(pending: Pending): string {
    const now = Date.now();
    for (const [key, old] of this.pending) if (now - old.created > PENDING_MS) this.pending.delete(key);
    const key = randomBytes(6).toString("base64url");
    this.pending.set(key, pending);
    return key;
  }

  private recall(key: string): Pending | undefined {
    const pending = this.pending.get(key);
    return pending && Date.now() - pending.created <= PENDING_MS ? pending : undefined;
  }

  // Bot API

  private api<T>(method: string, body: Record<string, unknown>, timeout?: number): Promise<T> {
    return callTelegram<T>(this.options.telegram.botToken, method, body, { timeout, signal: this.halt.signal });
  }

  /** Send a message, as a reply when replyTo is set. Returns its ID, or undefined if it failed. */
  private async say(replyTo: number | undefined, text: string, options: SendOptions = {}): Promise<number | undefined> {
    try {
      const sent = await this.api<TgMessage>("sendMessage", {
        chat_id: this.options.telegram.chatId,
        text,
        ...(options.html ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
        ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
      });
      if (options.session) await this.links.add([linkTo(sent.message_id, options.session)]);
      return sent.message_id;
    } catch (error) {
      this.log(`Cannot send a Telegram message: ${errorText(error)}`);
      return undefined;
    }
  }

  private async edit(messageId: number, text: string, options: Omit<SendOptions, "session"> = {}): Promise<void> {
    try {
      await this.api("editMessageText", {
        chat_id: this.options.telegram.chatId,
        message_id: messageId,
        text,
        ...(options.html ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
        ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
      });
    } catch (error) {
      // Editing to the same text fails, which is harmless.
      if (!errorText(error).includes("not modified")) this.log(`Cannot edit a Telegram message: ${errorText(error)}`);
    }
  }

  private async react(messageId: number, emoji: string): Promise<void> {
    try {
      await this.api("setMessageReaction", {
        chat_id: this.options.telegram.chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
    } catch (error) {
      this.log(`Cannot react to a Telegram message: ${errorText(error)}`);
    }
  }

  private async answer(queryId: string, text?: string): Promise<void> {
    try {
      await this.api("answerCallbackQuery", { callback_query_id: queryId, ...(text ? { text } : {}) });
    } catch (error) {
      this.log(`Cannot answer a button press: ${errorText(error)}`);
    }
  }

  private async setCommands(): Promise<void> {
    try {
      await this.api("setMyCommands", {
        commands: [
          { command: "ls", description: "Running Pi sessions" },
          { command: "new", description: "Start a session: /new [directory] [prompt]" },
          { command: "stop", description: "Stop the session you reply to" },
          { command: "reload", description: "Reload the session you reply to, or all sessions" },
          { command: "help", description: "How to talk to Pi here" },
        ],
        scope: { type: "chat", chat_id: this.options.telegram.chatId },
      });
    } catch (error) {
      this.log(`Cannot set the bot's commands: ${errorText(error)}`);
    }
  }

  // The update offset survives restarts, so a restart does not run messages twice.

  private async readOffset(): Promise<number> {
    try {
      const state = JSON.parse(await readFile(join(this.options.dataDir, "state.json"), "utf8")) as { offset?: number };
      return typeof state.offset === "number" ? state.offset : 0;
    } catch {
      return 0;
    }
  }

  private async writeOffset(): Promise<void> {
    await writeFile(join(this.options.dataDir, "state.json"), `${JSON.stringify({ offset: this.offset })}\n`, { mode: 0o600 });
  }
}

/** "/name args" or "/name@bot args". Command names of Pi may contain ":" and "-". */
function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([\w:.-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : undefined;
}

function button(text: string, data: string): TgButton {
  return { text, callback_data: data };
}

function linkTo(message: number, live: LiveSession): MessageLink {
  return { message, session: live.session.id, file: live.session.file, cwd: live.session.cwd };
}

function label(live: LiveSession): string {
  return live.session.name || `${basename(live.session.cwd) || live.session.cwd} (${live.session.id.slice(0, 8)})`;
}

function stateIcon(live: LiveSession): string {
  return live.state === "working" ? "⚙️" : live.state === "waiting" ? "❓" : "💤";
}

function buttonLabel(live: LiveSession): string {
  return `${stateIcon(live)} ${label(live)}`;
}

function describe(live: LiveSession): string {
  const state = live.state === "working"
    ? "Working"
    : live.state === "waiting" ? "Waiting for an answer on the computer" : "Idle";
  return [
    `${stateIcon(live)} <b>${escapeHtml(label(live))}</b>`,
    `<code>${escapeHtml(tildify(live.session.cwd))}</code>`,
    `${state} · notifications ${live.notify ? "on" : "off"}`,
  ].join("\n");
}

function sessionKeyboard(live: LiveSession): TgButton[][] {
  const id = live.session.id;
  const row = [button("Last answer", `l:${id}`)];
  if (live.state !== "idle") row.push(button("Stop", `x:${id}`));
  row.push(live.notify ? button("Notify off", `f:${id}`) : button("Notify on", `o:${id}`));
  return [row];
}

/** Buttons of a /dashboard entry: it is a snapshot, so it can be taken again. */
export function dashboardKeyboard(live: LiveSession): TgButton[][] {
  const id = live.session.id;
  const row = [button("Refresh", `a:${id}`), button("Summary", `p:${id}`), button("Last answer", `l:${id}`)];
  if (live.state !== "idle") row.push(button("Stop", `x:${id}`));
  return [row];
}

/**
 * One session as a few lines: state and how long it has been in it, the tool it
 * is inside with its command, the last things it said, and anything that looks
 * stuck. The last line is the tally, so a wrong answer is easy to spot.
 */
export function describeActivity(live: LiveSession, activity: Activity | undefined): string {
  const now = Date.now();
  const state = live.state === "working"
    ? `working ${duration(now - (activity?.turnStartedAt ?? live.since))}`
    : live.state === "waiting" ? "waiting for you on the computer" : `idle ${duration(now - live.since)}`;
  const lines = [
    `${stateIcon(live)} <b>${escapeHtml(label(live))}</b> · ${escapeHtml(state)}`,
    `<code>${escapeHtml(tildify(live.session.cwd))}</code>`,
  ];
  if (activity?.lastUser) lines.push(`you: <i>“${escapeHtml(activity.lastUser)}”</i>`);

  const running = activity?.running ?? [];
  for (const run of running) {
    const age = duration(now - run.since);
    const hint = run.hint ? ` · <code>${escapeHtml(run.hint)}</code>` : "";
    lines.push(`🛠 <b>${escapeHtml(run.tool)}</b>${hint} · ${age}${stuck(run, now)}`);
  }
  if (!running.length && activity?.lastTool) {
    const tool = activity.lastTool;
    lines.push(`${tool.ok ? "✅" : "❌"} ${escapeHtml(tool.tool)} ${duration(now - tool.at)} ago`);
  }

  const progress = activity?.progress ?? [];
  if (progress.length) {
    lines.push("", `<b>last said</b>`);
    for (const line of progress) lines.push(`· ${escapeHtml(line)}`);
  } else if (activity?.lastAssistant) {
    lines.push("", `· ${escapeHtml(activity.lastAssistant)}`);
  }

  const tally: string[] = [];
  if (activity) {
    if (activity.toolCalls) tally.push(`${activity.toolCalls} tool calls`);
    if (activity.errors) tally.push(`${activity.errors} failed`);
    if (activity.lastEventAt) tally.push(`last activity ${duration(now - activity.lastEventAt)} ago`);
    if (activity.model) tally.push(escapeHtml(activity.model));
  }
  if (tally.length) lines.push("", `<i>${tally.join(" · ")}</i>`);
  return lines.join("\n");
}

/** A warning for the two ways a session hangs: a tool that never returns, and silence. */
function stuck(run: { since: number }, now: number): string {
  const minutes = (now - run.since) / 60_000;
  return minutes >= 10 ? ` ⚠️ ${Math.round(minutes)} min in this tool` : "";
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function age(date: number): string {
  const minutes = Math.round((Date.now() / 1000 - date) / 60);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch reports "fetch failed" and keeps the reason, such as ENOTFOUND, in the cause.
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
