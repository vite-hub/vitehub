---
title: Verify webhooks
navigation.title: Verify webhooks
description: Check the signature of a Stripe, GitHub, or other HMAC webhook in a plain route, with the secret in a server variable.
navigation.order: 12
icon: i-lucide-webhook
---

A provider such as Stripe or GitHub signs each webhook with a secret that only you and the provider know. `verifyWebhook()` checks that signature against a server variable and gives you the parsed body.

```ts [server/api/stripe/webhook.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { verifyWebhook } from 'vite-hub/env'

interface StripeEvent {
  id: string
  type: string
  data: { object: { id: string, customer_email: string | null } }
}

export default defineEventHandler(async (event) => {
  const [error, stripeEvent] = await verifyWebhook<StripeEvent>(event, {
    provider: 'stripe',
    secret: 'STRIPE_WEBHOOK_SECRET',
  })
  if (error) throw new HTTPError({ status: 400, message: error.message })
  if (stripeEvent.type !== 'checkout.session.completed') return { received: true }
  return { received: true, session: stripeEvent.data.object.id }
})
```

- `secret` is the name of the server variable, not the secret itself. ViteHub reads it on each request: `process.env`, or the Worker bindings on Cloudflare.
- It reads the raw body once and checks the signature in constant time. Do not read the body before you call it.
- It returns `[error, body]`. `body` is the parsed JSON.
- For Stripe, a signature older than 300 seconds fails. Change it with `toleranceSeconds`.

Set the secret in `.env` for `vite dev`, and as a secret on the host for production:

```bash [.env]
STRIPE_WEBHOOK_SECRET=whsec_...
```

## Providers

| `provider` | Header | Options |
| --- | --- | --- |
| `'stripe'` | `Stripe-Signature` | `toleranceSeconds`, default `300` |
| `'github'` | `X-Hub-Signature-256` | none |
| `'hmac'` | `header` | `header` (required), `prefix`, `encoding` (`'hex'` or `'base64'`), `secretEncoding` (`'utf8'` or `'base64'`) |

Use `'hmac'` for a provider that signs the raw body with HMAC-SHA256, such as Airtable:

```ts [server/api/airtable/webhook.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { verifyWebhook } from 'vite-hub/env'

export default defineEventHandler(async (event) => {
  const [error, notification] = await verifyWebhook<{ webhook: { id: string } }>(event, {
    provider: 'hmac',
    secret: 'AIRTABLE_WEBHOOK_SECRET',
    header: 'X-Airtable-Content-MAC',
    prefix: 'hmac-sha256=',
    encoding: 'hex',
    secretEncoding: 'base64',
  })
  if (error) throw new HTTPError({ status: 400, message: error.message })
  return { webhook: notification.webhook.id }
})
```

## Errors

`error.code` is one of these:

- `ENV_WEBHOOK_SIGNATURE_INVALID`: the header is missing, the signature does not match the body, or a Stripe signature is too old.
- `ENV_WEBHOOK_SECRET_UNSET`: the variable has no secret, so every delivery fails. The route never opens by mistake.
- `ENV_WEBHOOK_BODY_INVALID`: the signature is valid, but the body is not JSON.

Answer with `400` for these errors. The provider shows the failed delivery and sends it again later.

## Rotate a secret

The variable holds one secret, or a comma-separated list. A signature from any secret in the list passes.

1. Set the variable to `old-secret,new-secret` and deploy.
2. Change the secret at the provider.
3. Set the variable to `new-secret` and deploy.

::details{summary="When to use a Channel instead"}
`verifyWebhook()` only checks the request. A [Channel](/docs/channels) with `webhook()` or `stripe()` also stores each delivery, removes duplicates by delivery ID, and runs your handler again until it succeeds. Use a Channel when a lost or doubled delivery costs money. For a route that a script calls with a shared token, use [Service tokens](/docs/env/service-tokens).
::
