---
title: Webhooks server API
description: sendWebhook(), the request that the receiver gets, how a delivery moves from pending to sent, and the functions that inspect and operate deliveries.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code
---

## `sendWebhook()`

`sendWebhook(name, body, { event, key? })` stores a delivery and returns `[error, { id, status: 'pending' }]`. Import it from `vite-hub/webhooks` and call it from server code.

| Argument | Does |
| --- | --- |
| `name` | The webhook, typed from the files of `server/webhooks/`. An unknown name throws [`WEBHOOKS_NOT_FOUND`](/docs/webhooks/limits-and-errors#webhooks_not_found). |
| `body` | JSON data: an object, an array, a string, a number, a boolean, or `null`. The receiver gets it as the request body. |
| `event` | A label that the receiver gets in `x-vitehub-event`, such as `'comments.comment'`. |
| `key` | With `debounce`, sends with the same key collapse. Default: the webhook name. See [Debounce](/docs/webhooks/configure#debounce). |

```ts [server/webhooks/billing.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({ url: 'BILLING_WEBHOOK_URL', secret: 'BILLING_WEBHOOK_SECRET' })
```

```ts [server/utils/invoice-paid.ts]
import { sendWebhook } from 'vite-hub/webhooks'

export async function invoicePaid(invoice: { id: string, total: number, paidAt: Date }) {
  // A Date is not JSON data, so send an ISO string
  const [error, delivery] = await sendWebhook('billing', { ...invoice, paidAt: invoice.paidAt.toISOString() }, { event: 'invoice.paid' })
  if (error) return { error: error.code }
  return { delivery: delivery.id }
}
```

`sendWebhook()` returns its errors: a missing or wrong variable, a body that is not JSON, or a Database or Queue failure. See [Errors](/docs/webhooks/limits-and-errors#errors). A returned `id` means the delivery is stored. It does not mean the receiver got it.

## The request

The receiver gets a `POST` with the JSON body and these headers:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-hub-signature-256` | With `signature: 'github'`: `sha256=` and the hex HMAC-SHA256 of the body |
| `stripe-signature` | With `signature: 'stripe'`: `t=<time>,v1=<hex>`, the HMAC-SHA256 of `<time>.<body>` |
| `x-vitehub-event` | The `event` of the last send |
| `x-vitehub-delivery` | The delivery id, such as `whd_5f0c...`. It is the same for each retry. |
| `x-vitehub-events` | How many sends the delivery collapsed. `1` without a debounce. |
| `user-agent` | `ViteHub-Webhooks` |

The body is the same bytes for each attempt, so the signature stays valid. ViteHub does not follow a redirect, because a redirect would send the signed body to another place.

## How a delivery moves

1. `sendWebhook()` stores the delivery as `pending` in `vitehub_webhook_deliveries`, then puts a wake job on the `vitehub-webhooks` Queue with the debounce as its delay.
2. With a debounce, a later send with the same key replaces the body, raises the revision, and puts a new wake on the Queue. Only the wake of the latest revision delivers.
3. The wake claims the delivery as `sending` and posts it, with 10 seconds for an answer.
4. A 2xx answer marks it `sent`. Any other answer, a timeout, or a network error sets it back to `pending` and the Queue tries again. After 4 attempts it is `dead`.
5. A variable that is missing when the wake runs marks the delivery `dead` at once, because a retry cannot help. Set the variable, then redeliver.

A delivery is `pending`, `sending`, `sent`, `dead`, or `cancelled`.

Delivery is at least once. A receiver can get the same delivery twice, for example when it answers after the 10 seconds. Drop a request whose `x-vitehub-delivery` you already handled.

## Inspect and operate

`vite-hub/webhooks/runtime` reads and changes deliveries in server code. The delivery functions return `[error, data]`. They check no access, so call them only from trusted code, such as a test or a route that checks the user.

| Function | Does |
| --- | --- |
| `listWebhooks()` | Every webhook, with the names of its variables, `urlSet` and `secretSet`, and `debounceMs`. It returns the list, not a Result. |
| `listWebhookDeliveries({ webhook?, state?, limit?, before? })` | Deliveries, newest first. `limit` is 100 by default, 500 at most. |
| `listPendingWebhookDeliveries({ webhook?, limit? })` | Pending deliveries, the soonest due first. |
| `getWebhookDelivery(id)` | One delivery. |
| `flushWebhookDelivery(id)` | Delivers a pending delivery now, without the rest of its debounce. |
| `cancelWebhookDelivery(id)` | Cancels a pending delivery. Its wake then does nothing. |
| `redeliverWebhookDelivery(id)` | Sends a `sent`, `dead`, or `cancelled` delivery again now, as a new delivery with a new id, the same body, event, and count. |

```ts [server/utils/retry-dead.ts]
import { listWebhookDeliveries, redeliverWebhookDelivery } from 'vite-hub/webhooks/runtime'

/** Sends each dead delivery of a webhook again, for example after you fixed its URL. */
export async function retryDead(webhook: string) {
  const [error, dead] = await listWebhookDeliveries({ webhook, state: 'dead' })
  if (error) throw error
  const ids: string[] = []
  for (const delivery of dead) {
    const [redeliverError, sent] = await redeliverWebhookDelivery(delivery.id)
    if (redeliverError) throw redeliverError
    ids.push(sent.id)
  }
  return ids
}
```

A delivery has `id`, `webhook`, `key`, `event`, `body`, `revision`, `count`, `state`, `attempts`, `lastStatus` (the HTTP status of the last attempt), `lastError` (why it failed, never the URL or the secret), `dueAt`, `createdAt`, `updatedAt`, and `sentAt`. Times are milliseconds since the epoch.

## Tests

In a unit test, call `installWebhooks()` from `@vite-hub/webhooks/runtime` with your definitions, a store, and a wake sender. `createDrizzleWebhookStore(db)` from `@vite-hub/webhooks/database` gives a store on a libSQL or D1 Drizzle client, and `webhooksTables` holds the SQL of the table.

## Public imports

| Import | Purpose |
| --- | --- |
| `vite-hub/webhooks` | `defineWebhook()`, `sendWebhook()`, and the types |
| `vite-hub/webhooks/runtime` | The delivery functions above, and `installWebhooks()` for tests |
| `vite-hub/webhooks/database` | The table as `webhooksSchema`, as SQL in `webhooksTables`, and `createDrizzleWebhookStore()` |
| `@vite-hub/webhooks/vite` | `hubWebhooks()`. `vitehub()` adds it for you. |

Outside a ViteHub app, import the same names from `@vite-hub/webhooks`.
