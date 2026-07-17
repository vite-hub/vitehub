---
title: Rate Limit
description: Consume request budgets through provider-neutral Rate Limit Definitions and atomic drivers.
navigation.order: 3.5
icon: i-lucide-gauge
---

Rate Limit owns atomic budget consumption before expensive server work starts. Your server code supplies an opaque key; the selected Rate Limit Driver decides whether one unit is allowed.

Rate Limit is separate from KV. A generic KV `get()` followed by `set()` races under concurrency, so ViteHub accepts only drivers that implement atomic `consume()` for their backend.

## Before you start

- Use a Vite application that has the ViteHub framework distribution or the owner-package Vite Integration installed.
- Decide which authenticated user, account, API client, or host-controlled IP identity owns the budget. The primitive does not authenticate callers.
- Use the local memory path below without provider credentials. A Cloudflare deployment requires generated Worker output and the deployed Rate Limiting binding.

## Quick start

This path uses the local memory driver through the ViteHub preset during Vite development and serve commands. Production builds must infer Cloudflare or select an explicit provider; ViteHub does not automatically deploy process memory to an unknown host.

::steps{level="3"}

### Install and configure

```bash [Terminal]
pnpm add vite-hub
```

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ rateLimit: true })],
})
```

### Define the budget

Create a discovered Definition. The file name becomes the Rate Limit name `image-upload`.

```ts [server/rate-limits/image-upload.ts]
import { defineRateLimit } from 'vite-hub/rate-limit'

export default defineRateLimit({
  limit: 10,
  window: '1m',
})
```

### Consume the Definition from a server route

Call `consumeRateLimit()` with the discovered Definition name before expensive work starts. The Runtime Helper resolves `image-upload` from the generated registry, consumes one unit for the supplied key, and returns a `RateLimitDecision`.

```ts [server/api/image-upload.post.ts]
import { consumeRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async () => {
  const decision = await consumeRateLimit('image-upload', {
    key: 'demo:image-upload',
  })

  if (!decision.allowed) {
    return new Response('Too many uploads', {
      headers: decision.retryAfter === undefined
        ? undefined
        : { 'retry-after': String(decision.retryAfter) },
      status: 429,
    })
  }

  return {
    ok: true,
    remaining: decision.remaining,
  }
})
```

The fixed key makes the local example immediately testable. Replace it in production with an opaque key derived from an authenticated user, account, or API client. Do not pass a raw access token or an untrusted forwarded header.

### Verify the boundary

Call `POST /api/image-upload` 11 times. The first 10 calls return `{ "ok": true }`; the next call returns `429` before the route performs expensive work.

::

## Public imports

| Import | Use |
| --- | --- |
| `defineRateLimit`, `consumeRateLimit`, `getRateLimit` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Define and consume discovered budgets. |
| `createRateLimiter` from `vite-hub/rate-limit` or `@vite-hub/rate-limit` | Build a direct limiter around a custom driver. |
| `memoryRateLimitDriver` from `@vite-hub/rate-limit/drivers/memory` | Enforce fixed windows in one process. |
| `cloudflareRateLimitDriver` from `@vite-hub/rate-limit/drivers/cloudflare` | Consume a Cloudflare Rate Limiting binding directly. |
| `hubRateLimit` from `@vite-hub/rate-limit/vite` | Register discovery, generated Runtime Registry, and Provider Output without the framework preset. |

`@vite-hub/rate-limit/runtime` is the framework integration boundary for installing generated registry and request context. Application code should use the root Runtime Helpers.

## Choose the consumption API

Use `consumeRateLimit(name, { key })` for normal application code. It loads the discovered Definition by name, reuses the resolved limiter, and consumes one unit in a single call.

```ts [server/api/image-upload.post.ts]
import { consumeRateLimit } from 'vite-hub/rate-limit'

export function consumeImageUpload(verifiedUserId: string) {
  return consumeRateLimit('image-upload', {
    key: `user:${verifiedUserId}`,
  })
}
```

Use `getRateLimit(name)` when code needs to inspect the resolved policy or driver capabilities before consuming. Calling `consume()` on the returned limiter produces the same decision shape.

```ts [server/rate-limit-inspection.ts]
import { getRateLimit } from 'vite-hub/rate-limit'

export async function inspectAndConsumeImageUpload(verifiedUserId: string) {
  const limiter = await getRateLimit('image-upload')
  console.log(limiter.policy, limiter.capabilities)

  return limiter.consume({
    key: `user:${verifiedUserId}`,
  })
}
```

Use `createRateLimiter()` when the application supplies a driver directly and does not use discovered Definitions. Agent applications usually do not call these Runtime Helpers manually; `rateLimit({ limiter: 'image-upload' })` consumes the named Definition before each Agent Invocation.

## Define a rate limit

Create Definitions under `server/rate-limits/<path>.ts` or use `<path>.rate-limit.ts` outside that directory. Discovery normalizes the relative path into the Rate Limit name.

```ts [src/api/image-upload.rate-limit.ts]
import { defineRateLimit } from '@vite-hub/rate-limit'

export default defineRateLimit({
  enforcement: 'best-effort',
  failure: 'deny',
  limit: 10,
  window: '1m',
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | positive integer | required | Allowed successful consumptions in each fixed window. |
| `window` | duration string | required | Fixed window such as `10s`, `1m`, `1h`, or `1d`. |
| `enforcement` | `"best-effort" \| "strict"` | `"best-effort"` | Minimum enforcement guarantee the selected driver must provide. |
| `failure` | `"deny" \| "allow"` | `"deny"` | Whether an unavailable or throwing driver rejects the call or returns an allowed unavailable decision. |

The integration validates the Definition against the selected driver's capabilities. It fails during configuration or limiter creation when a strict policy selects a best-effort driver or the driver cannot represent the requested window.

Cloudflare Provider Output extracts the Definition at build time, so the discovered file must default-export `defineRateLimit({ ... })` directly with static `limit` and `window` literals. `enforcement` and `failure` must also be static when present. Use `createRateLimiter()` instead when policy is intentionally resolved at runtime.

## Understand the decision

Every driver must return `allowed`. Portable quota metadata is optional because native providers do not expose the same fields.

```ts
interface RateLimitDecision {
  allowed: boolean
  limit: number
  reason?: 'limited' | 'unavailable'
  remaining?: number
  resetAt?: number
  retryAfter?: number
  used?: number
  windowMs: number
}
```

Use `allowed` as the enforcement result. Add a `retry-after` header only when `retryAfter` is present, and do not calculate billing or authorization from optional best-effort metadata.

## Inspect driver guarantees

The Vite Integration writes `.vitehub/rate-limit/manifest.json` during config resolution and refreshes it with Provider Output. Inspect this generated state before deployment; agents and tooling can read it, but it is not an application import.

```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 1,
  "definitions": [
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

Definitions are sorted by `name`. Each entry records the resolved `memory` or `cloudflare` provider and the capabilities that provider will use.

Every runtime `RateLimiter` exposes the same capabilities when code needs to inspect the active limiter directly.

```ts [server/inspect-rate-limit.ts]
import { getRateLimit } from 'vite-hub/rate-limit'

const limiter = await getRateLimit('image-upload')
console.log(limiter.capabilities)
```

| Capability | Values | Meaning |
| --- | --- | --- |
| `enforcement` | `"strict" \| "best-effort"` | Whether the driver can satisfy a strict concurrency guarantee. |
| `scope` | `"process" \| "location" \| "global"` | Where counters coordinate. A location-scoped driver does not claim one global budget. |
| `rejectedAttempts` | `"counted" \| "not-counted" \| "unknown"` | Whether attempts after exhaustion continue changing provider state. |
| `metadata.<field>.availability` | `"always" \| "never" \| "on-rejection"` | When `remaining`, `resetAt`, `retryAfter`, or `used` can appear. |
| `metadata.<field>.quality` | `"exact" \| "approximate" \| undefined` | Accuracy when that metadata field is available. |
| `windows` | `number[] \| undefined` | Supported fixed-window durations in milliseconds when the driver is restricted. |

The memory driver reports strict process-scoped enforcement and rejected attempts that are not counted. `remaining`, `resetAt`, and `used` are always exact; `retryAfter` is exact on rejection. Cloudflare reports best-effort location-scoped enforcement, unknown rejected-attempt behavior, metadata that is never available, and 10-second or 60-second windows.

## Choose failure behavior

`failure: 'deny'` is the default. A missing binding or driver failure rejects the consume call, so protected work does not continue without enforcement.

`failure: 'allow'` returns `{ allowed: true, reason: 'unavailable' }` when the driver throws. Use it only when availability matters more than enforcing the budget, and record the unavailable reason in application diagnostics.

Neither policy changes an ordinary exhausted decision. A driver result with `allowed: false` remains rejected.

## Use the memory driver

The discovered runtime uses memory for local development. You can also create an isolated limiter for unit tests or direct scripts.

```ts [scripts/check-budget.ts]
import { createRateLimiter } from '@vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

const limiter = createRateLimiter({
  driver: memoryRateLimitDriver(),
  enforcement: 'strict',
  limit: 2,
  window: '1m',
})

console.log(await limiter.consume({ key: 'demo' }))
console.log(await limiter.consume({ key: 'demo' }))
console.log(await limiter.consume({ key: 'demo' }))
```

The third decision has `allowed: false`. The driver stores counters in one JavaScript process, resets them when that process restarts, and cannot coordinate multiple workers, regions, or serverless instances.

## Deploy to Cloudflare

Select Cloudflare in the preset or register the owner-package integration directly.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    rateLimit: { provider: 'cloudflare' },
  })],
})
```

Cloudflare native Rate Limiting bindings provide best-effort enforcement and support only `10s` or `1m` fixed windows. They return the allow-or-reject result without remaining, used, reset, or retry metadata. A Definition with `enforcement: 'strict'` or another window fails the build.

Inspect the generated `wrangler.json` `ratelimits` entries before deployment, then exercise the deployed Worker. The binding is request-scoped and cannot be proved by calling `consumeRateLimit()` from an unrelated Node script.

## Bring your own state backend

Implement `RateLimitDriver` around the backend's atomic primitive, then pass it to `createRateLimiter()`. The root package has no dependency on KV, Redis, Deno KV, Cloudflare, or another provider SDK.

```ts [server/rate-limiter.ts]
import { createRateLimiter } from '@vite-hub/rate-limit'
import type { RateLimitDriver } from '@vite-hub/rate-limit'

declare const driver: RateLimitDriver

export const limiter = createRateLimiter({
  driver,
  enforcement: 'strict',
  failure: 'deny',
  limit: 100,
  window: '1m',
})
```

The driver must declare enforcement, counter scope, rejected-attempt behavior, metadata availability and quality, and any restricted windows. It receives the resolved `limit`, `windowMs`, opaque `key`, and optional Definition `name` on every `consume()` call.

There is no `@vite-hub/rate-limit/kv` adapter. A future backend adapter must prove atomic consumption and describe its consistency guarantees; selecting `@vite-hub/kv` does not make it a Rate Limit Driver.

## Connect it to Agents

The Agent `rateLimit()` Capability accepts a discovered Rate Limit name or direct `RateLimiter`. Agent owns Invoker, Run, and trusted-IP identity derivation, then delegates the atomic decision to this primitive.

Read [Rate Limit Capability](/docs/capabilities/rate-limit) for configuration and migration from the former inline Store API.

## Limitations

- Memory enforcement is local and single-process. It is not a production default for horizontally scaled or request-scoped hosts.
- Automatic memory selection is limited to Vite development and serve commands. A production build with unknown hosting must set `provider: 'memory'` deliberately or use a custom Rate Limiter.
- Cloudflare native enforcement is best-effort, accepts only 10-second and 60-second windows, and does not return portable quota metadata.
- Identity is caller policy. The core package accepts an opaque key and does not infer, authenticate, or trust an IP address for you.
- The first public contract consumes one unit. It does not expose a non-consuming check because providers cannot all implement that operation honestly.
- The package does not expose generic KV or Capability subpaths. Agent integration remains owned by `@vite-hub/agent/capabilities`.

## Next steps

- [Configure Cloudflare Provider Output](/docs/frameworks-hosts/cloudflare)
- [Inspect Rate Limit import paths](/docs/reference/import-paths)
- [Use the Rate Limit Agent Capability](/docs/capabilities/rate-limit)
