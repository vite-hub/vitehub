---
title: Send your first webhook
description: Send a signed webhook from a ViteHub app to a receiver route, add a debounce, and read the deliveries from server code.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You need a ViteHub app from [Installation](/docs/getting-started/installation). Run the commands from its root. The app sends webhooks to a route of its own, so you can see both sides.

::tutorial-step{title="Install Webhooks"}
## Install Webhooks

Install Webhooks, and the Queue and Database packages that it uses:

```bash [commands/install]
pnpm add @vite-hub/webhooks @vite-hub/queue @vite-hub/database drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit@1.0.0-rc.5
```

Turn on `queue` and `database`. In development, the Queue runs jobs in the dev server and the Default Database is a SQLite file.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    queue: true,
    database: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ queue: true, database: true }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ queue: true, database: true })],
})
```
:::
::

::

::tutorial-step{title="Define the webhook"}
## Define the webhook

Create `server/webhooks/team.ts`. The file name is the webhook name. `url` and `secret` are the names of server variables, not the values:

```ts [server/webhooks/team.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'TEAM_WEBHOOK_URL',
  secret: 'TEAM_WEBHOOK_SECRET',
})
```

Set the variables in `.env`. Here the URL points to a route of the same app:

```bash [.env]
TEAM_WEBHOOK_URL=http://localhost:3000/api/hooks/team
TEAM_WEBHOOK_SECRET=change-me
```

Webhooks adds its table to the Default Database. Write and apply the migration:

```bash [commands/migrate]
vitehub database generate
vitehub database migrate
```

::

::tutorial-step{title="Receive it"}
## Receive it

Add the receiver. [`verifyWebhook()`](/docs/env/webhooks) checks the `x-hub-signature-256` header with the same secret:

```ts [server/api/hooks/team.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { verifyWebhook } from 'vite-hub/env'

export default defineEventHandler(async (event) => {
  const [error, body] = await verifyWebhook(event, { provider: 'github', secret: 'TEAM_WEBHOOK_SECRET' })
  if (error) throw new HTTPError({ status: 400, message: error.message })
  const headers = event.req.headers
  console.info(headers.get('x-vitehub-event'), headers.get('x-vitehub-delivery'), body)
  return { received: true }
})
```

::

::tutorial-step{title="Send it"}
## Send it

Call `sendWebhook()` from server code. The name `team` is typed from the files of `server/webhooks/`:

```ts [server/api/ping.post.ts]
import { defineEventHandler } from 'h3'
import { sendWebhook } from 'vite-hub/webhooks'

export default defineEventHandler(async () => {
  const [error, delivery] = await sendWebhook('team', { text: 'Hello' }, { event: 'app.ping' })
  if (error) throw error
  return delivery
})
```

Start the dev server with `pnpm dev`, then send from a second terminal:

```bash [commands/send]
curl -X POST http://localhost:3000/api/ping
```

The answer has the delivery id. The delivery is stored first, so it is `pending`:

```json [output/send.json]
{ "id": "whd_5f0c2c1e-8a4b-4d7e-9f1a-2b3c4d5e6f70", "status": "pending" }
```

The Queue job runs a moment later. The dev server logs `app.ping`, the delivery id, and `{ text: 'Hello' }`.

::

::tutorial-step{title="Add a debounce"}
## Add a debounce

Add `debounce`. Now each send restarts a 10 second wait, and the receiver gets the last body once:

```ts [debounce/server/webhooks/team.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'TEAM_WEBHOOK_URL',
  secret: 'TEAM_WEBHOOK_SECRET',
  debounce: '10s',
})
```

Send three times in a row. All three answers have the same delivery id. After 10 seconds, the receiver gets one request with `x-vitehub-events: 3`.

::

::tutorial-step{title="Read the deliveries"}
## Read the deliveries

`vite-hub/webhooks/runtime` reads the deliveries in server code. Do not return them from a public route, because the body can hold private data:

```ts [server/utils/webhook-report.ts]
import { listWebhookDeliveries } from 'vite-hub/webhooks/runtime'

/** The last 20 deliveries of the team webhook, for a report or a test. */
export async function webhookReport() {
  const [error, deliveries] = await listWebhookDeliveries({ webhook: 'team', limit: 20 })
  if (error) throw error
  return deliveries.map(delivery => ({ id: delivery.id, state: delivery.state, events: delivery.count, lastError: delivery.lastError }))
}
```

See [Server API](/docs/webhooks/server-api#inspect-and-operate) to flush, cancel, and redeliver.

::
