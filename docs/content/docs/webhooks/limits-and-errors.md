---
title: Webhooks limits and errors
description: Debounce, attempt, timeout, and list limits of Webhooks, how delivery retries work, and the WEBHOOKS error codes with their fixes.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| `debounce` | 24 hours at most, on every host. See [Hosts](/docs/webhooks/hosts#debounce-and-retries-on-each-host). |
| Answer time of the receiver | 10 seconds |
| Attempts of one delivery | 4: one delivery and three retries |
| Webhook name | Lowercase letters, digits, and dashes |
| Body | JSON data. The Queue of the host limits the size of a wake, not of the body, because the body stays in the Database. |
| `listWebhookDeliveries()` and `listPendingWebhookDeliveries()` page | 100 by default, 500 at most |
| Member endpoints | One for each member. `owner` at most 256 characters, `name` 120, `agent` 64, the URL 2,048, and the secret 1,024. |

## Delivery

Delivery is at least once. The receiver can get a delivery twice, for example when it answers after 10 seconds or when a server stops after the post. `x-vitehub-delivery` is the same for each attempt, so drop a request whose id you already handled.

A delivery fails when the receiver answers with a status that is not 2xx, does not answer in 10 seconds, or cannot be reached. A redirect is a failure too. The delivery then goes back to `pending`, `lastStatus` and `lastError` show why, and the Queue tries again. After 4 attempts it is `dead`. Fix the receiver, then call `redeliverWebhookDelivery()`.

A `sending` delivery that a stopped server left behind becomes free again after 70 seconds, so the next wake of the Queue takes it.

## Errors

`sendWebhook()` and the delivery functions return `[error, data]`. When `error` is set, it has `code`, `why`, `fix`, and `docs`, a link to the code page. Definition and build errors throw.

```ts [server/webhooks/team.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({ url: 'TEAM_WEBHOOK_URL', secret: 'TEAM_WEBHOOK_SECRET' })
```

```ts [server/utils/send-or-skip.ts]
import { sendWebhook } from 'vite-hub/webhooks'

/** Sends to the team when the app has the variables, and skips it in a preview without them. */
export async function sendOrSkip(body: { text: string }) {
  const [error, delivery] = await sendWebhook('team', body, { event: 'app.note' })
  if (error?.code === 'WEBHOOKS_URL_UNSET' || error?.code === 'WEBHOOKS_SECRET_UNSET') return null
  if (error) throw error
  return delivery.id
}
```

See [Webhooks diagnostics](/docs/webhooks/diagnostics) for every error code and how to fix it.
