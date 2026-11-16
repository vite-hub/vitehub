---
title: Rate Limit capability
description: Limit Agent runs before they start, choose the identity to limit, and use a custom driver.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-gauge
---

`rateLimit()` uses one unit of budget before each Agent Invocation (one Agent run) starts. This Capability decides the trusted identity and what happens on rejection. The [Rate Limit primitive](/docs/rate-limit) does the atomic counting.

## Configure a limiter

Create a direct limiter next to the Agent and pass it to the Capability. The Capability needs the full decision to add identity and rejection details, so it does not take the route guard `requireRateLimit()`. The memory driver comes from its own package:

```bash [Terminal]
pnpm add @vite-hub/rate-limit
```

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { rateLimit } from 'vite-hub/agent/capabilities'
import { createRateLimiter } from 'vite-hub/rate-limit'
import { memoryRateLimitDriver } from 'vite-hub/rate-limit/drivers/memory'

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

## How rate limits work

The Capability runs in the input phase. It builds a stable key from the Capability id, scope, and trusted identity, then calls the `RateLimiter` once.

- A rejection throws `ViteHubError` with code `RATE_LIMIT_REJECTED`. The HTTP handler returns `429` and sends `retry-after` headers only when the driver reports `retryAfter`. Cloudflare native enforcement returns no portable quota metadata.
- When the limiter cannot decide (`reason: 'unavailable'`), the Capability throws `RATE_LIMIT_UNAVAILABLE`, and the HTTP handler returns `503`.

The run does not start in either case.

The decision is stored under the Capability id in the Invocation Context and exposed as a finish extension. It holds the primitive decision plus `capabilityId`, `identity`, `identitySource`, `key`, and `scope`.

## Choose identity

The Agent chooses the identity, not the driver. The default `identity: 'auto'` uses the Agent Invoker (the caller) when the caller has an identity. For an anonymous caller, it uses Agent Run metadata (the thread or channel), then trusted IP headers. Anonymous callers with neither share one budget.

Use `identity: 'invoker'` when authentication gives a stable Invoker. Use `identity: 'ip'` only after you name headers that the host sets and cleans. Only `auto` and `ip` read `trustedIpHeaders`. With another identity, or with `ip` and no headers, `rateLimit()` throws `AGENT_R0161`.

```ts [server/agents/public-support.ts] fragment
rateLimit({
  identity: 'ip',
  limiter: invocations,
  trustedIpHeaders: ['cf-connecting-ip'],
})
```

> [!WARNING]
> Do not trust a forwarding header that the client controls. The Capability reads only the headers in `trustedIpHeaders`. You must make sure the host overwrites them.

## Use a custom driver

Pass any `RateLimiter` when your app owns the state or enforcement.

```ts [server/rate-limiter.ts]
import { createRateLimiter } from 'vite-hub/rate-limit'
import type { RateLimitDriver } from 'vite-hub/rate-limit'

declare const driver: RateLimitDriver

export const invocationLimiter = createRateLimiter({
  driver,
  enforcement: 'strict',
  limit: 20,
  window: '1m',
})
```

```ts [server/agents/support.ts] fragment
import { rateLimit } from 'vite-hub/agent/capabilities'
import { invocationLimiter } from '../rate-limiter'

rateLimit({ limiter: invocationLimiter })
```

A custom driver must implement an atomic `consume()`. ViteHub has no generic KV adapter, because a `get()` then `set()` is not atomic when requests run at the same time.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limiter` | `RateLimiter \| function` | required | Direct limiter or runtime resolver. |
| `id` | `string` | `"rate-limit"` | Capability id and Invocation Context key. |
| `identity` | `"auto" \| "invoker" \| "ip" \| "run" \| function` | `"auto"` | Identity for the private key. |
| `scope` | `string \| function` | Capability id | Extra key part. |
| `trustedIpHeaders` | `string[]` | none | Host-set headers for IP identity. Only `auto` and `ip` read them. |
| `message` | `string \| function` | default rejection message | Error message on rejection. |
| `onDecision` | `function` | none | Callback after every decision. |
| `onAllowed` | `function` | none | Callback after an allowed decision. |
| `onRejected` | `function` | none | Callback after a rejected decision. |

Decision callbacks get a limiter with `consume()`, `peek()`, and `reset()`. A limiter with only `consume()` still works. Then `peek()` or `reset()` returns `status: "unsupported"` with a reason.

## Migrate from an inline store

The Capability no longer owns `limit`, `window`, `action`, or `store`. Move the policy into a direct `RateLimiter`, then replace `store` with `limiter`.

```ts [Before] fails=TS2561
import { rateLimit } from 'vite-hub/agent/capabilities'

rateLimit({
  limit: 20,
  store: 'memory',
  window: '1m',
})
```

```ts [After]
import { rateLimit } from 'vite-hub/agent/capabilities'
import { memoryRateLimitDriver } from 'vite-hub/rate-limit/drivers/memory'
import { createRateLimiter } from 'vite-hub/rate-limit'

const invocations = createRateLimiter({
  driver: memoryRateLimitDriver(),
  limit: 20,
  window: '1m',
})

rateLimit({
  limiter: invocations,
})
```

## Verify it

Run the Agent several times with the same identity. Confirm that the first `limit` runs reach the Agent Driver and the next one fails with `RATE_LIMIT_REJECTED` before the model, provider, or custom run starts.

For local tests, use a separate memory driver instance. On Cloudflare, get the request binding in the limiter resolver and test the deployed binding, because the native decision depends on the request's Worker environment.

## Related

- [Rate Limit primitive](/docs/rate-limit)
- [Agent invocations](/docs/agents/invocations)
- [Auth Users and Agent Invokers](/docs/agents/invokers)
- [Official capabilities](/docs/agents/capabilities/official)
