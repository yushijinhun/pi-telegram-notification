import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNotification, markdownToTelegramHtml, MESSAGE_LIMIT } from "../src/format.ts";

test("Markdown replies become Telegram HTML", () => {
  const markdown = [
    "## Summary",
    "",
    "Fixed **two** bugs in *auth*, ~~removed~~ `legacy.ts`. See [the PR](https://example.com/pr?a=1&b=2).",
    "",
    "1. First",
    "   - nested",
    "2. Second",
    "",
    "- [x] tests",
    "- [ ] docs",
    "",
    "```ts",
    "if (a < b && c) {}",
    "```",
    "",
    "> Quoted",
    "",
    "| File | Lines |",
    "| --- | ---: |",
    "| `a.ts` | 12 |",
    "| **b.ts** | 3 |",
    "",
    "---",
  ].join("\n");
  assert.equal(markdownToTelegramHtml(markdown), [
    "<b>Summary</b>",
    "",
    'Fixed <b>two</b> bugs in <i>auth</i>, <s>removed</s> <code>legacy.ts</code>. See <a href="https://example.com/pr?a=1&amp;b=2">the PR</a>.',
    "",
    "1. First",
    "   • nested",
    "2. Second",
    "",
    "☑ tests",
    "☐ docs",
    "",
    '<pre><code class="language-ts">if (a &lt; b &amp;&amp; c) {}</code></pre>',
    "",
    "<blockquote>Quoted</blockquote>",
    "",
    "<pre>File | Lines",
    "-----+------",
    "a.ts |    12",
    "b.ts |     3</pre>",
    "",
    "──────────",
  ].join("\n"));
});

test("text and raw HTML in replies are escaped", () => {
  assert.equal(
    markdownToTelegramHtml('Use <span> & "quotes" when a > b.<br>Next\n\n<details>\nraw\n</details>'),
    "Use &lt;span&gt; &amp; &quot;quotes&quot; when a &gt; b.\nNext\n\n&lt;details&gt;\nraw\n&lt;/details&gt;",
  );
});

test("long replies are cut to fit one Telegram message", () => {
  // Every row is padded to the long cell, so the table is longer than its source.
  const reply = `| Column | Other |\n| --- | --- |\n| ${"x".repeat(100)} | y |\n${"| a | b |\n".repeat(600)}`;
  const { text, html } = formatNotification({
    host: "host",
    status: "completed",
    session: "session",
    cwd: "/work",
    detail: reply,
    markdown: true,
  });
  // Telegram counts the text left after parsing tags and entities.
  const visible = Array.from(html.replace(/<[^>]*>/g, "").replace(/&\w+;/g, "&")).length;
  assert.ok(visible <= MESSAGE_LIMIT, `${visible} characters`);
  assert.ok(visible > MESSAGE_LIMIT - 200, `${visible} characters`);
  assert.ok(html.endsWith("</pre>"));
  assert.ok(text.endsWith(reply));
});
