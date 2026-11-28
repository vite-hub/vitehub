---
title: Process a welcome job with Queue
description: Send a welcome job from an API route, run it in the dev server, then deploy it to Cloudflare and see it run there.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Queue runs work in the background, after your route responds. Your route adds a job to the queue and returns right away. A handler then runs the job a moment later.

In this tutorial, you send a welcome job from an API route, and the handler writes a line to the log. You run it locally first, then deploy to Cloudflare and watch it run there.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands in its root folder.
>
> Everything up to **Build and inspect** runs locally without an account. The last two steps deploy to Cloudflare and need a Cloudflare account with Queues, permission to create queues and deploy Workers, and access to Worker logs. Those steps create real Cloudflare resources that can cost money.

::tutorial-step{title="Build for Cloudflare"}
## Build for Cloudflare

Set `host: 'cloudflare'` in `nuxt.config.ts` or `vite.config.ts`, keeping your other app options.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare' },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'cloudflare' }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'cloudflare' })],
})
```
::::
:::

- `host: 'cloudflare'` builds the app for Cloudflare instead of `node`. If your app uses other ViteHub features, they now need their Cloudflare resources too.
- You do not need a `queue` option. The queue file that you create in the next step turns on Queue.

For Vercel, see [Queue hosts](/docs/queue/hosts). Deno has no Queue provider.

Install the Queue package and Wrangler, the Cloudflare CLI. You use it later to read the logs of the deployed app. With pnpm 11 or later, first [set the Wrangler builds in `allowBuilds`](/docs/frameworks-hosts/cloudflare#install-wrangler).

```bash pm [commands/install]
pnpm add @vite-hub/queue
pnpm add -D wrangler
```

::

::tutorial-step{title="Define the job"}
## Define the job

Create `server/queues/welcome-email.ts`. The file name is the queue name, `welcome-email`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>({
  handler: async ({ payload, id }) => {
    console.log(`Processing welcome job ${id} for ${payload.email}`)
  },
})
```

- `{ email: string }` is the type of the job payload.
- The handler receives `payload` and the job `id`.

This handler only logs a line. In production, make your handler safe to run twice. Queues can deliver the same job more than once. Before you send an email or do other work that must happen only once, check that the job has not run before.

::

::tutorial-step{title="Enqueue from a route"}
## Enqueue from a route

Create `server/api/welcome.post.ts` to handle `POST /api/welcome`:

```ts [server/api/welcome.post.ts]
import { defineEventHandler, HTTPError, readBody } from 'h3'
import { sendQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw new HTTPError({ status: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await sendQueue('welcome-email', { email: body.email.trim() })
  if (error) throw error
  return result
})
```

- `sendQueue('welcome-email', ...)` adds a job to the `welcome-email` queue. The second argument is the payload.
- `sendQueue()` returns `[error, result]`. Check `error` before using `result`. Setup errors, like a missing Cloudflare binding, throw. See [Queue limits and errors](/docs/queue/limits-and-errors).

::

::tutorial-step{title="Run the job in the dev server"}
## Run the job in the dev server

Start the dev server, then send a job from a second terminal:

```bash [commands/dev]
pnpm dev
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The route returns `{ "status": "queued", "messageId": "..." }`, and the dev server logs your handler output:

```text [output/dev.log]
Processing welcome job <message-id> for dev@example.com
```

The dev server runs jobs locally without a Cloudflare account. It follows the Cloudflare rules: after a retryable failure, the handler runs again at once, up to 4 attempts in total.

List saved jobs, inspect one, or retry a failed job from the CLI:

```bash [commands/jobs]
pnpm vitehub queue jobs list
pnpm vitehub queue jobs get <message-id>
pnpm vitehub queue jobs retry <message-id>
```

The list is empty after the handler runs, because ViteHub deletes a job that succeeds. [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) shows what the dev server does not copy from Cloudflare.

::

::tutorial-step{title="Build and inspect"}
## Build and inspect

Build the app and see what ViteHub found and wrote:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect output
```

- `inspect definitions` lists `welcome-email`.
- The build writes the Cloudflare bindings to `.output/server/wrangler.json`, under `queues.producers` and `queues.consumers`. ViteHub makes the Cloudflare queue name from your app name and the queue name.

You can stop here if you do not want to deploy. You verified that the handler works locally and that ViteHub found the queue. The build does not create the queue on Cloudflare. The next step does.

::

::tutorial-step{title="Provision and deploy"}
## Provision and deploy

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. The token needs permission to create Queues, deploy Workers, and read Worker logs. Keep the token out of your source files.

See what ViteHub will create, then create it:

```bash [commands/provision]
pnpm vitehub provision run --host cloudflare --dry-run
pnpm vitehub provision run --host cloudflare
```

Build again so the output includes the new resource IDs, then deploy the Vite app with Nitro:

```bash [commands/deploy]
pnpm build
pnpm exec nitro deploy --prebuilt
```

For a Nuxt app, deploy with Wrangler:

```bash [commands/deploy-nuxt]
pnpm build
pnpm exec wrangler deploy --config .output/server/wrangler.json
```

The deploy prints your Worker URL for the next step. See [Cloudflare](/docs/frameworks-hosts/cloudflare) for full host setup.

::

::tutorial-step{title="Check acceptance and delivery"}
## Check acceptance and delivery

Stream live Worker logs in one terminal:

```bash [commands/logs]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

In a second terminal, set `QUEUE_URL` to your Worker URL and send a job:

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The route returns a JSON response with a unique `messageId`:

```json [output/response.json]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` means Cloudflare accepted the job, not that the handler ran. The log line in `wrangler tail` confirms your handler ran:

```text [output/delivery.log]
Processing welcome job <delivery-id> for dev@example.com
```

The `<delivery-id>` in the log differs from the response's `messageId` because Cloudflare assigns each delivery its own ID.

The HTTP caller does not get the handler's return value. To track a background job until it finishes, use a [Workflow](/docs/workflows/get-started).

Before real users can call this route, add an access check to it.
::

## List Queues and send a test job

You can also send a job from the CLI without a route. `vitehub queue list` shows the queues of the running app. `vitehub queue send <name> '<json>'` sends one job to a queue:

```bash [commands/dispatch]
pnpm vitehub queue list
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --delay 30s
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --url https://app.example.com
```

Pass the JSON payload as the second argument, and add `--url` to target a deployed app. `queue send` returns `{ queue, status: "queued", messageId }`. Like the route, this means that the queue accepted the job, not that the job ran.

::details{summary="Options, access, and errors of the CLI commands"}
Both commands call the `queue.list` and `queue.send` [operations](/docs/console/operations) of the Queues section, on the dev server or on a deployment with `--url`. They need the Console RPC of `vitehub()`, and `queue.send` is registered only when `console.invoke` is enabled.

`--delay`, a duration like `1m`, and `--idempotency-key` map to [`QueueEnqueueOptions`](/docs/queue/server-api#queue-enqueue-options). A provider that does not support an option fails with `QUEUE_UNSUPPORTED_OPTION`. An unknown queue name fails with `QUEUE_DEFINITION_NOT_FOUND`.

Access needs the `queues` section. A read-only grant (`queues:read`) can list queues but not send jobs.

Cloudflare and Vercel do not let producers read pending messages, so no CLI command lists waiting jobs on a deployment. In `pnpm dev`, or on Node with the local provider, `vitehub queue jobs list` shows saved jobs.
::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/queue/configure#queue-definition-options"}
Set how many jobs run at the same time, and every other queue option.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/queue/server-api"}
Send jobs with a delivery delay or idempotency key.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/queue/hosts"}
See how Queue works on Cloudflare, Vercel, and Node.
:::
::
