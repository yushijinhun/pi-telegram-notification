import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  FooterComponent,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const credentials = { botToken: "123456:test_token", chatId: "-123456" };
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FixtureOptions {
  responses?: Array<"stop" | "error" | "retry">;
  reply?: string;
  waitForAbort?: boolean;
  rejectDelivery?: boolean;
  rejectRich?: boolean;
  rejectImages?: boolean;
  rejectHtml?: boolean;
  extension?: (pi: ExtensionAPI) => void;
}

interface Delivery {
  method: string;
  /** The rich message's Markdown, or sendMessage's text. */
  text: string;
  parseMode?: string;
  /** Uploaded multipart files. */
  files: string[];
  signal: AbortSignal | null | undefined;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-test-"));
  const config = join(dir, "telegram-notification.json");
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(config, JSON.stringify(credentials));

  const deliveries: Delivery[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).replace(`https://api.telegram.org/bot${credentials.botToken}/`, "");
    assert.ok(method === "sendRichMessage" || method === "sendMessage", method);
    let body: Record<string, any>;
    let files: string[] = [];
    if (init?.body instanceof FormData) {
      body = { chat_id: init.body.get("chat_id"), rich_message: JSON.parse(String(init.body.get("rich_message"))) };
      files = [...init.body.keys()].filter((key) => key !== "chat_id" && key !== "rich_message");
    } else {
      body = JSON.parse(String(init?.body));
    }
    assert.equal(body.chat_id, credentials.chatId);
    const rich = method === "sendRichMessage";
    const text: string = rich ? body.rich_message.markdown : body.text;
    deliveries.push({ method, text, parseMode: body.parse_mode, files, signal: init?.signal });
    const rejection = options.rejectDelivery
      ? "Bad Request: chat not found"
      : options.rejectRich && rich
        ? "Bad Request: RICH_MESSAGE_INVALID"
        : options.rejectImages && rich && text.includes("![")
          ? "Bad Request: RICH_MESSAGE_PHOTO_INVALID"
          : options.rejectHtml && body.parse_mode === "HTML"
            ? "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0"
            : undefined;
    return rejection
      ? Response.json({ ok: false, error_code: 400, description: rejection }, { status: 400 })
      : Response.json({ ok: true, result: { message_id: deliveries.length } });
  });

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    cacheWarming: "off",
  });
  let calls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("notification-test", {
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    apiKey: "test",
    models: [{
      id: "notification-model",
      name: "Notification model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1000,
    }],
    streamSimple(model, _context, streamOptions) {
      const stream = createAssistantMessageEventStream();
      const result = options.responses?.[calls] ?? "stop";
      calls++;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: "thinking", thinking: "Do not notify with thinking." },
          { type: "text", text: options.reply ?? "The task is complete." },
        ],
        stopReason: result === "stop" ? "stop" : "error",
        ...(result === "error" ? { errorMessage: "Permission denied" } : {}),
        ...(result === "retry" ? { errorMessage: "503 Service unavailable" } : {}),
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      const finish = () => {
        if (options.waitForAbort) message.stopReason = "aborted";
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }
      };
      if (options.waitForAbort) streamOptions?.signal?.addEventListener("abort", finish, { once: true });
      else finish();
      markStarted();
      return stream;
    },
  });

  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    additionalExtensionPaths: [extensionPath],
    extensionFactories: options.extension ? [options.extension] : [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "A test session.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("notification-test", "notification-model"),
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(dir),
    resourceLoader: loader,
    tools: [],
  });
  t.after(() => { session.dispose(); });
  const notices: Array<{ message: string; type?: string }> = [];
  const statuses = new Map([["other-extension", "Other status"]]);
  const ui = {
    notify: (message: string, type?: string) => { notices.push({ message, type }); },
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
    },
  } as ExtensionUIContext;
  await session.bindExtensions({
    mode: "tui",
    uiContext: ui,
    onError: (error) => { assert.fail(error.error); },
  });
  initTheme("dark");
  const footer = new FooterComponent(session, {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => statuses,
    onBranchChange: () => () => {},
  });
  const receipts = () => session.sessionManager.getEntries().filter(
    (entry) => entry.type === "custom" && entry.customType === "telegram-notification",
  );
  return { session, footer, config, deliveries, notices, started, receipts, calls: () => calls };
}

test("default off, missing credentials, toggle commands, and inline footer across reload", async (t) => {
  const f = await fixture(t);
  const before = f.footer.render(100);
  await f.session.prompt("Finish without notifying.");
  assert.equal(f.deliveries.length, 0);
  await rm(f.config);
  await f.session.prompt("/notify");
  assert.equal(f.notices.at(-1)?.type, "error");
  assert.ok(!plain(f.footer.render(100)[1]).includes("[Notification On]"));
  await writeFile(f.config, '{"botToken":"secret-do-not-display",');
  await f.session.prompt("/notify on");
  assert.equal(f.notices.at(-1)?.type, "error");
  assert.ok(!f.notices.at(-1)?.message.includes("secret-do-not-display"));
  await writeFile(f.config, JSON.stringify(credentials));
  await f.session.prompt("/notify");
  const after = f.footer.render(100);
  assert.equal(after.length, before.length);
  assert.equal(after[2], before[2]);
  assert.ok(plain(after[1]).includes(" [Notification On]"));
  assert.ok(plain(after[1]).includes("notification-model"));
  for (const width of [100, 45, 18, 10, 1]) {
    assert.ok(f.footer.render(width).every((line) => visibleWidth(line) <= width));
  }
  const render = FooterComponent.prototype.render;
  await f.session.reload();
  assert.equal(FooterComponent.prototype.render, render);
  assert.ok(!plain(f.footer.render(100)[1]).includes("[Notification On]"));
  await f.session.prompt("/notify on");
  assert.equal(plain(f.footer.render(100)[1]).split("[Notification On]").length - 1, 1);
  await f.session.prompt("/notify off");
  assert.ok(!plain(f.footer.render(100)[1]).includes("[Notification On]"));
  assert.equal(f.deliveries.length, 0);
});

test("one delivery and thread receipt after retries and queued follow-ups have finished", async (t) => {
  let ends = 0;
  let deliveryCount = () => 0;
  const f = await fixture(t, {
    responses: ["retry", "stop", "stop"],
    extension(pi) {
      pi.on("agent_end", () => {
        ends++;
        assert.equal(deliveryCount(), 0);
        if (ends === 2) pi.sendUserMessage("Queued follow-up", { deliverAs: "followUp" });
      });
    },
  });
  await f.session.prompt("/notify on");
  deliveryCount = () => f.deliveries.length;
  await f.session.prompt("Do the task.");
  assert.equal(f.calls(), 3);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].method, "sendRichMessage");
  assert.match(f.deliveries[0].text, /\*\*Pi completed\*\*/);
  assert.match(f.deliveries[0].text, /The task is complete\./);
  assert.ok(!f.deliveries[0].text.includes("thinking"));
  assert.equal(f.receipts().length, 1);
  assert.deepEqual(f.receipts()[0].type, "custom");
  assert.equal(f.session.messages.filter((message) => message.role === "custom").length, 0);
});

test("a final agent error still sends and records a receipt", async (t) => {
  const f = await fixture(t, { responses: ["error"] });
  await f.session.prompt("/notify on");
  await f.session.prompt("Fail this task.");
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].text, /Pi error/);
  assert.match(f.deliveries[0].text, /Permission denied/);
  assert.equal(f.receipts().length, 1);
});

test("aborting the agent does not cancel the notification", async (t) => {
  const f = await fixture(t, { waitForAbort: true });
  await f.session.prompt("/notify on");
  const run = f.session.prompt("Wait for cancellation.");
  await f.started;
  await f.session.abort();
  await run;
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].text, /Pi aborted/);
  assert.equal(f.deliveries[0].signal?.aborted, false);
  assert.equal(f.receipts().length, 1);
});

test("Telegram API rejection is displayed as a failed delivery", async (t) => {
  const f = await fixture(t, { rejectDelivery: true });
  await f.session.prompt("/notify on");
  await f.session.prompt("Finish the task.");
  const entry = f.receipts()[0];
  assert.ok(entry?.type === "custom");
  const data = entry.data as { sent: boolean; message: string };
  assert.equal(data.sent, false);
  assert.match(data.message, /Notification failed: Bad Request: chat not found/);
  assert.equal(f.calls(), 1);
  assert.deepEqual(
    f.deliveries.map((delivery) => [delivery.method, delivery.parseMode]),
    [["sendRichMessage", undefined], ["sendMessage", "HTML"], ["sendMessage", undefined]],
  );
});

test("if Telegram rejects the rich message, HTML is sent, and plain text if it rejects the HTML", async (t) => {
  const f = await fixture(t, { reply: "The task is **complete** & <verified>.", rejectRich: true, rejectHtml: true });
  await f.session.prompt("/notify on");
  await f.session.prompt("Finish the task.");
  assert.deepEqual(
    f.deliveries.map((delivery) => [delivery.method, delivery.parseMode]),
    [["sendRichMessage", undefined], ["sendMessage", "HTML"], ["sendMessage", undefined]],
  );
  assert.match(f.deliveries[0].text, /\n\nThe task is \*\*complete\*\* & &lt;verified>\.$/);
  assert.match(f.deliveries[1].text, /\n<b>Pi completed<\/b>\n/);
  assert.match(f.deliveries[1].text, /\n\nThe task is <b>complete<\/b> &amp; &lt;verified&gt;\.$/);
  assert.match(f.deliveries[2].text, /\nPi completed\n/);
  assert.match(f.deliveries[2].text, /\n\nThe task is \*\*complete\*\* & <verified>\.$/);
  const entry = f.receipts()[0];
  assert.ok(entry?.type === "custom");
  const data = entry.data as { sent: boolean; message: string };
  assert.equal(data.sent, true);
  assert.equal(
    data.message,
    "Notification sent as plain text (completed). Telegram rejected the rich message: Bad Request: RICH_MESSAGE_INVALID",
  );
});

test("local images are uploaded, and sent as text if Telegram rejects them", async (t) => {
  const f = await fixture(t, { reply: "Here is the plot:\n\n![Plot](plot.png)", rejectImages: true });
  const dir = dirname(f.config);
  await writeFile(join(dir, "plot.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ));
  await f.session.prompt("/notify on");
  await f.session.prompt("Plot the results.");
  assert.deepEqual(f.deliveries.map((delivery) => [delivery.method, delivery.files]), [
    ["sendRichMessage", ["image1"]],
    ["sendRichMessage", []],
  ]);
  assert.match(f.deliveries[0].text, /\n\nHere is the plot:\n\n!\[\]\(tg:\/\/photo\?id=image1 "Plot"\)$/);
  assert.ok(f.deliveries[1].text.endsWith(`\n\nHere is the plot:\n\nPlot \`${dir}/plot.png\``));
  const entry = f.receipts()[0];
  assert.ok(entry?.type === "custom");
  assert.equal(
    (entry.data as { message: string }).message,
    "Notification sent as rich message without images (completed). " +
      "Telegram rejected the rich message: Bad Request: RICH_MESSAGE_PHOTO_INVALID",
  );
});
