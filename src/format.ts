import { visibleWidth } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";

/** Telegram allows 4096 characters per message. This keeps a margin below that. */
export const MESSAGE_LIMIT = 4000;

export interface NotificationContent {
  host: string;
  status: string;
  session: string;
  cwd: string;
  /** The final assistant text, or the error message. */
  detail?: string;
  /** Assistant text is Markdown. Error messages are plain text. */
  markdown: boolean;
}

export interface Notification {
  /** Full plain text. */
  text: string;
  /** Telegram HTML, cut to fit one message. */
  html: string;
}

export function formatNotification(content: NotificationContent): Notification {
  const header = [
    `Message from ${content.host}:`,
    `Pi ${content.status}`,
    `Session: ${content.session}`,
    `Directory: ${content.cwd}`,
  ];
  const [from, title, ...rest] = header.map(escapeHtml);
  const htmlHeader = [from, `<b>${title}</b>`, ...rest].join("\n");
  const textHeader = header.join("\n");
  if (!content.detail) return { text: textHeader, html: htmlHeader };

  const limit = Math.max(0, MESSAGE_LIMIT - Array.from(textHeader).length - 2);
  const body = content.markdown
    ? fitMarkdown(content.detail, limit)
    : escapeHtml(truncate(content.detail, limit));
  return { text: `${textHeader}\n\n${content.detail}`, html: `${htmlHeader}\n\n${body}` };
}

export function truncate(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

/** Telegram decodes only &lt; &gt; &amp; &quot; and numeric entities. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Convert Markdown to the tags Telegram supports. Any other tag makes Telegram reject the message. */
export function markdownToTelegramHtml(markdown: string): string {
  return blocks(Lexer.lex(markdown), "\n\n").trim();
}

/** Convert the longest prefix of the Markdown whose text fits in `limit` characters. */
function fitMarkdown(markdown: string, limit: number): string {
  // Cut the source, not the HTML, so a tag is never split.
  const chars = Array.from(markdown).slice(0, limit);
  const render = (length: number) => markdownToTelegramHtml(chars.slice(0, length).join(""));
  const html = render(chars.length);
  if (visibleLength(html) <= limit) return html;

  // Padded tables can be longer than their source.
  let low = 0;
  let high = chars.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (visibleLength(render(middle)) <= limit) low = middle;
    else high = middle;
  }
  return render(low);
}

/** Telegram's limit applies to the text left after parsing tags and entities. */
function visibleLength(html: string): number {
  return Array.from(html.replace(/<[^>]*>/g, "").replace(/&\w+;/g, "&")).length;
}

function blocks(tokens: Token[], separator: string): string {
  return tokens.map(block).filter(Boolean).join(separator);
}

function block(token: Token): string {
  const t = token as MarkedToken;
  switch (t.type) {
    case "paragraph":
      return inline(t.tokens);
    case "text":
      return t.tokens ? inline(t.tokens) : escapeHtml(t.text);
    case "heading":
      return `<b>${inline(t.tokens)}</b>`;
    case "code": {
      const code = escapeHtml(t.text);
      const language = t.lang?.match(/^\S+/)?.[0];
      return language
        ? `<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>`
        : `<pre>${code}</pre>`;
    }
    case "blockquote":
      return `<blockquote>${blocks(t.tokens, "\n\n")}</blockquote>`;
    case "list":
      return list(t);
    case "table":
      return table(t);
    case "hr":
      return "──────────";
    case "space":
    case "def":
    // The list marker shows task checkboxes.
    case "checkbox":
      return "";
    default:
      return inline([token]);
  }
}

function inline(tokens: Token[]): string {
  return tokens.map((token) => {
    const t = token as MarkedToken;
    switch (t.type) {
      case "strong":
        return `<b>${inline(t.tokens)}</b>`;
      case "em":
        return `<i>${inline(t.tokens)}</i>`;
      case "del":
        return `<s>${inline(t.tokens)}</s>`;
      case "codespan":
        return `<code>${escapeHtml(t.text)}</code>`;
      // Telegram keeps only the text of links it cannot open, such as relative paths.
      case "link":
        return `<a href="${escapeHtml(t.href)}">${inline(t.tokens)}</a>`;
      case "image":
        return `<a href="${escapeHtml(t.href)}">${escapeHtml(t.text || t.href)}</a>`;
      case "br":
        return "\n";
      case "html":
        return /^<br\s*\/?>$/i.test(t.text) ? "\n" : escapeHtml(t.text);
      case "text":
        return t.tokens ? inline(t.tokens) : escapeHtml(t.text);
      case "escape":
        return escapeHtml(t.text);
      // The list marker shows task checkboxes.
      case "checkbox":
        return "";
      default:
        return escapeHtml(token.raw);
    }
  }).join("");
}

/** Telegram has no list tags, so items become lines with bullets or numbers. */
function list(token: Tokens.List): string {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items.map((item, index) => {
    const bullet = token.ordered ? `${start + index}. ` : item.task ? "" : "• ";
    const marker = bullet + (item.task ? (item.checked ? "☑ " : "☐ ") : "");
    return marker + indent(blocks(item.tokens, "\n"), " ".repeat(marker.length));
  }).join("\n");
}

/** Indent continuation lines. <pre> keeps whitespace, so code blocks are left alone. */
function indent(html: string, pad: string): string {
  return html.replace(/<pre>[\s\S]*?<\/pre>|\n(?!<pre>)/g, (match) => (match === "\n" ? `\n${pad}` : match));
}

/** Telegram has no tables, so the columns are aligned in a monospace block. */
function table(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows].map((row) => row.map((cell) => plain(cell.tokens)));
  const widths = token.header.map((_, column) => Math.max(...rows.map((row) => visibleWidth(row[column]))));
  const lines = rows.map((row) => row.map((cell, column) => {
    const space = " ".repeat(widths[column] - visibleWidth(cell));
    return token.align[column] === "right" ? space + cell : cell + space;
  }).join(" | ").trimEnd());
  lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("-+-"));
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/** Inline content without tags, because <pre> cannot contain other formatting. */
function plain(tokens: Token[]): string {
  return tokens.map((token) => {
    const t = token as MarkedToken;
    switch (t.type) {
      case "strong":
      case "em":
      case "del":
      case "link":
        return plain(t.tokens);
      case "text":
        return t.tokens ? plain(t.tokens) : t.text;
      case "codespan":
      case "escape":
      case "image":
        return t.text;
      case "br":
        return " ";
      case "html":
        return /^<br\s*\/?>$/i.test(t.text) ? " " : t.text;
      default:
        return token.raw;
    }
  }).join("");
}
