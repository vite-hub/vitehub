---
title: Email
navigation.title: Overview
description: Send email from your server through Resend or Cloudflare, and write messages as Markdown templates.
navigation.order: 1
icon: i-lucide-mail
---

::product-hero{tagline="Send email from your server through Resend or Cloudflare, and write messages as Markdown templates." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
::agent-only{skill="email"}
Use Email for outbound transactional messages. Email keeps delivery behind a provider-neutral driver and supports Markdown templates with a text fallback.

Read [Get started](/docs/email/get-started), [Configure](/docs/email/configure), and [Server API](/docs/email/server-api).

Keep recipients, sender identity, and delivery authorization in application policy. Use test capture or a local driver before sending to real recipients.

Prove rendered HTML and text output, a rejected address, and the provider response. Do not claim delivery from a queued request alone.
::

::product-hero{tagline="One message contract for transactional email: the Vite config selects Resend or Cloudflare Email, and routes stay unchanged." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [server/api/send-welcome.post.ts]
  import renderWelcome from '#vitehub/emails/welcome'
  import { renderEmailMarkdown } from 'vite-hub/email/markdown'
  import { email } from 'vite-hub/email/server'

  export async function sendWelcome(name: string, to: string) {
    const markdown = await renderWelcome({ user: { name } })
    const body = await renderEmailMarkdown(markdown)

    const [error, sent] = await email.send({
      ...body,
      from: 'verified-sender@example.com',
      to,
      subject: 'Your workspace is ready',
    })
    if (error) throw error
    return sent
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

  ```ts [server/api/feedback.post.ts]
  import { defineEventHandler } from 'h3'
  import { email } from 'vite-hub/email/server'

  // Send a plain text email
  export default defineEventHandler(async () => {
    return email.send({
      from: 'hello@example.com',
      to: 'team@example.com',
      subject: 'New feedback',
      text: 'Someone sent feedback.',
    })
  })
  ```

  ```md [server/emails/welcome.md]
  # Welcome {{ data.user.name }}

  Your account is ready.
  ```

  ```ts [server/api/welcome.post.ts]
  import { defineEventHandler } from 'h3'
  import renderWelcome from '#vitehub/emails/welcome'
  import {
    renderEmailMarkdown,
  } from 'vite-hub/email/markdown'
  import { email } from 'vite-hub/email/server'

  export default defineEventHandler(async () => {
    // Fill the template, then make HTML and text
    const markdown = await renderWelcome({
      user: { name: 'Ada' },
    })
    const body = await renderEmailMarkdown(markdown)

    return email.send({
      ...body,
      from: 'hello@example.com',
      to: 'ada@example.com',
      subject: 'Your account is ready',
    })
  })
  ```

  ```ts [test/welcome.test.ts]
  import { expect, it } from 'vitest'
  import { createTestEmail } from '@vite-hub/email/test'

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
  :::
::

::product-features
  :::product-feature-item{title="Pick a provider in one place" icon="i-lucide-sliders-horizontal" to="/docs/email/configure#configure-vite"}
  Choose Resend or Cloudflare Email in your Vite config. Your routes do not change.
  :::

  :::product-feature-item{title="Keys stay out of your code" icon="i-lucide-shield-check" to="/docs/email/get-started#provide-the-resend-secret"}
  The API key comes from a server environment variable when the server sends.
  :::

  :::product-feature-item{title="Write emails in Markdown" icon="i-lucide-files" to="/docs/email/server-api#compose-dynamic-markdown"}
  Files in `server/emails` become typed imports. Fill them with data to get HTML and text.
  :::

  :::product-feature-item{title="See each email while you develop" icon="i-lucide-inbox" to="/docs/email/hosts#development-outbox"}
  In `vite dev`, an outbox keeps a copy of each email. Set `deliver: false` to skip the real send.
  :::

  :::product-feature-item{title="Test without sending" icon="i-lucide-flask-conical" to="/docs/email/server-api#test-without-delivery"}
  `createTestEmail()` keeps messages in memory, so your tests can check them.
  :::

  :::product-feature-item{title="Clear errors, no double sends" icon="i-lucide-circle-alert" to="/docs/email/limits-and-errors#handle-delivery-errors"}
  Each failure has an `EMAIL_*` code. Email does not retry, so a message is not sent twice by mistake.
  :::
::
