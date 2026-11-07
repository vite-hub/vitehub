---
title: Channels server API
description: Send messages through a named Channel from an H3 or Nitro handler, add connectors, and read the receipt.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Send from an H3 or Nitro handler

`useChannel()` returns at once. `send()` calls the connector and returns `[null, receipt]` or `[error, null]`. Check the error first. The receipt has the Channel, connector, ViteHub delivery id, and optional provider message id.

The provider `id` must be a string. Other values are left out of receipts and logs.

Clients share one definition load per runtime registry. A failed load retries on the next send. A new registry clears the cache.

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

Each delivery tries to log `outbound.started`, then `outbound.completed` or `outbound.failed`, as JSON events in the `vitehub.channel.send` scope. Input and definition-load failures return before logging. Logging failures do not change the result.

Events have `deliveryId`, Channel, connector, and any provider message id or error message, but never message text or connector options.

::warning
Failed events keep up to 2,000 characters of the error message. Remove credentials and message content from provider errors before your connector throws.
::

Set up a log drain to keep the events. Channels only sends and keeps no state. Use Agent Channels to receive and recover messages.

The connector gets the same options object, with `connector` when set, so identity, methods, and private state stay intact.

## Add another connector

Add an entry to `connectors` to deliver through another provider. Each entry has its own options: Telegram can need `chatId`, Slack `channelId` and optional `threadTs`.

```ts
const [error] = await useChannel('alerts').send('Build finished.', {
  connector: 'slack',
  channelId: 'builds',
  threadTs: '1730000000.000100',
})
if (error) throw error
```

With more than one connector, set `connector` in each call so it shows where it delivers.

## Send through a Chat channel

Each Chat channel in `vite-hub/agent/channels` has a ready connector: `teams.connector()`, `slack.connector()`, `discord.connector()`, and `telegram.connector()`. Each sends Markdown through one Chat SDK adapter. `thread`, `idempotencyKey`, and `replace` need KV.

```ts [server/channels/teams/index.ts]
import { teams } from 'vite-hub/agent/channels'
import { defineOutboundChannel } from 'vite-hub/channels'

export default defineOutboundChannel({
  connectors: { teams: teams.connector() },
  defaultConnector: 'teams',
})
```

| Connector | Adapter | `thread` | `replace` |
| --- | --- | --- | --- |
| `teams.connector()` | Built like the `teams()` Agent Channel, from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, and `TEAMS_API_URL`. Install `@chat-adapter/teams`. | Yes | Yes |
| `slack.connector({ adapter })` | Required. Your adapter, such as `createSlackAdapter()` from `@chat-adapter/slack`. | Yes | Yes |
| `discord.connector()` | Built like `discord({ adapter: true })`, from `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_PUBLIC_KEY`. Install `@chat-adapter/discord`. | No | Yes |
| `telegram.connector()` | Built from `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API_BASE_URL`. | No | Yes |

Each also accepts `{ adapter }`: your adapter, or a function that returns it. Without `thread` support, a send with `thread` throws a `TypeError`.

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
| `recipient` | A Chat SDK thread ID where the bot got a message, or `user:<id>` for a direct message. |
| `thread` | Optional. Sends with the same `key` reply under one root. ViteHub posts the root once, from `root` or the first text, and stores it in KV. The recipient must be a channel without a message ID. |
| `idempotencyKey` | Optional. A repeated key for the same recipient returns the stored receipt and posts nothing. |
| `update` | Optional. With `idempotencyKey`, a repeated key edits the stored message and returns the same receipt. Without a stored receipt, it posts as usual. |
| `replace` | Optional. Needs `idempotencyKey`. Set it to the `idempotencyKey` of an earlier send to the same `recipient` and `thread`, not this send's key. After this send posts or edits, ViteHub deletes that message and its receipt. Without a stored receipt, it deletes nothing. |

Use `update` to keep one message current, such as a status card:

```ts
const [error] = await useChannel('teams').send(`Build ${buildId}: ${status}`, {
  recipient: teamsChannelThreadId,
  idempotencyKey: `build:${buildId}:status`,
  update: true,
})
if (error) throw error
```

Teams and Slack do not notify users of edits. To notify, post the result as new and use `replace` to delete the temporary message:

```ts
const options = { recipient: teamsChannelThreadId, thread: { key: `ticket:${ticketId}`, root: `Ticket ${ticketId}` } }
const [draftingError] = await useChannel('teams').send('Drafting a suggested reply...', { ...options, idempotencyKey: `ticket:${ticketId}:drafting` })
if (draftingError) throw draftingError
const [error] = await useChannel('teams').send(suggestion, {
  ...options,
  idempotencyKey: `ticket:${ticketId}:suggestion`,
  replace: `ticket:${ticketId}:drafting`,
})
if (error) throw error
```

Set `thread.root` on the first send so the temporary message is a reply, not the root. Replacing the root throws a `TypeError` before any post or edit, so the thread and receipts stay.

ViteHub stores the new receipt, then deletes the old message. A failed delete returns the error, and a retry with the same options deletes again. A message the platform no longer has counts as deleted.

ViteHub keeps roots and receipts in KV under the channel name, such as `teams:` or `slack:`, until you remove them. Sends with the same key run in order within one process.

::warning
Two processes that send with the same new key at the same time can each post a root. Keep one sender per key, or one replica.
::
