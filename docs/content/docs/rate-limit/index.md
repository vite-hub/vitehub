---
title: Rate Limit
navigation.title: Overview
description: Limit how many requests each client or user can make to a route, and reject the extra requests with a 429 error.
navigation.order: 1
icon: i-lucide-gauge
---

::product-hero{tagline="Cap how many requests each client or user can make, and reject the extra ones with a 429 error." hosts="Node, Docker, Cloudflare"}
  :::product-files
  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'
  import { nitro } from 'nitro/vite'

  export default defineConfig({
    plugins: [
      // On Node, counts stay in memory
      vitehub({ preset: 'node', rateLimit: true }),
      nitro() as never,
    ],
  })
  ```

  ```ts [server/api/upload.post.ts]
  import { defineEventHandler } from 'h3'
  import { requireRateLimit } from 'vite-hub/rate-limit'

  // 2 requests a minute for each client.
  // The third gets a 429 error.
  export default defineEventHandler(async (event) => {
    await requireRateLimit(event, 'image-upload', {
      limit: 2,
      window: '1m',
    })
    return { ok: true }
  })
  ```

  ```ts [server/api/messages.post.ts]
  import { defineEventHandler } from 'h3'
  import { withAuth } from 'vite-hub/auth/server'
  import { requireRateLimit } from 'vite-hub/rate-limit'

  // Count per signed-in user, not per address
  export default defineEventHandler(
    withAuth(async (event, { user }) => {
      await requireRateLimit(event, 'send-message', {
        key: user.id,
        limit: 10,
        window: '1m',
      })
      return { ok: true }
    }),
  )
  ```

  ```ts [server/api/search.get.ts]
  import { defineEventHandler } from 'h3'
  import { createRateLimiter } from '@vite-hub/rate-limit'
  import {
    memoryRateLimitDriver,
  } from '@vite-hub/rate-limit/drivers/memory'

  const limiter = createRateLimiter({
    driver: memoryRateLimitDriver(),
    limit: 30,
    window: '1m',
  })

  // Read the result and answer your own way
  export default defineEventHandler(async () => {
    const result = await limiter.consume({ key: 'all' })
    if (!result.allowed) return { busy: true }
    return { results: [] }
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One line guards a route" icon="i-lucide-shield-alert" to="/docs/rate-limit/server-api#require-a-managed-rate-limit"}
  `requireRateLimit()` lets the request continue or stops it with a 429 error.
  :::

  :::product-feature-item{title="Count per user or per team" icon="i-lucide-users" to="/docs/rate-limit/server-api#require-a-managed-rate-limit"}
  Each client address has its own count. Pass `key` to count per user, account, or team.
  :::

  :::product-feature-item{title="Choose your own response" icon="i-lucide-code-2" to="/docs/rate-limit/server-api#use-a-direct-driver"}
  `limiter.consume()` returns the result and does not throw.
  :::

  :::product-feature-item{title="Memory on Node, native on Cloudflare" icon="i-lucide-server" to="/docs/rate-limit/hosts#deploy-to-cloudflare"}
  On Node, counts stay in memory. On Cloudflare, the limit uses Cloudflare Rate Limiting.
  :::

  :::product-feature-item{title="See each limit before you deploy" icon="i-lucide-file-search" to="/docs/rate-limit/hosts#inspect-generated-guarantees"}
  The build writes a file that lists each limit and what the host can promise.
  :::

  :::product-feature-item{title="Know the limits" icon="i-lucide-info" to="/docs/rate-limit/limits-and-errors#limitations"}
  Memory counts reset on restart and are not shared between servers.
  :::
::

::agent-only{skill="rate-limit"}
Use Rate Limit to guard an action with an atomic counter and a defined window. Put identity derivation in the caller or Agent Capability.

Read [Get started](https://vitehub.dev/raw/docs/rate-limit/get-started.md), [Server API](https://vitehub.dev/raw/docs/rate-limit/server-api.md), [Hosts](https://vitehub.dev/raw/docs/rate-limit/hosts.md), or [Limits and errors](https://vitehub.dev/raw/docs/rate-limit/limits-and-errors.md).

Choose a provider whose guarantees match the action. Memory is local to one process. Inspect `.vitehub/rate-limit/manifest.json` before a production deploy. Do not replace a Rate Limit with a KV read followed by a write.

Prove allowed, rejected, reset, and provider failure behavior. Check the resolved window and enforcement mode in generated inspection state.
::
