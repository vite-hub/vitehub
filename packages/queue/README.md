# @vite-hub/queue

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Queue" src="https://img.shields.io/badge/Queue-background%20jobs-9333ea?style=flat-square">
</p>

`@vite-hub/queue` defines background job handlers by file path and keeps producers on one `runQueue()` API.

## Install

```sh
pnpm add @vite-hub/queue
```

Add `@vercel/queue` when you use the Vercel provider.

Vercel Queue projects that typecheck the generated path need Node and ws ambient types:

```sh
pnpm add -D @types/node @types/ws
```

## Minimal API

```ts
// server/queues/welcome-email.ts
import { defineQueue } from "@vite-hub/queue"

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```

```ts
// server/api/signup.post.ts
import { runQueue } from "@vite-hub/queue"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  return runQueue("welcome-email", await readBody<{ email: string }>(event))
})
```

```ts
// vite.config.ts
import { hubQueue } from "@vite-hub/queue/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubQueue()],
  queue: { provider: "cloudflare" },
})
```

Throw `ViteHubError` when a Queue Definition needs a stable application error code. Queue retry policy belongs to Queue Delivery and provider callbacks, not the error object.

```ts
import { ViteHubError } from "@vite-hub/runtime"
import { defineQueue } from "@vite-hub/queue"

export default defineQueue<{ email?: string }>(async ({ payload }) => {
  if (!payload.email) {
    throw new ViteHubError("WELCOME_EMAIL_INVALID_PAYLOAD", "Welcome email payload requires an email address.", {
      details: { field: "email" },
    })
  }

  await sendWelcomeEmail(payload.email)
})
```

ViteHub's built-in codes remain available as `QueueErrorCode`. ViteHub reports each failed delivery with safe Queue and message identifiers, attempt count, code, details, and the Queue-owned retry decision before choosing the provider action. Cloudflare `onError` and Vercel `callbackOptions.retry` directives override the default action when they return an explicit directive.

## Vite Integration

Use `hubQueue()` in Vite to discover `server/queues/<name>.ts` and `src/<name>.queue.ts`. The handler name comes from the file path, while provider output maps it to [Cloudflare Queues](https://developers.cloudflare.com/queues/) or [Vercel Queues](https://vercel.com/docs/queues).

In Nuxt, install the Queue module instead. It installs the same Vite integration and merges the generated runtime files and provider bindings into Nitro configuration:

```ts
export default defineNuxtConfig({
  modules: [["@vite-hub/queue/nuxt", { provider: "cloudflare" }]],
})
```

Run `vite build` to emit Queue Provider Output. Cloudflare output is written under `dist/**/wrangler.json`; Vercel output is written under `.vercel/output/functions/api/vitehub/queues/vercel/**`.

Learn more at [vitehub.dev](https://vitehub.dev).
