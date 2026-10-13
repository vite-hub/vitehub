---
title: Email configuration
description: Configure the Email Vite Integration, select a driver, and connect another provider.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure Vite

The ViteHub preset keeps Email opt-in:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
    },
  })],
})
```

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `driver` | `'resend' \| 'cloudflare-email'` | Required | Selects a built-in ViteHub Email driver. |
| `options` | `EnvRuntimeConfigOptions` | `{}` | Supplies serializable non-secret literals and runtime Env declarations. Env source values resolve in the server runtime for every send; literals and non-secret defaults are included in build output, while defaults on secret declarations are rejected. |
| `outbox` | `false \| { deliver?: boolean, limit?: number }` | `{ deliver: true, limit: 50 }` | Configures the [development outbox](/docs/email/hosts#development-outbox) in `vite dev`. Build output never contains it. |

`email: true` selects the `cloudflare-email` driver. The `cloudflare-email` driver requires Cloudflare hosting and generates an `EMAIL` `send_email` Worker binding. With other presets, set `driver: 'resend'`.

The integration serializes the driver name, literal options, and Env declarations into a server-only generated module. Credential values remain in the runtime environment when they are supplied through an Env source without a default.

## Configure another provider

Set `email.driver` to `resend` or `cloudflare-email` and declare its serializable options in the same Vite config. Keep credentials in Server Env or the deployment platform's secret store, and pass them as Env declarations without defaults. For another provider, implement the exported `EmailDriver` interface and pass it to `createEmail()`.

A driver object initializes once per client. Concurrent sends share pending initialization, and a later send retries initialization after a failure. A driver factory resolves and initializes a driver for each send. The development outbox uses the same lifecycle rules.
