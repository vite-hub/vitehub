---
title: Channels
description: Define named server delivery channels and send through a selected connector.
navigation.order: 31
icon: i-lucide-radio-tower
---

`vite-hub/channels` gives server code one named destination for outbound messages. You define the connectors that a Channel can use, then call `useChannel(name).send(text, options)` from an H3 or Nitro handler.

## Enable Channel discovery

Add the Channels integration to your Vite config. ViteHub then discovers files below `server/channels` and files that end in `.channel.ts`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true })],
  env: {
    server: {
      telegram: {
        botToken: env({
          secret: true,
          source: env.source('TELEGRAM_BOT_TOKEN'),
        }),
      },
    },
  },
})
```

## Define a named Channel

Create `server/channels/alerts.ts`. Read typed Server Env inside the connector's `send()` method so the value is resolved when the message is delivered. Unseal a secret only when the provider call needs the raw value.

```ts [server/channels/alerts.ts]
import { defineChannel } from 'vite-hub/channels'
import { useServerEnv } from '#vitehub/env/server'

type TelegramOptions = {
  chatId: string
}

export default defineChannel({
  connectors: {
    telegram: {
      async send(text: string, { chatId }: TelegramOptions) {
        const { telegram } = useServerEnv()
        const response = await fetch(`https://api.telegram.org/bot${telegram.botToken.unseal()}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })
        if (!response.ok) throw new Error(`Telegram returned ${response.status}.`)
        const result = await response.json() as { result?: { message_id?: number } }
        return { id: result.result?.message_id?.toString() }
      },
    },
  },
})
```

This example calls Telegram directly to keep the connector contract visible; use a provider client when your application already has one. Channels does not bundle provider adapters. For a connector that does not need credentials, omit the `useServerEnv()` call.

The file name becomes the Channel name. For a Vite suffix definition, use `src/alerts.channel.ts` instead; both forms discover the same `alerts` Channel.

## Send from an H3 or Nitro handler

`useChannel()` returns immediately. `send()` performs the connector call and returns a normalized result with the Channel name, connector name, and optional provider message id.

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  return await useChannel('alerts').send('Build finished.', {
    connector: 'telegram',
    chatId: 'build-room',
  })
})
```

The handler returns a result like this:

```json
{
  "channel": "alerts",
  "connector": "telegram",
  "id": "1730000000000"
}
```

## Add another connector

Add another entry to `connectors` when the same logical destination can deliver through more than one provider. Each entry defines its own options, so Telegram can require `chatId` while Slack requires `channelId` and optionally accepts `threadTs`.

```ts
await useChannel('alerts').send('Build finished.', {
  connector: 'slack',
  channelId: 'builds',
  threadTs: '1730000000.000100',
})
```

Keep `connector` explicit when a Channel has more than one delivery path. This makes the delivery choice visible at each call site.

## Know what this primitive includes

Channels provide discovery, connector selection, and a normalized outbound send contract. The current package does not ship Telegram or Slack adapters and does not generate inbound webhook routes; implement those connectors on top of the contract or add them as a later provider package.

`vite-hub/channels` is separate from `vite-hub/agent/channels`. Ordinary Channels send application messages. Agent Channels describe Agent conversation origins, inbound events, and Agent delivery policy; the Agent API stays unchanged.

See [Agent Channels](/docs/agents/channels) when the destination starts or drives an Agent Invocation.
