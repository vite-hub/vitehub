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
    host: 'node',
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
    host: 'node',
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
    host: 'node',
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
| `driver` | `'resend' \| 'cloudflare-email'` | Required | Picks a built-in Email driver. |
| `options` | `EnvRuntimeConfigOptions` | `{}` | Plain non-secret values and `env()` declarations. The server reads `env()` sources on every send. Plain values and non-secret defaults go into the build output. A default on a secret is rejected. |
| `remote` | `boolean` | `false` | `true` makes `vite dev` send real email through the provider. Else a dev send stays in the [development outbox](/docs/email/hosts#development-outbox). Builds ignore it. |
| `outbox` | `false \| { limit?: number }` | `{ limit: 50 }` | Sets up the [development outbox](/docs/email/hosts#development-outbox) in `vite dev`. `false` needs `remote: true`. Never in build output. |

No `email`, or `email: false`, keeps Email off. `email: true` picks `cloudflare-email`, which needs Cloudflare hosting and generates an `EMAIL` `send_email` Worker binding. On other hosts, set `driver: 'resend'`.

ViteHub writes the driver name, plain options, and `env()` declarations into a generated server-only module. A credential from an `env()` source without a default stays in the runtime environment.

## Configure another provider

Keep credentials in Server Env or your host's secret store, and pass them as `env()` declarations without defaults. For a provider other than `resend` or `cloudflare-email`, implement the exported `EmailDriver` interface and pass it to `createEmail()`.

- A driver object starts once per client. Sends at the same time share the pending start. After a failed start, the next send tries again.
- A driver factory creates and starts a driver for each send.
- The development outbox follows the same rules.
