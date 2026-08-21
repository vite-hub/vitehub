---
title: Rate Limit
description: Require request budgets through an event-first H3 guard and atomic drivers.
navigation.order: 3.5
icon: i-lucide-gauge
---

Use Rate Limit before expensive server work to cap requests by client, user, account, or tenant. The selected driver consumes one unit atomically and reports whether the request can continue.

Don't build this with a KV `get()` followed by `set()`. Concurrent requests can read the same value. Rate Limit accepts drivers that implement atomic `consume()` for their backend.

## Quick start

Register the integration. It uses memory during local Vite development and infers Cloudflare from a production Nitro preset.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", rateLimit: true })],
})
```

Require the Rate Limit directly in ordinary server code. The guard does not need a dedicated directory, file suffix, or module-scope declaration.

```ts [server/api/image-upload.post.ts]
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  await requireRateLimit(event, 'image-upload', {
    limit: 10,
    window: '1m',
  })
  return { ok: true }
})
```

`requireRateLimit()` uses the event's client address and throws a standard H3 `HTTPError` when the request is limited. Pass `key: authenticatedUser.id` when a user, account, tenant, or API client is the correct budget boundary.

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
| `window` | duration string | required | Fixed window such as `10s`, `1m`, `1h`, or `1d`. |
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

Use `createRateLimiter()` when the application needs this decision for a custom response, explicit logging, or another transport. Provider unavailability follows the declared failure policy and carries its original `cause`; configuration and provider-contract defects still throw normal `TypeError` or `Error` instances. The managed guard maps rejection to H3 `HTTPError`: status `429` when limited and status `503` when fail-closed enforcement is unavailable. It adds `retry-after` only when the driver supplies `retryAfter`, so do not calculate billing or authorization from optional best-effort metadata.

## Inspect generated guarantees

The integration writes `.vitehub/rate-limit/manifest.json` during configuration and Provider Output. Agents and tooling can inspect it. Application code keeps using the guard.

The manifest records `enforcement`, counter `scope`, `rejectedAttempts`, and supported `windows` without duplicating optional response metadata contracts.

```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 2,
  "rateLimits": [
    {
      "name": "image-upload",
      "provider": "cloudflare",
      "capabilities": {
        "enforcement": "best-effort",
        "rejectedAttempts": "unknown",
        "scope": "location",
        "windows": [10000, 60000]
      }
    }
  ]
}
```

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

## Deploy to Cloudflare

With a Cloudflare Nitro preset, `hubRateLimit()` infers the provider. Set a deployment-unique namespace so matching Rate Limit IDs cannot share counters across Workers or environments in the same Cloudflare account.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubRateLimit({ namespace: 'acme-image-service-production' })],
})
```

Cloudflare native enforcement is best-effort and exposes only 10-second and 60-second windows. It does not return portable quota metadata, so incompatible policies fail during the build. Use a different namespace for staging, production, and any separately deployed Worker because Cloudflare shares counters with the same namespace ID across Workers.

Inspect generated `wrangler.json` entries and exercise the deployed Worker. A request-scoped Cloudflare binding cannot be validated from an unrelated Node script.

## Limitations

- Memory enforcement is local and single-process. It is not a production default for horizontally scaled or request-scoped hosts.
- A production build with unknown hosting must select a provider explicitly or use a direct Rate Limiter.
- Request identity defaults to the H3 event's client address; explicit user or tenant identities remain application policy.
- Managed policies must be static so ViteHub can provision provider infrastructure.
- The package exposes atomic consumption, not a non-consuming check that providers cannot implement consistently.

## Related

- [Rate Limit Capability](/docs/capabilities/rate-limit)
- [Cloudflare Provider Output](/docs/frameworks-hosts/cloudflare)
- [Import paths](/docs/reference/import-paths)
