---
title: Webhooks
layout: landing
navigation.title: Overview
description: Send your app's events to external URLs with HMAC signatures, retries, and a durable debounce window, such as 30 minutes, on every host.
navigation.order: 1
icon: i-lucide-webhook
---

::product-hero{tagline="Call sendWebhook() from any callback. ViteHub stores the delivery, signs it, waits for the debounce, and retries." hosts="Node, Docker, Cloudflare, Vercel"}
  :::code-tree
  ```ts [server/webhooks/t3.ts]
  import { defineWebhook } from 'vite-hub/webhooks'

  // One file is one webhook. The values are names of server variables.
  export default defineWebhook({
    url: 'T3_WEBHOOK_URL',
    secret: 'T3_WEBHOOK_SECRET',
    debounce: '30 minutes',
  })
  ```

  ```ts [server/comments.ts]
  import { defineComments } from 'vite-hub/comments'
  import { sendWebhook } from 'vite-hub/webhooks'

  // 10 comments in 30 minutes give one delivery with the last body
  export const comments = defineComments({
    onComment: async ({ thread, message }) => {
      const [error] = await sendWebhook('t3', { thread: thread.id, message: message.body }, { event: 'comments.comment' })
      if (error) console.error(error)
    },
  })
  ```

  ```bash [.env]
  T3_WEBHOOK_URL=https://example.com/hooks/vitehub
  T3_WEBHOOK_SECRET=...
  ```
  :::
::

## What you get

| Part | What it does |
| --- | --- |
| Definition | `server/webhooks/<name>.ts` names the target URL and secret by their server variables. The file name is the webhook name, and `sendWebhook()` types it. |
| Signature | Each delivery has an HMAC-SHA256 signature in GitHub (`x-hub-signature-256`) or Stripe (`stripe-signature`) format. |
| Storage | Each delivery is stored in the Default Database so it survives restarts and deploys. |
| Debounce | With `debounce`, sends within the window collapse into one delivery with the latest body. |
| Retries | Queue retries a failed delivery under the same delivery ID, up to 4 attempts in total. |
| Inspection | `vite-hub/webhooks/runtime` lists, flushes, cancels, and redelivers deliveries. |

## Webhooks or Queue

Use Webhooks when the job goes to a URL outside your app. Use [Queue](/docs/queue) when your own code does the job. Webhooks uses Queue to send each delivery. To receive a webhook from Stripe or GitHub, use [`verifyWebhook()`](/docs/env/webhooks).

## Next

- [Get started](/docs/webhooks/get-started) sends a signed webhook from a ViteHub app.
- [Comments to a T3 Code thread](/docs/webhooks/t3-code-thread) starts a T3 Code thread 30 minutes after the last comment.
- [Send events](/docs/webhooks/send-events) forwards Forms, Blob, Content, and Auth events.
- [Failure alerts](/docs/webhooks/failure-alerts) posts to Slack when an Agent Invocation, Workflow run, or Schedule run fails.
- [Server API](/docs/webhooks/server-api) covers `defineWebhook()`, `sendWebhook()`, headers, and delivery helpers.
