# @vite-hub/rate-limit

`@vite-hub/rate-limit` provides atomic Rate Limit consumption without coupling policy to a storage provider.

## Install

```sh
pnpm add @vite-hub/rate-limit
```

## Require a Rate Limit

Declare the Rate Limit beside the server code that consumes it. The stable ID and policy must use static literals so the Vite integration can generate provider infrastructure.

```ts
import { requireRateLimit } from "@vite-hub/rate-limit"

export async function handleImageUpload(event): Promise<Response> {
  await requireRateLimit(event, "image-upload", {
    limit: 10,
    window: "1m",
  })
  return new Response("Upload accepted", { status: 202 })
}
```

`requireRateLimit()` can live inside any ordinary H3 handler. Its stable ID and provider policy must use static literals so the Vite integration can generate infrastructure; `event` and an optional dynamic `key` are runtime inputs. The guard defaults to the request's client address and throws an `HTTPError` with status `429` when the budget is exhausted. Pass `key: authenticatedUser.id` when a user or tenant is the correct budget boundary.

Provider unavailability follows the declared `failure` policy: fail-open guards continue, while fail-closed guards throw status `503` and preserve the provider cause. Invalid configuration and provider contract violations still throw normally. Use `createRateLimiter()` when the application needs a decision for a custom response or another transport.

Add the build integration:

```ts
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubRateLimit({ namespace: "acme-image-service-production" })],
})
```

`hubRateLimit()` uses the memory driver during local Vite serve and infers Cloudflare from the production Nitro preset. Cloudflare deployments require a unique namespace for each Worker and environment so counters cannot leak across deployments. Unknown production hosts still require an explicit provider because process-local memory is unsafe for horizontally scaled deployments.

Native Cloudflare enforcement is best-effort and accepts only `10s` and `1m` windows, so incompatible policies fail during the build.

## Custom drivers

Use `createRateLimiter()` when the application supplies a driver directly and does not need managed provider output:

```ts
import { createRateLimiter } from "@vite-hub/rate-limit"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"

const limiter = createRateLimiter({
  driver: memoryRateLimitDriver(),
  enforcement: "strict",
  limit: 10,
  window: "1m",
})

const decision = await limiter.consume({ key: authenticatedUser.id })
```

The memory driver is process-local and intended for development, tests, and single-process hosts. Production drivers must implement atomic `consume()`; generic KV `get()` and `set()` operations are insufficient.

Custom drivers return `[null, result]` after consuming the counter and `[error, undefined]` only for expected operational outages that the declared failure policy should govern. Invalid configuration, malformed provider responses, and implementation defects should throw normally.

Every direct limiter exposes its enforcement, counter scope, rejected-attempt behavior, and supported windows. The Vite integration writes those capabilities to `.vitehub/rate-limit/manifest.json` for agents and tooling to inspect.
