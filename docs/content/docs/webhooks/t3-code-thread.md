---
title: Comments to a T3 Code thread
description: Start a new T3 Code thread 30 minutes after the last comment on your site, with a signed webhook and a T3 scheduled task.
navigation.title: Comments to T3 Code
navigation.order: 7
icon: i-lucide-message-square-text
---

People comment on your site. 30 minutes after the last comment, T3 Code starts a new thread that reads the comment. The debounce keeps one busy discussion from starting 10 threads.

You need [Comments](/docs/comments/with-vite-hub) in a ViteHub app, with `queue` and `database` on, as in [Get started](/docs/webhooks/get-started#install-webhooks).

::tip
This page sends every comment of the site to one T3 task that you set up. For each person to hand the comments of a page to their own T3 thread, with one click in the comment pill, use [Send](/docs/comments/send): `defineComments({ send: true })`, and no webhook file.
::

## Define the webhook

```ts [server/webhooks/t3.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'T3_WEBHOOK_URL',
  secret: 'T3_WEBHOOK_SECRET',
  signature: 'github',
  debounce: '30 minutes',
})
```

`signature: 'github'` is the default. It sends `x-hub-signature-256: sha256=<hex>`, which T3 Code checks.

## Send each comment

Call `sendWebhook()` from `onComment`. Comments runs it for each new thread and each reply:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { sendWebhook } from 'vite-hub/webhooks'

export const comments = defineComments({
  onComment: async ({ thread, message }) => {
    const [error] = await sendWebhook('t3', {
      thread: { id: thread.id, n: thread.n, page: thread.subject.id },
      message: { author: message.author.name ?? message.author.id, body: message.body },
    }, { event: 'comments.comment' })
    if (error) console.error(error)
  },
})
```

All sends of `t3` share one debounce, so T3 gets the last comment. To start one T3 thread for each comment thread, pass `key: thread.id`. Then each comment thread has its own 30 minute wait.

A failed send never fails the comment. Comments logs a thrown error, and the code above logs the returned one.

## Create the T3 task

In T3 Code, create a scheduled task that runs on a webhook, such as with the `schedule_task` tool. These are its fields:

```json [t3-task.json]
{
  "title": "Site comments",
  "prompt": "A reader commented on the site.\n\nThread: {{body.thread}}\nComment: {{body.message}}\n\nRead the page, then answer or fix what the comment asks.",
  "bindToCurrentThread": false,
  "schedule": {
    "type": "webhook",
    "dedupe": { "replayKey": "{{headers.x-vitehub-delivery}}" },
    "signature": {
      "header": "x-hub-signature-256",
      "encoding": "hex",
      "prefix": "sha256=",
      "secret": "<the same value as T3_WEBHOOK_SECRET>"
    }
  }
}
```

- `bindToCurrentThread: false` starts a new thread for each run.
- The replay key is the delivery id. When the Queue tries a delivery again, T3 runs it once.
- `{{body.thread}}` and `{{body.message}}` read the JSON body of the delivery. T3 writes an object as JSON.
- The signature fields match what ViteHub sends: HMAC-SHA256 of the raw body, hex, after `sha256=`.

T3 shows the endpoint URL of the task. When it shows only a path, the T3 server has no public URL, and your app cannot reach it.

## Set the variables

Set both variables in `.env` for `vite dev`, and as secrets on the host for production. The URL can hold a token, so keep it secret too:

```bash [.env]
# The endpoint URL that T3 shows for the task
T3_WEBHOOK_URL=https://...
T3_WEBHOOK_SECRET=...
```

Generate the secret once, for example with `openssl rand -hex 32`, and put the same value in the T3 task.

## Check it

Comment on a page. `listPendingWebhookDeliveries()` shows the delivery with its `dueAt`. To skip the wait while you test, flush it:

```ts [server/utils/flush-t3.ts]
import { flushWebhookDelivery, listPendingWebhookDeliveries } from 'vite-hub/webhooks/runtime'

/** Delivers the pending T3 delivery now. Call it from a test or a protected route. */
export async function flushT3() {
  const [error, pending] = await listPendingWebhookDeliveries({ webhook: 't3' })
  if (error) throw error
  for (const delivery of pending) {
    const [flushError] = await flushWebhookDelivery(delivery.id)
    if (flushError) throw flushError
  }
}
```

A new T3 thread starts with the comment in its prompt. When T3 answers with a status that is not 2xx, the Queue tries again. See [Limits and errors](/docs/webhooks/limits-and-errors#delivery).
