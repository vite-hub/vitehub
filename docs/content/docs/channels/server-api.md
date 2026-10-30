---
title: Channels server API
description: Send messages through a named Channel from an H3 or Nitro handler, add connectors, and read the delivery receipt.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Send from an H3 or Nitro handler

`useChannel()` returns immediately. `send()` performs the connector call and returns `[null, receipt]` on success or `[error, null]` on failure. The receipt has the Channel name, connector name, ViteHub delivery id, and optional provider message id. Check the error before using the receipt.

The optional provider `id` must be a string. Unreadable or non-string IDs are omitted from successful receipts and delivery logs.

Named clients share one definition load for the active runtime registry. A failed load can retry on a later send. Replacing the runtime registry invalidates the cached definition for existing clients.

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', {
    connector: 'telegram',
    chatId: 'build-room',
  })
  if (error) throw error
  return receipt
})
```

The handler returns a result like this:

```json
{
  "channel": "alerts",
  "connector": "telegram",
  "deliveryId": "e4875238-2922-4787-9f7f-b13e2e7839be",
  "id": "1730000000000"
}
```

For each connector delivery, Channels attempts to write `outbound.started` and either `outbound.completed` or `outbound.failed` JSON events under the `vitehub.channel.send` scope. Input validation and definition-loading failures return before delivery logging starts. Logging is best effort. A logging failure does not change the send result.

The events include `deliveryId`, Channel, connector, and, when available, a provider message id or error message. ViteHub omits message text and connector options. Failed events include up to 2,000 characters of the thrown error message, so connectors must redact credentials and message content before throwing provider errors.

Configure the application's log drain to retain received events. This outbound-only package has no State Adapter. Use Agent Channels when inbound custody and recovery are required.

Channels passes the original options object to the selected connector, including the `connector` selector when supplied. It preserves object identity, methods, and private state.

## Add another connector

Add another entry to `connectors` when the same logical destination can deliver through more than one provider. Each entry defines its own options, so Telegram can require `chatId` while Slack requires `channelId` and optionally accepts `threadTs`.

```ts
const [error] = await useChannel('alerts').send('Build finished.', {
  connector: 'slack',
  channelId: 'builds',
  threadTs: '1730000000.000100',
})
if (error) throw error
```

Keep `connector` explicit when a Channel has more than one delivery path. This makes the delivery choice visible at each call site.

## Send to Microsoft Teams

`teams.connector()` from `vite-hub/agent/channels` is a ready connector for Microsoft Teams. It builds the same adapter as the `teams()` Agent Channel, from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, and `TEAMS_API_URL`. Install `@chat-adapter/teams`, and enable KV when you use `thread` or `idempotencyKey`.

```ts [server/channels/teams/index.ts]
import { teams } from 'vite-hub/agent/channels'
import { defineOutboundChannel } from 'vite-hub/channels'

export default defineOutboundChannel({
  connectors: { teams: teams.connector() },
  defaultConnector: 'teams',
})
```

```ts
const [error] = await useChannel('teams').send('**Build failed**', {
  recipient: teamsChannelThreadId,
  thread: { key: `build:${buildId}`, root: `Build ${buildId}` },
  idempotencyKey: `build:${buildId}:failed`,
})
if (error) throw error
```

| Option | Value |
| --- | --- |
| `recipient` | A Teams thread ID that the bot received a message in, or `user:<id>` for a direct message. |
| `thread` | Optional. Every send with the same `key` replies under one root message in a Teams channel. ViteHub posts the root once, from `root` or else from the first text, and stores its thread in KV. The recipient must be a channel without a message ID. |
| `idempotencyKey` | Optional. A repeated key for the same recipient returns the stored receipt and posts nothing. |
| `update` | Optional. With `idempotencyKey`, a repeated key edits the stored message to the new text and returns the same receipt. Without a stored receipt, ViteHub posts as usual. |
| `replace` | Optional. The `idempotencyKey` of an earlier send to the same `recipient` and `thread`. After this send posts or edits its message, ViteHub deletes the message stored for that key and removes its receipt. Without a stored receipt, ViteHub deletes nothing. It must not equal the `idempotencyKey` of this send. |

Use `update` to keep one message current, such as a status card that changes as work progresses:

```ts
const [error] = await useChannel('teams').send(`Build ${buildId}: ${status}`, {
  recipient: teamsChannelThreadId,
  idempotencyKey: `build:${buildId}:status`,
  update: true,
})
if (error) throw error
```

Use `replace` to remove a temporary message when the final message must be new. Teams does not notify users when a message is edited, so post the result as a new message and let ViteHub delete the temporary one:

```ts
const options = { recipient: teamsChannelThreadId, thread: { key: `ticket:${ticketId}` } }
const [draftingError] = await useChannel('teams').send('Drafting a suggested reply...', { ...options, idempotencyKey: `ticket:${ticketId}:drafting` })
if (draftingError) throw draftingError
const [error] = await useChannel('teams').send(suggestion, {
  ...options,
  idempotencyKey: `ticket:${ticketId}:suggestion`,
  replace: `ticket:${ticketId}:drafting`,
})
if (error) throw error
```

ViteHub stores the new receipt first and then deletes the replaced message. If the delete fails, the send returns the error. A retry with the same options returns the stored receipt and tries the delete again. A message that Teams no longer has counts as deleted.

ViteHub stores roots and receipts in KV under `teams:` and keeps them until you remove them. Sends with the same key run one after another within one process. Two processes that send with the same new key at the same time can each post a root, so keep one sender per key or one replica.
