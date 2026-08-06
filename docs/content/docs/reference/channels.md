---
title: Channels
description: Define named delivery channels with provider-specific connectors.
navigation.order: 31
icon: i-lucide-radio-tower
---

`vite-hub/channels` is the server primitive for named outbound message destinations. A Channel owns its connector configuration, while callers select the connector through typed send options.

```ts [server/channels/alerts.ts]
import { defineChannel } from 'vite-hub/channels'

export default defineChannel({
  connectors: {
    telegram: {
      async send(text, { chatId }: { chatId: string }) {
        return await sendTelegramMessage(chatId, text)
      },
    },
  },
})
```

Use the discovered Channel by name. `useChannel` is synchronous; delivery remains asynchronous.

```ts
import { useChannel } from 'vite-hub/channels'

const channel = useChannel('alerts')

await channel.send('Build finished.', {
  connector: 'telegram',
  chatId,
})
```

Connector options are discriminated by `connector`, so a Slack connector can expose `channelId` and `threadTs` without weakening Telegram's `chatId` type. The result is normalized with the logical channel name, connector name, and provider message id when one is available.

For Vite projects, use `<path>.channel.ts` such as `src/alerts.channel.ts`. Nuxt and Nitro projects use `server/channels/<path>.ts`; the same Definition and runtime API work in both environments. Enable discovery with `vitehub({ channels: true })` when using the ViteHub framework plugin.

This primitive is separate from `vite-hub/agent/channels`. Agent Channels continue to own Agent conversation origins, inbound events, and Agent delivery policy; ordinary Channels provide reusable server-side delivery without changing the Agent API.
