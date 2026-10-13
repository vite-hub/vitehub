---
title: Email hosts
description: Understand provider behavior, the development outbox, and Email runtime requirements.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider behavior for Resend

Use the quick-start `vitehub({ email: { driver: 'resend', options } })` configuration. A successful result has `driver: 'resend'`. ViteHub maps provider errors to `EMAIL_*` codes and keeps the original error in `cause`.

## Development outbox

In `vite dev`, `hubEmail()` wraps the provider driver with a development outbox. Each `email.send()` call records one message in the memory of the server runtime. Build output never contains the outbox: `vite build` generates the provider driver only.

The outbox records:

- the sender, recipients, `cc`, `bcc`, and `replyTo`
- the subject, preheader, text body, and HTML body
- the headers after ViteHub adds unsubscribe headers
- attachment names, content types, and sizes, but not attachment content
- tags, metadata, the provider driver name, and the delivery result

The outbox stores the effective recipients and subject of a single personalization. Messages appear as Sending while the provider is pending, in submission order.

By default the outbox records the message and then sends it through the provider, because development sends are real deliveries. Set `deliver: false` to record messages without a provider request. In this mode `email.send()` returns an `outbox-<n>` id with `driver: 'outbox'`, and ViteHub does not resolve the provider options.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
      outbox: { deliver: false, limit: 100 },
    },
  })],
})
```

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `outbox.deliver` | `boolean` | `true` | `true` sends each message through the provider after it records the message. `false` records messages only. |
| `outbox.limit` | `number` | `50` | Number of messages to keep, from 1 to 1000. The outbox removes the oldest message first. |

Set `outbox: false` to disable the outbox. Each Development Server has a separate outbox identity. A restart creates a fresh outbox. The outbox redacts header and metadata values with secret names, and credentials in delivery errors. It keeps message bodies as the application rendered them.

Inspect the outbox with the [CLI](/docs/development/cli#inspect-the-email-development-outbox) or in the [Console](/docs/development/console) **Email** section:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show outbox-1 --html > message.html
pnpm vitehub email preview welcome --data '{"user":{"name":"Ada"}}'
```

`vitehub email outbox` reads the outbox through the Nitro runtime, so it needs a Vite + Nitro Development Server. With Nuxt or plain Vite, the command reports that the host is not supported. `vitehub email preview` does not need a server. The Console never renders captured HTML. It shows the HTML source as text.

## Requirements

- `vite-hub/email` requires Node.js 24.15 or later. The direct `@vite-hub/email` package requires Node.js 24 or later.
- Email provider configuration requires Vite 8 or later; explicit `createEmail()` clients do not require Vite.
- Provider runtime support comes from the selected built-in or custom ViteHub driver.

ViteHub owns the portable driver contract, the built-in Resend and Cloudflare Email transports, runtime delivery, normalized errors, dynamic Markdown composition, and test capture. Queue, Workflow, and Schedule remain the orchestration layer.
