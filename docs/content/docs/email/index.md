---
title: Email
navigation.title: Overview
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 1
icon: i-lucide-mail
---

::product-hero{tagline="One message contract for transactional email: the Vite config selects Resend or Cloudflare Email, and routes stay unchanged." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [server/api/send-welcome.post.ts]
  import renderWelcome from '#vitehub/emails/welcome'
  import { renderEmailMarkdown } from 'vite-hub/email/markdown'
  import { email } from 'vite-hub/email/server'

  export async function sendWelcome(name: string, to: string) {
    const markdown = await renderWelcome({ user: { name } })
    const body = await renderEmailMarkdown(markdown)

    return await email.send({
      ...body,
      from: 'verified-sender@example.com',
      to,
      subject: 'Your workspace is ready',
    })
  }
  ```

  ```md [server/emails/welcome.md]
  # Welcome {{ data.user.name }}

  Your workspace is ready.
  ```

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

  ```ts [server/agents/mailer.ts]
  import { defineAgent } from 'vite-hub/agent'
  import { email } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    capabilities: [
      email({
        from: 'support@example.com',
        recipients: [
          'customer@example.net',
          'owner@example.com',
        ],
        policy: 'require-approval',
      }),
    ],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="Config picks the driver, runtime keeps the secret" icon="i-lucide-sliders-horizontal" to="/docs/email/configure"}
  `driver` is `resend` or `cloudflare-email`; the key resolves at runtime.
  :::

  :::product-feature-item{title="Markdown files in server/emails become typed imports" icon="i-lucide-files" to="/docs/email/server-api#compose-dynamic-markdown"}
  Each file becomes a typed `#vitehub/emails/<name>` import.
  :::

  :::product-feature-item{title="Every send in vite dev is recorded" icon="i-lucide-terminal" to="/docs/email/hosts#development-outbox"}
  The outbox records each `email.send()`; `deliver: false` skips the provider.
  :::

  :::product-feature-item{title="A test client captures messages without delivery" icon="i-lucide-play-circle" to="/docs/email/server-api#test-without-delivery"}
  `createTestEmail()` returns a client with an isolated in-memory mailbox.
  :::

  :::product-feature-item{title="An Agent sends plain text to allowed addresses" icon="i-lucide-bot" to="/docs/email/agent-capability"}
  The sender is fixed; recipients outside `recipients` deny the call.
  :::

  :::product-feature-item{title="Delivery errors stay explicit" icon="i-lucide-circle-alert" to="/docs/email/limits-and-errors"}
  Email maps failures to `EMAIL_*` codes and does not retry.
  :::
::
