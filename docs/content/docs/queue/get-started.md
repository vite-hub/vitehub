---
title: Process a welcome job with Queue
description: Send a welcome job from an API route, run it in the dev server, then deploy it to Cloudflare and see it run there.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Queue runs work in the background, after your route has answered. Your route adds a job to the queue and returns at once. A handler then runs the job, a moment later.

In this tutorial, you send a welcome job from an API route, and the handler writes a line to the log. You run it on your computer first. Then you deploy it to Cloudflare and see it run there.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation), and run the commands in its root folder.
>
> The steps up to **Build and inspect** run on your computer, with no account. The last two steps deploy to Cloudflare. For them, you need a Cloudflare account with Queues, permission to create a queue and deploy a Worker, and access to Worker logs. These steps create real Cloudflare resources, and they can cost money.

::tutorial-step{title="Enable Queue for Cloudflare"}
## Enable Queue for Cloudflare

In `nuxt.config.ts` or `vite.config.ts`, change the ViteHub options to use Cloudflare and turn on Queue. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'cloudflare', queue: true },
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
  plugins: [vitehub({ preset: 'cloudflare', queue: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'cloudflare', queue: true })],
})
```
::::
:::

- `preset: 'cloudflare'` builds the app for Cloudflare. It was `node` before. If your app uses other ViteHub features, they now need their Cloudflare resources too.
- `queue: true` turns on Queue.

For Vercel, see [Queue hosts](/docs/queue/hosts). Deno has no Queue provider.

Install the Queue package and Wrangler, the Cloudflare CLI. You use Wrangler later to read the logs of the deployed app:

```bash pm [commands/install]
pnpm add @vite-hub/queue
pnpm add -D wrangler
```

::

::tutorial-step{title="Define the job"}
## Define the job

Create `server/queues/welcome-email.ts`. The file name is the name of the queue: `welcome-email`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

- `{ email: string }` is the type of the job data, the payload.
- The handler gets the `payload` and the `id` of the job.

This handler only writes to the log. A real handler must be safe to run twice, because a queue can deliver the same job more than once. Before you send an email or do other work that must happen only once, check that the job has not run before.

::

::tutorial-step{title="Enqueue from a route"}
## Enqueue from a route

Create `server/api/welcome.post.ts`. It answers `POST /api/welcome`:

```ts [server/api/welcome.post.ts]
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

- `sendQueue('welcome-email', ...)` adds a job to the `welcome-email` queue. The second argument is the payload.
- `sendQueue()` returns `[error, result]`. Check `error` before you use `result`. A setup error, such as a missing Cloudflare binding, throws. See [Queue limits and errors](/docs/queue/limits-and-errors).

::

::tutorial-step{title="Run the job in the dev server"}
## Run the job in the dev server

Start the dev server. Then send a job from a second terminal:

```bash [commands/dev]
pnpm dev
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. The dev server shows the line from your handler:

```text [output/dev.log]
Processing welcome job <message-id> for dev@example.com
```

The dev server runs the job on your computer, with no Cloudflare account. It follows the Cloudflare rules: when the handler fails, it runs again at once, up to 4 times in total.

To list the saved jobs, show one job, or run a failed job again:

```bash [commands/jobs]
pnpm vitehub queue jobs list
pnpm vitehub queue jobs show <message-id>
pnpm vitehub queue jobs retry <message-id>
```

The list is empty after the handler runs, because a job that succeeds is deleted. [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) shows what the dev server does not copy from Cloudflare.

::

::tutorial-step{title="Build and inspect"}
## Build and inspect

Build the app, and see what ViteHub found and wrote:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect output
```

- The list of definitions shows `welcome-email`.
- The build writes the Cloudflare settings to `.output/server/wrangler.json`. Find `queues.producers` and `queues.consumers` in it. ViteHub makes the Cloudflare queue name from the app name and the queue name.

You can stop here if you do not want to deploy. The dev server showed that the handler works, and the build showed that ViteHub found the queue. The build does not create the queue on Cloudflare. The next step does.

::

::tutorial-step{title="Provision and deploy"}
## Provision and deploy

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. The token must be allowed to create Queues, deploy Workers, and read Worker logs. Do not put the token in your source files.

See what ViteHub will create, then create it:

```bash [commands/provision]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build again, so the output has the IDs of the new resources. Then deploy the Vite app with Nitro:

```bash [commands/deploy]
pnpm build
pnpm exec nitro deploy --prebuilt
```

For a Nuxt app, deploy with Wrangler:

```bash [commands/deploy-nuxt]
pnpm build
pnpm exec wrangler deploy --config .output/server/wrangler.json
```

The deploy prints the URL of your Worker. You use it in the next step. [Cloudflare](/docs/frameworks-hosts/cloudflare) shows the full host setup.

::

::tutorial-step{title="Check acceptance and delivery"}
## Check acceptance and delivery

Show the live logs of the Worker in one terminal:

```bash [commands/logs]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

In a second terminal, put your Worker URL in `QUEUE_URL`, and send a job:

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response looks like this. The message ID is different each time:

```json [output/response.json]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` means that Cloudflare took the job. It does not mean that the job ran. The line in the log shows that Cloudflare ran your handler:

```text [output/delivery.log]
Processing welcome job <delivery-id> for dev@example.com
```

The ID in the log is not the `messageId` of the response. Cloudflare gives each delivery its own ID.

The caller of the route does not get the result of the handler. To follow a job until it is done, use a [Workflow](/docs/workflows/get-started).

Before real users can call this route, add an access check to it.
::

## List Queues and send a test job

You can also send a job from the CLI, with no route. `vitehub queue list` shows the queues of the running app. `vitehub queue send <name> '<json>'` sends one job to a queue:

```bash [commands/dispatch]
pnpm vitehub queue list
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --delay-seconds 30
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --url https://app.example.com
```

The second argument is the payload, as JSON. Add `--url` to send to a deployed app. `queue send` returns `{ queue, status: "queued", messageId }`. Like the route, this means that the queue took the job, not that the job ran.

::details{summary="Options, access, and errors of the CLI commands"}
Both commands call the `queue.list` and `queue.send` [operations](/docs/development/operations) of the Queues section, on the dev server or on a deployment with `--url`. They need `vitehub()` (the Console RPC), and `queue.send` is registered only when `console.invoke` is on.

`--delay-seconds`, `--id`, and `--idempotency-key` are the options of [`QueueEnqueueOptions`](/docs/queue/server-api#queue-enqueue-options). A provider that does not support one fails with `QUEUE_UNSUPPORTED_OPTION`. An unknown name fails with `QUEUE_DEFINITION_NOT_FOUND`.

Access needs the `queues` section. A read-only grant (`queues:read`) can list but not send.

Cloudflare and Vercel do not let a producer read the queue, so there is no command that shows the waiting jobs of a deployment. In `pnpm dev`, and on a Node server with the local provider, `vitehub queue jobs list` shows the saved jobs.
::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/queue/configure#queue-definition-options"}
Set how many times a job runs again, and every other queue option.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/queue/server-api"}
Send jobs with a delay, an ID, or an idempotency key.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/queue/hosts"}
See how Queue works on Cloudflare, Vercel, and Node.
:::
::
