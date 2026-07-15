---
title: Email
description: Send outbound transactional email through a provider-neutral driver contract, with Dynamic Markdown composition and safe test capture.
navigation.order: 14
icon: i-lucide-mail
---

Email sends outbound transactional messages through one stable Runtime Helper. ViteHub owns the portable message, result, error, Definition, and driver boundaries, while delivery providers and SMTP servers stay behind an `EmailDriver`.

The first release does not own queues, retries, scheduling, provider templates, inbound email, webhooks, suppression lists, or tracking. Compose those workflows with Queue, Schedule, Workflow, and provider-specific services when the application needs them.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/email nodemailer
```

Nodemailer is only required for the Node.js SMTP driver. A custom `EmailDriver` can target another provider or host runtime without Nodemailer.

### Configure

```ts [vite.config.ts]
import { hubEmail } from '@vite-hub/email/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEmail()],
})
```

The ViteHub preset keeps Email opt-in:

```ts [vite.config.ts]
import { vitehub } from '@vite-hub/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ email: true })],
})
```

### Define the driver

```ts [server/email.ts]
import { defineEmail } from '@vite-hub/email'
import { smtp } from '@vite-hub/email/drivers/smtp'

const smtpURL = process.env.SMTP_URL
if (!smtpURL) throw new Error('SMTP_URL is required')

export default defineEmail({
  driver: smtp(smtpURL),
})
```

### Send a message

```ts [server/api/welcome.post.ts]
import { email } from '@vite-hub/email'

export default defineEventHandler(async () => {
  return await email.send({
    from: 'hello@example.com',
    to: 'maxi@example.com',
    subject: 'Welcome',
    text: 'Welcome to ViteHub.',
  })
})
```

A successful send returns `{ id, driver }`. The ID comes from the delivery provider, and `driver` identifies the active driver.

::

## Public imports

| Import | Use |
| --- | --- |
| `email`, `createEmail`, `defineEmail`, and `EmailError` from `@vite-hub/email` | Send through the discovered Definition, create an explicit client, declare the singleton Definition, and handle normalized failures. |
| `smtp` from `@vite-hub/email/drivers/smtp` | Send through a Nodemailer SMTP transport on Node.js. |
| `renderEmailMarkdown` from `@vite-hub/email/markdown` | Compose Dynamic Markdown and return `{ html, text }` message bodies. |
| `createTestEmail` and `createMemoryEmailDriver` from `@vite-hub/email/test` | Capture messages in an isolated in-memory mailbox. |
| `hubEmail` from `@vite-hub/email/vite` | Discover and bind the singleton Email Definition. |

## Message contract

`email.send()` and explicit clients accept `EmailMessage`.

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One or more recipients. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | Optional portable address fields. |
| `subject` | `string` | Yes | Must be non-empty. |
| `html`, `text` | `string` | One | At least one non-empty body is required. |
| `headers` | `Record<string, string>` | No | Provider-neutral custom headers. |
| `attachments` | `EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a filename, optional content type, content disposition, and CID. |

The core validates portable structure but does not parse mailbox syntax. Delivery providers retain ownership of address validation, SMTP envelope rules, size limits, and content policies.

## Compose Dynamic Markdown

`renderEmailMarkdown()` first calls `renderMarkdownTemplate()`, then parses the composed Markdown with Comark and renders HTML.

```ts [server/welcome.ts]
import { email } from '@vite-hub/email'
import { renderEmailMarkdown } from '@vite-hub/email/markdown'

export async function sendWelcome(name: string, to: string) {
  const body = await renderEmailMarkdown([
    '# Welcome {{ user.name }}',
    '',
    'Your **ViteHub** workspace is ready.',
  ].join('\n'), {
    data: { user: { name } },
  })

  return await email.send({
    ...body,
    from: 'hello@example.com',
    to,
    subject: 'Your workspace is ready',
  })
}
```

`html` contains the rendered HTML. `text` contains the fully composed Markdown, which gives text clients a readable fallback while preserving one deterministic composition policy. Supply your own `text` when the application requires a marker-free plain-text style.

Template imports remain caller-resolved. The Email Package does not read files or URLs implicitly.

## Use SMTP

The SMTP driver accepts a connection URL or Nodemailer SMTP options.

```ts [server/email.ts]
import { defineEmail } from '@vite-hub/email'
import { smtp } from '@vite-hub/email/drivers/smtp'

export default defineEmail({
  driver: smtp({
    host: process.env.SMTP_HOST,
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  }),
})
```

SMTP is a Node.js adapter, not the core portability boundary. Keep credentials in Server Env or the deployment platform's secret store, and do not put them in Vite Integration options.

## Bring another provider

Implement `EmailDriver` when a provider has an HTTP API or a host-native email binding. This example targets an HTTP endpoint that accepts the portable `EmailMessage` body and returns `{ id }`.

```ts [server/email.ts]
import { defineEmail, type EmailDriver, type EmailMessage } from '@vite-hub/email'

const endpoint = process.env.EMAIL_API_URL
const token = process.env.EMAIL_API_TOKEN
if (!endpoint || !token) throw new Error('EMAIL_API_URL and EMAIL_API_TOKEN are required')

async function send(message: EmailMessage): Promise<{ id: string }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
  })
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`)

  const result = await response.json() as { id?: unknown }
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Email provider returned an invalid message id')
  }
  return { id: result.id }
}

const driver = {
  name: 'http',
  send,
} satisfies EmailDriver

export default defineEmail({ driver })
```

The driver returns one stable message ID. Keep provider metadata and SDK types inside the adapter unless the portable contract promotes them later.

## Test without delivering

```ts [welcome.test.ts]
import { expect, it } from 'vitest'
import { createTestEmail } from '@vite-hub/email/test'

it('sends the welcome message', async () => {
  const mail = createTestEmail()
  await mail.send({
    from: 'hello@example.com',
    to: 'maxi@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })

  expect(mail.messages[0]?.subject).toBe('Welcome')
})
```

Each test client owns an isolated mailbox. Captured messages are copied before storage, delivery order is stable, and `clear()` resets the mailbox and deterministic IDs.

## Errors

`EmailError.code` is one of:

| Code | Meaning |
| --- | --- |
| `invalid-message` | The portable message is missing a required address, subject, body, or valid in-memory attachment. |
| `not-configured` | `email.send()` ran without a discovered Email Definition. |
| `authentication` | The driver rejected delivery credentials. |
| `rate-limit` | The provider reported throttling or a rate limit. |
| `timeout` | Delivery timed out. |
| `network` | The driver could not reach its provider. |
| `provider` | Delivery failed outside the more specific portable categories. |

The error preserves `cause` and `driver` for server-side diagnostics. Do not expose raw provider errors to clients because they can contain recipient data or provider details.

## Vite Integration options

`hubEmail({ projectRoot })` changes the project root used to discover `server/email.ts` or `server.email.ts`. Only one Email Definition is allowed.

The integration binds a virtual definition module and marks the package for server bundling. It does not serialize drivers, generate provider output, or move credentials into Vite config.

## Next steps

- Use [Queue](/docs/server-primitives/queue) when a request should return before email delivery completes.
- Use [Schedule](/docs/server-primitives/schedule) or [Workflows](/docs/server-primitives/workflows) for recurring or durable delivery orchestration.
- Use [Env](/docs/server-primitives/env) for typed server credentials.
- Check [File conventions](/docs/reference/file-conventions) and [Errors and diagnostics](/docs/reference/errors-diagnostics) for the package reference paths.
