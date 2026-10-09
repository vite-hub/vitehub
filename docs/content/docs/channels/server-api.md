---
title: Channels server API
description: Send messages through a named Channel and read the delivery receipt.
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
