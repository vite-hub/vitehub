---
title: Webhooks configuration
description: Every option of defineWebhook(), how the debounce collapses sends, where the URL and secret live, and what the app needs.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## `defineWebhook()`

`server/webhooks/<name>.ts` default-exports `defineWebhook()`. The name is lowercase letters, digits, and dashes, such as `t3` or `slack-alerts`.

```ts [server/webhooks/slack-alerts.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'SLACK_ALERTS_URL',
  secret: 'SLACK_ALERTS_SECRET',
  signature: 'stripe',
  debounce: '2 minutes',
})
```

| Option | Default | Does |
| --- | --- | --- |
| `url` | required | The name of the server variable that holds the receiver URL. It must be an `http` or `https` URL. |
| `secret` | required | The name of the server variable that holds the signing secret. |
| `signature` | `'github'` | `'github'` sends `x-hub-signature-256: sha256=<hex>`. `'stripe'` sends `stripe-signature: t=<time>,v1=<hex>`. Both are HMAC-SHA256. |
| `debounce` | none | Wait this long after the last send, then deliver once. A duration such as `'30m'`, `'10s'`, or `'1 day'`. At most 24 hours. Without it, each send is delivered at once. |

A wrong option throws [`WEBHOOKS_DEFINITION_INVALID`](/docs/webhooks/diagnostics/webhooks_definition_invalid) when the server loads the file, and a `debounce` that is not a duration, such as a number, throws [`RUNTIME_DURATION_INVALID`](/docs/development/diagnostics/runtime_duration_invalid). A debounce over 24 hours throws [`WEBHOOKS_DEBOUNCE_TOO_LONG`](/docs/webhooks/diagnostics/webhooks_debounce_too_long).

## URL and secret

`url` and `secret` are names, not values. A receiver URL often holds a token, so it stays out of your code and out of git. ViteHub reads both variables when it sends and again when it delivers: `process.env` on Node, and the bindings on Cloudflare. Set them in `.env` for `vite dev`, and as secrets on the host for production.

Errors and stored fields never hold the URL, its query, or the secret. A missing variable makes `sendWebhook()` return [`WEBHOOKS_URL_UNSET`](/docs/webhooks/diagnostics/webhooks_url_unset) or [`WEBHOOKS_SECRET_UNSET`](/docs/webhooks/diagnostics/webhooks_secret_unset).

To check a delivery in a ViteHub receiver, call [`verifyWebhook()`](/docs/env/webhooks) with `provider: 'github'` or `provider: 'stripe'` and the same secret.

## Debounce

A debounce is trailing: the receiver gets one delivery after the sends stop for the debounce time.

- Each send in the window replaces the body of the pending delivery. The last body wins.
- Each send moves the due time to now plus the debounce, and raises the revision of the delivery.
- Each send also puts a wake job on the Queue with the debounce as its delay. When a wake runs, it delivers only if it has the latest revision. Older wakes do nothing.
- `x-vitehub-events` tells the receiver how many sends the delivery collapsed.
- All sends return the same delivery id while the delivery waits.

Sends collapse by `key`. The default key is the webhook name, so all sends of one webhook collapse. Pass `key` to `sendWebhook()` to keep a separate wait for each thread, user, or document:

```ts [server/utils/notify-thread.ts]
import { sendWebhook } from 'vite-hub/webhooks'

/** One delivery for each comment thread, 2 minutes after its last reply. */
export async function notifyThread(threadId: string, text: string) {
  return sendWebhook('slack-alerts', { threadId, text }, { event: 'comments.comment', key: threadId })
}
```

A webhook without `debounce` ignores `key`. Each send is its own delivery.

The pending delivery and its due time live in the Database, and the wake lives in the Queue. A restart or a deploy keeps both, so a 30 minute wait still ends in one delivery.

## What the app needs

| Need | Why | Without it |
| --- | --- | --- |
| `queue` in `vitehub()` | Each delivery goes out through the internal `vitehub-webhooks` Queue. | The build fails with [`WEBHOOKS_QUEUE_OFF`](/docs/webhooks/diagnostics/webhooks_queue_off). |
| `database` in `vitehub()` | Each delivery is a row of `vitehub_webhook_deliveries`. | The build fails with [`WEBHOOKS_DATABASE_OFF`](/docs/webhooks/diagnostics/webhooks_database_off). |
| A SQLite Default Database | The table uses SQLite: a local file, libSQL such as Turso, or Cloudflare D1. | A Postgres Default Database cannot hold it. |
| The migration | `vitehub database generate` and `vitehub database migrate` add the table. | Each send returns [`WEBHOOKS_STORE_FAILED`](/docs/webhooks/diagnostics/webhooks_store_failed). |

Webhooks uses the Database named `default`, or the only Database of the app. See [Hosts](/docs/webhooks/hosts) for each host.
