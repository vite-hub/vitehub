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

Throw `QueueError` when a Queue Definition can classify the failure. Delivery retries by default; set `retryable: false` for a permanent failure such as an invalid payload.

```ts
import { defineQueue, QueueError } from "@vite-hub/queue"

export default defineQueue<{ email?: string }>(async ({ payload }) => {
  if (!payload.email) {
    throw new QueueError<"WELCOME_EMAIL_INVALID_PAYLOAD">({
      code: "WELCOME_EMAIL_INVALID_PAYLOAD",
      custom: true,
      details: { field: "email" },
      message: "Welcome email payload requires an email address.",
      retryable: false,
    })
  }

  await sendWelcomeEmail(payload.email)
})
```

Custom application codes use an explicit generic and `custom: true`, while ViteHub's built-in codes are available as `QueueErrorCode`. The marker makes application-owned messages, details, and retry policy an explicit public contract at runtime; `retryable` is available only on custom errors because ViteHub owns the retry policy for built-in failures. ViteHub reports each failed delivery with safe queue and message identifiers, attempt count, code, details, and retry policy before choosing the provider action. Cloudflare `onError` and Vercel `callbackOptions.retry` directives override the default action when they return an explicit directive.

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
