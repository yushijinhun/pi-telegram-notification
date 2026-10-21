# pi-telegram-notification

Opt-in Telegram notifications when Pi stops working.

## Install

```sh
pi install /path/to/pi-telegram-notification
```

Run `/reload` in an existing Pi session.

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

Every delivery adds a persistent receipt to the conversation. Delivery failures add an error receipt. Expand a receipt to see its timestamp and message. Receipts do not trigger another model turn. Sends have a 15-second timeout and use a separate cancellation signal so aborting the agent can still notify.

## Development

```sh
npm install
npm run typecheck
npm test
```

Pi 1.2.0 or newer is required for `agent_settled` and custom entry rendering.
