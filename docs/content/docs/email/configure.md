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
| `driver` | `'resend' \| 'cloudflare' \| 'log' \| './path'` | Required | Picks a built-in Email driver, or a [driver module](#configure-another-provider) that starts with `./` or `../`. `log` prints each message and sends nothing. |
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

For a provider other than `resend` or `cloudflare`, write a driver module and set `driver` to its path. The path is relative to the project root. The module default-exports a function that gets `email.options`, with each `env()` value read, and returns an `EmailDriver`. `email.send()`, Forms, and the Agent `email()` Capability then send through it.

```ts [vite.config.ts] fragment
email: {
  driver: './server/email-driver.ts',
  options: {
    apiKey: env({ secret: true, source: env.source('POSTMARK_TOKEN') }),
  },
},
```

```ts [server/email-driver.ts]
import type { EmailDriver } from 'vite-hub/email'

export default function postmarkDriver(options: { apiKey: string }): EmailDriver {
  return {
    name: 'postmark',
    async send(message) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': options.apiKey },
        body: JSON.stringify({ From: message.from, To: message.to, Subject: message.subject, HtmlBody: message.html, TextBody: message.text }),
      })
      if (!response.ok) {
        const error = Object.assign(new Error(`Postmark answered ${response.status}`), { code: 'PROVIDER' as const, driver: 'postmark', status: response.status })
        return [error, undefined]
      }
      const { MessageID } = await response.json() as { MessageID: string }
      return [undefined, { at: new Date(), driver: 'postmark', id: MessageID }]
    },
  }
}
```

The host compiles the module with your app, so it can import any package. ViteHub calls the function for each send. In `vite dev`, the [development outbox](/docs/email/hosts#development-outbox) wraps it like a built-in driver. A path to a file that does not exist fails the build with [`EMAIL_DRIVER_MODULE_NOT_FOUND`](/docs/email/diagnostics/email_driver_module_not_found).

To send without the `email` helper, pass the driver to `createEmail()`.

Keep credentials in Server Env or your host's secret store, and pass them as `env()` declarations without defaults. A driver's `send()` returns `[error, data]`, the same order as `email.send()`: `[undefined, { id, driver, at }]` on success, or `[error, undefined]` with an error that has a `code` such as `PROVIDER` and the `driver` name.

- A driver object starts once per client. Sends at the same time share the pending start. After a failed start, the next send tries again.
- A driver factory creates and starts a driver for each send.
- The development outbox follows the same rules.
