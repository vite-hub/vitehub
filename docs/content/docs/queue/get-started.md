---
title: Process a welcome job with Queue
description: Build a Queue Definition, deploy it to Cloudflare, and verify provider acceptance and handler delivery separately.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You send a welcome job from an API route. A job is a small task that your app runs later, in the background. A handler function then runs the job and writes a log line. First you run it on your computer, then on Cloudflare.

You need:

- the working app from [Installation](/docs/getting-started/installation), with its Node.js, pnpm, Vite, Nitro, and H3 setup
- for the last two steps only: a Cloudflare account with Queues, and permission to create a queue, deploy a Worker, and read Worker logs

You do not need an account for the first steps. `pnpm dev` runs each job on your computer. Run all commands from the app root.

The last two steps create real resources on Cloudflare, and Cloudflare can charge you for them.

::tutorial-step{title="Turn on Queue"}
## Turn on Queue

In `vite.config.ts`, change `preset` from `node` to `cloudflare`, and add `queue: true`. Keep the other options of your app.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'cloudflare', queue: true })],
})
```

The preset tells ViteHub where the app will run. With `cloudflare`, ViteHub builds the app for Cloudflare Workers and sends jobs through Cloudflare Queues. If you chose Nuxt in Installation, set the same options on the `vite-hub/nuxt` module.

> [!NOTE]
> Other features that you turned on also need their Cloudflare resources. For Vercel and for the Node.js server, see [Hosts](/docs/queue/hosts). Queue does not work on Deno.

Install Wrangler, the Cloudflare command line tool. You use it at the end to read the logs of your deployed app:

```bash [commands/install]
pnpm add -D wrangler
```

::

::tutorial-step{title="Write the handler"}
## Write the handler

Create `server/queues/welcome-email.ts`. The file name gives the queue its name, `welcome-email`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

`defineQueue()` sets the handler, the function that runs each job. `payload` is the data that you send with the job. Here it is an object with an `email`. `id` is the ID of the job.

This handler only writes a log line.

> [!NOTE]
> A job can run more than once, for example after a failure in the middle. Before a real handler sends an email or does other work that must not happen twice, make it check a saved record of the jobs that it already did.

::

::tutorial-step{title="Send a job from a route"}
## Send a job from a route

Create `server/api/welcome.post.ts`. Nitro uses the file name to make the route `POST /api/welcome`. `runQueue()` takes the queue name first, then the payload.

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

`runQueue()` puts the job in the queue and returns at once. It does not wait for the handler. It returns `[error, result]`, so check `error` before you use `result`. A config mistake, such as a missing Cloudflare queue, throws. See [Limits and errors](/docs/queue/limits-and-errors).

::

::tutorial-step{title="Run it on your computer"}
## Run it on your computer

Start the dev server. Then send a job from a second terminal:

```bash [commands/dev]
pnpm dev
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

The response is `{ "status": "queued", "messageId": "..." }`. It means that the queue took the job. Then the dev server prints the log line of the handler:

```text [output/dev.log]
Processing welcome job <message-id> for dev@example.com
```

This proves that the handler ran the job. The dev server uses the Cloudflare rules: if the handler fails, it runs again at once, up to 4 times. It does not need a Cloudflare account.

These commands list the saved jobs, show one job, and run again a job that failed all its tries:

```bash [commands/jobs]
pnpm vitehub queue jobs list
pnpm vitehub queue jobs show <message-id>
pnpm vitehub queue jobs retry <message-id>
```

The dev server deletes a job when it succeeds, so the list is empty after the handler runs. [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) lists what the dev server does not copy from Cloudflare.

::

::tutorial-step{title="Build and check"}
## Build and check

Build the app with the `build` script from Installation. Then ask ViteHub what it found:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind queue
pnpm vitehub inspect provider-output
```

- `inspect definitions` lists the queues that ViteHub found. The list must include `welcome-email`.
- `inspect provider-output` shows what the build made for Cloudflare.

Nitro writes the Worker config to `.output/server/wrangler.json`. Look for `queues.producers` (the app sends jobs) and `queues.consumers` (the app runs jobs). ViteHub makes the Cloudflare queue name from the app name and the queue name.

You can stop here if you do not have a Cloudflare account. The dev server proved that the handler works. The build proved that ViteHub found the queue and wrote the config. The build does not create the queue on Cloudflare.

::

::tutorial-step{title="Create the queue and deploy"}
## Create the queue and deploy

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your terminal. The token needs permission to create Queues, deploy Workers, and read Worker logs. Do not put it in your source files.

Create the queue on Cloudflare. `--dry-run` shows what the command will create, and changes nothing. The second command creates it:

```bash [commands/provision]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider cloudflare
```

Build again, so the output has the IDs of the new resources. Then deploy the Vite app with Nitro:

```bash [commands/deploy]
pnpm build
pnpm exec nitro deploy --prebuilt
```

For a Nuxt app, deploy with Wrangler and the config that the build made:

```bash [commands/deploy-nuxt]
pnpm build
pnpm exec wrangler deploy --config .output/server/wrangler.json
```

The deploy prints the URL of your Worker. You use it in the next step. For the full Cloudflare setup, see [Cloudflare](/docs/frameworks-hosts/cloudflare).

::

::tutorial-step{title="Send a job to Cloudflare"}
## Send a job to Cloudflare

In one terminal, show the logs of the Worker as they come:

```bash [commands/logs]
pnpm exec wrangler tail --config .output/server/wrangler.json
```

In a second terminal, send a job. Replace the example URL with the URL of your Worker:

```bash [commands/request]
QUEUE_URL=https://your-worker.workers.dev
curl -X POST "$QUEUE_URL/api/welcome" \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'
```

You see this. The message ID is different each time:

```json [output/response.json]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` proves that Cloudflare took the job. In the first terminal, the log line of the handler proves that Cloudflare ran the job:

```text [output/delivery.log]
Processing welcome job <delivery-id> for dev@example.com
```

Cloudflare gives the job a new ID, so it is not the same as the `messageId` in the response. The handler does not send a result back to the caller of the route. To know when work finishes, or how far it got, use a [Workflow](/docs/workflows/get-started).

> [!NOTE]
> Anyone can call this route. Check who the caller is before you let real users reach it.

::

## Send a test job from the CLI

`vitehub queue list` shows the queues that the running app loads, and the service that sends their jobs. `vitehub queue send <name> '<json>'` sends one job, so you can try a handler without a route. Both commands work on the dev server, or on a deployed app with `--url`. They call the `queue.list` and `queue.send` [operations](/docs/development/operations) of the Console. `queue send` works only when `console.invoke` is on.

```bash [commands/dispatch]
pnpm vitehub queue list
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --delay-seconds 30
pnpm vitehub queue send welcome-email '{"email":"dev@example.com"}' --url https://app.example.com
```

The payload is a JSON value. `--delay-seconds`, `--id`, and `--idempotency-key` are the [enqueue options](/docs/queue/server-api#queue-enqueue-options). If the service does not support an option, the command fails with `QUEUE_UNSUPPORTED_OPTION`. If the queue name does not exist, it fails with `QUEUE_DEFINITION_NOT_FOUND`. The command returns when the queue accepts the job, not when the handler finishes. A `queues:read` grant can list queues but cannot send jobs.

`queue send` returns `{ queue, status: "queued", messageId }`. This means that the queue took the job, not that the job finished. To use these commands, you need access to the `queues` section of the Console. With read-only access (`queues:read`), you can list but not send.

Cloudflare and Vercel do not let the app read its own queue, so you cannot list the waiting jobs of a deployed app there. In `pnpm dev`, and on a Node.js server, `vitehub queue jobs list` shows the saved jobs.

## Next steps

- [Configure](/docs/queue/configure#queue-definition-options): set how many times a failed job runs again.
- [Server API](/docs/queue/server-api#queue-enqueue-options): delay a job, or stop the same job from running twice.
- [Hosts](/docs/queue/hosts): run queues on Vercel or on your own Node.js server.
