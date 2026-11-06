# @vite-hub/queue

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fqueue&icon=npm)](https://npmx.dev/package/@vite-hub/queue)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fqueue&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/queue)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/queue` discovers background job handlers during a Vite build and connects `runQueue()` to Cloudflare Queues, Vercel Queues, or the local provider of a Node server. A successful enqueue means the provider accepted the job. It does not mean the handler finished.

Applications that already use the `vite-hub` framework distribution should enable Queue in `vitehub()` and import from `vite-hub/queue`. Install this owner package directly when you are building a custom composition, another framework integration, or package-level tooling. The [Queue guide](https://vitehub.dev/docs/queue) covers the framework-distribution setup.

## Install the owner package

```sh
pnpm add @vite-hub/queue
pnpm add -D @vite-hub/cli vite
```

The package requires Node.js 22.19 or newer. Vite is an optional peer dependency and is required for definition discovery and provider output. The ViteHub CLI provides the `vitehub provision` command used by the host guides.

For Vercel Queues, also install the provider package and the ambient types used by generated functions:

```sh
pnpm add @vercel/queue
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
import { runQueue } from "@vite-hub/queue";

export async function enqueueWelcomeEmail(email: string) {
  const [error, result] = await runQueue("welcome-email", { email });
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

That build proves discovery and generated output only. `runQueue()` needs the generated runtime, a deployed Cloudflare binding, and an existing queue before it can return `[undefined, { status: "queued" }]`. Use the [Cloudflare host guide](https://vitehub.dev/docs/frameworks-hosts/cloudflare) for provisioning and deployment checks. Do not import `.vitehub` or `dist` files from application code.

## Choose a provider

| Provider   | Choose it when                                                                                        | Generated output                                                    | Enqueue options                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cloudflare | The deployed runtime supplies request-scoped Cloudflare Queue bindings                                | Worker bundle and `wrangler.json` producer and consumer entries     | `contentType`, `delaySeconds`                                  |
| Vercel     | The deployment runs Vercel Queue callbacks and has a Queue region when the installed SDK requires one | One Nitro route per Queue Definition, with a Vercel queue trigger | `delaySeconds`, `idempotencyKey`, `region`, `retentionSeconds` |
| Local      | One Node server runs the jobs: `node .output/server/index.mjs`, Docker, `vite dev`, or a WebContainer  | A Nitro plugin that runs stored jobs in the server process         | `delaySeconds`, `idempotencyKey`                               |

The ViteHub framework preset selects Cloudflare for `preset: "cloudflare"`, Vercel for `preset: "vercel"`, and the local provider for `preset: "node"`. The owner package selects the local provider for a Nitro `node-server` preset. Set `provider` explicitly when host inference would be ambiguous. Netlify cannot infer one. ViteHub provides no Queue Provider for Deno. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before choosing a deployment target.

Cloudflare needs a concrete request-scoped binding at runtime. Its generated queue resources can be created through the ViteHub Cloudflare provision step when the required account credentials are present. Cloudflare rejects Vercel-only options such as `idempotencyKey`, `region`, and `retentionSeconds`.

Vercel needs a generated topic and the `@vercel/queue` runtime. It rejects Cloudflare's `contentType` option. The [Vercel host guide](https://vitehub.dev/docs/frameworks-hosts/vercel) explains the generated Build Output boundary.

## Run jobs on a Node server

The local provider stores each accepted job as a file in `.vitehub/data/queue`, next to the KV `fs-lite` store, and runs the Queue Definition in the same server process. `runQueue()` returns after the file is written.

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

- A failed job runs again after 1, 2, and 4 seconds. After 4 attempts, or after a Queue error that a retry cannot fix, it becomes a dead job. A dead job stays in its file with the last error. The provider keeps the 100 newest dead jobs of each Queue Definition.
- The server writes the attempt count before the handler runs. A job whose handler was running when the process stopped runs again after the restart. If that was the fourth attempt, the job becomes a dead job instead.
- Delivery is at least once. A successful handler can run again after a restart if the process stops before completion is saved, or if both deleting the job and saving its completed state fail. Make handler side effects idempotent.
- `delaySeconds` survives a restart. `idempotencyKey` returns the message ID of a pending or running job with the same key. A dead job does not hold its key. `sendBatch()` stores all jobs or none.
- The jobs survive a restart on the same disk. Another host, a new container, or an ephemeral filesystem does not have them. Run one server process per directory: there is no lock between processes, so two processes can run the same job.
- `onError` and `callbackOptions` are Cloudflare and Vercel options. The local provider does not call them.

The server logs the directory and this durability once when it starts. `vitehub queue list` shows the provider, the directory, `durability: "single-host"`, the dead-job limit, and the pending, running, and dead jobs of each Queue Definition.

## Treat acceptance and delivery separately

`runQueue()` waits for provider enqueue and returns `[error, result]`. `result` is this portable value:

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

`runQueue()`, `dynamicQueue.run()`, `send()`, and `sendBatch()` return `[error, data]`. `error.code` is `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, or `QUEUE_UNSUPPORTED_OPTION`, and each error has `why`, `fix`, `docs`, and `cause`. Configuration errors, for example an unknown Queue name or a missing Cloudflare binding, throw. `JSON.stringify(error)` and Queue delivery reports omit `cause`, so keep credentials and provider responses there. Throw `ViteHubError` from a handler for an application code. See the [Queue error reference](https://vitehub.dev/docs/queue/limits-and-errors) for each code and the retry policy.

## Public imports

| Import                           | Purpose                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `@vite-hub/queue`                | Queue Definitions, enqueue helpers, direct clients, host adapters, and public types |
| `@vite-hub/queue/vite`           | Vite discovery and Cloudflare, Vercel, or local Nitro configuration                 |
| `@vite-hub/queue/nuxt`           | Nuxt module that composes Queue into Nitro                                          |
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
import { getQueue, runQueue } from "@vite-hub/queue"

const [error] = await runQueue("welcome-email", { email: "ada@example.com" }, { delaySeconds: 60 })
const queue = await getQueue("welcome-email")
const [sendError] = await queue.send({ email: "ada@example.com" })
```

`QueueRegistry` is the generated definition map. `QueuePayload<"welcome-email">` extracts a payload type. A missing name or wrong payload is a type error. Run Vite configuration or the Nuxt prepare step after you add a definition. For a standalone TypeScript host, you can extend `QueueRegistry` with `typeof import("./welcome.queue").default`.

Use `dynamicQueue.run(name, payload, options?)`, `dynamicQueue.defer()`, or `dynamicQueue.get()` for names read from external input. These methods check that the definition exists at runtime. They do not validate payload shape. Validate external data in your application. Direct provider clients from `createQueueClient()` also accept unknown payloads because they have no Queue Definition.

This is a breaking change: replace `runQueue(name, { payload, ...options })` with `runQueue(name, payload, options)`, and `client.send({ payload, ...options })` with `client.send(payload, options)`. There is no envelope detection. Existing envelope objects are delivered whole as payloads.
