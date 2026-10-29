---
title: Process a welcome job with Queue
description: Build a Queue Definition, deploy it to Cloudflare, and verify provider acceptance and handler delivery separately.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Submit a welcome job from an API route and watch its handler log the delivery. The route returns when Cloudflare accepts the job. It does not wait for the handler to finish.

Start with the working app from [Installation](/docs/getting-started/installation). Use its Node.js, pnpm, Vite, Nitro, and H3 setup, and run commands from the app root.

Queue has no local delivery provider. You can build and inspect the Definition without credentials, but `pnpm dev` on `localhost:3000` does not prove delivery. Completing this tutorial requires a Cloudflare account with Queues available, permission to create a queue and deploy a Worker, and access to Worker logs. Provisioning and deployment create real provider resources and can incur charges. The deployed Worker must have the generated producer binding and consumer configuration.

This tutorial changes the app's preset from `node` to `cloudflare`. Any other enabled features also need their Cloudflare resources. See [Queue hosts](/docs/queue/hosts) for Vercel, the other supported Queue provider. There is no Queue provider for self-hosted Node or Deno.

::tutorial-step{title="Enable Queue for Cloudflare"}
## Enable Queue for Cloudflare

Change the existing `vitehub()` options in `vite.config.ts` to select Cloudflare and enable Queue. Keep the app's other configuration.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'cloudflare', queue: true })],
})
```

`vitehub()` includes the Nitro integration. The preset selects the Queue provider and Nitro output. If you chose Nuxt in Installation, set these same options on the existing `vite-hub/nuxt` module and keep Nuxt's server integration.

Install Wrangler to read the deployed Worker's logs later:

```bash [commands/install]
pnpm add -D wrangler
```

::

::tutorial-step{title="Define the job"}
## Define the job

Create `server/queues/welcome-email.ts`. Its file name becomes the Queue Definition name, `welcome-email`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

This handler only logs a message. Providers can deliver a job more than once, so a real handler must tolerate retries after a partial side effect. Add a durable duplicate check before sending mail or doing other work that must not repeat.

::

::tutorial-step{title="Enqueue from a route"}
## Enqueue from a route

Create `server/api/welcome.post.ts`. Nitro serves it at `POST /api/welcome`. `runQueue()` takes the Definition name and payload as separate arguments.

```ts [server/api/welcome.post.ts]
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

`runQueue()` returns `[error, result]`. Check `error` before using the result. Configuration errors, such as a missing Cloudflare binding, throw. See [Queue limits and errors](/docs/queue/limits-and-errors).

::

::tutorial-step{title="Build and inspect"}
## Build and inspect

Use the build script from Installation, then inspect the discovered Definition and provider output:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect provider-output
```

The definitions list must include `welcome-email`. Nitro writes the Worker configuration to `.output/server/wrangler.json`; check its `queues.producers` and `queues.consumers` entries. ViteHub derives the physical queue name from the app name and Definition name.

This is the credential-free stopping point. A successful build proves discovery and generated output. It does not create the remote queue or run the handler.

::

::tutorial-step{title="Provision and deploy"}
## Provision and deploy

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal environment using your account credentials. The token needs permission to provision Queues, deploy Workers, and read Worker logs. Keep it out of source files.

Review the resource plan, then create any missing resources:

```bash [commands/provision]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build again so the output includes any provisioned resource IDs. For the Vite app, deploy with Nitro:

```bash [commands/deploy]
pnpm build
pnpm exec nitro deploy --prebuilt
```

For the Nuxt alternative, use its build script and the generated Wrangler configuration:

```bash [commands/deploy-nuxt]
pnpm build
pnpm exec wrangler deploy --config .output/server/wrangler.json
```

Use the Worker URL printed by deployment for the next step. See [Cloudflare](/docs/frameworks-hosts/cloudflare) for the full host setup.

::

::tutorial-step{title="Check acceptance and delivery"}
## Check acceptance and delivery

Start the live log stream in one terminal:

```bash [commands/logs]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

In another terminal, replace the example URL with your deployed Worker URL and submit a job:

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response has this shape. The message ID varies:

```json [output/response.json]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` confirms provider acceptance. The handler's log confirms that Cloudflare delivered the job and ran the handler:

```text [output/delivery.log]
Processing welcome job <delivery-id> for dev@example.com
```

Cloudflare assigns the delivery ID. It differs from the locally generated `messageId` in the enqueue response. The handler does not return a result to the HTTP caller. For tracked completion and progress, use a [Workflow](/docs/workflows/get-started).

Continue with [Configuration](/docs/queue/configure#queue-definition-options) for retry policy and [Server API](/docs/queue/server-api) for enqueue options. Add access checks before exposing this route to users.
::

## List Queues and send a test job

`vitehub queue list` shows the Queue Definitions that the running app loads and the provider that sends their jobs. `vitehub queue send <name> '<json>'` sends one job, so you can try a handler without a route. Both call the `queue.list` and `queue.send` [operations](/docs/development/operations) of the Queues section, on the dev server or on a deployment with `--url`. They need `vitehub()` (the Console RPC), and `queue.send` is registered only when `console.invoke` is on.

```bash [Terminal]
pnpm vitehub queue list
pnpm vitehub queue send welcome '{"userId":7}' --delay-seconds 30
pnpm vitehub queue send welcome '{"userId":7}' --url https://app.example.com
```

The payload is a JSON value. `--delay-seconds`, `--id`, and `--idempotency-key` are the options of [`QueueEnqueueOptions`](/docs/queue/server-api#queue-enqueue-options); a provider that does not support one fails with `QUEUE_UNSUPPORTED_OPTION`. `queue send` returns `{ queue, status: "queued", messageId }`, which is acceptance and not completion. An unknown name fails with `QUEUE_DEFINITION_NOT_FOUND`. Access needs the `queues` section, and a read-only grant (`queues:read`) can list but not send. There is no peek or backlog command: Cloudflare and Vercel do not let a producer read the queue.
