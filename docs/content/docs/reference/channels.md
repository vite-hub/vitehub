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

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true })],
})
```

## Define a named Channel

Create `server/channels/alerts.ts`. The connector function receives the message text and only the options for that connector. Replace the example `console.info` call with your provider client.

```ts [server/channels/alerts.ts]
import { defineChannel } from 'vite-hub/channels'

type TelegramOptions = {
  chatId: string
}

export default defineChannel({
  connectors: {
    telegram: {
      async send(text: string, { chatId }: TelegramOptions) {
        console.info(`[telegram:${chatId}] ${text}`)
        return { id: `${chatId}:${Date.now()}` }
      },
    },
  },
})
```

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
  "id": "build-room:1730000000000"
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
