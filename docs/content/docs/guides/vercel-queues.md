---
title: Use Vercel Queues in a Vite app with ViteHub
description: Use Vercel Queues from a Vite app with ViteHub. Define a queue in one file, send jobs with runQueue(), and let a private Vercel Function run each job.
navigation.title: Vercel Queues
navigation.order: 24
navigation.group: Server work
icon: i-simple-icons-vercel
---

To use Vercel Queues from a Vite app, install `@vercel/queue`, set `preset: 'vercel'` and `queue: true` in `vitehub()`, and add one file per queue in `server/queues/`. A route calls `runQueue()` to send a job and replies at once. The build writes one private Vercel Function per queue with a `queue/v2beta` trigger, and Vercel calls that function for each job.

## What Vercel Queues is

[Vercel Queues](https://vercel.com/docs/queues) is the message queue of the Vercel platform. A producer sends a message to a topic. A consumer function receives the message, and Vercel retries it until the consumer acknowledges it or the message expires. Delivery is at least once. Vercel Queues is in beta on all plans.

ViteHub writes the topic name, the consumer function, and its trigger for you. You write the handler and the call that sends the job. The same files run on [Cloudflare Queues](/docs/guides/cloudflare-queues) when you change the preset.

## Set up Vercel Queues

### Install the packages

```bash [Terminal]
pnpm add vite-hub @vercel/queue
pnpm add -D @types/node @types/ws
```

The generated Queue runtime imports `@vercel/queue` to send and receive messages. If you typecheck the generated Queue files, set `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

### Enable Queue with the Vercel preset

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', queue: true })],
})
```

The `vercel` preset selects the Vercel Queue Provider. `vitehub()` includes the Nitro Vite plugin, so `vite build` writes Vercel Build Output to `.vercel/output`. See [Queue configuration](/docs/queue/configure) for every option.

### Define a queue

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

// The file name is the queue name: welcome-email
export default defineQueue<{ email: string }>(async ({ payload, id, attempts }) => {
  console.log(`Welcome job ${id} for ${payload.email}, attempt ${attempts}`)
})
```

Vercel can deliver the same job two times. A handler that sends mail or charges a card must check first that the work is not already done.

### Send a job from a route

```ts [server/api/signup.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await runQueue('welcome-email', { email: body.email.trim() })
  if (error) throw error
  return result
})
```

`runQueue()` returns `[error, result]`. When Vercel accepts the job, `result` is `{ status: 'queued', messageId }`. `messageId` is the Vercel message id. It is `undefined` when Vercel accepts the job for deferred processing. The result does not contain the handler result, because the handler runs later in another function. See [Queue server API](/docs/queue/server-api) for `getQueue()` and `deferQueue()`.

### Use the Vercel enqueue options

Vercel accepts more enqueue options than Cloudflare. Pass them as the third argument.

```ts [server/utils/enqueue-welcome.ts]
import { runQueue } from 'vite-hub/queue'

export async function enqueueWelcome(email: string) {
  const [error, result] = await runQueue('welcome-email', { email }, {
    delaySeconds: 600,
    idempotencyKey: `welcome:${email}`,
    retentionSeconds: 3600,
  })
  if (error) throw error
  return result
}
```

| Option | Description |
| --- | --- |
| `delaySeconds` | Wait this many seconds before Vercel delivers the job. Cloudflare also accepts it. |
| `idempotencyKey` | Vercel drops a second send with the same key. ViteHub uses the message `id` when you omit it. |
| `region` | The Vercel region for this send. |
| `retentionSeconds` | How long Vercel keeps the message before it expires. |

`idempotencyKey`, `region`, and `retentionSeconds` work only on Vercel. On Cloudflare, they return `QUEUE_UNSUPPORTED_OPTION` and ViteHub does not send the job.

### Choose the queue region

Vercel keeps queue messages in one region. ViteHub reads the region from `queue.region`, then `QUEUE_REGION`, then `VERCEL_REGION`, then the region of the current Vercel request. To use one fixed region, set `QUEUE_REGION` in the Vercel project environment. If the installed `@vercel/queue` needs a region and ViteHub finds none, the send fails with `QUEUE_MISSING_REGION`. Read [Vercel region and topics](/docs/queue/configure#vercel-region-and-topics).

## How Vercel delivers a job

The build adds one Nitro route for each Queue Definition under `/api/vitehub/queues/vercel/<name>`. ViteHub gives that route a `queue/v2beta` trigger through Nitro's `vercel.functionRules`, so Nitro writes one Vercel Function for each queue. The topic name is `topic--` and the queue name in hexadecimal. Do not use this name in application code. Use the queue name with `runQueue()`.

Vercel calls a queue consumer function only from its queue system. The function has no public URL. See [consumer function security](https://vercel.com/docs/queues/concepts#consumer-function-security).

## Handle failed jobs

When the handler throws, Vercel retries the job. ViteHub acknowledges Queue errors that a retry cannot fix. Use `callbackOptions.retry` to choose another action for your own errors. Return `{ acknowledge: true }` to stop retries, `{ afterSeconds }` to retry later, or `undefined` to keep the default.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'
import { getViteHubErrorShape, ViteHubError } from 'vite-hub/runtime'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  if (!payload.email.includes('@')) {
    throw new ViteHubError('WELCOME_INVALID_EMAIL', 'The welcome job has no valid email.')
  }
  // Send the email here
}, {
  callbackOptions: {
    retry: error => getViteHubErrorShape(error)?.code === 'WELCOME_INVALID_EMAIL'
      ? { acknowledge: true }
      : undefined,
    visibilityTimeoutSeconds: 120,
  },
})
```

Vercel Queues has no built-in dead letter queue. Acknowledge a job that can never succeed, or Vercel retries it until it expires. `visibilityTimeoutSeconds` passes a visibility timeout to `@vercel/queue`. When this time ends before the handler acknowledges the job, Vercel delivers the job again. See [Handle failures](/docs/queue/server-api#handle-failures).

## How to use Vercel Queues locally

ViteHub has no local Queue Provider. The dev server does not deliver jobs to the handler. Use a build to check that ViteHub finds your queues and writes the Vercel output:

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind queue
cat .vercel/output/functions/api/vitehub/queues/vercel/welcome-email.func/.vc-config.json
```

The definitions list must include `welcome-email`. The `.vc-config.json` file must contain the queue trigger. A build proves discovery and output. It does not send a job. For fast tests, test the functions that your handler calls. See [Queue hosts](/docs/queue/hosts).

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root.

Then send a job to the deployment:

```bash [Terminal]
curl -X POST https://your-app.vercel.app/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. The handler log appears in the Vercel runtime logs. Vercel also shows queue throughput and message age in [Queues observability](https://vercel.com/docs/queues/observability).

## Vercel Queues limits

These limits come from Vercel. Read [Vercel Queues pricing and limits](https://vercel.com/docs/queues/pricing) and [Queues concepts](https://vercel.com/docs/queues/concepts) before production.

| Limit | Value |
| --- | --- |
| Message retention | 60 seconds to 7 days. The default is 24 hours. |
| Delivery delay | Up to 7 days, and never more than the retention. |
| Message size | Up to 100 MB. |
| Visibility timeout | 60 seconds by default, up to 60 minutes. |
| Idempotency window | The message retention, but never more than 24 hours. |
| Order | Approximate write order. Vercel does not guarantee first in, first out. |

Vercel bills per API operation, and it counts each 4 KiB of a message as one operation. Vercel bills a send with an idempotency key at 2 times the units. ViteHub sends an idempotency key with every job, so every `runQueue()` send uses that rate.

Vercel pins each message to the deployment that sent it. After you promote a new deployment, the old deployment keeps running its consumers until each of its messages succeeds or expires. To stop them, delete the old deployment. See [deployments and versioning](https://vercel.com/docs/queues/concepts#deployments-and-versioning).

For ViteHub error codes, read [Queue limits and errors](/docs/queue/limits-and-errors).

## Move the same queue to another host

The queue file and the route stay the same. To move to Cloudflare Queues:

1. Change `preset: 'vercel'` to `preset: 'cloudflare'`.
2. Remove `idempotencyKey`, `region`, and `retentionSeconds` from `runQueue()` calls.
3. Replace `callbackOptions` with `onError`, which returns `'ack'`, `'retry'`, or `{ retry: { delaySeconds } }`.
4. Create the queues with `vitehub provision run --provider cloudflare`.

Read [Cloudflare Queues](/docs/guides/cloudflare-queues) for the full steps. ViteHub has no Queue Provider for self-hosted Node or Deno. Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) before you choose a host.
