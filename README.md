# pi-telegram-notification

Opt-in Telegram notifications when Pi stops working, and [remote control](#remote-control) of Pi sessions by replying in Telegram.

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
- `/notify last` sends the last response now, for when you forgot to enable notifications. It does not turn notifications on.

Notifications default to **off** on each session start, session switch, and `/reload`. If credentials are missing or invalid, `/notify` reports an error and leaves notifications off.

While enabled, ` [Notification On]` appears inline in Pi's stats footer, alongside other inline extensions such as pi-token-speed. It uses the built-in footer's render method, so it requires Pi's standard footer.

One notification is sent when the complete agent run settles, after automatic retries, compaction, and queued follow-ups. Successful runs, final errors, and user aborts all notify. Enabling notifications itself does not send a message.

`/notify last` reads the last assistant response on the current branch of the session, so it also works after `/reload`, `/resume`, or `/tree`. It sends the same message a notification would, with the status taken from how that response ended. While Pi is working, it reports an error; use `/notify on` to be notified when the run stops.

The message contains the status, session name or ID, working directory, and the final assistant text or error, limited to Telegram's message size. Thinking and tool output are omitted.

Messages are sent as Telegram [rich messages](https://core.telegram.org/bots/api#rich-messages) (Bot API 10.1), which Telegram renders from the assistant's Markdown: headings, lists, task lists, tables, code blocks, quotes, footnotes, formulas, and images. Older Telegram apps may not display rich messages correctly. Replies are limited to about 32,000 characters and cut at a paragraph or other block boundary.

The Markdown is adjusted so Telegram shows what Pi shows:

- LaTeX in `$...$`, `\(...\)`, `$$...$$`, `\[...\]`, or a bare display environment such as `\begin{aligned}`, the forms [pi-math](https://github.com/monotykamary/pi-math) renders, becomes a Telegram formula. A dollar sign that pi-math would not treat as a formula, as in `$5 and $10`, stays text.
- Raw HTML, HTML entities, `==`, `||`, and `*` or `_` surrounded by spaces stay text. Telegram would otherwise read them as tags, highlights, spoilers, or italics.
- Code is sent unchanged.

Images are found the way pi-markdown-images finds them: `![alt](path-or-url "title")` with an absolute path, a path relative to Pi's working directory, `~/`, `file://`, or a base64 `data:` URL is uploaded with the message. PNG, JPEG, WebP, and GIF (as a still image) are supported. Telegram fetches HTTP(S) images itself. Images larger than a Telegram photo allows (10 MB, width plus height over 10,000 pixels, or an aspect ratio over 20:1) are sent as files. The title, or else the alt text, becomes the caption. Each image is placed on its own line, because Telegram drops the caption of an image that shares a line with text. Images in table cells, missing files, and unsupported formats are shown as a link or as their caption and path. A message has at most 50 images and 50 MB of uploads.

If Telegram rejects the rich message, for example because an image URL cannot be downloaded, the extension sends it again with images as links and paths, then as Telegram HTML, then as plain text. The receipt shows which format was sent and Telegram's reason. The HTML version is limited to 4,000 characters. It keeps bold, italic, strikethrough, code, links, and quotes, turns headings into bold lines, lists into bulleted or numbered lines, and tables into aligned monospace blocks, and shows formulas as LaTeX source. Telegram formats at most 100 spans in an HTML message and shows the rest unformatted.

Every delivery adds a persistent receipt to the conversation. Delivery failures add an error receipt. Expand a receipt to see its timestamp and message. Receipts do not trigger another model turn. Sends have a 15-second timeout, or 60 seconds for a message with images, and use a separate cancellation signal so aborting the agent can still notify.

## Remote control

A daemon polls the bot and passes your Telegram messages to running Pi sessions over a Unix socket. It also starts sessions in WezTerm, and opens closed ones again.

### Start the daemon

Run these in this repository's directory:

```sh
mkdir -p ~/.config/systemd/user
sed "s|/path/to/pi-telegram-notification|$PWD|" systemd/pi-telegram-remote.service \
  > ~/.config/systemd/user/pi-telegram-remote.service
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram-remote
```

Then run `/reload` in running Pi sessions so they connect. See the log with `journalctl --user -u pi-telegram-remote -f`. Node.js 22.18 or newer runs `daemon.ts` directly.

The daemon reads `telegram-notification.json` when it starts, so restart it after editing the file. It needs `remote.userId`, your Telegram user ID, and `chatId` must be the same number: your private chat with the bot. Otherwise it does not start. The other two settings are optional:

```json
{
  "botToken": "123456789:your_bot_token",
  "chatId": "your_user_id",
  "remote": { "userId": your_user_id, "awayOnLock": true, "staleMinutes": 10 }
}
```

Telegram lets one process poll a bot. Another one gets HTTP 409, which the log shows. Run one daemon per bot token: pi on a second computer needs its own bot.

Only `remote.userId` can use the bot. The daemon asks Telegram for messages and button presses only, and drops each one that is not from that user in their private chat with the bot. This includes messages in groups, messages sent on behalf of a chat, through a business account, or to the bot as a guest, and buttons of inline-mode messages. The daemon does not answer them, and logs them at most once a minute for each sender. Whoever controls that Telegram account can make Pi run commands on this computer.

On the computer, the daemon creates its socket with mode 600, and Pi connects only to a socket that the same user owns.

### Talk to a session

Every interactive Pi session connects to the daemon when it starts, whether notifications are on or not. `pi -p` and RPC sessions do not.

- **Reply** to any message about a session to send it a prompt: a notification, an entry of `/ls`, an answer, or your own earlier message. The session takes it like Enter in the editor: an idle session starts a run, and a working one gets it as a steering message. The daemon reacts with 👀 when Pi has taken the message. The answer comes back as a reply to your message, even with notifications off.
- If the session is closed, the daemon opens it again with `pi --session` in a new WezTerm tab first.
- If you quote part of a message in the reply, the quote goes before your text.
- **Attachments**: photos, files, audio, voice messages, videos, video messages, and stickers are saved under `~/.pi/agent/telegram-remote/files/YYYY-MM-DD/`, and the prompt lists their paths with type, size, and length. Pi decides how to use them, for example by transcribing a voice message. An album becomes one prompt. Bots can download files of up to 20 MB.
- A message that is **not a reply** gets buttons: one for each running session, and **New session…**.
- A **command** sent as a reply runs in that session as if you typed it on the computer, idle or working: built-in commands such as `/model sonnet` or `/session`, extension commands, skills, and prompt templates. Extensions cannot submit Pi's editor, so the extension puts the command in the editor and presses Enter through `wezterm cli send-text`. Text already in the editor is put back afterwards. The reply says when the command ran, and the new model if it changed. A command that opens a picker, such as `/resume`, opens it on the computer. `/model` without a model name is the exception: the bot shows the session's models as buttons.
- Outside WezTerm, only what the extension API can run works, while the session is idle: extension commands, skills, prompt templates, `/compact [instructions]`, and `/reload`.

If Pi does not start working on a prompt within 10 seconds, for example because its model has no API key, the daemon replies with an error instead of 👀. A prompt that arrives while Pi compacts the conversation waits until compaction finishes, and the daemon says so.

### Bot commands

- `/ls` lists running sessions, one message each, with the name, directory, first prompt, state, and notification setting. Its buttons send the last answer, stop the run, and turn notifications on or off.
- `/model` shows the models of the session you reply to as buttons, with the current one marked. Choosing a model changes it for that session only. `/model provider/model` in a reply still runs Pi's own command. The session must run the current extension: reload it after updating the extension.
- `/new [directory] [prompt]` starts Pi in a new WezTerm tab. The directory is a path, or the start of a directory name from past sessions, as in `/new robo fix the loader`. Without one match, buttons offer the matching or recent directories. As a reply, it uses that session's directory. Attachments go with the prompt.
- `/stop` stops the session you reply to. Without a reply, it stops the only working session, or asks which one.
- `/reload` reloads the session you reply to, or every running session without a reply, for example after updating an extension. A working session reloads when it stops. Only a command handler can reload Pi, so the extension adds `/telegram-reload` for this.
- `/help` explains the above.

To start Pi, the daemon runs `wezterm cli --prefer-mux spawn` into the first window of the WezTerm mux server, then waits up to 45 seconds for the new Pi to connect from that pane (`WEZTERM_PANE`). The mux server's `PATH` must find `pi`. `PI_TELEGRAM_WEZTERM` and `PI_TELEGRAM_PI` override the two commands.

### Away mode

While the GNOME screen is locked, every session notifies when it stops, as if `/notify on` were set. The daemon watches `org.gnome.ScreenSaver` with `gdbus`. Set `"awayOnLock": false` to turn this off.

### Late messages

Telegram keeps messages for the bot for up to 24 hours, so messages sent while the computer sleeps arrive when it wakes up. A message that arrives more than `staleMinutes` (default 10) after you sent it waits for its **Send** or **Discard** button.

### Files

- `~/.pi/agent/telegram-remote/messages.jsonl` records which session each Telegram message belongs to. Pi sessions add their notifications, and the daemon adds its own messages and yours.
- `~/.pi/agent/telegram-remote/state.json` holds the Telegram update offset, so a restart does not handle a message twice.
- `$XDG_RUNTIME_DIR/pi-telegram-remote.sock` is the socket. `PI_TELEGRAM_SOCKET` overrides it, for the daemon and for Pi.

## Development

```sh
npm install
npm run typecheck
npm test
```

The remote-control tests run the daemon and a Pi session in one process against a fake Bot API. `PI_TELEGRAM_API_BASE` points the daemon and the extension at another Bot API server.

Pi 1.2.0 or newer is required for `agent_settled` and custom entry rendering.
