---
title: Rate Limit
description: Consume request budgets through source-local handles and atomic drivers.
navigation.order: 3.5
icon: i-lucide-gauge
---

Rate Limit owns atomic budget consumption before expensive server work starts. The active host integration supplies the request identity by default; an explicit user or tenant key can override it. The selected Rate Limit Driver decides whether one unit is allowed.

Rate Limit is separate from KV. A generic KV `get()` followed by `set()` races under concurrency, so ViteHub accepts only drivers that implement atomic `consume()` for their backend.

## Quick start

Register the integration. It uses memory during local Vite development and infers Cloudflare from a production Nitro preset.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ rateLimit: true })],
})
```

Declare and consume the Rate Limit in ordinary server code. The declaration does not need a default export, dedicated directory, or file suffix.

```ts [server/api/image-upload.post.ts]
import { defineRateLimit } from 'vite-hub/rate-limit'

const uploads = defineRateLimit('image-upload', {
  failure: 'deny',
  limit: 10,
  window: '1m',
})

export default defineEventHandler(async () => {
  await uploads.enforce()
  return { ok: true }
})
```

Inside an H3 request, `.enforce()` uses the client address installed by the integration and throws a standard H3 `HTTPError` when the request is limited. Pass an explicit key such as `.enforce(authenticatedUser.id)` when authenticated user, account, tenant, or API-client identity is the correct budget boundary.

## Define a managed Rate Limit

`defineRateLimit(id, policy)` returns the runtime handle. The integration finds top-level declarations through the compiler AST and uses their stable IDs and policies for Provider Output.

```ts
const uploads = defineRateLimit('image-upload', {
  enforcement: 'best-effort',
  failure: 'deny',
  limit: 10,
  window: '1m',
})
```

The call must be assigned directly to a top-level `const`. The ID, `limit`, `window`, `enforcement`, and `failure` must use static literals because provider infrastructure is generated before runtime. Duplicate IDs fail with both source locations.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | positive integer | required | Allowed consumptions in each fixed window. |
| `window` | duration string | required | Fixed window such as `10s`, `1m`, `1h`, or `1d`. |
| `enforcement` | `"best-effort" \| "strict"` | `"best-effort"` | Minimum enforcement guarantee the selected driver must provide. |
| `failure` | `"deny" \| "allow"` | `"deny"` | Whether an unavailable driver returns a denied or allowed unavailable decision. |

## Public imports

| Import | Use |
| --- | --- |
| `defineRateLimit` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Declare a managed handle and enforce it with `.enforce(key?)` or inspect it with `.consume(key?)`. |
| `createRateLimiter` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Build a direct limiter around a custom driver. |
| `memoryRateLimitDriver` from `@vite-hub/rate-limit/drivers/memory` | Enforce fixed windows in one process. |
| `cloudflareRateLimitDriver` from `@vite-hub/rate-limit/drivers/cloudflare` | Consume a Cloudflare Rate Limiting binding directly. |
| `hubRateLimit` from `@vite-hub/rate-limit/vite` | Register source collection, runtime setup, and Provider Output without the framework preset. |

`@vite-hub/rate-limit/runtime` is reserved for framework integration. Applications consume the handle returned by `defineRateLimit()`.

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

Use `.consume()` when the application needs this decision for a custom response, explicit logging, or another transport. Provider unavailability follows the declared failure policy and carries its original `cause`; configuration and provider-contract defects still throw normally. Add a `retry-after` header only when `retryAfter` is present, and do not calculate billing or authorization from optional best-effort metadata.

## Inspect generated guarantees

The integration writes `.vitehub/rate-limit/manifest.json` during configuration and Provider Output. Agents and tooling can inspect it; application code should keep using the handle.

The manifest records `rejectedAttempts` and the other provider guarantees so tooling does not have to infer them from the driver name.

```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 1,
  "rateLimits": [
    {
      "name": "image-upload",
      "provider": "cloudflare",
      "capabilities": {
        "enforcement": "best-effort",
        "metadata": {
          "remaining": { "availability": "never" },
          "resetAt": { "availability": "never" },
          "retryAfter": { "availability": "never" },
          "used": { "availability": "never" }
        },
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

Every direct limiter exposes `policy` and `capabilities`. The memory driver is process-local and intended for development, tests, and known single-process hosts.

Custom drivers return `{ unavailable: true, cause }` only for expected operational outages that the declared failure policy should govern. Configuration, provider-contract, and implementation defects should throw normally.

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
- Request identity defaults to the active host integration; explicit user or tenant identities remain application policy.
- Managed policies must be static so ViteHub can provision provider infrastructure.
- The package exposes atomic consumption, not a non-consuming check that providers cannot implement consistently.

## Related

- [Rate Limit Capability](/docs/capabilities/rate-limit)
- [Cloudflare Provider Output](/docs/frameworks-hosts/cloudflare)
- [Import paths](/docs/reference/import-paths)
