import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { readRemoteSettings } from "../src/config.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import { RemoteClient } from "../src/remote/client.ts";
import { PROTOCOL_VERSION, type DaemonMessage } from "../src/remote/protocol.ts";

const TOKEN = "123456:remote_test";
const CHAT = 4242;
// Requests that the fake does not answer fail here, instead of reaching Telegram.
const API = "http://127.0.0.1:9";
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

interface Call {
  method: string;
  body: Record<string, any>;
  /** The message_id that the fake gave a sent message. */
  id?: number;
}

/** A fake Bot API: queued updates for getUpdates, recorded calls, and files to download. */
class FakeTelegram {
  readonly calls: Call[] = [];
  readonly files = new Map<string, { path: string; data: Uint8Array<ArrayBuffer> }>();
  private readonly updates: Array<Record<string, unknown>> = [];
  private nextUpdate = 1;
  private nextBotMessage = 1000;
  private nextUserMessage = 1;
  private wake: (() => void) | undefined;

  /** Queue a message from the user and return its message_id. */
  send(fields: Record<string, unknown>): number {
    const id = this.nextUserMessage++;
    const message = { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: { id: CHAT }, ...fields };
    this.updates.push({ update_id: this.nextUpdate++, message });
    this.wake?.();
    return id;
  }

  press(data: string, messageId: number, fields: Record<string, unknown> = {}): void {
    const message = { message_id: messageId, date: 0, chat: { id: CHAT, type: "private" } };
    this.push({ callback_query: { id: `q${this.nextUpdate}`, from: { id: CHAT }, message, data, ...fields } });
  }

  /** Queue any update. */
  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
    this.wake?.();
  }

  sent(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const filePrefix = `${API}/file/bot${TOKEN}/`;
    if (url.startsWith(filePrefix)) {
      const file = [...this.files.values()].find((item) => item.path === url.slice(filePrefix.length));
      return file ? new Response(file.data) : new Response("not found", { status: 404 });
    }
    const method = url.slice(`${API}/bot${TOKEN}/`.length);
    let body: Record<string, any>;
    if (init?.body instanceof FormData) {
      body = Object.fromEntries([...init.body.entries()].map(([key, value]) => {
        if (typeof value !== "string") return [key, value];
        try {
          return [key, JSON.parse(value)];
        } catch {
          return [key, value];
        }
      }));
    } else {
      body = JSON.parse(String(init?.body ?? "{}"));
    }

    if (method === "getUpdates") {
      const signal = init?.signal;
      // Answer at once if there are updates, else wait briefly like a long poll.
      if (!this.updates.some((update) => (update.update_id as number) >= body.offset)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          this.wake = () => { clearTimeout(timer); resolve(); };
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
      return Response.json({ ok: true, result: this.updates.filter((update) => (update.update_id as number) >= body.offset) });
    }

    const call: Call = { method, body };
    this.calls.push(call);
    assert.equal(String(body.chat_id ?? CHAT), String(CHAT));
    if (method === "getFile") {
      const file = this.files.get(body.file_id);
      return Response.json({ ok: true, result: { file_id: body.file_id, file_path: file?.path } });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      call.id = this.nextBotMessage++;
      return Response.json({ ok: true, result: { message_id: call.id, date: 0, chat: { id: CHAT, type: "private" } } });
    }
    return Response.json({ ok: true, result: true });
  }
}

interface FixtureOptions {
  /** The model waits until the run is aborted. */
  waitForAbort?: boolean;
  /** WEZTERM_PANE of the session. */
  pane?: string;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-remote-"));
  const wezterm = join(dir, "wezterm");
  const env: Record<string, string | undefined> = {
    PI_CODING_AGENT_DIR: dir,
    PI_TELEGRAM_SOCKET: join(dir, "daemon.sock"),
    PI_TELEGRAM_API_BASE: API,
    // Never type into a real WezTerm pane, such as the one that runs these tests.
    PI_TELEGRAM_WEZTERM: wezterm,
    WEZTERM_PANE: options.pane,
  };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await writeFile(join(dir, "telegram-notification.json"), JSON.stringify({ botToken: TOKEN, chatId: String(CHAT) }));

  const telegram = new FakeTelegram();
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, init?: RequestInit) => telegram.fetch(String(url), init));

  const logs: string[] = [];
  const daemon = new Daemon({
    telegram: { botToken: TOKEN, chatId: String(CHAT) },
    remote: { userId: String(CHAT), awayOnLock: false, staleMinutes: 10 },
    socket: join(dir, "daemon.sock"),
    dataDir: join(dir, "telegram-remote"),
    linksPath: join(dir, "telegram-remote", "messages.jsonl"),
    sessionsDir: join(dir, "sessions"),
    commands: { wezterm, pi: "pi" },
    log: (message) => logs.push(message),
  });
  await daemon.start();

  // The model answers "Done: <prompt>" and records each prompt.
  const prompts: string[] = [];
  /** The next model call waits until this is resolved. */
  let held: Promise<void> | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("remote-test", {
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    apiKey: "test",
    models: [{
      id: "remote-model",
      name: "Remote model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1000,
    }, {
      id: "second-model",
      name: "Second model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1000,
    }],
    streamSimple(model, context, streamOptions) {
      const user = context.messages.filter((message) => message.role === "user").at(-1);
      const prompt = typeof user?.content === "string"
        ? user.content
        : (user?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
      prompts.push(prompt);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: `Done: ${prompt}` }],
        stopReason: "stop",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      const finish = () => {
        if (options.waitForAbort) {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }
      };
      if (held) {
        void held.then(finish);
        held = undefined;
      } else if (options.waitForAbort) {
        streamOptions?.signal?.addEventListener("abort", finish, { once: true });
      } else {
        finish();
      }
      markStarted();
      return stream;
    },
  });

  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "A test session.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("remote-test", "remote-model"),
    settingsManager: settings,
    sessionManager: SessionManager.create(dir, join(dir, "sessions", "--test--")),
    resourceLoader: loader,
    tools: [],
  });
  // The editor submits its text each time the fake wezterm is called to press Enter.
  const editor = { text: "", submitted: [] as string[], presses: 0 };
  const weztermCalls = join(dir, "wezterm-calls");
  const ui = {
    notify: () => {},
    setStatus: () => {},
    setEditorText: (text: string) => { editor.text = text; },
    getEditorText: () => {
      const presses = existsSync(weztermCalls)
        ? readFileSync(weztermCalls, "utf8").split("\n").filter((line) => line.includes("send-text")).length
        : 0;
      if (presses > editor.presses) {
        editor.presses = presses;
        editor.submitted.push(editor.text);
        editor.text = "";
      }
      return editor.text;
    },
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({
    mode: "tui",
    uiContext: ui,
    onError: (error) => { assert.fail(error.error); },
    // Pi's terminal UI gives command handlers these. The extension's reload command uses reload().
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: () => session.reload(),
    },
  });

  t.after(async () => {
    // Let a run that is still settling finish, so it does not use a disposed session.
    await Promise.race([session.waitForIdle(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await settle();
    session.dispose();
    await daemon.stop();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => daemon.sessions().length === 1);
  const receipts = () => session.sessionManager.getEntries().filter(
    (entry) => entry.type === "custom" && entry.customType === "telegram-notification",
  ).length;
  /** Hold the next model call. Returns the function that lets it finish. */
  const hold = () => {
    let release!: () => void;
    held = new Promise((resolve) => { release = resolve; });
    return release;
  };
  return {
    dir, telegram, daemon, session, prompts, started, logs, wezterm, weztermCalls, editor, receipts, hold,
    live: () => daemon.sessions()[0],
  };
}

/** agent_settled handlers finish a few ticks after their last step. A prompt sent before then waits for them. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor<T>(check: () => T | Promise<T>, timeout = 5_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A notification sent by the session, to reply to. */
async function notification(f: Awaited<ReturnType<typeof fixture>>): Promise<number> {
  await f.session.prompt("/notify on");
  await f.session.prompt("First task.");
  await f.session.prompt("/notify off");
  const sent = f.telegram.sent("sendRichMessage");
  assert.equal(sent.length, 1);
  return sent[0].id!;
}

test("a reply to a notification prompts its session, and the answer replies to it with notifications off", async (t) => {
  const f = await fixture(t);
  assert.equal(f.live().session.id, f.session.sessionManager.getSessionId());
  const notice = await notification(f);

  const asked = f.telegram.send({ text: "Second task.", reply_to_message: { message_id: notice } });
  const answer = await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  assert.equal(f.prompts.at(-1), "Second task.");
  assert.equal(answer.body.reply_parameters.message_id, asked);
  assert.match(answer.body.rich_message.markdown, /Done: Second task\./);
  await waitFor(() => f.telegram.sent("setMessageReaction").length);
  assert.deepEqual(f.telegram.sent("setMessageReaction").map((call) => [call.body.message_id, call.body.reaction[0].emoji]), [[asked, "👀"]]);

  // Replies to the answer and to the user's own message reach the same session.
  f.telegram.send({ text: "Third task.", reply_to_message: { message_id: answer.id } });
  await waitFor(() => f.telegram.sent("sendRichMessage")[2]);
  f.telegram.send({ text: "Fourth task.", reply_to_message: { message_id: asked } });
  await waitFor(() => f.telegram.sent("sendRichMessage")[3]);
  assert.deepEqual(f.prompts.slice(-2), ["Third task.", "Fourth task."]);

  // A prompt typed on the computer does not go to Telegram.
  await waitFor(() => f.receipts() === 4);
  await settle();
  await f.session.prompt("Local task.");
  assert.equal(f.prompts.at(-1), "Local task.");
  assert.equal(f.telegram.sent("sendRichMessage").length, 4);

  f.telegram.send({ text: "Who are you?", reply_to_message: { message_id: 999_999 } });
  const unknown = await waitFor(() => f.telegram.sent("sendMessage").at(-1));
  assert.match(unknown.body.text, /don't know which Pi session/);
});

test("attachments are saved as files, and Pi gets their paths", async (t) => {
  const f = await fixture(t);
  const notice = await notification(f);
  f.telegram.files.set("voice-id", { path: "voice/file_1.oga", data: new Uint8Array([1, 2, 3]) });
  f.telegram.files.set("photo-small", { path: "photos/file_2.jpg", data: new Uint8Array([4]) });
  f.telegram.files.set("photo-large", { path: "photos/file_3.jpg", data: new Uint8Array([5, 6]) });
  f.telegram.files.set("doc-id", { path: "documents/file_4.pdf", data: new Uint8Array([7]) });

  // An album arrives as separate messages; the caption is on one of them.
  const album = { media_group_id: "album-1", reply_to_message: { message_id: notice } };
  f.telegram.send({
    ...album,
    caption: "Transcribe the voice message and look at the photo.",
    voice: { file_id: "voice-id", duration: 7, mime_type: "audio/ogg", file_size: 3 },
  });
  f.telegram.send({
    ...album,
    photo: [
      { file_id: "photo-small", width: 90, height: 60, file_size: 1 },
      { file_id: "photo-large", width: 800, height: 600, file_size: 2 },
    ],
  });
  f.telegram.send({
    ...album,
    document: { file_id: "doc-id", file_name: "report draft.pdf", mime_type: "application/pdf", file_size: 1 },
  });

  await waitFor(() => f.telegram.sent("sendRichMessage")[1], 8_000);
  const prompt = f.prompts.at(-1)!;
  assert.match(prompt, /^Transcribe the voice message and look at the photo\.\n\nFiles sent from Telegram:\n/);
  const files = [...prompt.matchAll(/^- (\S+) \((.+)\)$/gm)].map(([, path, description]) => ({ path, description }));
  assert.deepEqual(files.map((file) => file.description), [
    "voice message, audio/ogg, 0:07, 1 KB",
    "photo, 800×600, 1 KB",
    "file, application/pdf, 1 KB",
  ]);
  assert.match(files[0].path, /\/telegram-remote\/files\/\d{4}-\d\d-\d\d\/\d+-1-voice\.ogg$/);
  assert.match(files[2].path, /-3-report_draft\.pdf$/);
  assert.deepEqual([...await readFile(files[0].path)], [1, 2, 3]);
  assert.deepEqual([...await readFile(files[1].path)], [5, 6]);
  assert.deepEqual(f.telegram.sent("getFile").map((call) => call.body.file_id), ["voice-id", "photo-large", "doc-id"]);
});

test("a message that is not a reply asks for a session, and a button sends it", async (t) => {
  const f = await fixture(t);
  const asked = f.telegram.send({ text: "Which files changed?" });
  const question = await waitFor(() => f.telegram.sent("sendMessage")[0]);
  assert.equal(question.body.text, "Send this to which session?");
  assert.equal(question.body.reply_parameters.message_id, asked);
  const buttons = question.body.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].text, "New session…");
  assert.match(buttons[0].text, /^💤 /);

  f.telegram.press(buttons[0].callback_data, question.id!);
  const answer = await waitFor(() => f.telegram.sent("sendRichMessage")[0]);
  assert.equal(f.prompts.at(-1), "Which files changed?");
  assert.equal(answer.body.reply_parameters.message_id, asked);
  assert.match(f.telegram.sent("editMessageText")[0].body.text, /^Sent to /);

  // The button only works once.
  f.telegram.press(buttons[0].callback_data, question.id!);
  await waitFor(() => f.telegram.sent("answerCallbackQuery")[1]);
  assert.equal(f.telegram.sent("answerCallbackQuery")[1].body.text, "This choice has expired.");
  assert.equal(f.prompts.length, 1);
});

test("/ls lists sessions, and its buttons turn notifications on and send the last answer", async (t) => {
  const f = await fixture(t);
  await f.session.prompt("Earlier task.");
  // The daemon learns the first prompt when Pi reports that the run settled.
  await waitFor(() => f.live().session.firstPrompt === "Earlier task.");
  f.telegram.send({ text: "/ls" });
  const entry = await waitFor(() => f.telegram.sent("sendMessage")[0]);
  assert.equal(entry.body.parse_mode, "HTML");
  assert.match(entry.body.text, /^💤 <b>.+<\/b>\n<code>.+<\/code>\n<i>“Earlier task\.”<\/i>\nIdle · notifications off$/);
  const data = (entry.body.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>)
    .map((item) => [item.text, item.callback_data.split(":")[0]]);
  assert.deepEqual(data, [["Last answer", "l"], ["Notify on", "o"]]);

  // A session that connected before the extension learned about first prompts still shows one.
  f.live().session.firstPrompt = undefined;
  f.telegram.send({ text: "/ls" });
  const reread = await waitFor(() => f.telegram.sent("sendMessage")[1]);
  assert.match(reread.body.text, /<i>“Earlier task\.”<\/i>/);

  const id = f.live().session.id;
  f.telegram.press(`o:${id}`, entry.id!);
  await waitFor(() => f.live().notify);
  const edited = await waitFor(() => f.telegram.sent("editMessageText")[0]);
  assert.match(edited.body.text, /notifications on$/);
  assert.equal(f.telegram.sent("answerCallbackQuery")[0].body.text, "Notifications on.");
  await f.session.prompt("Local task.");
  assert.match(f.telegram.sent("sendRichMessage")[0].body.rich_message.markdown, /Done: Local task\./);

  f.telegram.press(`l:${id}`, entry.id!);
  const last = await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  assert.equal(last.body.reply_parameters.message_id, entry.id);
  assert.match(last.body.rich_message.markdown, /Done: Local task\./);

  // A reply to the entry reaches the session.
  f.telegram.send({ text: "Next task.", reply_to_message: { message_id: entry.id } });
  await waitFor(() => f.telegram.sent("sendRichMessage")[2]);
  assert.equal(f.prompts.at(-1), "Next task.");
});

test("/model lists the session's models, and a button changes the model", async (t) => {
  const f = await fixture(t);
  f.telegram.send({ text: "/ls" });
  const entry = await waitFor(() => f.telegram.sent("sendMessage")[0]);

  f.telegram.send({ text: "/model", reply_to_message: { message_id: entry.id } });
  const chooser = await waitFor(() => f.telegram.sent("sendMessage")[1]);
  assert.match(chooser.body.text, /^Choose a model for .+\nCurrent: remote-test\/remote-model\.$/);
  const buttons = (chooser.body.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>);
  assert.deepEqual(buttons.map((item) => item.text), ["✓ Remote model (remote-test)", "Second model (remote-test)"]);

  f.telegram.press(buttons[1].callback_data, chooser.id!);
  await waitFor(() => f.session.model?.id === "second-model");
  const edited = await waitFor(() => f.telegram.sent("editMessageText")[0]);
  assert.match(edited.body.text, /^Model: remote-test\/second-model/);
  assert.deepEqual(edited.body.reply_markup.inline_keyboard, []);
});

/** With waitForAbort, a run only ends when it is aborted. Returns the notification of one such run. */
async function abortedNotification(f: Awaited<ReturnType<typeof fixture>>): Promise<number> {
  await f.session.prompt("/notify on");
  const run = f.session.prompt("First task.");
  await f.started;
  await f.session.abort();
  await run;
  await f.session.prompt("/notify off");
  return f.telegram.sent("sendRichMessage")[0].id!;
}

test("/stop as a reply aborts the run, which still answers in Telegram", async (t) => {
  const f = await fixture(t, { waitForAbort: true });
  const notice = await abortedNotification(f);

  const asked = f.telegram.send({ text: "Long task.", reply_to_message: { message_id: notice } });
  await waitFor(() => f.live().state === "working");
  const stop = f.telegram.send({ text: "/stop", reply_to_message: { message_id: asked } });
  const answer = await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  assert.equal(answer.body.reply_parameters.message_id, asked);
  assert.match(answer.body.rich_message.markdown, /Pi aborted/);
  await waitFor(() => f.telegram.sent("setMessageReaction").some((call) => call.body.message_id === stop));
  assert.equal(f.telegram.sent("setMessageReaction").find((call) => call.body.message_id === stop)!.body.reaction[0].emoji, "👌");
  await waitFor(() => f.live().state === "idle");
});

test("a prompt that arrives during compaction waits for it, then runs", async (t) => {
  const f = await fixture(t);
  const notice = await notification(f);
  const release = f.hold();
  const compaction = f.session.compact();
  await waitFor(() => f.session.isCompacting);
  const asked = f.telegram.send({ text: "After compaction.", reply_to_message: { message_id: notice } });
  const note = await waitFor(() => f.telegram.sent("sendMessage").find((call) => /compacting/.test(call.body.text)));
  assert.equal(note.body.reply_parameters.message_id, asked);
  assert.equal(f.prompts.includes("After compaction."), false);
  release();
  await compaction;
  const answer = await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  assert.equal(answer.body.reply_parameters.message_id, asked);
  assert.equal(f.prompts.at(-1), "After compaction.");
});

test("in WezTerm, a command in a reply is typed into the session's editor, so every command runs", async (t) => {
  const f = await fixture(t, { pane: "42" });
  const notice = await notification(f);
  await writeFile(f.wezterm, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${f.weztermCalls}'\n`);
  await chmod(f.wezterm, 0o755);
  f.editor.text = "unsent draft";

  const asked = f.telegram.send({ text: "/model gpt-x", reply_to_message: { message_id: notice } });
  const said = await waitFor(() => f.telegram.sent("sendMessage").find((call) => call.body.reply_parameters?.message_id === asked));
  assert.equal(said.body.text, "Ran /model on the computer.");
  assert.deepEqual(f.editor.submitted, ["/model gpt-x"]);
  assert.equal(f.editor.text, "unsent draft");
  assert.deepEqual((await readFile(f.weztermCalls, "utf8")).split("\n").filter(Boolean), ["cli send-text --pane-id 42 --no-paste \r"]);
  assert.equal(f.prompts.length, 1);
});

test("outside WezTerm, a command in a reply runs if the extension API can run it", async (t) => {
  const f = await fixture(t);
  const notice = await notification(f);
  f.telegram.send({ text: "/model gpt", reply_to_message: { message_id: notice } });
  const refused = await waitFor(() => f.telegram.sent("sendMessage")[0]);
  assert.match(refused.body.text, /^\/model only runs from Pi's editor, and this session does not run in WezTerm/);

  f.telegram.send({ text: "/notify on", reply_to_message: { message_id: notice } });
  await waitFor(() => f.live().notify);
  assert.equal(f.prompts.length, 1);
  assert.equal(existsSync(f.weztermCalls), false);
});

test("/new matches a directory by name, starts Pi in WezTerm, and sends the prompt once Pi connects", async (t) => {
  const f = await fixture(t);
  const project = join(f.dir, "RoboProject");
  await mkdir(project);
  const folder = join(f.dir, "sessions", "--robo--");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", cwd: project })}\n`);

  const calls = join(f.dir, "wezterm-calls");
  await writeFile(f.wezterm, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    'case "$3" in list) echo \'[{"window_id":3},{"window_id":1}]\' ;; spawn) echo 77 ;; esac',
  ].join("\n"));
  await chmod(f.wezterm, 0o755);

  // Stands in for the Pi that WezTerm would start in pane 77.
  const requests: DaemonMessage[] = [];
  const asked = f.telegram.send({ text: "/new robo fix the loader\nand run the tests" });
  await waitFor(async () => (await readFile(calls, "utf8").catch(() => "")).includes("spawn"));
  const client: RemoteClient = new RemoteClient({
    path: join(f.dir, "daemon.sock"),
    hello: () => ({
      type: "hello",
      version: PROTOCOL_VERSION,
      pid: 1,
      host: "test",
      pane: "77",
      session: { id: "new-session", cwd: project },
      state: "idle",
      notify: false,
    }),
    onMessage: (message) => {
      requests.push(message);
      if (message.type !== "away") client.send({ type: "result", id: message.id, ok: true });
    },
  });
  client.start();
  t.after(() => client.close());

  const prompt = await waitFor(() => requests.find((message) => message.type === "prompt"));
  assert.deepEqual(prompt.type === "prompt" && [prompt.text, prompt.replyTo], ["fix the loader\nand run the tests", asked]);
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
    "cli --prefer-mux list --format json",
    `cli --prefer-mux spawn --window-id 1 --cwd ${project} -- pi`,
  ]);
  const started = await waitFor(() => f.telegram.sent("sendMessage").find((call) => /^Started/.test(call.body.text)));
  assert.equal(started.body.text, `Started a session in ${project}.`);
  await waitFor(() => f.telegram.sent("setMessageReaction").some((call) => call.body.message_id === asked));
});

test("a message that arrives late asks before it runs", async (t) => {
  const f = await fixture(t);
  const notice = await notification(f);
  f.telegram.send({ text: "Old task.", date: Math.floor(Date.now() / 1000) - 3600, reply_to_message: { message_id: notice } });
  const question = await waitFor(() => f.telegram.sent("sendMessage")[0]);
  assert.match(question.body.text, /^This message reached the computer 60 minutes after you sent it\./);
  assert.equal(f.prompts.length, 1);
  const send = question.body.reply_markup.inline_keyboard[0][0].callback_data as string;
  f.telegram.press(send, question.id!);
  await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  assert.equal(f.prompts.at(-1), "Old task.");
});

test("only the owner, in the owner's private chat, can use the bot", async (t) => {
  const f = await fixture(t);
  const notice = await notification(f);
  const before = f.telegram.calls.length;
  const stranger = { id: 999, type: "private" };
  const id = f.live().session.id;
  f.telegram.files.set("photo", { path: "photos/p.jpg", data: new Uint8Array([1]) });

  // Another user, in their own chat with the bot.
  f.telegram.send({ chat: stranger, from: { id: 999 }, text: "/ls" });
  f.telegram.send({ chat: stranger, from: { id: 999 }, text: "Delete everything.", reply_to_message: { message_id: notice } });
  f.telegram.send({ chat: stranger, from: { id: 999 }, caption: "/new robo", photo: [{ file_id: "photo", width: 1, height: 1 }] });
  // The owner, in a group with the bot.
  f.telegram.send({ chat: { id: -100123, type: "supergroup" }, text: "/ls" });
  // In the owner's chat, but not sent by the owner as a user.
  f.telegram.send({ from: { id: 999 }, text: "/ls" });
  f.telegram.send({ from: { id: 555, is_bot: true }, text: "/ls" });
  f.telegram.send({ sender_chat: { id: -100777, type: "channel" }, text: "/ls" });
  f.telegram.send({ business_connection_id: "b1", text: "/ls" });
  f.telegram.send({ guest_query_id: "g1", text: "/ls" });
  // Buttons pressed by another user, on an inline-mode message, and on a message in another chat.
  f.telegram.press(`x:${id}`, notice, { from: { id: 999 } });
  f.telegram.press(`x:${id}`, notice, { message: undefined, inline_message_id: "inline-1" });
  f.telegram.press(`x:${id}`, notice, { message: { message_id: 7, date: 0, chat: stranger } });
  // Kinds of updates that the daemon does not ask for.
  f.telegram.push({ guest_message: { message_id: 50, date: 0, chat: { id: CHAT, type: "private" }, from: { id: 999 }, text: "/ls", guest_query_id: "g2" } });
  f.telegram.push({ business_message: { message_id: 51, date: 0, chat: stranger, from: { id: 999 }, text: "/ls", business_connection_id: "b2" } });
  f.telegram.push({ edited_message: { message_id: notice, date: 0, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "/ls" } });

  // The owner's message, sent after all of these, is the only one that does anything.
  f.telegram.send({ text: "Owner task.", reply_to_message: { message_id: notice } });
  await waitFor(() => f.telegram.sent("sendRichMessage")[1]);
  await waitFor(() => f.telegram.sent("setMessageReaction")[0]);
  assert.deepEqual(f.prompts.slice(1), ["Owner task."]);
  assert.deepEqual(f.telegram.calls.slice(before).map((call) => call.method).sort(), ["sendRichMessage", "setMessageReaction"]);
  assert.ok(f.logs.includes("Ignored a message from user 999 in chat 999. Only user 4242 can use this bot."));
});

test("the daemon does not start unless remote.userId is set and is the user of chatId", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-remote-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const daemon = (userId: string | undefined) => new Daemon({
    telegram: { botToken: TOKEN, chatId: String(CHAT) },
    remote: { userId, awayOnLock: false, staleMinutes: 10 },
    socket: join(dir, "daemon.sock"),
    dataDir: join(dir, "telegram-remote"),
    linksPath: join(dir, "telegram-remote", "messages.jsonl"),
    sessionsDir: join(dir, "sessions"),
    commands: { wezterm: "wezterm", pi: "pi" },
    log: () => {},
  });
  await assert.rejects(daemon(undefined).start(), /^Error: Set remote\.userId/);
  await assert.rejects(daemon("12345").start(), /^Error: chatId must be 12345/);

  // User IDs can be larger than 32 bits.
  await writeFile(join(dir, "config.json"), JSON.stringify({ botToken: TOKEN, chatId: "9876543210", remote: { userId: 9876543210 } }));
  assert.equal((await readRemoteSettings(join(dir, "config.json"))).userId, "9876543210");
});

test("/reload reloads the session you reply to, or every session, and a working one when it stops", async (t) => {
  const f = await fixture(t, { waitForAbort: true });
  const notice = await abortedNotification(f);
  // After a reload, the new extension connects again.
  const reconnected = (before: unknown) => waitFor(() => {
    const live = f.live();
    return live !== undefined && live !== before && live;
  });

  const first = f.live();
  const one = f.telegram.send({ text: "/reload", reply_to_message: { message_id: notice } });
  await reconnected(first);
  const said = await waitFor(() => f.telegram.sent("sendMessage").find((call) => call.body.reply_parameters?.message_id === one));
  assert.equal(said.body.text, "Reloading.");

  const asked = f.telegram.send({ text: "Long task.", reply_to_message: { message_id: notice } });
  await waitFor(() => f.live().state === "working");
  const working = f.live();
  const all = f.telegram.send({ text: "/reload" });
  const summary = await waitFor(() => f.telegram.sent("sendMessage").find((call) => call.body.reply_parameters?.message_id === all));
  assert.match(summary.body.text, /^✓ .+: Pi reloads when it stops working\.$/);
  assert.equal(f.live(), working);

  f.telegram.send({ text: "/stop", reply_to_message: { message_id: asked } });
  await reconnected(working);
  // The aborted run still answered first.
  assert.match(f.telegram.sent("sendRichMessage").at(-1)!.body.rich_message.markdown, /Pi aborted/);
});
