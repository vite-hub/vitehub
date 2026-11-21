---
title: Email configuration
description: Configure the Email Vite Integration, select a driver, and connect another provider.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure Vite

Email is off until you turn it on:

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
    },
  })],
})
```
:::
::

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `driver` | `'resend' \| 'cloudflare' \| 'log'` | Required | Picks a built-in Email driver. `log` prints each message and sends nothing. |
| `options` | `EnvRuntimeConfigOptions` | `{}` | Plain non-secret values and `env()` declarations. The server reads `env()` sources on every send. Plain values and non-secret defaults go into the build output. A default on a secret is rejected. |
| `remote` | `boolean` | `false` | `true` makes `vite dev` send real email through the provider. Else a dev send stays in the [development outbox](/docs/email/hosts#development-outbox). Builds ignore it. |
| `outbox` | `false \| { limit?: number }` | `{ limit: 50 }` | Sets up the [development outbox](/docs/email/hosts#development-outbox) in `vite dev`. `false` needs `remote: true`, except with `log`. Never in build output. |

No `email`, or `email: false`, keeps Email off.

## Start with `email: true`

`email: true` works on every host. It picks the default driver of the host:

| Host | `vite dev` | Production build |
| --- | --- | --- |
| `cloudflare` | `cloudflare` | `cloudflare`, with an `EMAIL` `send_email` Worker binding |
| Every other host | `log`, in the [development outbox](/docs/email/hosts#development-outbox) | Fails with [`VITE_HUB_R0089`](/docs/development/diagnostics/vite_hub_r0089) |

Only Cloudflare has an Email provider of its own. On other hosts, set `driver` before you build, such as `driver: 'resend'`. Set `driver: 'log'` to build an app that sends no email.

## Run without a provider

Set `driver: 'log'` when a build has no Email provider, for example a self-hosted copy of your app. It works on every host and in production. `email.send()` prints each message with `console.info` and returns `{ driver: 'log', id }`. It sends nothing. The log keeps the message body, so links in it, such as sign-in links, are in the server log.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

const resend = {
  driver: 'resend' as const,
  options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
}

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    // Pick the driver when you build. The API key stays a runtime secret.
    email: process.env.EMAIL_PROVIDER === 'resend' ? resend : { driver: 'log' },
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

const resend = {
  driver: 'resend' as const,
  options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
}

export default defineConfig({
  plugins: [vitehub({ email: process.env.EMAIL_PROVIDER === 'resend' ? resend : { driver: 'log' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

const resend = {
  driver: 'resend' as const,
  options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
}

export default defineConfig({
  plugins: [vitehub({ email: process.env.EMAIL_PROVIDER === 'resend' ? resend : { driver: 'log' } })],
})
```
:::
::

Read `email.canSend` in server code to tell if a message reaches a mailbox. It is `false` with the `log` driver and without `email`. Use it to skip email verification, or to show a link on the page:

```ts [server/api/invite.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email'

export default defineEventHandler(async () => {
  const link = 'https://example.com/invite/123'
  if (!email.canSend) return { link }
  const [error] = await email.send({ from: 'team@example.com', to: 'ada@example.com', subject: 'Join the team', text: link })
  if (error) throw error
  return { sent: true }
})
```

`email.canSend` follows the configured driver. The [development outbox](/docs/email/hosts#development-outbox) of `vite dev` does not change it.

ViteHub writes the driver name, plain options, and `env()` declarations into a generated server-only module. A credential from an `env()` source without a default stays in the runtime environment.

## Configure another provider

Keep credentials in Server Env or your host's secret store, and pass them as `env()` declarations without defaults. For a provider other than `resend` or `cloudflare`, implement the exported `EmailDriver` interface and pass it to `createEmail()`. Its `send()` returns `[error, data]`, the same order as `email.send()`: `[undefined, { id, driver, at }]` on success, or `[error, undefined]` with an error that has a `code` such as `PROVIDER` and the `driver` name.

- A driver object starts once per client. Sends at the same time share the pending start. After a failed start, the next send tries again.
- A driver factory creates and starts a driver for each send.
- The development outbox follows the same rules.
