---
title: Rate Limit limits and errors
description: Rate Limit enforcement, identity, and provider limits to know before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limitations

- Memory counts live in one process. Do not use them in production on scaled-out or per-request hosts. On several Node instances, turn on KV so the `kv` provider shares the counts. See [Share counts on Node](/docs/rate-limit/hosts#share-counts-on-node).
- A production build for an unknown host must set a provider or use a direct Rate Limiter.
- The request identity defaults to the client address in the event's Standard Context, and explicit user or tenant identities remain application policy.
- Managed policies must be static, so ViteHub can create the provider resources.
- The package has only atomic consume. Providers cannot all check without consuming.

## Cloudflare limits

The [Cloudflare Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) accepts a `period` of 10 or 60 seconds and is best-effort. A Cloudflare build fails when a policy needs more:

| Policy | Code |
| --- | --- |
| `enforcement: 'strict'` | `RATE_LIMIT_R0015` |
| `window` other than `10s` or `1m`, for example `30s` or `1h` | `RATE_LIMIT_R0016` |

The dev server counts in memory, but checks the same policies when the build targets Cloudflare: `vitehub({ host: 'cloudflare' })`, `hubRateLimit({ provider: 'cloudflare' })`, or the Cloudflare Nitro preset with no provider set. Then `vite dev` fails to start with the same code, and saving a file with an unsupported policy logs the error. Without a Cloudflare target, the dev server accepts every valid policy.

## Memory limits

The memory driver keeps at most 100,000 counters in one process. It removes counters whose window has ended before it adds a new one. When every counter is still active, the next new key fails with `RATE_LIMIT_R0008`. Pass `maxEntries` to `memoryRateLimitDriver()` to change the cap. Counters are lost when the process restarts, and two processes count separately.

## Errors

A request over the limit is not an error code. `requireRateLimit()` answers `429`, and an Agent Invocation fails with `RATE_LIMIT_REJECTED`. The codes below are defects in a policy, a call, or a driver. Each one is a Nostics diagnostic with a fix.

### Policies

The build reads the policy of each `checkRateLimit()` and `requireRateLimit()` call. A policy that it cannot read or accept stops `vite dev` and `vite build` with `RATE_LIMIT_R0001`, before a request arrives. `createRateLimiter()` checks its policy when you call it and throws `RATE_LIMIT_R0031` to `RATE_LIMIT_R0036`.

| Code | Cause |
| --- | --- |
| `RATE_LIMIT_R0001` | A policy is not a static object literal, or one of its values is wrong. The message names the file, line, and column. |
| `RATE_LIMIT_R0002` | A source file does not parse while ViteHub collects policies. |
| `RATE_LIMIT_R0003` | Two calls use the same ID with different policies. The message lists both locations. |
| `RATE_LIMIT_R0031`, `RATE_LIMIT_R0032` | `window` is not a duration such as `10s`, `1m`, `1h`, or `1d`, or it is not greater than zero. |
| `RATE_LIMIT_R0033`, `RATE_LIMIT_R0034` | The policy is not an object, or `limit` is not a positive integer. |
| `RATE_LIMIT_R0035`, `RATE_LIMIT_R0036` | `enforcement` is not `'best-effort'` or `'strict'`, or `failure` is not `'allow'` or `'deny'`. |

### Calls

| Code | Cause |
| --- | --- |
| `RATE_LIMIT_R0009` | The Cloudflare Rate Limiting binding of the policy is not on the request. Deploy the generated Wrangler configuration. |
| `RATE_LIMIT_R0010` | `checkRateLimit()` or `requireRateLimit()` has an empty ID. |
| `RATE_LIMIT_R0011`, `RATE_LIMIT_R0012` | The call has an unknown option, or `key` is an empty string. |
| `RATE_LIMIT_R0013` | The request has no client address and the call has no `key`. Pass a user or tenant key. |
| `RATE_LIMIT_R0030`, `RATE_LIMIT_R0038` | A direct Rate Limiter call has an empty key. |

### Drivers

| Code | Cause |
| --- | --- |
| `RATE_LIMIT_R0027` | The policy asks for `enforcement: 'strict'`, and the driver is best-effort. |
| `RATE_LIMIT_R0028` | The driver does not support the window of the policy. The message lists the windows it supports. |
| `RATE_LIMIT_R0029` | `createRateLimiter()` has no driver, or its options cannot be read. |
| `RATE_LIMIT_R0004` to `RATE_LIMIT_R0006` | The Cloudflare driver has no binding, the binding failed, or it returned an invalid result. A failed binding follows the `failure` of the policy. |

## KV limits

The `kv` provider counts fixed windows with one atomic `increment` for each request. The key is `rate-limit:<id>:<window ms>:<key>:<window start>` in the default KV store, and its TTL is the window, set with the first request.

- Rejected requests also increment the counter, so `used` can be larger than `limit`. The manifest says `rejectedAttempts: "counted"`.
- Each instance computes the window start from its own clock. Keep the server clocks in sync, or requests at the end of a window can count in the next one.
- When KV fails or takes more than one second, the request follows the `failure` policy: `deny` returns `503`, `allow` lets it continue. `peek` and `reset` also return `unavailable` after one second. The deadline does not cancel the KV operation, so a timed-out request can still increment the counter. A KV configuration error, such as a missing `REDIS_URL` for an explicit `redis` store, throws.
- `peekRateLimit()` and `resetRateLimit()` read the window from the policies that this process used. In a process that has not used the Rate Limit yet, `peek` returns `unused` and `reset` returns `unsupported`.
- Without a KV store, the `kv` provider fails with `RATE_LIMIT_R0047`. `kvRateLimitDriver()` without `increment`, `get`, and `delete` fails with `RATE_LIMIT_R0046`.
