---
title: Rate limiting vs throttling, and the four rate limiting algorithms
description: Rate limiting rejects extra requests and throttling delays them. Compare fixed window, sliding window, token bucket, and leaky bucket, then add one with ViteHub.
navigation.title: Rate limiting algorithms
navigation.order: 40
navigation.group: Concepts
icon: i-lucide-gauge
---

Rate limiting caps how many requests a client can make in a period of time and rejects the extra requests, usually with HTTP `429 Too Many Requests`. Throttling slows the extra requests down: it puts them in a queue or delays them, so the work goes out at a steady rate. Four algorithms do most of this work: fixed window, sliding window, token bucket, and leaky bucket. Sliding window has two common forms, a log and a counter. The algorithms differ in what happens at the edge of a window. ViteHub Rate Limit rejects and does not delay. On Node it uses a fixed window counter.

## Rate limiting vs throttling

| | Rate limiting | Throttling |
| --- | --- | --- |
| What happens to an extra request | The server rejects it at once. | The server delays it or puts it in a queue. |
| What the client sees | A `429` status and, often, a `Retry-After` header. | A slower answer, or an error only when the queue is full. |
| Typical algorithm | Fixed window, sliding window, token bucket. | Leaky bucket used as a queue. |
| Good for | Public APIs, login forms, expensive routes, model cost caps. | Calls to a provider that accepts only N calls per second. |

Vendors do not use these words the same way. [Amazon API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html) calls its token bucket "throttling", but it rejects extra requests with `429`. [NGINX `limit_req`](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) uses a leaky bucket and delays extra requests up to a `burst` size, then rejects the rest. Before you compare two products, check whether "throttle" means reject or delay.

`429` is defined in [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585#section-4). `Retry-After` is defined in [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after). The IETF HTTPAPI working group also has a [draft for `RateLimit` and `RateLimit-Policy` header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/). It is still a draft, not an RFC.

## One worked example for all four algorithms

The policy is the same in each case: **10 requests per minute for one client**. The client sends 10 requests at 12:00:59, then more requests at 12:01:01. The difference between the algorithms is what happens to the requests at 12:01:01, two seconds later.

### Fixed window

The server keeps one counter for each client and each clock minute. The counter starts at 0 at the start of the minute, and the server rejects a request when the counter is at 10.

- 12:00:59: requests 1 to 10 use the window that started at 12:00:00. The counter goes from 0 to 10. All 10 are allowed.
- 12:00:59.5: request 11 is rejected. The window ends at 12:01:00, so `Retry-After` is `1`.
- 12:01:01: a new window started at 12:01:00 with a counter of 0. The client can send 10 more requests at once.

Result: the server accepts **20 requests in about 2 seconds**, although the policy says 10 per minute. This burst at the window edge is the main weakness of a fixed window. Its strength is cost: one integer and one end time for each key, and one atomic increment for each request.

### Sliding window log

The server keeps the time of each accepted request and counts the requests in the last 60 seconds.

- 12:01:01: the last 60 seconds contain the 10 requests from 12:00:59. The request is rejected.
- 12:01:59: the requests from 12:00:59 are now older than 60 seconds. The client can send again.

Result: never more than 10 requests in any 60 seconds. This is exact, but the memory cost grows with the limit: a limit of 5,000 per hour keeps up to 5,000 timestamps for each key.

### Sliding window counter

The server keeps the counter of the current minute and the counter of the previous minute. It estimates the requests in the last 60 seconds with a weight on the previous minute. [Cloudflare describes this method](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) for its own rate limiting:

```txt
estimate = previous × (60 − seconds into this minute) / 60 + current
```

In this example, a request is allowed when the estimate plus the new request is 10 or less. Implementations differ on this comparison.

- 12:01:01: previous = 10, current = 0, 1 second into the minute. The estimate is 10 × 59/60 + 0 = 9.83. With the new request, it is 10.83, so the request is rejected.
- 12:01:30: the estimate is 10 × 30/60 + 0 = 5. At that time, the client can send 5 requests at once. Then the estimate is 10.

Result: close to the sliding log, with two integers for each key. The estimate assumes that requests in the previous minute were spread out evenly, so it is an approximation.

### Token bucket

The bucket holds up to 10 tokens and gets 1 new token every 6 seconds (10 per minute). Each request takes 1 token. A request without a token is rejected.

- 12:00:59: the bucket is full. Requests 1 to 10 take all 10 tokens.
- 12:01:01: 2 seconds later, the bucket has 2/6 = 0.33 of a token. The request is rejected. The next full token comes at 12:01:05.
- After that: 1 request every 6 seconds.

Result: a burst of up to 10, then a steady 10 per minute. A full bucket and the refill together can still let about 20 requests through in one 60-second span, but not 20 in 2 seconds. Burst size and refill rate are two separate settings, which is why many API gateways use this algorithm.

### Leaky bucket

The bucket is a queue that holds up to 10 waiting requests. It lets 1 request out every 6 seconds, at a steady rate. A request that arrives when the queue is full is dropped.

- 12:00:59: request 1 starts at once. Requests 2 to 10 wait and start at 12:01:05, 12:01:11, and so on. Request 10 starts at 12:01:53, 54 seconds after it arrived.
- 12:01:01: 9 requests wait. The new request joins the queue as number 10 and starts at 12:01:59.
- A request that arrives when 10 requests wait is rejected.

Result: the server never does more than 1 request every 6 seconds. This is throttling: the client waits instead of getting a `429`. Some implementations use the leaky bucket as a meter without a queue. Then it rejects like a token bucket.

### The results side by side

| Algorithm | Requests at 12:01:01 | State for each key | Burst at a window edge |
| --- | --- | --- | --- |
| Fixed window | Allowed, 10 more | 1 counter, 1 end time | Up to 2 × limit |
| Sliding window log | Rejected until 12:01:59 | 1 timestamp for each request | None |
| Sliding window counter | Rejected, 5 allowed at 12:01:30 | 2 counters | Small, from the estimate |
| Token bucket | Rejected, next at 12:01:05 | Token count, last refill time | Up to the bucket size |
| Leaky bucket (queue) | Delayed until 12:01:59 | A queue | None, output is steady |

## What ViteHub Rate Limit does

ViteHub Rate Limit counts and rejects. It does not queue or delay requests. The algorithm depends on the provider.

**Memory provider (Node, Docker, `vite dev`).** The memory driver uses a fixed window. For each Rate Limit ID and key, it stores a count and the window end. The window end is aligned to the clock: `Math.floor(now / windowMs) * windowMs + windowMs`. A `1m` window starts at second 0 of each minute, and a `1d` window starts at midnight UTC. The worked example above is exactly what the memory driver does, including the 20 requests in 2 seconds.

Other facts from the memory driver:

- A rejected request does not increase the count. A client that retries after a `429` does not make its wait longer.
- A rejected decision has `retryAfter`, the seconds to the window end, rounded up, with a minimum of 1. `requireRateLimit()` sends it as the `Retry-After` header. ViteHub does not send the draft `RateLimit` header fields.
- The counts are in the memory of one process. They reset when the process restarts, and two app instances do not share them.

**Cloudflare provider.** On a Cloudflare preset, ViteHub writes a [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) for each Rate Limit ID, with your `limit` and a `period` of 10 or 60 seconds. Cloudflare does not document which algorithm the binding uses. Cloudflare says that the counts are local to each Cloudflare location and eventually consistent, so requests can go over the limit before the counts reach other instances. The binding returns only success or failure. ViteHub therefore gets no `retryAfter` and sends no `Retry-After` header. A window that is not 10 or 60 seconds fails the build, and so does `enforcement: 'strict'`.

The build writes these guarantees to `.vitehub/rate-limit/manifest.json`. The memory provider reports `enforcement: "strict"`, `scope: "process"`, and `rejectedAttempts: "not-counted"`. Cloudflare reports `enforcement: "best-effort"`, `scope: "location"`, `rejectedAttempts: "unknown"`, and `windows: [10000, 60000]`. Read [Rate Limit hosts](/docs/rate-limit/hosts#inspect-generated-guarantees) for the file.

If the fixed window burst is a problem for your route, use a shorter window with a smaller limit. `limit: 2, window: '10s'` allows at most 4 requests in 2 seconds at a window edge, instead of 20. The sustained rate changes from 10 to 12 per minute.

## Add a rate limit to a route

Enable Rate Limit in the Vite config:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', rateLimit: true })],
})
```

Call `requireRateLimit()` before the work. This route allows 10 requests per minute for each signed-in user. Request 11 in the same clock minute gets a `429` with a `Retry-After` header.

```ts [server/api/messages.post.ts]
import { defineEventHandler } from 'h3'
import { withAuth } from 'vite-hub/auth/server'
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(
  withAuth(async (event, { user }) => {
    await requireRateLimit(event, 'send-message', {
      key: user.id,
      limit: 10,
      window: '1m',
    })
    return { ok: true }
  }),
)
```

Without `key`, the count is for each client address. ViteHub finds this call in the build, so the ID, `limit`, and `window` must be literal values. `key` can change at runtime.

To answer a limited request with something cheaper than an error, use `checkRateLimit()`. It takes the same arguments, uses the same counter, and returns the decision:

```ts [server/api/search.get.ts]
import { defineEventHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  const decision = await checkRateLimit(event, 'search', {
    limit: 30,
    window: '1m',
  })
  if (!decision.allowed) {
    return { results: [], limited: true, retryAfter: decision.retryAfter }
  }
  return { results: [], limited: false }
})
```

On the memory provider, `decision.remaining`, `decision.used`, and `decision.resetAt` are also set. On Cloudflare, only `allowed` is set, so do not build billing or UI on the other fields.

Read the counter of one key while the dev server runs. `peek` does not use a token:

```bash [Terminal]
pnpm vitehub rate-limit peek send-message user_123
pnpm vitehub inspect definitions --kind rate-limit
```

## Add a rate limit to an Agent

The `rateLimit()` Capability uses one token before each Agent Invocation. A rejected Invocation does not reach the Driver, so it costs no model call. Install the owner package for the memory driver:

```bash [Terminal]
pnpm add @vite-hub/rate-limit
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { rateLimit } from 'vite-hub/agent/capabilities'
import { createRateLimiter } from '@vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

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

The Capability chooses the key. With the default `identity: 'auto'`, it uses the Agent Invoker, then the thread or channel of the run, then an IP address from `trustedIpHeaders`. If none of these exist, all callers share one `anonymous` key. In this example, that makes the limit a cap of 20 runs per minute for the whole Agent. To limit each user, sign the user in and set `identity: 'invoker'`. Read [Choose identity](/docs/rate-limit/agent-capability#choose-identity).

A rejected Invocation fails with the code `RATE_LIMIT_REJECTED`. The generated Agent HTTP routes map it to `429`. In your own route, map it yourself:

```ts [server/api/support.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import { getViteHubErrorShape } from 'vite-hub/runtime'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ question?: string }>(event)
  const [error, result] = await runAgent(support, { prompt: body?.question ?? '' })
  if (getViteHubErrorShape(error)?.code === 'RATE_LIMIT_REJECTED') {
    throw createError({ statusCode: 429, message: 'Too many questions. Try again in a minute.' })
  }
  if (error) throw error
  return result
})
```

This Agent example needs `agent: true` in the ViteHub options. See [First Agent](/docs/getting-started/first-agent).

## Related

- [Rate Limit get started](/docs/rate-limit/get-started): guard a route and see the `429`.
- [Rate Limit server API](/docs/rate-limit/server-api): options, the decision shape, and direct limiters.
- [Rate Limit Agent Capability](/docs/rate-limit/agent-capability): identity, scope, and callbacks.
- [Rate Limit limits and errors](/docs/rate-limit/limits-and-errors#limitations): what memory and Cloudflare cannot promise.
- [Choose Queue, Workflow, or Schedule](/docs/guides/background-jobs): move work that can wait out of the request.
