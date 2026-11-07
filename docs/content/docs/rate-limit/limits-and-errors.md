---
title: Rate Limit limits and errors
description: Rate Limit enforcement, identity, and provider limits to know before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limitations

- Memory counts live in one process. Do not use them in production on scaled-out or per-request hosts.
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

The dev server counts in memory, but checks the same policies when the build targets Cloudflare: `vitehub({ preset: 'cloudflare' })`, `hubRateLimit({ provider: 'cloudflare' })`, or the Cloudflare Nitro preset with no provider set. Then `vite dev` fails to start with the same code, and saving a file with an unsupported policy logs the error. Without a Cloudflare target, the dev server accepts every valid policy.
