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

## Definition and build errors

### WEBHOOKS_DATABASE_OFF

The app has files in `server/webhooks/` but no Database, so the build fails. Turn on `database` in `vitehub()`, or remove the files.

### WEBHOOKS_DEBOUNCE_TOO_LONG

`debounce` is longer than 24 hours. Cloudflare Queues delays a message at most 24 hours, and a webhook must work on every host. Set 24 hours or less.

### WEBHOOKS_DEFINITION_INVALID

A file of `server/webhooks/` does not default-export `defineWebhook()`, or an option is wrong. `url` and `secret` must be names of server variables, such as `'T3_WEBHOOK_URL'`, not the URL or the secret. `signature` is `'github'` or `'stripe'`, and `debounce` is a duration such as `'30 minutes'`.

### WEBHOOKS_FILE_INVALID

A file name of `server/webhooks/` is not lowercase letters, digits, and dashes, or two files define the same webhook. Rename the file, such as `slack-alerts.ts`.

### WEBHOOKS_NOT_FOUND

`sendWebhook()` or `redeliverWebhookDelivery()` names a webhook that has no file. Add `server/webhooks/<name>.ts`, or use a name from the generated types. It throws, because the name is a mistake in code.

### WEBHOOKS_NOT_INSTALLED

Webhooks is not running in this server: the app has no `server/webhooks/` files, or the code runs outside the ViteHub server. In a unit test, call `installWebhooks()` from `@vite-hub/webhooks/runtime` first.

### WEBHOOKS_QUEUE_OFF

The app has files in `server/webhooks/` but no Queue, so the build fails. Turn on `queue` in `vitehub()`, or remove the files.

## Runtime errors

### WEBHOOKS_BODY_INVALID

The body is not JSON data. Pass a plain object, an array, a string, a number, a boolean, or `null`. Convert a `Date` to an ISO string and a `bigint` to a string first.

### WEBHOOKS_DATABASE_MISSING

The server has no Default Database for the deliveries. Turn on `database` in `vitehub()` and add the Default Database, or name one Database `default`.

### WEBHOOKS_DELIVERY_ACTIVE

`redeliverWebhookDelivery()` got a delivery that is `pending` or `sending`. Wait until it is sent, dead, or cancelled. To send a pending delivery now, flush it.

### WEBHOOKS_DELIVERY_FAILED

One attempt failed: a status that is not 2xx, no answer in 10 seconds, or a network error. The Queue handler throws it so that the Queue tries again. `lastError` of the delivery shows the same reason. Check that the receiver is up and answers with 2xx in time.

### WEBHOOKS_DELIVERY_NOT_FOUND

No delivery has that id. Pass an id that `listWebhookDeliveries()` returns.

### WEBHOOKS_DELIVERY_NOT_PENDING

`flushWebhookDelivery()` or `cancelWebhookDelivery()` got a delivery that is not `pending`. To send a sent, dead, or cancelled delivery again, redeliver it.

### WEBHOOKS_SECRET_UNSET

The server has no value for the variable that `secret` names. Set it in `.env` for `vite dev`, and as a secret on the host for production. When this happens at delivery time, the delivery is `dead`: set the variable, then redeliver.

### WEBHOOKS_STORE_FAILED

The Database could not read or write a delivery. Most often the table is missing: run `vitehub database generate` and `vitehub database migrate`. `error.cause` holds the Database error.

### WEBHOOKS_URL_INVALID

The variable that `url` names does not hold an `http` or `https` URL. Set it to the full URL of the receiver.

### WEBHOOKS_URL_UNSET

The server has no value for the variable that `url` names. Set it in `.env` for `vite dev`, and as a secret on the host for production. Keep it secret when the URL holds a token.

### WEBHOOKS_WAKE_FAILED

The delivery is stored, but the Queue did not accept its wake job. `error.cause` holds the Queue error. When the Queue works again, call `flushWebhookDelivery()` with the id from `listPendingWebhookDeliveries()`.
