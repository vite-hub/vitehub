# @vite-hub/rate-limit

`@vite-hub/rate-limit` gives server code one atomic consume-and-decide operation for fixed-window request budgets. It keeps policy separate from the driver that stores and updates each counter.

Install this owner package when you need a direct Rate Limiter, a custom driver, or the standalone Vite integration. If your application already uses the `vite-hub` framework distribution, enable Rate Limit there and import from `vite-hub/rate-limit` instead. See the [Rate Limit guide](https://vitehub.dev/docs/server-primitives/rate-limit) for that application setup.

## Install the owner package

```sh
pnpm add @vite-hub/rate-limit
```

The package requires Node 24 or newer. Vite is an optional peer dependency and is needed only for the managed Vite integration.

## Get the first decision

Create `rate-limit.mjs`. This example uses only public package imports and needs no provider account.

```js
import { createRateLimiter } from "@vite-hub/rate-limit";
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory";

const limiter = createRateLimiter({
  driver: memoryRateLimitDriver(),
  enforcement: "strict",
  limit: 2,
  name: "image-upload",
  window: "1m",
});

for (let attempt = 1; attempt <= 3; attempt++) {
  const decision = await limiter.consume({ key: "user-123" });
  console.log(`${attempt}: ${decision.allowed ? "allowed" : decision.reason}`);
}
```

Run it:

```sh
node rate-limit.mjs
```

The first two calls consume the budget. The third call returns a limited decision.

```text
1: allowed
2: allowed
3: limited
```

Direct Rate Limiters return a decision. Your code must stop the operation when `allowed` is false. The memory driver performs strict atomic consumption inside one process, so use it for development, tests, or a known single-process host. Its counters do not coordinate across processes, regions, or request-scoped runtimes.

## Choose managed guards or a direct driver

| Need                                                                                   | Use                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Enforce a discovered Rate Limit in an H3 handler and let Vite generate provider output | `requireRateLimit()` with `hubRateLimit()` |
| Return a custom response, use another transport, or supply storage yourself            | `createRateLimiter()` with a direct driver |

The managed path selects and configures a driver. The direct path gives your code the decision and leaves deployment integration to the application.

## Let Vite manage an H3 guard

Register the standalone integration:

```ts
import { hubRateLimit } from "@vite-hub/rate-limit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubRateLimit({ namespace: "acme-image-service-production" })],
});
```

Then require a budget before expensive work:

```ts
import { requireRateLimit } from "@vite-hub/rate-limit";

export async function handleImageUpload(event): Promise<Response> {
  await requireRateLimit(event, "image-upload", {
    key: authenticatedUser.id,
    limit: 10,
    window: "1m",
  });

  return new Response("Upload accepted", { status: 202 });
}
```

The stable ID and provider policy must use static literals so the Vite integration can discover them and generate provider configuration. `event` and `key` are runtime values. If you omit `key`, the guard uses the request client address and fails when it cannot find one.

An allowed request continues. An exhausted budget throws an H3 `HTTPError` with status `429`. The default `failure: "deny"` turns an expected driver outage into status `503`; `failure: "allow"` lets the request continue. Use fail-open behavior only when the protected operation is safe without enforcement. Invalid configuration, malformed provider results, missing bindings, and driver defects still throw instead of following the failure policy.

Local Vite development uses the process-local memory driver. A Cloudflare Nitro preset selects Cloudflare Rate Limiting, and every deployed Worker and environment needs a unique namespace. ViteHub has no native Rate Limit driver for Vercel, Netlify, or Deno. Automatic provider selection fails for an unknown production host instead of falling back to unsafe per-instance memory. Select memory explicitly only for a known single-process deployment; otherwise supply a direct production driver. Check the [runtime and host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before choosing a deployment target.

Cloudflare enforcement is best-effort, location-scoped, and limited to `10s` and `1m` windows. It does not report portable remaining, reset, or retry metadata. A policy that requests strict enforcement or another window fails before deployment. The [Cloudflare host guide](https://vitehub.dev/docs/frameworks-hosts/cloudflare#rate-limiting-bindings) covers generated bindings and deployment verification.

## Supply a direct driver

Use `createRateLimiter()` when the application selects the driver and handles the decision. A production driver must implement one atomic `consume()` operation for its backend. A generic KV `get()` followed by `set()` is not safe under concurrent requests.

Drivers return `[null, result]` after consuming the counter. They return `[error, undefined]` only for an expected operational outage. The limiter then returns `reason: "unavailable"` and sets `allowed` from the failure policy, which defaults to deny. Configuration errors, malformed provider results, and implementation defects must throw normally.

The limiter exposes its resolved `policy` and the driver's declared `capabilities`, including enforcement, counter scope, rejected-attempt behavior, and supported windows. Inspect them when deciding whether a driver fits a deployment.

## Public imports

| Import                                    | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `@vite-hub/rate-limit`                    | `requireRateLimit()`, `createRateLimiter()`, and public contract types    |
| `@vite-hub/rate-limit/drivers/memory`     | Process-local fixed-window driver                                         |
| `@vite-hub/rate-limit/drivers/cloudflare` | Direct adapter for a request-scoped Cloudflare Rate Limiting binding      |
| `@vite-hub/rate-limit/vite`               | Source discovery, runtime setup, manifest generation, and provider output |

`@vite-hub/rate-limit/runtime` is reserved for framework integrations. Application code should use the guard or a direct Rate Limiter.

## Go deeper

- [Rate Limit guide](https://vitehub.dev/docs/server-primitives/rate-limit)
- [Rate Limit Capability for Agents](https://vitehub.dev/docs/capabilities/rate-limit)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)
