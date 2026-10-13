---
title: Rate Limit
navigation.title: Overview
description: Require request budgets through an event-first H3 guard and atomic drivers.
navigation.order: 1
icon: i-lucide-gauge
---

::product-hero{tagline="One guard caps requests per client, user, or tenant, with atomic drivers: memory on Node, Cloudflare Rate Limiting on Cloudflare." hosts="Node, Docker, Cloudflare"}
  :::code-group
  ```ts [Route]
  import { auth } from '@vite-hub/auth/server'
  import { requireRateLimit } from 'vite-hub/rate-limit'

  export default defineEventHandler(async (event) => {
    const session = await auth.api.getSession({ headers: new Headers(getRequestHeaders(event)) })

    await requireRateLimit(event, 'image-upload', {
      enforcement: 'best-effort',
      failure: 'deny',
      key: session?.user.id,
      limit: 10,
      window: '1m',
    })
    return { ok: true }
  })
  ```

  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [vitehub({ preset: "node", rateLimit: true })],
  })
  ```

  ```ts [Limiter]
  import { createRateLimiter } from '@vite-hub/rate-limit'
  import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

  const limiter = createRateLimiter({
    driver: memoryRateLimitDriver(),
    enforcement: 'strict',
    limit: 2,
    window: '1m',
  })

  const decision = await limiter.consume({ key: 'demo' })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { rateLimit } from 'vite-hub/agent/capabilities'
  import { createRateLimiter } from '@vite-hub/rate-limit'
  import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

  const invocations = createRateLimiter({
    driver: memoryRateLimitDriver(),
    limit: 20,
    window: '1m',
  })

  export default defineAgent({
    driver: { model },
    capabilities: [
      rateLimit({
        limiter: invocations,
      }),
    ],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="Limited requests get a 429 from the guard" icon="i-lucide-shield-alert" to="/docs/rate-limit/server-api"}
  `requireRateLimit()` throws `429`, keyed by client address unless you pass `key`.
  :::

  :::product-feature-item{title="Read the decision for your own response" icon="i-lucide-code-2" to="/docs/rate-limit/server-api#use-a-direct-driver"}
  `limiter.consume()` returns the decision and does not throw.
  :::

  :::product-feature-item{title="The preset selects the driver" icon="i-lucide-sliders-horizontal" to="/docs/rate-limit/get-started"}
  `node` uses memory; `cloudflare` uses Cloudflare Rate Limiting.
  :::

  :::product-feature-item{title="Budget each Agent Invocation before it runs" icon="i-lucide-bot" to="/docs/rate-limit/agent-capability"}
  `rateLimit()` consumes one unit; a rejection maps to `429`.
  :::

  :::product-feature-item{title="The build records what each provider guarantees" icon="i-lucide-cloud-cog" to="/docs/rate-limit/hosts"}
  `.vitehub/rate-limit/manifest.json` lists enforcement, scope, and windows per limit.
  :::

  :::product-feature-item{title="Not a KV get followed by set" icon="i-lucide-git-branch" to="/docs/kv"}
  KV get then set races; Rate Limit drivers `consume()` atomically.
  :::
::
