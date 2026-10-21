# pi-telegram-notification

Opt-in Telegram notifications when Pi stops working.

## Install

```sh
cd /path/to/pi-telegram-notification
npm install
pi install /path/to/pi-telegram-notification
```

Pi does not install dependencies for packages installed from a local path, so run `npm install` first. Run `/reload` in an existing Pi session.

## Configure

Create `~/.pi/agent/telegram-notification.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "botToken": "123456789:your_bot_token",
  "chatId": "your_chat_id"
}
```

Set the file permissions to `600`. Both fields are required. Credentials are read again before each send, so edits take effect immediately. This extension sends directly through Telegram's Bot API; it does not run the `tg` script.

## Use

- `/notify` toggles notifications.
- `/notify on` enables them.
- `/notify off` disables them.

Notifications default to **off** on each session start, session switch, and `/reload`. If credentials are missing or invalid, `/notify` reports an error and leaves notifications off.

While enabled, ` [Notification On]` appears inline in Pi's stats footer, alongside other inline extensions such as pi-token-speed. It uses the built-in footer's render method, so it requires Pi's standard footer.

One notification is sent when the complete agent run settles, after automatic retries, compaction, and queued follow-ups. Successful runs, final errors, and user aborts all notify. Enabling notifications itself does not send a message.

The message contains the hostname, session name or ID, working directory, and the final assistant text or error, limited to Telegram's message size. Thinking and tool output are omitted.

Messages are sent as Telegram [rich messages](https://core.telegram.org/bots/api#rich-messages) (Bot API 10.1), which Telegram renders from the assistant's Markdown: headings, lists, task lists, tables, code blocks, quotes, footnotes, formulas, and images. Older Telegram apps may not display rich messages correctly. Replies are limited to about 32,000 characters and cut at a paragraph or other block boundary.

The Markdown is adjusted so Telegram shows what Pi shows:

- LaTeX in `$...$`, `\(...\)`, `$$...$$`, `\[...\]`, or a bare display environment such as `\begin{aligned}`, the forms [pi-math](https://github.com/monotykamary/pi-math) renders, becomes a Telegram formula. A dollar sign that pi-math would not treat as a formula, as in `$5 and $10`, stays text.
- Raw HTML, HTML entities, `==`, `||`, and `*` or `_` surrounded by spaces stay text. Telegram would otherwise read them as tags, highlights, spoilers, or italics.
- Code is sent unchanged.

Images are found the way pi-markdown-images finds them: `![alt](path-or-url "title")` with an absolute path, a path relative to Pi's working directory, `~/`, `file://`, or a base64 `data:` URL is uploaded with the message. PNG, JPEG, WebP, and GIF (as a still image) are supported. Telegram fetches HTTP(S) images itself. Images larger than a Telegram photo allows (10 MB, width plus height over 10,000 pixels, or an aspect ratio over 20:1) are sent as files. The title, or else the alt text, becomes the caption. Each image is placed on its own line, because Telegram drops the caption of an image that shares a line with text. Images in table cells, missing files, and unsupported formats are shown as a link or as their caption and path. A message has at most 50 images and 50 MB of uploads.

If Telegram rejects the rich message, for example because an image URL cannot be downloaded, the extension sends it again with images as links and paths, then as Telegram HTML, then as plain text. The receipt shows which format was sent and Telegram's reason. The HTML version is limited to 4,000 characters. It keeps bold, italic, strikethrough, code, links, and quotes, turns headings into bold lines, lists into bulleted or numbered lines, and tables into aligned monospace blocks, and shows formulas as LaTeX source. Telegram formats at most 100 spans in an HTML message and shows the rest unformatted.

Every delivery adds a persistent receipt to the conversation. Delivery failures add an error receipt. Expand a receipt to see its timestamp and message. Receipts do not trigger another model turn. Sends have a 15-second timeout, or 60 seconds for a message with images, and use a separate cancellation signal so aborting the agent can still notify.

## Development

```sh
npm install
npm run typecheck
npm test
```

Pi 1.2.0 or newer is required for `agent_settled` and custom entry rendering.
