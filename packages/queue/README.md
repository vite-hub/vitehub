# @vite-hub/queue

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fqueue&icon=npm)](https://npmx.dev/package/@vite-hub/queue)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fqueue&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/queue)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/queue` discovers background job handlers during a Vite build and connects `sendQueue()` to Cloudflare Queues, Vercel Queues, or a Node server that runs the jobs from Postgres or from local files. In `vite dev`, every app runs its jobs in the dev server, so you can test a handler without an account. A successful enqueue means the provider accepted the job. It does not mean the handler finished.

Applications that already use the `vite-hub` framework distribution should enable Queue in `vitehub()` and import from `vite-hub/queue`. Install this owner package directly when you are building a custom composition, another framework integration, or package-level tooling. The [Queue guide](https://vitehub.dev/docs/queue) covers the framework-distribution setup.

## Install the owner package

```sh
pnpm add @vite-hub/queue
pnpm add -D @vite-hub/cli vite
```

The package requires Node.js 22.19 or newer. Vite is an optional peer dependency and is required for definition discovery and provider output. The ViteHub CLI provides the `vitehub provision` command used by the host guides.

For Vercel Queues, also install the provider package and the ambient types used by generated functions:

```sh
pnpm add @vercel/queue @vercel/functions
pnpm add -D @types/node @types/ws
```

## Build the first Queue Definition

The local provider runs Queue Definitions in a Node server without credentials. See [Run jobs on a Node server](#run-jobs-on-a-node-server). The example below selects Cloudflare explicitly, so its first result is a build that discovers a Queue Definition and emits provider configuration.

Define the handler in a discoverable file:

```ts
// src/welcome-email.queue.ts
import { defineQueue } from "@vite-hub/queue";

export default defineQueue<{ email: string }>(async ({ payload }) => {
  console.log(`Send welcome email to ${payload.email}`);
});
```

Enqueue it by its discovered name:

```ts
// src/server.ts
import { sendQueue } from "@vite-hub/queue";

export async function enqueueWelcomeEmail(email: string) {
  const [error, result] = await sendQueue("welcome-email", { email });
  if (error) throw error;
  return result;
}

export default function handleRequest() {
  return new Response("Queue producer ready");
}
```

Register the Vite integration with the Nitro Vite plugin. Nitro is the only host output:

```ts
// vite.config.ts
import { hubQueue } from "@vite-hub/queue/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  nitro: { preset: "cloudflare-module", serverEntry: "./src/server.ts" },
  plugins: [hubQueue({ provider: "cloudflare" }), nitro()],
});
```

Run a production-shaped build:

```sh
pnpm vite build
```

A successful build writes `.vitehub/queue/registry.mjs` with the `welcome-email` definition. Nitro writes the Worker and `.output/server/wrangler.json`. The Wrangler configuration contains one generated producer binding and one consumer for the Queue Definition.

That build proves discovery and generated output only. In the built Worker, `sendQueue()` needs a deployed Cloudflare binding and an existing queue before it can return `[undefined, { status: "queued" }]`. In `vite dev`, it needs neither: see [Run jobs in vite dev](#run-jobs-in-vite-dev). Use the [Cloudflare host guide](https://vitehub.dev/docs/frameworks-hosts/cloudflare) for provisioning and deployment checks. Do not import `.vitehub` or `dist` files from application code.

## Choose a provider

| Provider   | Choose it when                                                                                        | Generated output                                                    | Enqueue options                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cloudflare | The deployed runtime supplies request-scoped Cloudflare Queue bindings                                | Worker bundle and `wrangler.json` producer and consumer entries     | `contentType`, `delaySeconds`                                  |
| Vercel     | The deployment runs Vercel Queue callbacks and has a Queue region when the installed SDK requires one | One Nitro route per Queue Definition, with a Vercel queue trigger | `delaySeconds`, `idempotencyKey`, `region`, `retentionSeconds` |
| Local      | One Node server runs the jobs: `node .output/server/index.mjs`, Docker, or a WebContainer               | A Nitro plugin that runs stored jobs in the server process         | `delaySeconds`, `idempotencyKey`                               |
| Postgres   | One or more Node servers share a Postgres database                                                    | A Nitro plugin that starts workers in each server process           | `delaySeconds`, `idempotencyKey`                               |

The ViteHub framework host selects Cloudflare for `host: "cloudflare"` and Vercel for `host: "vercel"`. For `host: "node"` and a Nitro `node-server` preset, it selects the postgres provider when the app has a Postgres Default Database, else the local provider. `vitehub({ queue: { provider: "postgres" } })` or `{ provider: "local" }` picks one on Node. Set `provider` explicitly when host inference would be ambiguous. Netlify cannot infer one. ViteHub provides no Queue Provider for Deno. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before choosing a deployment target.

Cloudflare needs a concrete request-scoped binding at runtime. Its generated queue resources can be created through the ViteHub Cloudflare provision step when the required account credentials are present. Cloudflare rejects Vercel-only options such as `idempotencyKey`, `region`, and `retentionSeconds`.

Vercel needs a generated topic and the `@vercel/queue` runtime. It rejects Cloudflare's `contentType` option. The [Vercel host guide](https://vitehub.dev/docs/frameworks-hosts/vercel) explains the generated Build Output boundary.

## Run jobs on a Node server

The local provider stores each accepted job as a file in `.vitehub/data/queue`, next to the KV `fs-lite` store, and runs the Queue Definition in the same server process. `sendQueue()` returns after the file is written.

```ts
// vite.config.ts
import { nitro } from "nitro/vite"
import { hubQueue } from "@vite-hub/queue/vite"
import { defineConfig } from "vite"

export default defineConfig({
  nitro: { preset: "node-server", serverEntry: "./src/server.ts" },
  plugins: [hubQueue(), nitro()],
})
```

`hubQueue({ provider: "local", base: "data/queue" })` selects it explicitly and changes the directory.

Direct clients from `createQueueClient()` always redact plain handler errors. They cannot share a directory with the generated dev engine, which reports error details: that fails with `QUEUE_LOCAL_MODE_MISMATCH`. Use `useQueue()` in the dev server, or give the direct client a separate `base` directory.

When a production server reopens a dev store, it redacts stored errors without a code before it exposes the jobs. Queue errors and `ViteHubError` keep their code and message.

- A failed job runs again after 1, 2, and 4 seconds. After 4 attempts, or after a Queue error that a retry cannot fix, it becomes a dead job. A dead job stays in its file with the last error. The provider keeps the 100 newest dead jobs of each Queue Definition.
- The server writes the attempt count before the handler runs. A job whose handler was running when the process stopped runs again after the restart. If that was the fourth attempt, the job becomes a dead job instead.
- Delivery is at least once. A successful handler can run again after a restart if the process stops before completion is saved, or if both deleting the job and saving its completed state fail. Make handler side effects idempotent.
- `delaySeconds` survives a restart. `idempotencyKey` returns the message ID of a pending or running job with the same key. A dead job does not hold its key. `sendBatch()` stores all jobs or none.
- The jobs survive a restart on the same disk. Another host, a new container, or an ephemeral filesystem does not have them. Run one server process per directory: there is no lock between processes, so two processes can run the same job.
- `onError` and `callbackOptions` are Cloudflare and Vercel options. The local provider does not call them.

The server logs the directory and this durability once when it starts. `vitehub queue list` shows the provider, the directory, `durability: "single-host"`, the dead-job limit, and the pending, running, and dead jobs of each Queue Definition. In `vite dev`, it also shows `rules`, the provider of the build. `vitehub queue jobs list` shows each job.

## Run jobs on several Node servers

The postgres provider keeps the jobs in the `vitehub_queue_jobs` table, and every server process of the app takes due jobs from it. Install `postgres` (postgres.js). The jobs use the postgres.js client of the Default Database, so they connect as the Database does, whatever variable or URL its Definition reads. `QUEUE_POSTGRES_URL` on the server overrides it. An explicit `provider: "postgres"` without a Postgres Default Database needs `QUEUE_POSTGRES_URL`.

```ts
// vite.config.ts
import { hubQueue } from "@vite-hub/queue/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  nitro: { preset: "node-server", serverEntry: "./src/server.ts" },
  plugins: [hubQueue({ provider: "postgres" }), nitro()],
})
```

- The first server creates the table and its indexes under `pg_advisory_xact_lock`, so servers that start at the same time do not race.
- Workers claim jobs with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. A send wakes the workers with `NOTIFY`. Without it, each worker checks every second.
- A claim holds a job for 30 seconds, and a running handler renews it. When a process stops during a handler, another instance runs the job again with the next attempt number after the claim ends.
- Retries, dead jobs, `delaySeconds`, `idempotencyKey`, `sendBatch()`, and `concurrency` follow the local rules above. `concurrency` applies per process.
- When Nitro closes, the workers stop taking jobs and wait up to 10 seconds for the running jobs.
- `vitehub queue list` shows the table and its database without the password, and `durability: "shared"`. `vitehub queue jobs` and the Console read the table, so any instance shows the jobs of all instances.
- `vite dev` runs the jobs of a postgres app with the local provider and the same rules, so development needs no Postgres.

## Run jobs in vite dev

In `vite dev` and `nuxt dev`, `sendQueue()` stores the job in `.vitehub/data/queue` of the project and the dev server runs the Queue Definition, whatever the provider of the build. A Cloudflare or Vercel app needs no binding, credentials, or `wrangler dev`. The build output does not change: `vite build` still writes the Cloudflare or Vercel runtime.

The dev server follows the documented defaults of the provider of the build, so a handler fails and retries in dev as it does on the host:

| Rule | Cloudflare | Vercel | Local |
| --- | --- | --- | --- |
| Attempts | 4 (`max_retries` 3) | No limit until the job expires | 4 |
| Retry delay | None | 60 seconds (`retryAfterSeconds`) | 1, 2, then 4 seconds |
| Largest `delaySeconds` | 86400 (24 hours) | 604800 (7 days) | No limit |
| Retention | None | `retentionSeconds` from 60 to 604800, default 86400 | None |
| Largest payload | 128 KB of JSON | 100 MB of JSON | No limit |
| Largest `sendBatch()` | 100 jobs, 256 KB | 100 jobs | No limit |
| Rejected options | `idempotencyKey`, `region`, `retentionSeconds` | `contentType` | `contentType`, `region`, `retentionSeconds` |

The sources are the [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Cloudflare batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), the [Vercel Queues concepts](https://vercel.com/docs/queues/concepts), and the [Vercel Queues limits](https://vercel.com/docs/queues/pricing#limits). A broken limit fails `sendQueue()` with `QUEUE_PROVIDER_FAILED`, and `error.cause` names the limit. A rejected option fails with `QUEUE_UNSUPPORTED_OPTION` and names the provider of the build.

Dev does not emulate these parts of the host:

- It delivers one job at a time per Queue Definition, up to `concurrency`. It has no Cloudflare batches, `max_batch_size`, or `max_batch_timeout`.
- It does not call `onError` or `callbackOptions`. A failed handler retries by the rules above, and a Queue error that a retry cannot fix makes the job dead at once.
- It keeps a dead job for inspection. Cloudflare deletes it, or moves it to a dead-letter queue, and Vercel deletes an expired job.
- The payload is a JSON copy. Cloudflare `contentType: "v8"` can send values that JSON cannot, such as a `Map`. The payload size is the JSON size, not the provider encoding.
- `idempotencyKey` deduplicates only while a job is pending or running. Vercel deduplicates for the retention, up to 24 hours. `useQueue()` returns the local client.

List, inspect, run again, and remove the stored jobs with the CLI. The commands call the `queue.jobs-list`, `queue.jobs-show`, `queue.jobs-retry`, and `queue.jobs-clear` operations of the running dev server, or of a deployed app with `--url`. The Console and agents run the same operations.

```sh
pnpm vitehub queue jobs list --state dead
pnpm vitehub queue jobs show <message-id>
pnpm vitehub queue jobs retry <message-id>
pnpm vitehub queue jobs clear --state dead --yes
```

`--json` prints JSON. `jobs list` takes `--queue` and `--state`. `jobs retry` runs the job now: a dead job gets a new set of attempts, and a delayed job does not wait. `jobs clear` removes pending and dead jobs, not running ones. It asks for confirmation on a terminal and needs `--yes` elsewhere. The handler of a successful job deletes it, so the list shows pending, running, and dead jobs. In `vite dev`, a plain `Error` from a handler shows its message and stack. A production server shows `Queue Delivery failed.` instead, because a message can hold private data; throw a `ViteHubError` to keep a code and message. The same commands work on a Node server with the local or postgres provider. Cloudflare and Vercel do not let the app read their queue, so the commands fail there with `QUEUE_JOBS_UNAVAILABLE`.

## Treat acceptance and delivery separately

`sendQueue()` waits for provider enqueue and returns `[error, result]`. `result` is this portable value:

```ts
type QueueSendResult = {
  messageId?: string;
  status: "queued";
};
```

The optional message ID is provider-specific. Vercel returns the ID from its enqueue response. Cloudflare returns the input's `id`, generating one locally when omitted; it does not send that ID to Cloudflare, and the later delivery has a different Cloudflare message ID. The local provider returns the input's `id`, or a generated one, and the handler receives the same `id`. In every case, `status: "queued"` is the portable acceptance signal. Queue handlers run later and return no value to the producer. Use a [Workflow](https://vitehub.dev/docs/workflows) when the caller needs a tracked run, durable steps, waits, or progress.

`deferQueue()` does not wait for provider acceptance. It schedules enqueue work through the current request's `waitUntil`, logs dispatch failures, and calls the Queue Definition's `onDispatchError` hook when present.

Providers, the local one included, can retry failed delivery, so handlers must tolerate another invocation after a partial side effect. ViteHub does not expose an exactly-once delivery guarantee. Vercel sends an idempotency key, using the generated message ID by default; pass a stable application key when repeated enqueue attempts should share one key. Cloudflare does not accept `idempotencyKey`, so protect non-repeatable side effects inside the handler.

On Cloudflare, successful handlers acknowledge the message. Failed handlers retry by default unless the error is a Queue error that a retry cannot fix or `onError` returns an explicit acknowledge or retry action. On Vercel, `callbackOptions.retry` can return an explicit directive; returning nothing preserves provider behavior. Application error codes do not choose retry policy.

`sendQueue()`, `dynamicQueue.send()`, `send()`, and `sendBatch()` return `[error, data]`. `error.code` is `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, or `QUEUE_UNSUPPORTED_OPTION`, and each error has `why`, `fix`, `docs`, and `cause`. Configuration errors, for example an unknown Queue name or a missing Cloudflare binding, throw. `JSON.stringify(error)` and Queue delivery reports omit `cause`, so keep credentials and provider responses there. Throw `ViteHubError` from a handler for an application code. See the [Queue error reference](https://vitehub.dev/docs/queue/limits-and-errors) for each code and the retry policy.

## Public imports

| Import                           | Purpose                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `@vite-hub/queue`                | Queue Definitions, enqueue helpers, direct clients, host adapters, and public types |
| `@vite-hub/queue/vite`           | Vite discovery and Cloudflare, Vercel, local, or postgres Nitro configuration       |
| `@vite-hub/queue/runtime/hosted` | Advanced hosted Vercel callback adapter                                             |

`@vite-hub/queue/internal/*` exists for generated framework integration. Application code should not import it.

## Go deeper

- [Queue guide](https://vitehub.dev/docs/queue)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Definitions and discovery](https://vitehub.dev/docs/development/definition-discovery)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)


## Definition-owned dispatch types

The Vite Integration writes `.vitehub/queue.d.ts`. Include that file in your TypeScript project. The Nuxt Integration adds it to the generated type context. Names and payloads then come from the discovered Queue Definitions:

```ts
import { sendQueue, useQueue } from "@vite-hub/queue"

const [error] = await sendQueue("welcome-email", { email: "ada@example.com" }, { delaySeconds: 60 })
const queue = await useQueue("welcome-email")
const [sendError] = await queue.send({ email: "ada@example.com" })
```

`QueueRegistry` is the generated definition map. `QueuePayload<"welcome-email">` extracts a payload type. A missing name or wrong payload is a type error. Run Vite configuration or the Nuxt prepare step after you add a definition. For a standalone TypeScript host, you can extend `QueueRegistry` with `typeof import("./welcome.queue").default`.

Use `dynamicQueue.send(name, payload, options?)`, `dynamicQueue.defer()`, or `dynamicQueue.use()` for names read from external input. These methods check that the definition exists at runtime. They do not validate payload shape. Validate external data in your application. Direct provider clients from `createQueueClient()` also accept unknown payloads because they have no Queue Definition.

This is a breaking change: replace `sendQueue(name, { payload, ...options })` with `sendQueue(name, payload, options)`, and `client.send({ payload, ...options })` with `client.send(payload, options)`. There is no envelope detection. Existing envelope objects are delivered whole as payloads.
