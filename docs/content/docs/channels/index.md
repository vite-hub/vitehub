---
title: Channels
navigation.title: Overview
description: Send messages from your server to Slack, Telegram, or any service through a named Channel.
navigation.order: 1
icon: i-lucide-send
---

::product-hero{tagline="Send messages to Slack, Telegram, or your own API from server code, through one named destination." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno" channels="Telegram, Slack, Your API" channel-mode="custom"}
  :::product-files
  ```ts [server/channels/alerts.ts]
  import {
    defineOutboundChannel,
  } from 'vite-hub/channels'
  import { postToSlack } from '../utils/slack'

  // The file name makes this the "alerts" Channel.
  // Each connector is one way to deliver a message.
  export default defineOutboundChannel({
    connectors: {
      // Prints to the terminal while you test
      log: {
        send(text: string, meta: { label: string }) {
          console.log(`[${meta.label}] ${text}`)
          return { id: `log-${meta.label}` }
        },
      },
      slack: { send: postToSlack },
    },
  })
  ```

  ```ts [server/utils/slack.ts]
  import { useServerEnv } from '#vitehub/env/server'

  // Post to a Slack incoming webhook.
  // Declare the URL as a secret in vite.config.ts.
  export async function postToSlack(text: string) {
    const env = useServerEnv()
    const url = env.slack.webhookUrl.unseal()
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) throw new Error('Slack failed')
    return {}
  }
  ```

  ```ts [server/api/builds.post.ts]
  import { defineEventHandler } from 'h3'
  import { useChannel } from 'vite-hub/channels/server'

  export default defineEventHandler(async () => {
    // Choose the connector on each send
    const [error, receipt] = await useChannel('alerts')
      .send('Build finished.', { connector: 'slack' })
    // A failed send returns an error, not a throw
    if (error) throw error
    return receipt
  })
  ```

  ```ts [server/api/test-alert.post.ts]
  import { defineEventHandler } from 'h3'
  import { useChannel } from 'vite-hub/channels/server'

  // Each connector takes its own options
  export default defineEventHandler(async () => {
    const [error, receipt] = await useChannel('alerts')
      .send('Test alert.', {
        connector: 'log',
        label: 'test',
      })
    if (error) throw error
    return receipt
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file for each destination" icon="i-lucide-file-code-2" to="/docs/channels/get-started#define-a-named-channel"}
  Add a file to `server/channels`. Its name is the Channel name.
  :::

  :::product-feature-item{title="You write the delivery code" icon="i-lucide-plug" to="/docs/channels/server-api#add-another-connector"}
  A connector is a `send()` function you write. One Channel can have several, such as Slack and Telegram.
  :::

  :::product-feature-item{title="Pick the connector on each send" icon="i-lucide-route" to="/docs/channels/server-api#add-another-connector"}
  Name the connector in each call, so it is clear where a message goes.
  :::

  :::product-feature-item{title="Errors without try and catch" icon="i-lucide-code-2" to="/docs/channels/server-api#send-from-an-h3-or-nitro-handler"}
  `send()` returns `[null, receipt]` or `[error, null]`. The receipt has a delivery id.
  :::

  :::product-feature-item{title="Logs without message text" icon="i-lucide-activity" to="/docs/channels/server-api#send-from-an-h3-or-nitro-handler"}
  Each send logs when it starts and when it ends. The logs leave out the message text and options.
  :::

  :::product-feature-item{title="Test before you add a service" icon="i-lucide-terminal" to="/docs/channels/get-started#send-and-verify-one-delivery"}
  A connector that prints to the terminal lets you check your code first.
  :::
::
