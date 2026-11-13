---
title: Rate limiting vs throttling, and the four rate limiting algorithms
seo.title: "Rate limiting vs throttling, and four algorithms"
description: "Rate limiting rejects extra requests and throttling delays them. Compare fixed window, sliding window, token bucket, and leaky bucket, and add one with ViteHub."
navigation.title: Rate limiting algorithms
navigation.order: 40
navigation.group: Concepts
icon: i-lucide-gauge
---

Rate limiting caps a client's requests per period and rejects the extra ones, usually with HTTP `429 Too Many Requests`. Throttling queues or delays them, so work goes out at a steady rate. Four algorithms do most of this: fixed window, sliding window (as a log or a counter), token bucket, and leaky bucket. They differ in what happens at the edge of a window. ViteHub Rate Limit rejects and does not delay. On Node it uses a fixed window counter.

## Rate limiting vs throttling

| | Rate limiting | Throttling |
| --- | --- | --- |
| An extra request | Is rejected at once. | Is delayed or queued. |
| The client sees | A `429` status and often a `Retry-After` header. | A slower answer, or an error only when the queue is full. |
| Typical algorithm | Fixed window, sliding window, token bucket. | Leaky bucket used as a queue. |
| Good for | Public APIs, login forms, expensive routes, model cost caps. | Calls to a provider that allows only N calls per second. |

Vendors use these words differently. [Amazon API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html) calls its token bucket "throttling", but rejects extra requests with `429`. [NGINX `limit_req`](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) uses a leaky bucket that delays extra requests up to a `burst` size, then rejects the rest. When you compare products, check whether "throttle" means reject or delay.

[RFC 6585](https://www.rfc-editor.org/rfc/rfc6585#section-4) defines `429`, and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after) defines `Retry-After`. The IETF HTTPAPI working group has a [draft for `RateLimit` and `RateLimit-Policy` header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/), not yet an RFC.

## One worked example for all four algorithms

The policy is always **10 requests per minute for one client**. The client sends 10 requests at 12:00:59, then more at 12:01:01. The algorithms differ in what happens to those later requests.

### Fixed window

The server keeps one counter per client per clock minute. It starts at 0 each minute, and a request is rejected when it is at 10.

- 12:00:59: requests 1 to 10 fall in the 12:00:00 window. The counter goes from 0 to 10. All are allowed.
- 12:00:59.5: request 11 is rejected. The window ends at 12:01:00, so `Retry-After` is `1`.
- 12:01:01: a new window started at 12:01:00 at 0. The client can send 10 more at once.

Result: **20 requests in about 2 seconds**, though the policy says 10 per minute. This edge burst is the main weakness of a fixed window. Its strength is cost: one integer and one end time per key, and one atomic increment per request.

### Sliding window log

The server keeps the time of each accepted request and counts those in the last 60 seconds.

- 12:01:01: the last 60 seconds hold the 10 requests from 12:00:59. Rejected.
- 12:01:59: those requests are now older than 60 seconds. The client can send again.

Result: never more than 10 in any 60 seconds. This is exact, but memory grows with the limit: 5,000 per hour keeps up to 5,000 timestamps per key.

### Sliding window counter

The server keeps counters for the current and previous minute, and estimates the last 60 seconds with a weight on the previous minute. [Cloudflare describes this method](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) for its own rate limiting:

```txt
estimate = previous × (60 − seconds into this minute) / 60 + current
```

Here a request is allowed when the estimate plus the new request is 10 or less. Implementations differ on this comparison.

- 12:01:01: previous = 10, current = 0, 1 second in. The estimate is 10 × 59/60 + 0 = 9.83. With the new request it is 10.83, so it is rejected.
- 12:01:30: the estimate is 10 × 30/60 + 0 = 5, so the client can send 5 at once. Then the estimate is 10.

Result: close to the sliding log, with two integers per key. It is an estimate, because it assumes the previous minute's requests were evenly spread.

### Token bucket

The bucket holds up to 10 tokens and gains 1 every 6 seconds (10 per minute). Each request takes a token. A request with no token is rejected.

- 12:00:59: the bucket is full. Requests 1 to 10 take all 10 tokens.
- 12:01:01: the bucket has 2/6 = 0.33 of a token. Rejected. The next full token comes at 12:01:05.
- After that: 1 request every 6 seconds.

Result: a burst of up to 10, then a steady 10 per minute. A full bucket plus refill can still pass about 20 requests in one 60-second span, but not 20 in 2 seconds. Burst size and refill rate are separate settings, which is why many API gateways use it.

### Leaky bucket

The bucket is a queue of up to 10 waiting requests. It lets 1 out every 6 seconds. A request that arrives when it is full is dropped.

- 12:00:59: request 1 starts at once. Requests 2 to 10 wait and start at 12:01:05, 12:01:11, and so on. Request 10 starts at 12:01:53, 54 seconds after it arrived.
- 12:01:01: 9 requests wait. The new one joins as number 10 and starts at 12:01:59.
- A request that arrives when 10 wait is rejected.

Result: never more than 1 request every 6 seconds. This is throttling: the client waits instead of getting a `429`. Some implementations use the leaky bucket as a meter with no queue, and then it rejects like a token bucket.

### The results side by side

| Algorithm | Requests at 12:01:01 | State for each key | Burst at a window edge |
| --- | --- | --- | --- |
| Fixed window | Allowed, 10 more | 1 counter, 1 end time | Up to 2 × limit |
| Sliding window log | Rejected until 12:01:59 | 1 timestamp per request | None |
| Sliding window counter | Rejected, 5 allowed at 12:01:30 | 2 counters | Small, from the estimate |
| Token bucket | Rejected, next at 12:01:05 | Token count, last refill time | Up to the bucket size |
| Leaky bucket (queue) | Delayed until 12:01:59 | A queue | None, output is steady |

## What ViteHub Rate Limit does

ViteHub Rate Limit counts and rejects. It does not queue or delay. The algorithm depends on the provider.

**Memory provider (Node, Docker, `vite dev`).** The memory driver uses a fixed window. Per Rate Limit ID and key, it stores a count and the window end, aligned to the clock: `Math.floor(now / windowMs) * windowMs + windowMs`. A `1m` window starts at second 0 of each minute, and a `1d` window at midnight UTC. The worked example above is exactly what it does, including 20 requests in 2 seconds. Also:

- A rejected request does not raise the count, so retrying after a `429` does not lengthen the wait.
- A rejected decision has `retryAfter`: seconds to the window end, rounded up, at least 1. `requireRateLimit()` sends it as `Retry-After`. ViteHub does not send the draft `RateLimit` header fields.
- Counts live in one process's memory. They reset on restart, and app instances do not share them.

**Cloudflare provider.** On a Cloudflare host, ViteHub writes a [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) per Rate Limit ID, with your `limit` and a `period` of 10 or 60 seconds. Cloudflare does not document the algorithm. It says counts are local to each Cloudflare location and eventually consistent, so requests can pass the limit before counts reach other instances. The binding returns only success or failure, so there is no `retryAfter` and no `Retry-After` header. A window other than 10 or 60 seconds fails the build, and so does `enforcement: 'strict'`.

The build writes these guarantees to `.vitehub/rate-limit/manifest.json`. Memory reports `enforcement: "strict"`, `scope: "process"`, and `rejectedAttempts: "not-counted"`. Cloudflare reports `enforcement: "best-effort"`, `scope: "location"`, `rejectedAttempts: "unknown"`, and `windows: [10000, 60000]`. See [Rate Limit hosts](/docs/rate-limit/hosts#inspect-generated-guarantees).

If the edge burst is a problem, use a shorter window and smaller limit. `limit: 2, window: '10s'` allows at most 4 requests in 2 seconds at an edge, not 20. The sustained rate goes from 10 to 12 per minute.

## Add a rate limit to a route

Enable Rate Limit in the Vite config:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', rateLimit: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', rateLimit: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', rateLimit: true })],
})
```
:::
::

Call `requireRateLimit()` before the work. This route allows 10 requests per minute per signed-in user. Request 11 in the same clock minute gets a `429` with `Retry-After`.

```ts [server/api/messages.post.ts]
import { defineEventHandler, type H3Event } from 'h3'
import { withAuth } from 'vite-hub/auth/server'
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(
  withAuth(async (event: H3Event, { user }) => {
    await requireRateLimit(event, 'send-message', {
      key: user.id,
      limit: 10,
      window: '1m',
    })
    return { ok: true }
  }),
)
```

Without `key`, the count is per client address. The build reads this call, so the ID, `limit`, and `window` must be literals. `key` can change at runtime.

To answer a limited request with something cheaper than an error, use `checkRateLimit()`. It takes the same arguments, uses the same counter, and returns `[error, decision]`:

```ts [server/api/search.get.ts]
import { defineEventHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  const [error, decision] = await checkRateLimit(event, 'search', {
    limit: 30,
    window: '1m',
  })
  if (error) throw error
  if (!decision.allowed) {
    return { results: [], limited: true, retryAfter: decision.retryAfter }
  }
  return { results: [], limited: false }
})
```

On the memory provider, `decision.remaining`, `decision.used`, and `decision.resetAt` are also set. On Cloudflare only `allowed` is, so do not build billing or UI on the others.

Read one key's counter while the dev server runs. `peek` uses no token:

```bash [Terminal]
pnpm vitehub rate-limit peek send-message user_123
pnpm vitehub inspect definitions --kind rate-limit
```

## Add a rate limit to an Agent

The `rateLimit()` Capability uses one token before each Agent run (Invocation). A rejected run never reaches the Driver, so it costs no model call. Install the package for the memory driver:

```bash [Terminal]
pnpm add @vite-hub/rate-limit
```

```ts [server/agents/support.ts]
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
  runtime: false,
  capabilities: [rateLimit({ limiter: invocations })],
  driver: {
    run({ prompt }) {
      return { text: `You asked: ${String(prompt)}` }
    },
  },
})
```

The Capability picks the key. With the default `identity: 'auto'`, it uses the Agent Invoker (the caller). There is always an Invoker, with the fallback id `anonymous:<origin>` when the caller has no identity.

::warning
Unauthenticated calls from the same origin share one counter. `auto` does not split them by thread, channel, or IP address, so here they share 20 runs per minute.
::

For a per-user limit, pass the signed-in user's identity as the Invoker. Use `identity: 'run'` for thread or channel metadata, or `identity: 'ip'` with `trustedIpHeaders` for IP limits. See [Choose identity](/docs/rate-limit/agent-capability#choose-identity).

A rejected Invocation fails with the code `RATE_LIMIT_REJECTED`. `runAgent()` returns it as `error.cause` of `AGENT_RUN_FAILED`. The generated Agent HTTP routes map it to `429`. In your own route, map it yourself:

```ts [server/api/support.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import { getViteHubErrorShape } from 'vite-hub/runtime'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ question?: string }>(event)
  const [error, result] = await runAgent(support, { prompt: body?.question ?? '' })
  if (getViteHubErrorShape(error?.cause)?.code === 'RATE_LIMIT_REJECTED') {
    throw createError({ statusCode: 429, message: 'Too many questions. Try again in a minute.' })
  }
  if (error) throw error
  return { text: result.text }
})
```

This example needs `agent: true` in the ViteHub options. See [First Agent](/docs/getting-started/first-agent).

## Related

- [Rate Limit get started](/docs/rate-limit/get-started): guard a route and see the `429`.
- [Rate Limit server API](/docs/rate-limit/server-api): options, the decision shape, and direct limiters.
- [Rate Limit Agent Capability](/docs/rate-limit/agent-capability): identity, scope, and callbacks.
- [Rate Limit limits and errors](/docs/rate-limit/limits-and-errors#limitations): what memory and Cloudflare cannot promise.
- [Choose Queue, Workflow, or Schedule](/docs/guides/background-jobs): move work that can wait out of the request.
