---
title: Process a welcome job with Queue
description: Send a welcome job from an API route, run it in the dev server and in a Node build, then deploy it to Cloudflare.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Queue runs work in the background, after your route responds. Your route adds a job to the queue and returns right away. A handler then runs the job a moment later.

In this tutorial, you send a welcome job from an API route, and the handler writes a line to the log. You run it in the dev server and in a Node build. Then you can deploy it to Cloudflare.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands in its root folder. All steps run on your computer, with no account or API key needed.

::tutorial-step{title="Install Queue"}
## Install Queue

Install the Queue package:

```bash pm [commands/install]
pnpm add @vite-hub/queue
```

- You do not need a `queue` option. The queue file that you create in the next step turns on Queue.
- You do not change the host. On Node, the default host, Queue runs jobs in the server process and keeps them in `.vitehub/data/queue`. You need no account or queue service.

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
- `sendQueue()` returns `[error, result]`. Check `error` before using `result`. Setup errors, like a missing host binding, throw. See [Queue limits and errors](/docs/queue/limits-and-errors).

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

When the handler throws, the job runs again after 1, 2, and 4 seconds, up to 4 attempts in total. After that, it is a dead job that you can retry from the CLI.

List saved jobs, inspect one, or retry a failed job from the CLI:

```bash [commands/jobs]
pnpm vitehub queue jobs list
pnpm vitehub queue jobs get <message-id>
pnpm vitehub queue jobs retry <message-id>
```

The list is empty after the handler runs, because ViteHub deletes a job that succeeds. [Local delivery](/docs/queue/limits-and-errors#local-delivery) has all the rules.

::

::tutorial-step{title="Build and run on Node"}
## Build and run on Node

Build the app, check that ViteHub found the queue, and start the built server:

```bash [commands/build]
pnpm build
pnpm vitehub inspect definitions --kind queue
node .output/server/index.mjs
```

```txt [output/inspect.txt]
Queues (queue): 1
  welcome-email  server/queues/welcome-email.ts  [server-queues]
```

Send a job to the built server with the same `curl` command. The server terminal shows where the jobs are and your handler output:

```txt [output/server.txt]
[vitehub] Durability (1 instance. Set VITEHUB_INSTANCES when you run more):
  queue  local  host  Job files in .vitehub/data/queue. One server process must own this folder.
Processing welcome job queue_dd69928f-8ee1-4af8-94ac-cfb432e30c2d for dev@example.com
```

- Jobs survive a restart on the same disk. In Docker, mount `.vitehub/data` as a volume, or a new container loses them.
- Run one server process per folder. For more than one process, add a Postgres Database. See [Run on several Node instances](/docs/queue/hosts#run-on-several-node-instances).

::

## Deploy to Cloudflare

Keep the queue file and the route when you change hosts. On Cloudflare, Cloudflare Queues delivers the jobs. You need a Cloudflare account with Queues, permission to create queues and deploy Workers, and access to Worker logs. These steps create real Cloudflare resources that can cost money. For Vercel, see [Queue hosts](/docs/queue/hosts). Deno has no Queue provider.

Set `host: 'cloudflare'`, keeping your other app options. Other ViteHub features of your app then need their Cloudflare resources too.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [cloudflare/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare' },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [cloudflare/vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare' }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [cloudflare/vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare' })],
})
```
:::
::

`pnpm dev` still runs the jobs in the dev server, now with the Cloudflare rules: after a failure, the handler runs again at once. [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) lists the rules.

Install Wrangler, the Cloudflare CLI, to deploy and read the logs:

```bash pm [commands/install-wrangler]
pnpm add -D wrangler
```

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. Keep the token out of your source files. See what ViteHub will create, then create it:

```bash [commands/provision]
pnpm vitehub provision run --host cloudflare --dry-run
pnpm vitehub provision run --host cloudflare
```

Build again so the output includes the new resource IDs, then deploy. The build writes the queue to `.output/server/wrangler.json`, under `queues.producers` and `queues.consumers`. ViteHub makes the Cloudflare queue name from your app name and the queue name.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```bash [commands/deploy-nuxt]
pnpm build
pnpm exec wrangler deploy --config .output/server/wrangler.json
```
:::

:::tabs-item{label="Nitro"}
```bash [commands/deploy-nitro]
pnpm build
pnpm exec nitro deploy --prebuilt
```
:::

:::tabs-item{label="Vite"}
```bash [commands/deploy-vite]
pnpm build
pnpm exec nitro deploy --prebuilt
```
:::
::

The deploy prints your Worker URL. Stream the Worker logs in one terminal, and send a job from a second terminal:

```bash [commands/logs]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The route returns `{ "status": "queued", "messageId": "..." }`. This means that Cloudflare accepted the job, not that the handler ran. The `Processing welcome job` line in `wrangler tail` shows that your handler ran. Its ID differs from the `messageId`, because Cloudflare gives each delivery its own ID.

The HTTP caller does not get the handler's return value. To track a background job until it finishes, use a [Workflow](/docs/workflows/get-started). Before real users can call this route, add an access check to it. See [Cloudflare](/docs/frameworks-hosts/cloudflare) for the full host setup.

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
