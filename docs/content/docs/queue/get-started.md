---
title: Process a welcome job with Queue
description: Submit a welcome job to Cloudflare Queues and verify its delivery.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Submit a welcome job from an API route and watch the Queue consumer log its delivery. The route returns as soon as the provider accepts the job. It does not wait for the handler's result.

You need Node.js 24.15 or newer, pnpm, a Cloudflare account, and credentials that can create a Queue and deploy a Worker. Start in an empty directory. Queue has hosted providers only, so this tutorial includes a deployment and can incur provider charges. If you only need to run a local handler, use a [Workflow](/docs/workflows/get-started).

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/queue h3 nitro
pnpm add -D @vite-hub/cli vite
```

Register the integration in `vite.config.ts`:

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  nitro: { preset: 'cloudflare_module' },
  plugins: [hubQueue({ provider: 'cloudflare' }), nitro() as never],
})
```

With the `vite-hub` distribution, use `vitehub({ preset: 'cloudflare', queue: true })` and import from `vite-hub/queue`.

::

::tutorial-step{title="Define the job"}
## Define the job

This handler only logs the job so you can verify delivery without sending mail. A real handler can run more than once after retries; use an idempotency check before a non-repeatable side effect.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

The file name becomes the Queue Definition name. The handler runs in the provider consumer, after the route has returned.

::

::tutorial-step{title="Enqueue from a route"}
## Enqueue from a route

`runQueue()` selects `welcome-email` by its Definition name and submits the email as a payload. The handler runs separately from this route.

```ts [server/api/welcome.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const { email } = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', { email })
})
```

The response is an acceptance signal:

```json [output/response.json]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` does not contain the handler result. The provider will deliver the job later and may retry it after a failure. Make the handler safe to run more than once. Cloudflare does not support Vercel's `idempotencyKey`; use that option only when you select the Vercel provider.

::

::tutorial-step{title="Inspect the definition"}
## Inspect the definition

Build the app and inspect the generated definition before deploying:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect provider-output
```

You should see `welcome-email` and the generated Cloudflare producer and consumer output. Nitro writes the Worker configuration to `.output/server/wrangler.json`. This build proves discovery and output. Queue has no local provider.

Provision the queue and deploy the generated Worker with Cloudflare credentials:

The next commands create provider resources and deploy the Worker. Use an account intended for this tutorial, and review the generated output before running them.

```bash [commands/deploy]
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
pnpm vitehub provision run --provider cloudflare
pnpm exec nitro deploy --prebuilt
```

Set `QUEUE_URL` to the deployed Worker URL, then send a request:

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response confirms provider acceptance. Look for the handler log in the provider consumer to confirm delivery.

::

## Continue

- Read [Make Queue handlers safe to retry](/docs/queue/configure#queue-definition-options) before sending non-repeatable side effects.
- Read the [Server API](/docs/queue/server-api) for delays, direct clients, and delivery failures.
- Read [Hosts](/docs/queue/hosts) before choosing Cloudflare or Vercel.
