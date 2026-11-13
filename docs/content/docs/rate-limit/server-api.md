---
title: Rate Limit server API
description: Guard routes with managed Rate Limits, read limiter decisions, and build direct limiters around drivers.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Require a managed rate limit

`requireRateLimit(event, id, options)` resolves when the request is allowed. At build time, ViteHub finds these calls and writes their IDs and policies to Provider Output, the generated host config.

```ts fragment
await requireRateLimit(event, 'image-upload', {
  enforcement: 'best-effort',
  failure: 'deny',
  key: authenticatedUser.id,
  limit: 10,
  window: '1m',
})
```

The ID, `limit`, `window`, `enforcement`, and `failure` must be static literals, because ViteHub writes the provider config before runtime. `event` and `key` are runtime values, so the identity can change per request.

- `event` is any request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties: an H3 2 event in a ViteHub app, or a Web `Request`, such as the one `withAuth()` passes.
- Without `key`, the guard counts by `event['~standard'].runtime.clientAddress`. On Cloudflare, the `cf-connecting-ip` header comes first.
- A `Request` has no client address, so pass `key`. On Cloudflare, the guard reads `cf-connecting-ip` and the current request's bindings instead.
- The same ID with the same normalized policy shares one budget. Conflicting policies fail the build and show both source locations.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | positive integer | required | Allowed requests per fixed window. |
| `window` | duration string | required | Fixed window such as `10s`, `1m`, `1h`, or `1d`. Must be finite, more than zero, and at most `8.64e15` milliseconds. |
| `enforcement` | `"best-effort" \| "strict"` | `"best-effort"` | Lowest guarantee the driver must give. |
| `failure` | `"deny" \| "allow"` | `"deny"` | Whether an unavailable driver denies or allows the request. |
| `key` | `string` | request client address | Identity of a user, tenant, account, or API client. |

## Check without throwing

`checkRateLimit(event, id, options)` takes the same arguments and uses the same counters as `requireRateLimit()`, but returns the [decision](#understand-the-decision) instead of throwing. Use it to still answer a limited request, for example with a cached result.

```ts [server/api/og.get.ts]
import { defineEventHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  const decision = await checkRateLimit(event, 'og-image', { limit: 20, window: '1m' })
  // Over the limit, answer with the generic card instead of rendering one
  if (!decision.allowed) return { image: '/og/generic.png' }
  return { image: `/og/render.png?path=${encodeURIComponent(event.url.pathname)}` }
})
```

`reason` is `limited` when the budget is used up, or `unavailable` when the driver failed and `failure` is `deny`. With `failure: 'allow'`, an unavailable driver returns `allowed: true` with `reason: 'unavailable'`. Invalid options, a missing Cloudflare binding, and a request without a key still throw. ViteHub finds `checkRateLimit()` calls like `requireRateLimit()` calls, so the ID and policy must be static, and both share one budget per ID.

## Public imports

| Import | Use |
| --- | --- |
| `requireRateLimit` from `vite-hub/rate-limit` | Enforce a managed Rate Limit in an H3 handler. |
| `checkRateLimit` from `vite-hub/rate-limit` | Consume a managed Rate Limit and return its decision. |
| `createRateLimiter` from `vite-hub/rate-limit` | Build a direct limiter around a custom driver. |
| `memoryRateLimitDriver` from `vite-hub/rate-limit/drivers/memory` | Fixed windows in one process. |
| `kvRateLimitDriver` from `@vite-hub/rate-limit/drivers/kv` | Fixed windows in a KV store that every process shares, with `kv` from `vite-hub/kv`. |
| `cloudflareRateLimitDriver` from `vite-hub/rate-limit/drivers/cloudflare` | Use a Cloudflare Rate Limiting binding directly. |
| `hubRateLimit` from `@vite-hub/rate-limit/vite` | Add call discovery, runtime setup, and Provider Output without the framework integration. |

`@vite-hub/rate-limit/runtime` is for framework integrations only. Apps call `requireRateLimit()` or build a direct limiter.

## Understand the decision

Every driver returns `allowed`. Quota metadata is optional, because native providers return different fields.

`resetAt`, when present, must be a positive Unix timestamp in milliseconds, at most `8.64e15`. The memory driver rejects a window that ends past that limit before it stores a counter, and keeps the configured duration. Invalid custom driver timestamps always throw, whatever the failure policy.

```ts
interface RateLimitDecision {
  allowed: boolean
  cause?: unknown
  limit: number
  reason?: 'limited' | 'unavailable'
  remaining?: number
  resetAt?: number
  retryAfter?: number
  used?: number
  windowMs: number
}
```

Use `createRateLimiter()` when you need the decision for a custom response, logging, or another transport.

- An unavailable provider follows the failure policy and keeps its original `cause`.
- Config and provider-contract defects use `RATE_LIMIT_B####` or `RATE_LIMIT_R####` Nostics codes.
- A diagnostic thrown while ViteHub reads options passes through only when it comes from the same `nostics` package as this module. ViteHub cannot verify diagnostics from other packages or realms, so it reports them as `RATE_LIMIT_R0029`. This stops user values from slipping past the invalid-options check.
- The managed guard throws H3 `HTTPError`: `429` when limited, and `503` when fail-closed enforcement is unavailable. It adds `retry-after` only when the driver gives `retryAfter`. Do not base billing or authorization on optional best-effort metadata.

## Use a direct driver

Use `createRateLimiter()` when you choose the policy or driver yourself, outside managed Provider Output. Install the package first:

```bash [Terminal]
pnpm add @vite-hub/rate-limit
```

```ts
import { createRateLimiter } from 'vite-hub/rate-limit'
import { memoryRateLimitDriver } from 'vite-hub/rate-limit/drivers/memory'

const limiter = createRateLimiter({
  driver: memoryRateLimitDriver(),
  enforcement: 'strict',
  limit: 2,
  window: '1m',
})

const decision = await limiter.consume({ key: 'demo' })
```

Every direct limiter exposes its resolved `policy` and the provider features that affect enforcement and deployment. The memory driver lives in one process. Use it for development, tests, and hosts you know run one process.

`kvRateLimitDriver()` counts in a KV store instead, so every process that uses the store shares the counts. The store needs an atomic `increment`: the `redis`, `database`, and `upstash` KV drivers have one.

```ts
import { createRateLimiter } from '@vite-hub/rate-limit'
import { kvRateLimitDriver } from '@vite-hub/rate-limit/drivers/kv'
import { kv } from 'vite-hub/kv'

const limiter = createRateLimiter({
  driver: kvRateLimitDriver({ storage: kv.store('limits') }),
  enforcement: 'strict',
  limit: 10,
  window: '1m',
})
```

A custom driver returns `[null, result]` after it consumes the counter. It returns `[error, undefined]` only for expected outages that the failure policy handles. Config, provider-contract, and code defects must throw.
