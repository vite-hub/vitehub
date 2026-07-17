# @vite-hub/rate-limit

`@vite-hub/rate-limit` provides atomic Rate Limit consumption without coupling policy to a storage provider.

## Install

```sh
pnpm add @vite-hub/rate-limit
```

## Rate Limit Definitions

```ts
// src/image-upload.rate-limit.ts
import { defineRateLimit } from "@vite-hub/rate-limit"

export default defineRateLimit({
  failure: "deny",
  limit: 10,
  window: "1m",
})
```

Add the Vite integration to discover `src/**/*.rate-limit.ts` and `server/rate-limits/**/*.ts` Definitions:

```ts
// vite.config.ts
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubRateLimit()],
})
```

Consume the discovered Definition by name from server code. The Runtime Helper returns the decision that the application must enforce.

```ts
// server/upload-image.ts
import { consumeRateLimit } from "@vite-hub/rate-limit"

export async function handleImageUpload(authenticatedUserId: string): Promise<Response> {
  const decision = await consumeRateLimit("image-upload", {
    key: `user:${authenticatedUserId}`,
  })

  if (!decision.allowed) {
    return new Response("Too many uploads", { status: 429 })
  }

  return new Response("Upload accepted", { status: 202 })
}
```

The application derives the opaque key from authenticated identity and rejects the request when `allowed` is `false`. Use `getRateLimit(name)` when code needs the resolved limiter and its capabilities, or use `createRateLimiter()` when the application supplies a driver without discovery.

`hubRateLimit()` without a provider uses an in-memory fixed-window driver only during local Vite serve. Production builds require a detected Cloudflare host or an explicit provider, including `provider: "memory"` for a known single-process deployment. Native Cloudflare enforcement is best-effort and accepts only `10s` and `1m` windows, so incompatible Definitions fail during the build.

## Custom drivers

Use a custom driver without ViteHub Definitions or ViteHub KV:

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

The memory driver is process-local and intended for development, tests, and single-process hosts. Production drivers must implement atomic `consume()`; generic KV `get()` and `set()` operations are not sufficient.

Every limiter exposes `capabilities` describing enforcement, counter scope, metadata quality, supported windows, and whether rejected attempts consume budget. Inspect those fields when application behavior depends on more than the portable `allowed` decision.

The Vite integration writes the same resolved provider guarantees for every discovered Definition to `.vitehub/rate-limit/manifest.json`. This is stable generated state for agents and tooling to inspect; application code should keep using the runtime API instead of importing the manifest.
