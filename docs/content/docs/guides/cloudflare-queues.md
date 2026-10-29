---
title: Use Cloudflare Queues in a Vite app with ViteHub
description: Use Cloudflare Queues from a Vite app with ViteHub. Define a queue in one file, and the build writes the Worker producer and consumer config for you.
navigation.title: Cloudflare Queues
navigation.order: 25
navigation.group: Server work
icon: i-simple-icons-cloudflare
---

To use Cloudflare Queues from a Vite app, set `preset: 'cloudflare'` and `queue: true` in `vitehub()`, and add one file per queue in `server/queues/`. A route calls `runQueue()` to send a job. The build writes the producer binding and the consumer for each queue into `.output/server/wrangler.json`. `vitehub provision run` creates the queues, and the same Worker runs the handler when Cloudflare delivers a batch.

## What Cloudflare Queues is

[Cloudflare Queues](https://developers.cloudflare.com/queues/) is the message queue of Cloudflare Workers. A Worker sends messages through a producer binding. A consumer Worker receives them in batches, and Cloudflare retries the messages that fail. Cloudflare Queues is available on the Workers Free and Workers Paid plans.

ViteHub generates the binding names, the queue names, and the consumer entry from your queue files. You write the handler and the call that sends the job. The same files run on [Vercel Queues](/docs/guides/vercel-queues) when you change the preset.

## Set up Cloudflare Queues

### Enable Queue with the Cloudflare preset

```bash [Terminal]
pnpm add vite-hub
pnpm add -D wrangler
```

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', queue: true })],
})
```

The `cloudflare` preset selects the Cloudflare Queue Provider and Worker output. `vitehub()` includes the Nitro Vite plugin. You use Wrangler to run the built Worker locally and to read its logs. See [Queue configuration](/docs/queue/configure) for every option.

### Define a queue

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

// The file name is the queue name: welcome-email
export default defineQueue<{ email: string }>(async ({ payload, id, attempts }) => {
  console.log(`Welcome job ${id} for ${payload.email}, attempt ${attempts}`)
})
```

Cloudflare can deliver the same message two times. A handler that sends mail or charges a card must check first that the work is not already done.

### Send a job from a route

```ts [server/api/signup.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await runQueue('welcome-email', { email: body.email.trim() }, {
    delaySeconds: 60,
  })
  if (error) throw error
  return result
})
```

`runQueue()` returns `[error, result]`. When Cloudflare accepts the job, `result` is `{ status: 'queued', messageId }`. On Cloudflare, `messageId` is the ViteHub message id. Cloudflare does not receive it, and the handler gets a different Cloudflare message id. The result does not contain the handler result.

Cloudflare accepts `delaySeconds` and `contentType` (`'bytes'`, `'json'`, `'text'`, or `'v8'`). To send many jobs in one call, use `sendBatch()` on the client from `getQueue('welcome-email')`. See [Queue server API](/docs/queue/server-api#queue-enqueue-options).

## What the build generates

ViteHub derives the Cloudflare names from the queue name and the application name. The application name comes from `vitehub({ name })`, then `WRANGLER_CI_OVERRIDE_NAME` in Workers Builds, then the `package.json` name. For an app named `my-app`:

| Item | Value for `welcome-email` |
| --- | --- |
| Producer binding | `QUEUE_77656C636F6D652D656D61696C` |
| Queue name | `my-app-queue--77656c636f6d652d656d61696c` |
| Consumer | One `queues.consumers` entry for that queue |

The binding and the queue name hold the queue name in hexadecimal. A Cloudflare queue name longer than 63 characters becomes a readable prefix and a digest. Do not use these names in application code. Use the queue name with `runQueue()`. Read [Cloudflare names](/docs/queue/configure#cloudflare-names).

Nitro's `cloudflare:queue` hook runs the consumer in the same Worker as your routes.

## Handle failed messages

When the handler returns, ViteHub acknowledges the message. When the handler throws, Cloudflare retries the message, except for Queue errors that a retry cannot fix. Use `onError` to choose another action. Return `'ack'` to drop the message, `'retry'` to retry it, `{ retry: { delaySeconds } }` to retry it later, or nothing to keep the default.

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

`concurrency` controls batch delivery concurrency. The default is `1`. See [Queue Definition options](/docs/queue/configure#queue-definition-options) and [Handle failures](/docs/queue/server-api#handle-failures).

## How to use Cloudflare Queues locally

The Vite dev server does not deliver Queue jobs. A `runQueue()` call there throws `QUEUE_BINDING_NOT_FOUND`, because the dev server has no queue binding. First, check discovery and the generated config with a build:

```bash [Terminal]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect provider-output
```

The definitions list must include `welcome-email`. `.output/server/wrangler.json` must contain the `queues.producers` and `queues.consumers` entries. To run the built Worker on your machine, start it with Wrangler:

```bash [Terminal]
pnpm wrangler dev --config .output/server/wrangler.json
```

Wrangler runs the Worker and its queues locally through Miniflare. Cloudflare documents the limits of this mode in [Queues local development](https://developers.cloudflare.com/queues/configuration/local-development/).

## Deploy to Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. The token needs permission to create Queues and deploy Workers. Preview the resources, then create the queues:

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build again and deploy with Nitro:

```bash [Terminal]
pnpm build
pnpm exec nitro deploy --prebuilt
```

Stream the Worker logs in one terminal, and send a job from another:

```bash [Terminal]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

```bash [Terminal]
curl -X POST https://your-worker.workers.dev/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. The handler log appears in the tail output when Cloudflare delivers the batch. [Process a welcome job with Queue](/docs/queue/get-started) walks through these steps with checks. Read [Provisioning](/docs/development/provisioning) and [Cloudflare](/docs/frameworks-hosts/cloudflare) for the host setup.

## Cloudflare Queues limits

These limits come from Cloudflare. Read [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) before production.

| Limit | Value |
| --- | --- |
| Message size | 128 KB, with about 100 bytes of internal metadata. |
| Batch size | 100 messages or 256 KB in total. |
| Delivery delay | Up to 24 hours. |
| Retries | Up to 100. |
| Message retention | 24 hours on Workers Free. Up to 14 days on Workers Paid. |
| Throughput | 5,000 messages per second for each queue. |
| Consumer invocations | 250 at the same time. |
| Consumer duration | 15 minutes of wall clock time. |

ViteHub writes each consumer entry with the queue name only. Cloudflare's default batch and retry settings apply, and the consumer has no dead letter queue. A queue name that needs a digest also needs the `nodejs_compat` compatibility flag, or the build fails with `QUEUE_CRYPTO_UNAVAILABLE`. For every ViteHub error code, read [Queue limits and errors](/docs/queue/limits-and-errors).

## Move the same queue to another host

The queue file and the route stay the same. To move to Vercel Queues:

1. Change `preset: 'cloudflare'` to `preset: 'vercel'`.
2. Install `@vercel/queue`.
3. Remove `contentType` from `runQueue()` calls. Vercel returns `QUEUE_UNSUPPORTED_OPTION` for it.
4. Replace `onError` with `callbackOptions.retry`, which returns `{ acknowledge: true }`, `{ afterSeconds }`, or `undefined`. `concurrency` applies only to Cloudflare.

Read [Vercel Queues](/docs/guides/vercel-queues) for the full steps. ViteHub has no Queue Provider for self-hosted Node or Deno. See [Queue hosts](/docs/queue/hosts) and the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix).
