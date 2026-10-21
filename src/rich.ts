import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token } from "marked";
import { truncate, type NotificationContent } from "./format.ts";

/** Rich messages allow 32768 characters. This keeps a margin below that. */
export const RICH_MESSAGE_LIMIT = 32_000;
/** Telegram allows 50 media per rich message, 10 MB per photo and 50 MB per uploaded file. */
const MAX_MEDIA = 50;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface RichFile {
  /** Multipart field name, and the id in its tg://photo?id= or tg://document?id= link. */
  id: string;
  /** Images that Telegram does not accept as photos are sent as files. */
  kind: "photo" | "document";
  name: string;
  type: string;
  data: Uint8Array<ArrayBuffer>;
}

export interface RichMessage {
  markdown: string;
  /** Local images uploaded with the message. */
  files: RichFile[];
  /** The same message with images as links, or undefined if it shows no images. */
  withoutImages?: string;
}

/** Markdown for Telegram's sendRichMessage. */
export async function formatRichMessage(content: NotificationContent): Promise<RichMessage> {
  // A backslash at the end of a line is a line break.
  const header = [
    `Message from ${escapeMarkdown(content.host)}:`,
    `**Pi ${escapeMarkdown(content.status)}**`,
    `Session: ${escapeMarkdown(content.session)}`,
    `Directory: ${escapeMarkdown(content.cwd)}`,
  ].join("\\\n");
  const withHeader = (body: string) => [header, body.replace(/^\n+|\s+$/g, "")].filter(Boolean).join("\n\n");
  if (!content.detail) return { markdown: header, files: [] };

  const budget = RICH_MESSAGE_LIMIT - header.length - 2;
  if (!content.markdown) {
    // Escaping makes the text at most five times longer (& becomes &amp;).
    return { markdown: withHeader(plainText(truncate(content.detail, Math.floor(budget / 5)))), files: [] };
  }
  const body = await convertMarkdown(content.detail, content.cwd, budget);
  return {
    markdown: withHeader(body.markdown),
    files: body.files,
    withoutImages: body.withoutImages === body.markdown ? undefined : withHeader(body.withoutImages),
  };
}

/** Characters that Telegram's rich Markdown accepts backslash escapes for. */
const ESCAPABLE = new Set("\\_*[]()~`>#+-=|{}.!$");

function escapeChar(char: string): string {
  if (char === "<") return "&lt;";
  if (char === "&") return "&amp;";
  return ESCAPABLE.has(char) ? `\\${char}` : char;
}

/** Text that Telegram shows as written. */
export function escapeMarkdown(text: string): string {
  return Array.from(text, escapeChar).join("");
}

/** Plain text, keeping its line breaks. */
function plainText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").map((line) => escapeMarkdown(line.trim())).join("\\\n"))
    .join("\n\n");
}

interface ImageRef {
  raw: string;
  href: string;
  alt: string;
  title?: string;
  inTable: boolean;
}

async function convertMarkdown(markdown: string, cwd: string, budget: number) {
  const media = new Media(cwd);
  let withImages = "";
  let withoutImages = "";
  for (const token of Lexer.lex(markdown)) {
    // Top-level code blocks are copied unchanged. rewrite() skips code inside lists and quotes.
    const segments = token.type === "code"
      ? [token.raw]
      : rewrite(token.raw, collectImages([token]), token.type === "table");
    let block = "";
    let blockWithoutImages = "";
    for (const segment of segments) {
      const [shown, linked] = typeof segment === "string" ? [segment, segment] : await media.render(segment);
      block += shown;
      blockWithoutImages += linked;
    }
    if (Math.max(withImages.length + block.length, withoutImages.length + blockWithoutImages.length) > budget) {
      // Cut at a block boundary. A single block longer than the limit is cut anywhere.
      if (!withImages) {
        withImages = truncate(block, budget);
        withoutImages = truncate(blockWithoutImages, budget);
      }
      break;
    }
    withImages += block;
    withoutImages += blockWithoutImages;
  }
  const used = new Set(Array.from(withImages.matchAll(/tg:\/\/(?:photo|document)\?id=([\w-]+)/g), (match) => match[1]));
  return { markdown: withImages, withoutImages, files: media.files.filter((file) => used.has(file.id)) };
}

function collectImages(tokens: Token[], inTable = false, images: ImageRef[] = []): ImageRef[] {
  for (const token of tokens) {
    const t = token as MarkedToken;
    if (t.type === "image") {
      images.push({
        raw: t.raw,
        href: t.href,
        alt: t.text.replace(/\\([!-/:-@[-`{-~])/g, "$1"),
        title: t.title ?? undefined,
        inTable,
      });
    } else if (t.type === "table") {
      for (const cell of [...t.header, ...t.rows.flat()]) collectImages(cell.tokens, true, images);
    } else if (t.type === "list") {
      collectImages(t.items, inTable, images);
    } else if ("tokens" in t && t.tokens) {
      collectImages(t.tokens, inTable, images);
    }
  }
  return images;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const FENCE_PREFIX = /^[ \t]*(?:(?:>|(?:[-+*]|\d{1,9}[.)])[ \t])[ \t]*)*$/;
/** Quote markers, list markers and indentation at the start of a line. */
const CONTAINER_PREFIX = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)*[ \t]*/;
const AUTOLINK_OR_BREAK = /^<(?:[A-Za-z][A-Za-z\d+.-]{1,31}:[^\s<>]*|[^\s@<>]+@[^\s@<>]+|br\s*\/?)>/i;
const ENTITY = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i;
// The display environments pi-math renders without $$ delimiters.
const MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "displaymath", "math", "align", "align*", "alignat", "alignat*",
  "flalign", "flalign*", "gather", "gather*", "multline", "multline*", "split", "aligned",
  "alignedat", "gathered", "array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix",
  "Vmatrix", "cases", "CD",
]);

/**
 * Rewrite one top-level Markdown block so Telegram shows what Pi shows.
 * - \(...\), \[...\] and \begin{...} formulas, which pi-math renders, become $...$ and $$...$$.
 * - Text that Pi shows as written is escaped: dollar signs outside formulas, raw HTML, entities,
 *   and ==, || and spaced * or _, which Telegram reads as highlights, spoilers or italics.
 * - Images are returned as separate segments, each on its own line.
 * Code and formulas are copied unchanged.
 */
function rewrite(src: string, images: ImageRef[], table: boolean): Array<string | ImageRef> {
  const segments: Array<string | ImageRef> = [];
  let text = "";
  // Output since the last line break.
  let tail = "";
  let i = 0;
  const emit = (output: string) => {
    text += output;
    const lineBreak = output.lastIndexOf("\n");
    tail = lineBreak < 0 ? tail + output : output.slice(lineBreak + 1);
  };
  const copyTo = (end: number) => {
    emit(src.slice(i, end));
    i = end;
  };
  const replace = (length: number, replacement: string) => {
    emit(replacement);
    i += length;
  };

  while (i < src.length) {
    const char = src[i]!;
    if (char === "`" || char === "~") {
      const end = fenceEnd(src, i);
      if (end >= 0) {
        copyTo(end);
        continue;
      }
    }
    if (char === "`") {
      copyTo(codeSpanEnd(src, i));
    } else if (char === "\\") {
      const math = bracketMath(src, i);
      const next = src[i + 1];
      if (math) replace(math.length, math.text);
      else if (next && ASCII_PUNCTUATION.test(next)) replace(2, escapeChar(next));
      else replace(1, char);
    } else if (char === "$") {
      const end = dollarMathEnd(src, i);
      if (end >= 0) copyTo(end);
      else replace(1, "\\$");
    } else if (char === "<") {
      const kept = AUTOLINK_OR_BREAK.exec(src.slice(i, i + 2048));
      if (kept) copyTo(i + kept[0].length);
      else replace(1, "&lt;");
    } else if (char === "&") {
      replace(1, ENTITY.test(src.slice(i, i + 34)) ? "&amp;" : "&");
    } else if (char === "!" && src[i + 1] === "[" && images.some((image) => src.startsWith(image.raw, i))) {
      // Images marked could not locate, such as alt text spanning quoted lines, are skipped.
      const image = images.splice(0, images.findIndex((image) => src.startsWith(image.raw, i)) + 1).at(-1)!;
      const line = lineAt(src, i);
      // Telegram drops the caption of an image that shares its line, so it gets a line in the same
      // list item or quote. Images in links, tables and headings, and custom emoji, stay in place.
      const separate = !image.inTable && !/^tg:/i.test(image.href) && !/^[ \t]*#{1,6}(?:[ \t]|$)/.test(line.text);
      const prefix = CONTAINER_PREFIX.exec(line.text)![0];
      const lineBreak = `\n${prefix.replace(/[-+*]|\d{1,9}[.)]/g, (marker) => " ".repeat(marker.length))}`;
      const before = tail.replace(CONTAINER_PREFIX, "");
      if (separate && before.trim() && !before.trimEnd().endsWith("[")) emit(lineBreak);
      segments.push(text, image);
      text = "";
      tail = image.raw;
      i += image.raw.length;
      const after = src.slice(i, line.start + line.text.length);
      if (separate && after.trim() && !after.trimStart().startsWith("]")) {
        emit(lineBreak);
        i += after.length - after.trimStart().length;
        // The text after the image now starts a line, where it must not become a list, heading or quote.
        const marker = /^(?:(?:[-+*]|\d{1,9}[.)])(?=[ \t])|[#>])/.exec(src.slice(i, i + 12));
        if (marker) replace(marker[0].length, marker[0].slice(0, -1) + escapeChar(marker[0].at(-1)!));
      }
    } else if (char === "*" || char === "_" || char === "=" || char === "|") {
      const length = runLength(src, i, char);
      replace(length, keepRun(src, i, length, table) ? src.slice(i, i + length) : `\\${char}`.repeat(length));
    } else {
      replace(1, char);
    }
  }
  segments.push(text);
  return segments;
}

function runLength(src: string, i: number, char: string): number {
  let end = i;
  while (src[end] === char) end++;
  return end - i;
}

function lineAt(src: string, i: number): { start: number; text: string } {
  const start = src.lastIndexOf("\n", i - 1) + 1;
  const end = src.indexOf("\n", i);
  return { start, text: src.slice(start, end < 0 ? src.length : end) };
}

/** End of a fenced code block in a list or quote, or -1. */
function fenceEnd(src: string, i: number): number {
  const char = src[i]!;
  const length = runLength(src, i, char);
  const line = lineAt(src, i);
  if (length < 3 || !FENCE_PREFIX.test(src.slice(line.start, i))) return -1;
  // Backtick fences cannot contain backticks in the info string; that is inline code.
  if (char === "`" && src.slice(i + length, line.start + line.text.length).includes("`")) return -1;
  const closing = new RegExp(`^[ \\t>]*[${char}]{${length},}[ \\t]*$`);
  for (let start = src.indexOf("\n", i) + 1; start > 0 && start < src.length;) {
    const end = src.indexOf("\n", start);
    const stop = end < 0 ? src.length : end;
    if (closing.test(src.slice(start, stop))) return stop;
    start = end + 1;
  }
  return src.length;
}

/** End of the inline code span starting at i, or the end of its backticks if it is not closed. */
function codeSpanEnd(src: string, i: number): number {
  const length = runLength(src, i, "`");
  for (let j = src.indexOf("`", i + length); j >= 0;) {
    const run = runLength(src, j, "`");
    if (run === length) return j + run;
    j = src.indexOf("`", j + run);
  }
  return i + length;
}

function isEscaped(src: string, i: number): boolean {
  let count = 0;
  while (src[i - 1 - count] === "\\") count++;
  return count % 2 === 1;
}

function findUnescaped(src: string, sequence: string, from: number): number {
  for (let i = src.indexOf(sequence, from); i >= 0; i = src.indexOf(sequence, i + 1)) {
    if (!isEscaped(src, i)) return i;
  }
  return -1;
}

/** A \(...\), \[...\] or \begin{...} formula at i, rewritten with dollar delimiters. */
function bracketMath(src: string, i: number): { length: number; text: string } | undefined {
  const next = src[i + 1];
  if (next === "(" || next === "[") {
    const end = findUnescaped(src, next === "(" ? "\\)" : "\\]", i + 2);
    const latex = end < 0 ? "" : src.slice(i + 2, end);
    if (!latex.trim()) return undefined;
    return { length: end + 2 - i, text: next === "(" ? `$${latex.trim()}$` : `$$${latex}$$` };
  }
  const environment = /^\\begin\{([A-Za-z]+\*?)\}/.exec(src.slice(i, i + 32));
  if (!environment || !MATH_ENVIRONMENTS.has(environment[1]!)) return undefined;
  const pattern = /\\(begin|end)\{([^{}]+)\}/g;
  pattern.lastIndex = i + environment[0].length;
  const open = [environment[1]!];
  for (let match; (match = pattern.exec(src));) {
    if (match[1] === "begin") open.push(match[2]!);
    else if (open.at(-1) === match[2] && open.pop() && !open.length) {
      const end = match.index + match[0].length;
      const delimiter = environment[1] === "math" ? "$" : "$$";
      return { length: end - i, text: `${delimiter}${src.slice(i, end)}${delimiter}` };
    }
  }
  return undefined;
}

/**
 * End of a $$...$$ or $...$ formula at i, or -1. Like pi-math, a single dollar opens a formula
 * only if it is followed by a non-space, and the next dollar on the line closes it only if it
 * follows a non-space and is not followed by a digit. "$5 and $10" is not a formula.
 */
function dollarMathEnd(src: string, i: number): number {
  if (src[i + 1] === "$") {
    const end = findUnescaped(src, "$$", i + 2);
    return end >= 0 && src.slice(i + 2, end).trim() ? end + 2 : -1;
  }
  if (!src[i + 1] || /\s/u.test(src[i + 1]!)) return -1;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\n") return -1;
    if (src[j] === "\\") j++;
    else if (src[j] === "$") {
      return /\s/u.test(src[j - 1]!) || src[j + 1] === "$" || /\d/.test(src[j + 1] ?? "") ? -1 : j + 1;
    }
  }
  return -1;
}

/** Keep a run of *, _, = or | that Pi reads the same way as Telegram. */
function keepRun(src: string, i: number, length: number, table: boolean): boolean {
  const char = src[i]!;
  const line = lineAt(src, i);
  if (char === "|") return length === 1 || table;
  // Pi has no ==highlight==. Setext heading underlines stay.
  if (char === "=") return length === 1 || /^[ \t>]*=+[ \t]*$/.test(line.text);
  // Horizontal rules and * list markers.
  if (/^[ \t>]*([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(line.text)) return true;
  const after = src[i + length] ?? "\n";
  if (char === "*" && length === 1 && /^[ \t>]*$/.test(src.slice(line.start, i)) && /[ \t]/.test(after)) {
    return true;
  }
  // Telegram reads "2 * 3 * 4" as italics. In CommonMark, a run must be left- or right-flanking.
  const before = src[i - 1] ?? "\n";
  const space = (c: string) => /\s/u.test(c);
  const punctuation = (c: string) => /[\p{P}\p{S}]/u.test(c);
  const left = !space(after) && (!punctuation(after) || space(before) || punctuation(before));
  const right = !space(before) && (!punctuation(before) || space(after) || punctuation(after));
  return left || right;
}

type ImageSource =
  | { kind: "telegram" }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "data"; url: string };

/** Image sources resolved like pi-markdown-images. */
function resolveSource(href: string, cwd: string): ImageSource | undefined {
  if (!href || /[\x00-\x1f\x7f]/.test(href)) return undefined;
  try {
    // Telegram's own custom emoji and date links.
    if (/^tg:/i.test(href)) return { kind: "telegram" };
    if (/^data:/i.test(href)) return { kind: "data", url: href };
    if (/^https?:/i.test(href)) return { kind: "url", url: new URL(href).href };
    if (/^file:/i.test(href)) return { kind: "file", path: fileURLToPath(href) };
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
    // marked percent-encodes spaces in destinations.
    const path = decodeURIComponent(href);
    return { kind: "file", path: path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path) };
  } catch {
    return undefined;
  }
}

class Media {
  readonly files: RichFile[] = [];
  private readonly uploads = new Map<string, RichFile>();
  private readonly cwd: string;
  private count = 0;
  private bytes = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** The image as Markdown, and as a link or text for when Telegram rejects the images. */
  async render(image: ImageRef): Promise<[string, string]> {
    const source = resolveSource(image.href, this.cwd);
    if (source?.kind === "telegram") return [image.raw, image.raw];
    const label = image.title || image.alt;
    const fallback = imageFallback(label, source);
    // Telegram removes images in table cells.
    if (!source || image.inTable || this.count >= MAX_MEDIA) return [fallback, fallback];
    const url = source.kind === "url" ? source.url : await this.upload(source);
    if (!url) return [fallback, fallback];
    this.count++;
    // Telegram shows the title as the caption and ignores the alt text, so the alt text becomes the title.
    return [`![](${encodeUrl(url)}${label ? ` "${caption(label)}"` : ""})`, fallback];
  }

  private async upload(source: { kind: "file"; path: string } | { kind: "data"; url: string }) {
    const key = source.kind === "file" ? source.path : source.url;
    let file = this.uploads.get(key);
    if (!file) {
      const data = source.kind === "file" ? await readImageFile(source.path) : decodeDataUrl(source.url);
      const type = data && sniffImage(data);
      if (!data || !type || this.bytes + data.length > MAX_UPLOAD_BYTES) return undefined;
      const id = `image${this.files.length + 1}`;
      file = {
        id,
        kind: fitsPhoto(data, type) ? "photo" : "document",
        name: source.kind === "file" ? basename(source.path) : `${id}.${type.slice("image/".length)}`,
        type,
        data,
      };
      this.files.push(file);
      this.uploads.set(key, file);
      this.bytes += data.length;
    }
    return `tg://${file.kind}?id=${file.id}`;
  }
}

function imageFallback(label: string, source: ImageSource | undefined): string {
  if (source?.kind === "url") return `[${escapeMarkdown(label || source.url)}](${encodeUrl(source.url)})`;
  if (source?.kind === "file") return `${label ? `${escapeMarkdown(label)} ` : ""}${codeSpan(source.path)}`;
  return escapeMarkdown(label || "image");
}

/** Captions are parsed as Markdown. Quotes would end the title. */
function caption(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, " ").trim()).replaceAll('"', "&quot;");
}

function encodeUrl(url: string): string {
  return url.replace(/[\s()<>"]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function codeSpan(text: string): string {
  const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

async function readImageFile(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let file;
  try {
    // A FIFO at the path must not block the notification.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) return undefined;
    return new Uint8Array(await file.readFile());
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

function decodeDataUrl(url: string): Uint8Array<ArrayBuffer> | undefined {
  const match = /^data:image\/[\w.+-]+;base64,([A-Za-z\d+/]*={0,2})$/i.exec(url);
  if (!match || match[1]!.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) return undefined;
  return new Uint8Array(Buffer.from(match[1]!, "base64"));
}

function sniffImage(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Telegram photos are at most 10 MB, 10000 pixels in width plus height, with a 20:1 aspect ratio. */
function fitsPhoto(data: Uint8Array, type: string): boolean {
  if (data.length > MAX_PHOTO_BYTES) return false;
  const size = getImageDimensions(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), type);
  if (!size || size.widthPx < 1 || size.heightPx < 1) return false;
  const [short, long] = [size.widthPx, size.heightPx].sort((a, b) => a - b) as [number, number];
  return short + long <= 10_000 && long <= 20 * short;
}
