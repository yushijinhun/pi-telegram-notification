/** How much of the first prompt /ls shows. */
export const FIRST_PROMPT_CHARS = 120;

/** A prompt on one line and shortened, or undefined when it has no text. */
export function promptLine(content: string | Array<{ type: string; text?: string }>): string | undefined {
  const text = typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(" ");
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return clip(line, FIRST_PROMPT_CHARS);
}

/**
 * Cut text to max characters and mark the cut with an ellipsis. Counts Unicode code
 * points, so a cut never leaves half an emoji's surrogate pair.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
