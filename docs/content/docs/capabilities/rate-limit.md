---
title: Rate limit
description: Consume a Rate Limiter before an Agent Invocation starts.
navigation.title: Rate limit
navigation.order: 190
navigation.group: Decisions and output
icon: i-lucide-gauge
---

`rateLimit()` consumes one budget unit before the main Agent Invocation starts. The Capability owns trusted Agent identity and rejection behavior, while the [Rate Limit primitive](/docs/server-primitives/rate-limit) owns atomic enforcement.

## Configure a limiter

Create a direct limiter beside the Agent and pass it to the Capability. The Capability needs the portable decision to attach Agent identity and rejection context, so the handler-only `requireRateLimit()` guard is not its input.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { rateLimit } from '@vite-hub/agent/capabilities'
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

## Runtime behavior

The Capability runs during the input phase. It derives a stable key from the Capability id, scope, and trusted identity, then calls the `RateLimiter` exactly once.

A rejected decision throws `ViteHubError` with code `RATE_LIMIT_REJECTED`; the HTTP boundary maps that code to `429` and emits `retry-after` headers only when the selected driver reports `retryAfter`. Cloudflare native enforcement does not return portable quota metadata.

The decision is stored under the Capability id in Agent Invocation Context and exposed as a finish extension. It contains the primitive decision plus `capabilityId`, `identity`, `identitySource`, `key`, and `scope`.

## Choose identity

Identity derivation belongs to the Agent boundary, not the Rate Limit Driver. The default `identity: 'auto'` prefers the Agent Invoker, then Agent Run metadata, then explicitly trusted IP headers, and finally an anonymous identity.

Use `identity: 'invoker'` when authentication provides a stable Agent Invoker. Use `identity: 'ip'` only after naming headers that the deployed host sets and sanitizes.

```ts [server/agents/public-support.ts]
rateLimit({
  identity: 'ip',
  limiter: invocations,
  trustedIpHeaders: ['cf-connecting-ip'],
})
```

Do not trust a client-controlled forwarding header. The Capability reads only the headers listed in `trustedIpHeaders`, but the application remains responsible for ensuring the host overwrites them.

## Use a custom driver

Pass any `RateLimiter` when the application owns state or enforcement outside managed ViteHub Rate Limits.

```ts [server/rate-limiter.ts]
import { createRateLimiter } from '@vite-hub/rate-limit'
import type { RateLimitDriver } from '@vite-hub/rate-limit'

declare const driver: RateLimitDriver

export const invocationLimiter = createRateLimiter({
  driver,
  enforcement: 'strict',
  limit: 20,
  window: '1m',
})
```

```ts [server/agents/support.ts]
import { rateLimit } from '@vite-hub/agent/capabilities'
import { invocationLimiter } from '../rate-limiter'

rateLimit({ limiter: invocationLimiter })
```

The custom driver must implement atomic `consume()`. ViteHub does not provide a generic KV adapter because a portable `get()` followed by `set()` cannot guarantee an atomic decision under concurrency.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limiter` | `RateLimiter \| function` | required | Direct limiter or runtime resolver. |
| `id` | `string` | `"rate-limit"` | Capability id and Agent Invocation Context key. |
| `identity` | `"auto" \| "invoker" \| "ip" \| "run" \| function` | `"auto"` | Identity used to derive the private rate-limit key. |
| `scope` | `string \| function` | Capability id | Additional key partition. |
| `trustedIpHeaders` | `string[]` | none | Host-controlled headers allowed for IP identity. |
| `message` | `string \| function` | default rejection message | Error message for a rejected decision. |
| `onDecision` | `function` | none | Callback after every decision. |
| `onAllowed` | `function` | none | Callback after an allowed decision. |
| `onRejected` | `function` | none | Callback after a rejected decision. |

## Migrate from an inline store

The Capability no longer owns `limit`, `window`, `action`, or `store`. Move policy into a direct `RateLimiter`, then replace `store` with `limiter`.

```ts [Before]
rateLimit({
  limit: 20,
  store: 'memory',
  window: '1m',
})
```

```ts [After]
const invocations = createRateLimiter({
  driver: memoryRateLimitDriver(),
  limit: 20,
  window: '1m',
})

rateLimit({
  limiter: invocations,
})
```

There is no compatibility shim. `memoryRateLimitStore()` and `RateLimitStore` are replaced by `memoryRateLimitDriver()` and `RateLimitDriver` from `@vite-hub/rate-limit`.

## Verify it

Run repeated Agent Invocations with the same identity. The first `limit` invocations should reach the Agent Driver; the next should fail with code `RATE_LIMIT_REJECTED` before model, harness, or custom-run execution.

For local tests, use a dedicated memory driver instance. For Cloudflare, resolve the request binding in the limiter resolver and test the deployed binding because the native decision depends on request-scoped Worker environment.

## Related

- [Rate Limit primitive](/docs/server-primitives/rate-limit)
- [Agent invocations](/docs/agents/invocations)
- [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers)
