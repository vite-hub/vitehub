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

## Vite Integration

Use `hubQueue()` in Vite to discover `server/queues/<name>.ts` and `src/<name>.queue.ts`. The handler name comes from the file path, while provider output maps it to [Cloudflare Queues](https://developers.cloudflare.com/queues/) or [Vercel Queues](https://vercel.com/docs/queues).

Learn more at [vitehub.dev](https://vitehub.dev).
