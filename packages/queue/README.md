# @vite-hub/queue

`@vite-hub/queue` discovers background job handlers during a Vite build and connects `runQueue()` to Cloudflare Queues or Vercel Queues. A successful enqueue means the provider accepted the job. It does not mean the handler finished.

Applications that already use the `vite-hub` framework distribution should enable Queue in `vitehub()` and import from `vite-hub/queue`. Install this owner package directly when you are building a custom composition, another framework integration, or package-level tooling. The [Queue guide](https://vitehub.dev/docs/server-primitives/queue) covers the framework-distribution setup.

## Install the owner package

```sh
pnpm add @vite-hub/queue
pnpm add -D vite
```

The package requires Node 24 or newer. Vite is an optional peer dependency and is required for definition discovery and provider output.

For Vercel Queues, also install the provider package and the ambient types used by generated functions:

```sh
pnpm add @vercel/queue
pnpm add -D @types/node @types/ws
```

## Build the first Queue Definition

Queue has no in-memory provider for local delivery. The first credential-free result is a build that discovers a Queue Definition and emits provider configuration. This example selects Cloudflare explicitly.

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
  return await runQueue("welcome-email", { email });
}

export default function handleRequest() {
  return new Response("Queue producer ready");
}
```

Register the standalone Vite integration and give Vite a server entry:

```ts
// vite.config.ts
import { resolve } from "node:path";

import { hubQueue } from "@vite-hub/queue/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
    ssr: true,
  },
  plugins: [hubQueue({ provider: "cloudflare" })],
});
```

Run a production-shaped build:

```sh
pnpm vite build
```

A successful build writes `.vitehub/queue/registry.mjs` with the `welcome-email` definition. It also writes a Cloudflare Worker and `wrangler.json` under `dist`. The Wrangler configuration contains one generated producer binding and one consumer for the Queue Definition.

That build proves discovery and generated output only. `runQueue()` needs the generated runtime, a deployed Cloudflare binding, and an existing queue before it can return `{ status: "queued" }`. Use the [Cloudflare host guide](https://vitehub.dev/docs/frameworks-hosts/cloudflare) for provisioning and deployment checks. Do not import `.vitehub` or `dist` files from application code.

## Choose Cloudflare or Vercel

| Provider   | Choose it when                                                                                        | Generated output                                                    | Enqueue options                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cloudflare | The deployed runtime supplies request-scoped Cloudflare Queue bindings                                | Worker bundle and `wrangler.json` producer and consumer entries     | `contentType`, `delaySeconds`                                  |
| Vercel     | The deployment runs Vercel Queue callbacks and has a Queue region when the installed SDK requires one | Consumer functions and trigger configuration under `.vercel/output` | `delaySeconds`, `idempotencyKey`, `region`, `retentionSeconds` |

The ViteHub framework preset selects Cloudflare for `preset: "cloudflare"` and Vercel for `preset: "vercel"`. With the standalone owner package, set `provider` explicitly when host inference would be ambiguous. Netlify cannot infer one. ViteHub provides no Queue Provider for local delivery, Deno, or self-hosted Node. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before choosing a deployment target.

Cloudflare needs a concrete request-scoped binding at runtime. Its generated queue resources can be created through the ViteHub Cloudflare provision step when the required account credentials are present. Cloudflare rejects Vercel-only options such as `idempotencyKey`, `region`, and `retentionSeconds`.

Vercel needs a generated topic and the `@vercel/queue` runtime. It rejects Cloudflare's `contentType` option. The [Vercel host guide](https://vitehub.dev/docs/frameworks-hosts/vercel) explains the generated Build Output boundary.

## Treat acceptance and delivery separately

`runQueue()` waits for provider enqueue and returns this portable result:

```ts
type QueueSendResult = {
  messageId?: string;
  status: "queued";
};
```

The optional message ID identifies provider acceptance. Queue handlers run later and return no value to the producer. Use a [Workflow](https://vitehub.dev/docs/server-primitives/workflows) when the caller needs a tracked run, durable steps, waits, or progress.

`deferQueue()` does not wait for provider acceptance. It schedules enqueue work through the current request's `waitUntil`, logs dispatch failures, and calls the Queue Definition's `onDispatchError` hook when present.

Providers can retry failed delivery, so handlers must tolerate another invocation after a partial side effect. ViteHub does not expose an exactly-once delivery guarantee. Vercel sends an idempotency key, using the generated message ID by default; pass a stable application key when repeated enqueue attempts should share one key. Cloudflare does not accept `idempotencyKey`, so protect non-repeatable side effects inside the handler.

On Cloudflare, successful handlers acknowledge the message. Failed handlers retry by default unless ViteHub identifies a non-retryable built-in error or `onError` returns an explicit acknowledge or retry action. On Vercel, `callbackOptions.retry` can return an explicit directive; returning nothing preserves provider behavior. Application error codes do not choose retry policy.

Queue operations use the shared `ViteHubError` contract. Public `code` and JSON-safe `details` may appear in delivery reports. Put credentials, provider responses, and private resource locations in `cause`; serialized errors and Queue reports omit it. See the [Queue error and retry reference](https://vitehub.dev/docs/server-primitives/queue#errors) for built-in codes and provider callbacks.

## Public imports

| Import                           | Purpose                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `@vite-hub/queue`                | Queue Definitions, enqueue helpers, direct clients, host adapters, and public types |
| `@vite-hub/queue/vite`           | Vite discovery and Cloudflare or Vercel Provider Output                             |
| `@vite-hub/queue/nuxt`           | Nuxt module that composes Queue into Nitro                                          |
| `@vite-hub/queue/runtime/hosted` | Advanced hosted Vercel callback adapter                                             |

`@vite-hub/queue/internal/*` exists for generated framework integration. Application code should not import it.

## Go deeper

- [Queue guide](https://vitehub.dev/docs/server-primitives/queue)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Definitions and discovery](https://vitehub.dev/docs/concepts/definitions-and-discovery)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)
