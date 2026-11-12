---
title: Email
layout: landing
navigation.title: Overview
description: Send email from your server through Resend or Cloudflare, and write messages as Markdown templates.
navigation.order: 1
icon: i-lucide-mail
---

::product-hero{tagline="Send email from your server through Resend or Cloudflare, and write messages as Markdown templates." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="email"}
::

::code-tree{feature="email"}
```ts [server/api/welcome.post.ts] fragment
import renderWelcome from '#vitehub/emails/welcome'
import { defineEventHandler } from 'h3'
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email/server'

export default defineEventHandler(async () => {
  // Fill the template, then make HTML and text
  const markdown = await renderWelcome({ user: { name: 'Ada' } })
  const body = await renderEmailMarkdown(markdown)

  const [error, sent] = await email.send({
    ...body,
    from: 'verified-sender@example.com',
    to: 'ada@example.com',
    subject: 'Your workspace is ready',
  })
  if (error) throw error
  return sent
})
```

```md [server/emails/welcome.md]
# Welcome {{ data.user.name }}

Your workspace is ready.
```

:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    // Resend sends the email
    email: {
      driver: 'resend',
      // The server reads the key when it sends
      options: {
        apiKey: env({
          secret: true,
          source: env.source('RESEND_API_KEY'),
        }),
      },
    },
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    // Resend sends the email
    email: {
      driver: 'resend',
      // The server reads the key when it sends
      options: {
        apiKey: env({
          secret: true,
          source: env.source('RESEND_API_KEY'),
        }),
      },
    },
  }), nitro()],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    // Resend sends the email
    email: {
      driver: 'resend',
      // The server reads the key when it sends
      options: {
        apiKey: env({
          secret: true,
          source: env.source('RESEND_API_KEY'),
        }),
      },
    },
  })],
})
```
:::

```ts [test/welcome.test.ts]
import { expect, it } from 'vitest'
import { createTestEmail } from 'vite-hub/email/test'

// Check an email without sending it
it('sends the welcome email', async () => {
  const mail = createTestEmail()
  await mail.send({
    from: 'hello@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })
  expect(mail.messages[0]?.subject).toBe('Welcome')
})
```
::

::product-features
  :::product-feature-item{title="Pick a provider in one place" icon="i-lucide-sliders-horizontal" to="/docs/email/configure#configure-vite"}
  Pick Resend or Cloudflare Email in your Vite config. Your routes stay the same.
  :::

  :::product-feature-item{title="Keys stay out of your code" icon="i-lucide-shield-check" to="/docs/email/get-started#provide-the-resend-secret"}
  The server reads the API key from an environment variable when it sends.
  :::

  :::product-feature-item{title="Write emails in Markdown" icon="i-lucide-files" to="/docs/email/server-api#compose-dynamic-markdown"}
  Files in `server/emails` become typed imports. Fill them with data for HTML and text.
  :::

  :::product-feature-item{title="See each email while you develop" icon="i-lucide-inbox" to="/docs/email/hosts#development-outbox"}
  In `vite dev`, each email stays in an outbox. `remote: true` also sends it through the provider.
  :::

  :::product-feature-item{title="Test without sending" icon="i-lucide-flask-conical" to="/docs/email/server-api#test-without-delivery"}
  `createTestEmail()` keeps messages in memory for your tests to check.
  :::

  :::product-feature-item{title="Clear errors, no double sends" icon="i-lucide-circle-alert" to="/docs/email/limits-and-errors#handle-delivery-errors"}
  Each failure has an `EMAIL_*` code. Email does not retry, so nothing sends twice by mistake.
  :::
::

::agent-only{skill="email"}
Use Email for outbound transactional messages. Email keeps delivery behind a provider-neutral driver and supports Markdown templates with a text fallback.

Keep recipients, sender identity, and delivery authorization in application policy. Use test capture or a local driver before sending to real recipients.

Prove rendered HTML and text output, a rejected address, and the provider response. Do not claim delivery from a queued request alone.
::
