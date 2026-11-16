---
title: Service tokens
navigation.title: Service tokens
description: Protect routes that scripts, runners, and webhooks call with a bearer token from a server variable.
navigation.order: 10
icon: i-lucide-key-round
---

A service token is a shared secret that a machine sends to your app, such as a CI runner that posts results or a script that starts a sync. The caller sends `Authorization: Bearer <token>`. Your route checks it against a server variable. No user, session, or Auth setup is necessary.

```ts [server/api/runs.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { requireServiceToken } from 'vite-hub/env'

export default defineEventHandler(async (event) => {
  requireServiceToken(event, 'INGEST_TOKEN')
  const run = await readBody<{ task: string, score: number }>(event)
  return { saved: run.task }
})
```

- `requireServiceToken(event, name)` reads the host variable `name` on each request: `process.env`, or the Worker bindings on Cloudflare.
- It compares the token in constant time, so the response time does not show how much of a guess was correct.
- A wrong or missing token throws a `401` HTTP error with the code `ENV_SERVICE_TOKEN_INVALID`.
- When the variable has no token, every request fails with `503` and `ENV_SERVICE_TOKEN_UNSET`. The route never opens by mistake.

Set the token in `.env` for `vite dev`, and as a secret on the host for production:

```bash [Terminal]
openssl rand -base64 32
```

Call the route with the same token:

```bash [Terminal]
curl -X POST https://evals.example.com/api/runs \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"task":"meetups","score":0.92}'
```

## Rotate a token

The variable holds one token, or a comma-separated list. Each token in the list passes.

1. Set the variable to `old-token,new-token` and deploy.
2. Change the callers to send `new-token`.
3. Set the variable to `new-token` and deploy.

## Answer without throwing

`checkServiceToken(event, name)` does the same check and returns `[error, undefined]`. Use it when a route answers everyone, but shows more to a caller with the token.

```ts [server/api/health.get.ts]
import { defineEventHandler } from 'h3'
import { checkServiceToken } from 'vite-hub/env'

export default defineEventHandler((event) => {
  const [error] = checkServiceToken(event, 'ADMIN_TOKEN')
  if (error) return { ok: true }
  return { ok: true, queue: 3, lastSync: '2026-11-16T09:30:00Z' }
})
```

`error.code` is `ENV_SERVICE_TOKEN_INVALID` or `ENV_SERVICE_TOKEN_UNSET`.

::details{summary="When to use Auth instead"}
A service token proves that the caller knows a secret. It does not say who the caller is, and every caller with the token has the same access. For people, use [Auth](/docs/auth) sessions. For a webhook that a provider signs, such as GitHub or Stripe, check the signature of the body.
::
