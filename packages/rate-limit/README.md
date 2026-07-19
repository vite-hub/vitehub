# @vite-hub/rate-limit

`@vite-hub/rate-limit` provides atomic Rate Limit consumption without coupling policy to a storage provider.

## Install

```sh
pnpm add @vite-hub/rate-limit
```

## Define and enforce a Rate Limit

Declare the Rate Limit beside the server code that consumes it. The stable ID and policy must use static literals so the Vite integration can generate provider infrastructure.

```ts
import { defineRateLimit } from "@vite-hub/rate-limit"

const uploads = defineRateLimit("image-upload", {
  failure: "deny",
  limit: 10,
  window: "1m",
})

export async function handleImageUpload(): Promise<Response> {
  await uploads.enforce()
  return new Response("Upload accepted", { status: 202 })
}
```

`defineRateLimit()` can live in any ordinary server source file. It does not require a default export, dedicated directory, file suffix, registry, or separate string lookup. Inside an H3 request, `.enforce()` defaults to the client address installed by the active host integration and throws an `HTTPError` with status `429` when the budget is exhausted. Pass an explicit key such as `.enforce(authenticatedUser.id)` when authenticated user or tenant identity is the correct budget boundary; calls outside a request require one.

Use `.consume()` when the application needs the full decision for a custom response or another transport. Provider unavailability follows the declared `failure` policy: fail-open decisions continue, while fail-closed enforcement throws status `503` and preserves the provider cause. Invalid configuration and provider contract violations still throw normally.

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

Custom drivers return `{ unavailable: true, cause }` only for expected operational outages that the declared failure policy should govern. Invalid configuration, malformed provider responses, and implementation defects should throw normally.

Every direct limiter exposes `capabilities` describing enforcement, counter scope, metadata quality, supported windows, and whether rejected attempts consume budget. The Vite integration writes the resolved managed guarantees to `.vitehub/rate-limit/manifest.json` for agents and tooling to inspect.
