---
title: Use Vercel Queues in a Vite app with ViteHub
description: Use Vercel Queues from a Vite app with ViteHub. Define a queue in one file, send jobs with sendQueue(), and let a private Vercel Function run each job.
navigation.title: Vercel Queues
navigation.order: 24
navigation.group: Server work
icon: i-simple-icons-vercel
---

Install `@vercel/queue`, set `preset: 'vercel'` and `queue: true` in `vitehub()`, and add one file per queue in `server/queues/`. A route calls `sendQueue()` to send a job and replies at once. The build writes one private Vercel Function per queue with a `queue/v2beta` trigger, and Vercel calls it for each job.

## What Vercel Queues is

[Vercel Queues](https://vercel.com/docs/queues) is Vercel's message queue, in beta on all plans. A producer sends a message to a topic. A consumer function gets it, and Vercel retries until the consumer acknowledges it or it expires. Delivery is at least once.

You write the handler and the send call. ViteHub writes the topic name, consumer function, and trigger, and the same files run on [Cloudflare Queues](/docs/guides/cloudflare-queues) with another preset.

## Set up Vercel Queues

### Install the packages

```bash [Terminal]
pnpm add vite-hub @vite-hub/queue @vercel/queue
pnpm add -D @types/node @types/ws
```

The generated Queue code imports `@vercel/queue`. To typecheck it, set `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

### Enable Queue with the Vercel preset

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'vercel', queue: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', queue: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', queue: true })],
})
```
:::
::

The `vercel` preset picks the Vercel Queue Provider. `vitehub()` includes the Nitro Vite plugin, so `vite build` writes Vercel Build Output to `.vercel/output`. See [Queue configuration](/docs/queue/configure) for all options.

### Define a queue

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

// The file name is the queue name: welcome-email
export default defineQueue<{ email: string }>(async ({ payload, id, attempts }) => {
  console.log(`Welcome job ${id} for ${payload.email}, attempt ${attempts}`)
})
```

::warning
Vercel can deliver the same job twice. A handler that sends mail or charges a card must first check that the work is not done yet.
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

  const [error, result] = await sendQueue('welcome-email', { email: body.email.trim() })
  if (error) throw error
  return result
})
```

`sendQueue()` returns `[error, result]`. When Vercel accepts the job, `result` is `{ status: 'queued', messageId }` with the Vercel message id, or `undefined` for deferred processing. The handler runs later in another function, so its result is not here. See [Queue server API](/docs/queue/server-api) for `useQueue()` and `deferQueue()`.

### Use the Vercel enqueue options

Vercel accepts more options than Cloudflare. Pass them as the third argument.

```ts [server/utils/enqueue-welcome.ts]
import { sendQueue } from 'vite-hub/queue'

export async function enqueueWelcome(email: string) {
  const [error, result] = await sendQueue('welcome-email', { email }, {
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
| `delaySeconds` | Seconds to wait before delivery. Cloudflare accepts it too. |
| `idempotencyKey` | Vercel drops a second send with the same key. Defaults to the message `id`. |
| `region` | The Vercel region for this send. |
| `retentionSeconds` | How long Vercel keeps the message before it expires. |

`idempotencyKey`, `region`, and `retentionSeconds` work only on Vercel. On Cloudflare, they return `QUEUE_UNSUPPORTED_OPTION` and the job is not sent.

### Send many jobs in one request

`sendBatch()` on `useQueue()` sends 1 to 100 jobs in one `@vercel/queue` request. Each job takes `body` and its own `delaySeconds`, `idempotencyKey`, and `retentionSeconds`. The second argument sets `delaySeconds` and `retentionSeconds` for jobs that do not. The batch uses the client's region. This excerpt uses the Queue registry generated when Vite loads the app configuration.

```ts [server/utils/enqueue-welcomes.ts] fragment
import { useQueue } from 'vite-hub/queue'

export async function enqueueWelcomes(emails: string[]) {
  const queue = await useQueue('welcome-email')
  const [error, results] = await queue.sendBatch(
    emails.map(email => ({ body: { email }, idempotencyKey: `welcome:${email}` })),
    { delaySeconds: 600 },
  )
  if (error) throw error
  return results
}
```

If Vercel rejects a job, `sendBatch()` returns `QUEUE_PROVIDER_FAILED`, and `error.cause.results` has each job's result in input order. A request-level failure can happen after Vercel accepts jobs, and it has no per-job results. `sendBatch()` needs `@vercel/queue` 0.10 or later.

::warning
To retry safely after either failure, give every job your own `idempotencyKey` from the first attempt, as above. Vercel uses those keys to drop jobs it already accepted. Without them, ViteHub makes a new key on each call, so a retry can send accepted jobs again.
::

### Choose the queue region

Vercel keeps queue messages in one region. ViteHub reads it from `queue.region`, then `QUEUE_REGION`, then `VERCEL_REGION`, then the current request's region. For one fixed region, set `QUEUE_REGION` in the Vercel project. If `@vercel/queue` needs a region and ViteHub finds none, the send fails with `QUEUE_MISSING_REGION`. See [Vercel region and topics](/docs/queue/configure#vercel-region-and-topics).

## How Vercel delivers a job

The build adds one Nitro route per queue file under `/api/vitehub/queues/vercel/<name>`. ViteHub gives it a `queue/v2beta` trigger through Nitro's `vercel.functionRules`, so Nitro writes one Vercel Function per queue. The topic name is `topic--` plus the queue name in hexadecimal. Do not use it in your code; pass the queue name to `sendQueue()`.

Only Vercel's queue system calls a consumer function. It has no public URL. See [consumer function security](https://vercel.com/docs/queues/concepts#consumer-function-security).

## Handle failed jobs

When the handler throws, Vercel retries the job. ViteHub acknowledges Queue errors that a retry cannot fix. For your own errors, return from `callbackOptions.retry`:

- `{ acknowledge: true }` stops retries.
- `{ afterSeconds }` retries later.
- `undefined` keeps the default.

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

Vercel Queues has no dead letter queue. Acknowledge a job that can never succeed, or Vercel retries it until it expires. `visibilityTimeoutSeconds` passes a visibility timeout to `@vercel/queue`: if the handler has not acknowledged the job when it ends, Vercel delivers the job again. See [Handle failures](/docs/queue/server-api#handle-failures).

## How to use Vercel Queues locally

`pnpm dev` runs jobs in the dev server, with no Vercel project or token. It uses Vercel's defaults: a retry every 60 seconds until the job expires, 24 hours of retention (set by `retentionSeconds`), `delaySeconds` up to 7 days, and payloads up to 100 MB. It does not call `callbackOptions.retry`. See [Dev delivery](/docs/queue/limits-and-errors#dev-delivery).

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
pnpm vitehub queue jobs list
```

A failed job waits 60 seconds before the next attempt, as on Vercel. `vitehub queue jobs retry <message-id>` runs it now, and `vitehub queue jobs clear --yes` removes stored jobs.

Build to check that ViteHub finds your queues and writes the Vercel output:

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind queue
cat .vercel/output/functions/api/vitehub/queues/vercel/welcome-email.func/.vc-config.json
```

The list must include `welcome-email`, and `.vc-config.json` must have the queue trigger. A build does not send a job. See [Queue hosts](/docs/queue/hosts).

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root. Then send a job:

```bash [Terminal]
curl -X POST https://your-app.vercel.app/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. The handler log shows in the Vercel runtime logs. [Queues observability](https://vercel.com/docs/queues/observability) shows throughput and message age.

## Vercel Queues limits

Vercel sets these limits. Read [Vercel Queues pricing and limits](https://vercel.com/docs/queues/pricing) and [Queues concepts](https://vercel.com/docs/queues/concepts) before production.

| Limit | Value |
| --- | --- |
| Message retention | 60 seconds to 7 days. The default is 24 hours. |
| Delivery delay | Up to 7 days, never more than the retention. |
| Message size | Up to 100 MB. |
| Visibility timeout | 60 seconds by default, up to 60 minutes. |
| Idempotency window | The message retention, but never more than 24 hours. |
| Order | About write order. No first-in, first-out guarantee. |

Vercel bills per API operation, and each 4 KiB of a message is one operation. A send with an idempotency key costs 2 times the units. ViteHub sends a key with every job, so every `sendQueue()` send pays that rate.

Vercel pins each message to the deployment that sent it. After you promote a new deployment, the old one keeps running its consumers until each of its messages succeeds or expires. To stop them, delete the old deployment. See [deployments and versioning](https://vercel.com/docs/queues/concepts#deployments-and-versioning).

See [Queue limits and errors](/docs/queue/limits-and-errors) for error codes.

## Move the same queue to another host

The queue file and route stay the same. To move to Cloudflare Queues:

1. Change `preset: 'vercel'` to `preset: 'cloudflare'`.
2. Remove `idempotencyKey`, `region`, and `retentionSeconds` from `sendQueue()` calls.
3. Replace `callbackOptions` with `onError`, which returns `'ack'`, `'retry'`, or `{ retry: { delaySeconds } }`.
4. Create the queues with `vitehub provision run --provider cloudflare`.

See [Cloudflare Queues](/docs/guides/cloudflare-queues) for all steps. Self-hosted Node uses the local provider. Deno has no Queue Provider. Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) before you choose a host.
