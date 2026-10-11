---
title: Rate Limit server API
description: Require managed Rate Limits, read limiter decisions, and build direct limiters around drivers.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Require a managed rate limit

`requireRateLimit(event, id, options)` resolves when the request is allowed. The integration finds calls inside handlers through the compiler AST and uses their stable IDs and provider policies for Provider Output.

```ts
await requireRateLimit(event, 'image-upload', {
  enforcement: 'best-effort',
  failure: 'deny',
  key: authenticatedUser.id,
  limit: 10,
  window: '1m',
})
```

The ID, `limit`, `window`, `enforcement`, and `failure` must use static literals because ViteHub generates provider configuration before runtime. `event` and `key` remain runtime inputs, so an authenticated identity can be dynamic. Repeated IDs with the same normalized policy share one budget. Conflicting policies fail the build and report both source locations.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | positive integer | required | Allowed consumptions in each fixed window. |
| `window` | duration string | required | Fixed window such as `10s`, `1m`, `1h`, or `1d`. It must resolve to finite milliseconds greater than zero and at most `8.64e15`. |
| `enforcement` | `"best-effort" \| "strict"` | `"best-effort"` | Minimum enforcement guarantee the selected driver must provide. |
| `failure` | `"deny" \| "allow"` | `"deny"` | Whether an unavailable driver returns a denied or allowed unavailable decision. |
| `key` | `string` | request client address | Runtime identity for a user, tenant, account, or API client. |

## Public imports

| Import | Use |
| --- | --- |
| `requireRateLimit` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Enforce a discovered managed Rate Limit inside an H3 handler. |
| `createRateLimiter` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Build a direct limiter around a custom driver. |
| `memoryRateLimitDriver` from `@vite-hub/rate-limit/drivers/memory` | Enforce fixed windows in one process. |
| `cloudflareRateLimitDriver` from `@vite-hub/rate-limit/drivers/cloudflare` | Consume a Cloudflare Rate Limiting binding directly. |
| `hubRateLimit` from `@vite-hub/rate-limit/vite` | Register source collection, runtime setup, and Provider Output without the framework preset. |

`@vite-hub/rate-limit/runtime` is reserved for framework integration. Applications call `requireRateLimit()` or build a direct limiter.

## Understand the decision

Every driver returns `allowed`. Portable quota metadata is optional because native providers do not expose the same fields.

When present, `resetAt` must be a positive Unix timestamp in milliseconds, at most `8.64e15`. The memory driver rejects a fixed window whose end exceeds that range before it stores a counter. It preserves the configured duration. Invalid custom driver timestamps throw regardless of the failure policy.

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

Use `createRateLimiter()` when the application needs this decision for a custom response, explicit logging, or another transport. Provider unavailability follows the declared failure policy and carries its original `cause`; configuration and provider-contract defects use package-owned `RATE_LIMIT_B####` or `RATE_LIMIT_R####` Nostics codes. The managed guard maps rejection to H3 `HTTPError`: status `429` when limited and status `503` when fail-closed enforcement is unavailable. It adds `retry-after` only when the driver supplies `retryAfter`, so do not calculate billing or authorization from optional best-effort metadata.

## Use a direct driver

Use `createRateLimiter()` when the policy or driver is intentionally resolved outside managed Provider Output.

Install the owner package before importing a driver directly:

```bash [Terminal]
pnpm add @vite-hub/rate-limit
```

```ts
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

Every direct limiter exposes its resolved `policy` and the provider capabilities that affect enforcement and deployment. The memory driver is process-local and intended for development, tests, and known single-process hosts.

Custom drivers return `[null, result]` after consuming the counter and `[error, undefined]` only for expected operational outages handled by the failure policy. Configuration, provider-contract, and implementation defects must throw normally.
