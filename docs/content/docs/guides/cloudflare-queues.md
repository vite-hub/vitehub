---
title: Use Cloudflare Queues in a Vite app with ViteHub
description: Use Cloudflare Queues from a Vite app with ViteHub. Define a queue in one file, and the build writes the Worker producer and consumer config for you.
navigation.title: Cloudflare Queues
navigation.order: 25
navigation.group: Server work
icon: i-simple-icons-cloudflare
---

Set `host: 'cloudflare'` and `queue: true` in `vitehub()`, and add one file per queue in `server/queues/`. A route calls `sendQueue()` to send a job. The build writes each queue's producer binding and consumer into `.output/server/wrangler.json`. `vitehub provision run` creates the queues, and the same Worker runs the handler when Cloudflare delivers a batch.

## What Cloudflare Queues is

[Cloudflare Queues](https://developers.cloudflare.com/queues/) is the message queue of Cloudflare Workers, on the Free and Paid plans. A Worker sends messages through a producer binding. A consumer Worker gets them in batches, and Cloudflare retries failed messages.

You write the handler and the send call. ViteHub makes the bindings, queue names, and consumer entry, and the same files run on [Vercel Queues](/docs/guides/vercel-queues) with another host.

## Set up Cloudflare Queues

### Enable Queue with the Cloudflare host

```bash [Terminal]
pnpm add vite-hub @vite-hub/queue
pnpm add -D wrangler
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', queue: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', queue: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', queue: true })],
})
```
:::
::

The `cloudflare` host picks the Cloudflare Queue Provider and Worker output. `vitehub()` includes the Nitro Vite plugin. Wrangler runs the built Worker locally and reads its logs. See [Queue configuration](/docs/queue/configure).

### Define a queue

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

// The file name is the queue name: welcome-email
export default defineQueue<{ email: string }>(async ({ payload, id, attempts }) => {
  console.log(`Welcome job ${id} for ${payload.email}, attempt ${attempts}`)
})
```

::warning
Cloudflare can deliver the same message twice. A handler that sends mail or charges a card must first check that the work is not done yet.
::

### Send a job from a route

```ts [server/api/signup.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { sendQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await sendQueue('welcome-email', { email: body.email.trim() }, {
    delaySeconds: 60,
  })
  if (error) throw error
  return result
})
```

`sendQueue()` returns `[error, result]`. When Cloudflare accepts the job, `result` is `{ status: 'queued', messageId }`, not the handler's result. `messageId` is ViteHub's id; Cloudflare never sees it and gives the handler its own id.

Cloudflare accepts `delaySeconds` and `contentType` (`'bytes'`, `'json'`, `'text'`, or `'v8'`). To send many jobs at once, call `sendBatch()` on `useQueue('welcome-email')`. See [Queue server API](/docs/queue/server-api#queue-enqueue-options).

## What the build generates

ViteHub builds the Cloudflare names from the queue name and the app name. The app name comes from `vitehub({ name })`, then `WRANGLER_CI_OVERRIDE_NAME` in Workers Builds, then `package.json`. For an app named `my-app`:

| Item | Value for `welcome-email` |
| --- | --- |
| Producer binding | `QUEUE_77656C636F6D652D656D61696C` |
| Queue name | `my-app-queue--77656c636f6d652d656d61696c` |
| Consumer | One `queues.consumers` entry for that queue |

The binding and Cloudflare queue name hold the queue name in hexadecimal. A Cloudflare queue name over 63 characters becomes a readable prefix plus a digest. Do not use these names in your code; pass the queue name to `sendQueue()`. See [Cloudflare names](/docs/queue/configure#cloudflare-names).

Nitro's `cloudflare:queue` hook runs the consumer in the same Worker as your routes.

## Handle failed messages

A handler that returns acknowledges the message. One that throws gets a Cloudflare retry, except for Queue errors a retry cannot fix. For another action, return from `onError`:

- `'ack'` drops the message.
- `'retry'` retries it.
- `{ retry: { delaySeconds } }` retries it later.
- Nothing keeps the default.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'
import { getViteHubErrorShape, ViteHubError } from 'vite-hub/runtime'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  if (!payload.email.includes('@')) {
    throw new ViteHubError('WELCOME_INVALID_EMAIL', 'The welcome job has no valid email.')
  }
  // Send the email here
}, {
  concurrency: 5,
  onError: error => getViteHubErrorShape(error)?.code === 'WELCOME_INVALID_EMAIL'
    ? 'ack'
    : { retry: { delaySeconds: 30 } },
})
```

`concurrency` sets how many batches run at once. The default is `1`. See [Queue Definition options](/docs/queue/configure#queue-definition-options) and [Handle failures](/docs/queue/server-api#handle-failures).

## How to use Cloudflare Queues locally

`pnpm dev` runs jobs in the dev server, with no binding or account. It uses Cloudflare's defaults: 4 attempts, an instant retry, `delaySeconds` up to 24 hours, and payloads up to 128 KB. It does not run batches or call `onError`. See [Dev delivery](/docs/queue/limits-and-errors#dev-delivery).

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
pnpm vitehub queue jobs list
```

The handler logs to the dev server output. `vitehub queue jobs list` shows pending, running, and dead jobs. After a fix, `vitehub queue jobs retry <message-id>` reruns a dead job.

To check the Cloudflare output, build and inspect the found queues and the config:

```bash [Terminal]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect output
```

The list must include `welcome-email`, and `.output/server/wrangler.json` must have `queues.producers` and `queues.consumers` entries. To run the built Worker and its batches on your machine, use Wrangler:

```bash [Terminal]
pnpm wrangler dev --config .output/server/wrangler.json
```

Wrangler runs them through Miniflare. See Cloudflare's [Queues local development](https://developers.cloudflare.com/queues/configuration/local-development/) for its limits.

## Deploy to Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token must be allowed to create Queues and deploy Workers. Preview, then create the queues:

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build again and deploy with Nitro:

```bash [Terminal]
pnpm build
pnpm exec nitro deploy --prebuilt
```

Stream the Worker logs in one terminal and send a job from another:

```bash [Terminal]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

```bash [Terminal]
curl -X POST https://your-worker.workers.dev/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. The handler log shows in the tail when Cloudflare delivers the batch. [Process a welcome job with Queue](/docs/queue/get-started) covers these steps with checks. See [Provisioning](/docs/development/provisioning) and [Cloudflare](/docs/frameworks-hosts/cloudflare) for host setup.

## Cloudflare Queues limits

Cloudflare sets these limits. Read [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) before production.

| Limit | Value |
| --- | --- |
| Message size | 128 KB, with about 100 bytes of internal metadata. |
| Batch size | 100 messages or 256 KB in total. |
| Delivery delay | Up to 24 hours. |
| Retries | Up to 100. |
| Message retention | 24 hours on Workers Free. Up to 14 days on Workers Paid. |
| Throughput | 5,000 messages per second per queue. |
| Consumer invocations | 250 at once. |
| Consumer duration | 15 minutes of wall clock time. |

ViteHub writes each consumer entry with the queue name only, so Cloudflare's default batch and retry settings apply and there is no dead letter queue. A queue name that needs a digest also needs the `nodejs_compat` flag, or the build fails with `QUEUE_CRYPTO_UNAVAILABLE`. See [Queue limits and errors](/docs/queue/limits-and-errors) for all error codes.

## Move the same queue to another host

The queue file and route stay the same. To move to Vercel Queues:

1. Change `host: 'cloudflare'` to `host: 'vercel'`.
2. Install `@vercel/queue`.
3. Remove `contentType` from `sendQueue()` calls. Vercel returns `QUEUE_UNSUPPORTED_OPTION` for it.
4. Replace `onError` with `callbackOptions.retry`, which returns `{ acknowledge: true }`, `{ afterSeconds }`, or `undefined`. `concurrency` applies only to Cloudflare.

See [Vercel Queues](/docs/guides/vercel-queues) for all steps. Self-hosted Node uses the local provider. Deno has no Queue Provider. See [Queue hosts](/docs/queue/hosts) and the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix).
