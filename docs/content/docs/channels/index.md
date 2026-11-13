---
title: Channels
layout: landing
navigation.title: Overview
description: One connection to Slack, Teams, Stripe, or any HTTP sender, for messages in both directions.
navigation.order: 1
icon: i-lucide-send
---

::product-hero{tagline="Receive webhooks with signature checks, dedupe and retry, and send messages from any server code, through one named Channel." hosts="Node, Docker, Cloudflare, Vercel" channels="Stripe, Slack, Teams, Your API" channel-mode="custom"}
  :hero-figure{name="channels"}
::

::code-tree
```ts [server/channels/stripe.ts] fragment
import { defineChannel, stripe } from 'vite-hub/channels'
import { sendQueue } from 'vite-hub/queue'

// The file name makes this the "stripe" Channel.
export default defineChannel({
  // Checks Stripe-Signature with STRIPE_WEBHOOK_SECRET
  adapter: stripe(),
  on: {
    // Runs once per Stripe event ID, after ViteHub stores it.
    // A failed Result retries the event.
    'checkout.session.completed': event =>
      sendQueue('fulfil', event.data),
  },
})
```

```ts [server/queues/fulfil.ts]
import type { StripeEvent } from 'vite-hub/channels'
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<StripeEvent>(async ({ payload }) => {
  // Fulfil the order of payload.data.object
  console.log('fulfil', payload.data.object.id)
})
```

```ts [server/channels/slack.ts]
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack } from 'vite-hub/agent/channels'
import { defineChannel } from 'vite-hub/channels'

// The Agent that lists "slack" answers its messages.
export default defineChannel({
  adapter: slack({ adapter: createSlackAdapter() }),
})
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  channels: ['slack'],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

```ts [server/api/deploys.post.ts] fragment
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  // Send through the same Channel from any server code
  const [error, receipt] = await useChannel('slack')
    .send('Deploy finished.', { recipient: 'slack:C0123:' })
  // A failed send returns an error, not a throw
  if (error) throw error
  return receipt
})
```

:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', agent: true, channels: true, queue: true },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', agent: true, channels: true, queue: true }), nitro()],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', agent: true, channels: true, queue: true })],
})
```
:::
::

::product-features
  :::product-feature-item{title="One file for each connection" icon="i-lucide-file-code-2" to="/docs/channels/get-started"}
  Add a file to `server/channels`. Its name is the Channel name, for both directions.
  :::

  :::product-feature-item{title="Webhooks that run once" icon="i-lucide-shield-check" to="/docs/channels/server-api#receive-webhooks"}
  ViteHub checks the signature, stores the delivery, drops repeats by delivery ID, and retries the target.
  :::

  :::product-feature-item{title="A target for each event" icon="i-lucide-route" to="/docs/channels/server-api#receive-webhooks"}
  Send an event to a handler, a Queue, a Workflow, or the Agent that lists the Channel.
  :::

  :::product-feature-item{title="Send from anywhere" icon="i-lucide-code-2" to="/docs/channels/server-api#send-a-message"}
  `useChannel(name).send()` returns `[undefined, receipt]` or `[error, undefined]`.
  :::

  :::product-feature-item{title="Start a trigger from code" icon="i-lucide-timer" to="/docs/channels/server-api#start-a-trigger-from-code"}
  A Schedule starts a Channel trigger with the same delivery rules, without a fake webhook.
  :::

  :::product-feature-item{title="Logs without message text" icon="i-lucide-activity" to="/docs/channels/server-api#send-a-message"}
  Each send logs when it starts and ends. The logs leave out the text and options.
  :::
::

::agent-only{skill="channels"}
A Channel is one connection to a platform, defined once in `server/channels/<name>.ts` with `defineChannel({ adapter, on })` from `vite-hub/channels`. Use it for both directions: inbound webhooks go to the `on` targets (a handler, a Queue or Workflow through a handler, or a `defineChannelTrigger()`), or to the Agent that lists the Channel in `defineAgent({ channels: ['name'] })`. Outbound messages go through `useChannel(name).send()` from any server code. `sendChannelTrigger(name, trigger, input)` starts a trigger from code, such as a Schedule, with the same delivery rules as a webhook.

Use `stripe()` or `webhook({ signature, secret })` from `vite-hub/channels` for HTTP senders, and `slack()`, `teams()`, `discord()`, `telegram()`, `github()`, or `gmail()` from `vite-hub/agent/channels` for chat, forge, and mail. Inbound Channels need `agent: true` next to `channels: true`. Keep secrets in Server Env and never parse or verify a webhook by hand.

Prove one signed delivery reaching its target, one duplicate that does not run twice, and one outbound send with its receipt.
::
