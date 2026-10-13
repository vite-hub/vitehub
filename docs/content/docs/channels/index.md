---
title: Channels
navigation.title: Overview
description: Define named server delivery channels and send through a selected connector.
navigation.order: 1
icon: i-lucide-send
---

::product-hero{tagline="Send outbound messages to a named destination from server code, through connectors you write and select per call." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno" channels="Telegram, Slack, Your API" channel-mode="custom"}
  :::code-group
  ```ts [Definition]
  import { defineOutboundChannel } from 'vite-hub/channels'
  import { useServerEnv } from '#vitehub/env/server'

  type TelegramOptions = {
    chatId: string
  }

  export default defineOutboundChannel({
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

  ```ts [Route]
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

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { channelDelivery } from 'vite-hub/agent/capabilities'
  import { useChannel } from 'vite-hub/channels/server'
  import bot from '../agents/bot/agent'

  const reportAgent = defineAgent({
    extends: bot,
    name: 'weekly-report',
    capabilities: [
      channelDelivery({
        channel: useChannel('teams'),
        options: { recipient: 'user:7b0bff9d' },
        description: 'Send the finished weekly report. Call once.',
        required: true,
      }),
    ],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="Send through your own connector" icon="i-lucide-plug" to="/docs/channels/get-started"}
  Discovers `server/channels` and `.channel.ts`; each connector owns its `send()`.
  :::

  :::product-feature-item{title="Handle delivery results" icon="i-lucide-code-2" to="/docs/channels/server-api"}
  Returns `[null, receipt]` or `[error, null]` with the delivery id.
  :::

  :::product-feature-item{title="One destination, several providers" icon="i-lucide-blocks" to="/docs/channels/server-api#add-another-connector"}
  Name `connector` at each call site, such as `telegram` or `slack`.
  :::

  :::product-feature-item{title="Inspect delivery events" icon="i-lucide-activity" to="/docs/channels/server-api#send-from-an-h3-or-nitro-handler"}
  `outbound.*` events omit message text and connector options.
  :::

  :::product-feature-item{title="The application picks the recipient" icon="i-lucide-bot" to="/docs/channels/agent-capability"}
  `channelDelivery()` fixes Channel and options; the model writes the message.
  :::

  :::product-feature-item{title="Receive messages with Agent Channels" icon="i-lucide-radio" to="/docs/agents/channels"}
  Use Agent Channels when the destination starts an Invocation.
  :::
::
