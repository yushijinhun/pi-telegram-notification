import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NotificationContent } from "../src/format.ts";
import { formatRichMessage, RICH_MESSAGE_LIMIT } from "../src/rich.ts";

const header = "Message from host:\\\n**Pi completed**\\\nSession: s\\\nDirectory: /work\n\n";
const content = (detail: string, cwd = "/work"): NotificationContent =>
  ({ host: "host", status: "completed", session: "s", cwd, detail, markdown: true });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("formulas use dollar delimiters, and text Pi shows as written is escaped", async () => {
  const reply = [
    "Inline \\(a^2\\) and $b^2$, currency $5 and $10.",
    "",
    "\\[",
    "x = 1",
    "\\]",
    "",
    "\\begin{aligned} a &= b \\end{aligned}",
    "",
    "`$HOME \\(x\\)` <span>raw</span> &copy; AT&T <https://example.com> line<br>break",
    "",
    "x==y, a||b, 2 * 3, *em* and **strong**",
    "",
    "* item",
    "* item with `code`",
    "  ```sh",
    "  echo $HOME <tag>",
    "  ```",
    "",
    "Title",
    "===",
    "",
    "***",
    "",
    "| a | b |",
    "|---|---|",
    "| $x_1$ | c |",
  ].join("\n");
  const message = await formatRichMessage(content(reply));
  assert.equal(message.markdown, header + [
    "Inline $a^2$ and $b^2$, currency \\$5 and \\$10.",
    "",
    "$$",
    "x = 1",
    "$$",
    "",
    "$$\\begin{aligned} a &= b \\end{aligned}$$",
    "",
    "`$HOME \\(x\\)` &lt;span>raw&lt;/span> &amp;copy; AT&T <https://example.com> line<br>break",
    "",
    "x\\=\\=y, a\\|\\|b, 2 \\* 3, *em* and **strong**",
    "",
    "* item",
    "* item with `code`",
    "  ```sh",
    "  echo $HOME <tag>",
    "  ```",
    "",
    "Title",
    "===",
    "",
    "***",
    "",
    "| a | b |",
    "|---|---|",
    "| $x_1$ | c |",
  ].join("\n"));
  assert.equal(message.withoutImages, undefined);
  assert.deepEqual(message.files, []);
});

test("images are uploaded or linked, each on its own line, with a text version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-rich-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "plot.png"), png);
  // Only the PNG header: 400 by 12000 pixels is too tall for a Telegram photo.
  const tall = Buffer.alloc(24);
  png.copy(tall, 0, 0, 16);
  tall.writeUInt32BE(400, 16);
  tall.writeUInt32BE(12_000, 20);
  await writeFile(join(dir, "tall.png"), tall);

  const reply = [
    "Here is the plot: ![Plot](plot.png) - it grows.",
    "",
    "![](./plot.png 'Same \"plot\"')",
    `![Tall](file://${dir}/tall.png)`,
    "![Logo](https://example.com/logo.png)",
    `![Data](data:image/png;base64,${png.toString("base64")})`,
    "![Missing](missing.png)",
    "",
    "| Cell |",
    "| --- |",
    "| ![cell](plot.png) |",
    "",
    "`![code](plot.png)`",
  ].join("\n");
  const message = await formatRichMessage(content(reply, dir));
  const head = header.replace("/work", dir.replaceAll("-", "\\-"));
  assert.equal(message.markdown, head + [
    "Here is the plot: ",
    "![](tg://photo?id=image1 \"Plot\")",
    "\\- it grows.",
    "",
    "![](tg://photo?id=image1 \"Same &quot;plot&quot;\")",
    "![](tg://document?id=image2 \"Tall\")",
    "![](https://example.com/logo.png \"Logo\")",
    "![](tg://photo?id=image3 \"Data\")",
    `Missing \`${dir}/missing.png\``,
    "",
    "| Cell |",
    "| --- |",
    `| cell \`${dir}/plot.png\` |`,
    "",
    "`![code](plot.png)`",
  ].join("\n"));
  assert.equal(message.withoutImages, head + [
    "Here is the plot: ",
    `Plot \`${dir}/plot.png\``,
    "\\- it grows.",
    "",
    `Same "plot" \`${dir}/plot.png\``,
    `Tall \`${dir}/tall.png\``,
    "[Logo](https://example.com/logo.png)",
    "Data",
    `Missing \`${dir}/missing.png\``,
    "",
    "| Cell |",
    "| --- |",
    `| cell \`${dir}/plot.png\` |`,
    "",
    "`![code](plot.png)`",
  ].join("\n"));
  assert.deepEqual(message.files.map(({ data, ...file }) => ({ ...file, size: data.length })), [
    { id: "image1", kind: "photo", name: "plot.png", type: "image/png", size: png.length },
    { id: "image2", kind: "document", name: "tall.png", type: "image/png", size: tall.length },
    { id: "image3", kind: "photo", name: "image3.png", type: "image/png", size: png.length },
  ]);
});

test("header fields and error text are escaped, and long replies end at a block boundary", async () => {
  const error = await formatRichMessage({
    host: "box_1",
    status: "error",
    session: "a*b",
    cwd: "/tmp/my_dir",
    detail: "Failed: <bad> & $5 #1\n\n  next line.\nsecond",
    markdown: false,
  });
  assert.equal(error.markdown, [
    "Message from box\\_1:\\",
    "**Pi error**\\",
    "Session: a\\*b\\",
    "Directory: /tmp/my\\_dir",
    "",
    "Failed: &lt;bad\\> &amp; \\$5 \\#1",
    "",
    "next line\\.\\",
    "second",
  ].join("\n"));

  const paragraph = (n: number) => `Paragraph ${n} ${"x".repeat(20)}.`;
  const long = await formatRichMessage(content(Array.from({ length: 2000 }, (_, n) => paragraph(n)).join("\n\n")));
  assert.ok(long.markdown.length <= RICH_MESSAGE_LIMIT, `${long.markdown.length} characters`);
  assert.ok(long.markdown.length > RICH_MESSAGE_LIMIT - 100, `${long.markdown.length} characters`);
  assert.match(long.markdown, /\n\nParagraph \d+ x{20}\.$/);
});
