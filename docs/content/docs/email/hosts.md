---
title: Email hosts
description: Understand provider behavior, the development outbox, and Email runtime requirements.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider behavior for Resend

Use the quick-start config, `vitehub({ email: { driver: 'resend', options } })`. A successful result has `driver: 'resend'`. ViteHub maps provider errors to `EMAIL_*` codes and keeps the original error in `cause`.

## Development outbox

In `vite dev`, `hubEmail()` wraps the provider driver with a development outbox. Each `email.send()` records one message in server memory. `vite build` generates only the provider driver, never the outbox.

The outbox records:

- the sender, recipients, `cc`, `bcc`, and `replyTo`
- the subject, text body, and HTML body
- the headers after ViteHub adds unsubscribe headers
- attachment names, content types, and sizes, but not attachment content
- tags, metadata, the provider driver name, and the delivery result

Messages show as Sending while the provider is pending, in the order they were sent.

By default, a dev send stays in the outbox. The provider gets no request, `email.send()` returns an `outbox-<n>` id with `driver: 'outbox'`, and ViteHub does not read the provider options. So a signup flow you test in `vite dev` sends no real email.

Set `remote: true` to send real email from `vite dev`. The outbox records each message, then sends it through the provider. The first send prints `` [vitehub] Email is remote: `vite dev` sends real email through resend. `` Builds ignore `remote`, so build output stays the same.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
      remote: true,
      outbox: { limit: 100 },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
      remote: true,
      outbox: { limit: 100 },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
      remote: true,
      outbox: { limit: 100 },
    },
  })],
})
```
:::
::

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `remote` | `boolean` | `false` | `true` sends each dev message through the provider after the outbox records it. `false` keeps dev sends in the outbox. |
| `outbox.limit` | `number` | `50` | Messages to keep, from 1 to 1000. The oldest goes first. |

Set `outbox: false` to turn the outbox off. A dev send then goes straight to the provider, so `outbox: false` needs `remote: true`. Without it, `vite dev` fails with [`EMAIL_REMOTE_REQUIRED`](/docs/email/limits-and-errors#email_remote_required).

- Each dev server has its own outbox. A restart starts an empty one.
- The outbox hides header and metadata values with secret names, and credentials in delivery errors.
- It keeps message bodies as your app rendered them.

Inspect the outbox with the [CLI](/docs/cli/env#inspect-the-email-development-outbox) or in the [Console](/docs/console) **Email** section:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show outbox-1 --html > message.html
pnpm vitehub email preview welcome --data '{"user":{"name":"Ada"}}'
```

`vitehub email outbox` runs the `email.outbox-*` [operations](/docs/console/operations) in the app, so it needs this project's dev server running. With `--url`, it reads the outbox of a deployed app with the Console on, but only `vite dev` captures messages. `vitehub email preview` needs no server. The Console never renders captured HTML. It shows the HTML source as text.

## Requirements

- `vite-hub/email` needs Node.js 22.22 or later. The standalone `@vite-hub/email` package needs Node.js 22.18 or later.
- Provider config needs Vite 8 or later. `createEmail()` clients do not need Vite.
- Runtime support comes from the built-in or custom driver you pick.

Email owns the driver contract, the built-in Resend and Cloudflare Email transports, delivery, errors, Markdown templates, and test capture. To run work later or in steps, use Queue, Workflow, and Schedule.

## Related guides

Read [Send email with Resend](/docs/guides/resend) for deploy credentials and
delivery checks.
