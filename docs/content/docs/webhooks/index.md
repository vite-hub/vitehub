---
title: Webhooks
layout: landing
navigation.title: Overview
description: Send your app's events to a URL outside the app, signed and retried, with a durable debounce such as 30 minutes, on every host.
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
| Definition | `server/webhooks/<name>.ts` names the receiver URL and the secret by their server variables. The file name is the webhook name, and `sendWebhook()` types it. |
| Signature | Each delivery has an HMAC-SHA256 signature in the GitHub form (`x-hub-signature-256`) or the Stripe form (`stripe-signature`). |
| Storage | Each delivery is a row of the Default Database, so it survives a restart or a deploy. |
| Debounce | With `debounce`, sends in the window collapse into one delivery with the last body. |
| Retries | The Queue tries a failed delivery again with the same delivery id, 4 attempts in all. |
| Inspection | `vite-hub/webhooks/runtime` lists, flushes, cancels, and redelivers deliveries. |

## Webhooks or Queue

Does the job go to a URL outside your app? Then use Webhooks. Does your own code do the job? Then use [Queue](/docs/queue). Webhooks uses Queue to send each delivery. To receive a webhook from Stripe or GitHub, use [`verifyWebhook()`](/docs/env/webhooks).

## Next

- [Get started](/docs/webhooks/get-started): send a signed webhook from a ViteHub app.
- [Comments to a T3 Code thread](/docs/webhooks/t3-code-thread): start a T3 Code thread 30 minutes after the last comment.
- [Send events](/docs/webhooks/send-events): Forms, Blob, Content, and Auth events.
- [Failure alerts](/docs/webhooks/failure-alerts): a message in Slack when an Agent Invocation, a Workflow run, or a Schedule run fails.
- [Server API](/docs/webhooks/server-api): `defineWebhook()`, `sendWebhook()`, the headers, and the delivery functions.
