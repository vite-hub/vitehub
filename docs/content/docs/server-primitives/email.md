---
title: Email
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 14
icon: i-lucide-mail
---

Email sends outbound transactional messages through one stable Runtime Helper. ViteHub owns the portable message, result, error, Definition, and driver boundaries, while the Email Definition owns the active delivery provider and its server-only credentials.

The examples below use the canonical `vite-hub` application imports. SMTP, test utilities, and direct Vite Integration control remain explicit `@vite-hub/email` owner-package imports.

## Before you begin

The quick start takes about ten minutes and sends a real message through an SMTP server. You need:

- Node.js 24 or later and an existing Vite 8 or later server application.
- pnpm and a POSIX-compatible shell for the commands below.
- An SMTP connection URL and a sender address accepted by that server.
- A real recipient address you can check.

Nodemailer is required only for the SMTP driver. `createEmail()` can use a custom driver without Vite or Nodemailer, but this package still requires Node.js 24 or later in its current release.

## Send your first message

::steps{level="3"}

### Install the SMTP dependencies

```bash [Terminal]
pnpm add vite-hub @vite-hub/email nodemailer
```

`vite-hub` provides the framework and provider-neutral Email imports. Install `@vite-hub/email` directly as well because the SMTP adapter is intentionally available only from its owner package.

### Register Email discovery

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", email: true })],
})
```

### Provide the SMTP secret

Set `SMTP_URL` in the server process. Replace every uppercase placeholder with credentials from your SMTP provider:

```bash [Terminal]
export SMTP_URL='smtps://USERNAME:PASSWORD@smtp.example.com:465'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

### Define the delivery driver

```ts [server/email.ts]
import { smtp } from '@vite-hub/email/drivers/smtp'
import { defineEmail } from 'vite-hub/email'

const smtpURL = process.env.SMTP_URL
if (!smtpURL) throw new Error('SMTP_URL is required')

export default defineEmail({
  driver: smtp(smtpURL),
})
```

### Send from server code

Replace both addresses with values accepted by your SMTP provider. The request performs a real delivery.

```ts [server/api/welcome.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email/server'

export default defineEventHandler(async () => {
  return await email.send({
    from: 'verified-sender@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Welcome to ViteHub.',
  })
})
```

### Verify the result

Start the application with its normal development command and send a `POST` request to `/api/welcome`. A successful response has this shape:

```json
{
  "id": "<provider-message-id>",
  "driver": "smtp"
}
```

The SMTP server supplies `id`. Confirm delivery in the recipient inbox or the provider's delivery log; an accepted message ID does not guarantee final inbox placement.

::

## Choose the client surface

| Surface | Use it when |
| --- | --- |
| `email.send(message)` | A Vite app discovers one Email Definition through `vitehub({ preset: "node", email: true })`. |
| `createEmail({ driver })` | A server integration creates and owns the driver explicitly. Vite discovery is not required. |
| `createTestEmail()` | A test needs production message validation and deterministic in-memory capture without delivery. |

## Public imports

Applications should use the canonical `vite-hub` paths for framework and provider-neutral APIs. Provider adapters, test utilities, and direct integration control stay on the owner package so those dependencies remain explicit.

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `createEmail`, `defineEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailMessage`, `EmailDriver`, `EmailDriverResult`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `@vite-hub/runtime` | `ViteHubError`, `getViteHubErrorShape` | Shared operational error contract. |
| `vite-hub/email/server` | `email` | — |
| `vite-hub/email/markdown` | `renderEmailMarkdown` | `RenderEmailMarkdownOptions`, `RenderedEmailMarkdown` |
| `@vite-hub/email/drivers/smtp` | `smtp` | Nodemailer owns the accepted SMTP option types. |
| `@vite-hub/email/test` | `createTestEmail`, `createMemoryEmailDriver` | `TestEmailClient`, `MemoryEmailDriver` |
| `@vite-hub/email/vite` | `hubEmail` | `EmailVitePluginOptions`, `EmailVitePlugin`, `EmailVitePluginAPI` |

The direct `@vite-hub/email`, `@vite-hub/email/server`, and `@vite-hub/email/markdown` paths remain stable for focused libraries and applications that install the owner package without the framework distribution.

## Message contract

`email.send()` and explicit clients accept `EmailMessage`.

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One address or a non-empty address array. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | Optional portable recipient fields. |
| `subject` | `string` | Yes | Must be non-empty after trimming. |
| `html`, `text` | `string` | At least one | At least one body must be non-empty after trimming. |
| `headers` | `Readonly<Record<string, string>>` | No | Provider-neutral custom headers with string values. |
| `attachments` | `readonly EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a non-empty filename. |

`EmailAttachment` also accepts optional `contentType`, `cid`, and `contentDisposition: 'attachment' | 'inline'`. The package does not read attachment paths or URLs.

The core validates portable structure but does not parse mailbox syntax. Delivery providers retain ownership of address validation, SMTP envelope rules, message size, accepted content, and sender authorization.

Every successful send returns `Promise<EmailSendResult>`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | The non-empty message ID returned by the driver. |
| `driver` | `string` | The active `EmailDriver.name`. |

## Compose dynamic Markdown

`renderEmailMarkdown()` first composes the template through `@vite-hub/markdown-template`, then parses the composed Markdown with Comark and renders HTML.

```ts [server/welcome.ts]
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email/server'

export async function sendWelcome(name: string, to: string) {
  const body = await renderEmailMarkdown([
    '# Welcome {{ user.name }}',
    '',
    'Your **ViteHub** workspace is ready.',
    '',
    '::if{user.trial}',
    'Your trial is active.',
    '::',
  ].join('\n'), {
    data: { user: { name, trial: true } },
  })

  return await email.send({
    ...body,
    from: 'verified-sender@example.com',
    to,
    subject: 'Your workspace is ready',
  })
}
```

`html` contains rendered HTML. `text` contains the fully composed Markdown, which is readable in text clients but can retain Markdown markers such as `**`. Supply your own `text` when the application requires marker-free plain text.

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `data` | `Record<string, unknown>` | `{}` | Supplies scalar bindings, Markdown fragments, and conditional values. |
| `resolveImport` | `RenderEmailMarkdownOptions['resolveImport']` | None | Resolves relative imports synchronously or asynchronously. Return `{ id, template }`, or `undefined` when an import is unavailable. No files or URLs are read without it. |
| `sourceId` | `string` | `'<template>'` | Identifies the root template to the import resolver and cycle detector. |
| `maxImportDepth` | `number` | `4` | Limits nested imports. It must be a non-negative integer. |

::warning
`renderEmailMarkdown()` does not sanitize authored HTML, trusted Markdown fragments, or imported templates, and it does not inline email CSS. Use scalar `{{ value }}` bindings for untrusted text. Sanitize any untrusted content before intentionally passing it through a `{{{ fragment }}}` binding or an imported template.
::

## Configure SMTP

The SMTP driver accepts a connection URL or Nodemailer SMTP options. Validate required environment values before constructing an option object so a missing credential cannot silently become a different connection attempt.

```ts [server/email.ts]
import { smtp } from '@vite-hub/email/drivers/smtp'
import { defineEmail } from 'vite-hub/email'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export default defineEmail({
  driver: smtp({
    host: requiredEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: requiredEnv('SMTP_USER'),
      pass: requiredEnv('SMTP_PASSWORD'),
    },
  }),
})
```

SMTP is a Node.js adapter, not the provider-neutral contract. Keep credentials in Server Env or the deployment platform's secret store, and never put them in Vite Integration options.

## Implement another provider

An `EmailDriver` has a non-empty `name` and one `send(message)` method that resolves to `{ id }`. The example below assumes an application-owned HTTP endpoint that accepts `EmailMessage`; adapt the request and response mapping to your provider's actual API.

```ts [server/email.ts]
import { ViteHubError } from '@vite-hub/runtime'
import { defineEmail, type EmailDriver, type EmailMessage } from 'vite-hub/email'

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

  if (response.status === 401) {
    throw new ViteHubError('EMAIL_AUTHENTICATION', '[vitehub] Email provider rejected its credentials.', {
      details: { driver: 'http' },
    })
  }
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`)

  const result = await response.json() as { id?: unknown }
  if (typeof result.id !== 'string' || result.id.trim().length === 0) {
    throw new Error('Email provider returned an invalid message id')
  }
  return { id: result.id }
}

const driver = { name: 'http', send } satisfies EmailDriver

export default defineEmail({ driver })
```

`createEmail()` preserves a ViteHub error with an `EMAIL_*` code thrown by a driver. A custom driver must give that error a safe public message and put the raw provider failure in `cause` when protected diagnostics need it. Any other thrown value becomes `EMAIL_PROVIDER_FAILED`, and an empty driver message ID also becomes a provider failure. Keep provider SDK types and response payloads inside the adapter.

## Test without delivery

```ts [welcome.test.ts]
import { expect, it } from 'vitest'
import { createTestEmail } from '@vite-hub/email/test'

it('sends the welcome message', async () => {
  const mail = createTestEmail()

  await expect(mail.send({
    from: 'hello@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })).resolves.toEqual({ driver: 'memory', id: 'memory-1' })

  expect(mail.messages[0]?.subject).toBe('Welcome')
})
```

Each test client owns an isolated mailbox. Captured messages are cloned before storage, delivery order is stable, and `clear()` empties the mailbox and resets the next ID to `memory-1`.

Use `createMemoryEmailDriver()` when another client or test harness should own the in-memory driver directly.

## Handle delivery errors

Use the `EMAIL_*` code for control flow and `details.driver` to identify the failing adapter. SMTP and core-wrapped provider failures keep the raw failure in `cause` and expose a safe message. A custom driver owns the same safety boundary when it throws `ViteHubError` directly.

```ts [server/send.ts]
import { getViteHubErrorShape } from '@vite-hub/runtime'
import { type EmailMessage } from 'vite-hub/email'
import { email } from 'vite-hub/email/server'

export async function send(message: EmailMessage) {
  try {
    return await email.send(message)
  }
  catch (error) {
    const shape = getViteHubErrorShape(error)
    if (shape?.code.startsWith('EMAIL_')) {
      console.error('Email delivery failed', {
        code: shape.code,
        driver: shape.details?.driver,
      })
    }
    throw error
  }
}
```

Inspect `cause` only in protected server-side diagnostics because provider errors can contain addresses, credentials, response text, or infrastructure details.

| Code | Produced by | Meaning | Retry guidance |
| --- | --- | --- | --- |
| `EMAIL_INVALID_MESSAGE` | Core client | A portable field, body, or attachment is invalid. | Fix the message; do not retry unchanged. |
| `EMAIL_NOT_CONFIGURED` | Discovered Runtime Helper | No Email Definition was discovered. | Fix discovery; do not retry unchanged. |
| `EMAIL_AUTHENTICATION` | SMTP or a custom driver | Delivery credentials were rejected. | Fix credentials before retrying. |
| `EMAIL_RATE_LIMITED` | SMTP or a custom driver | The provider reported throttling. | Apply an application-owned retry policy. |
| `EMAIL_TIMEOUT` | SMTP or a custom driver | Delivery did not complete before the transport timeout. | Treat the outcome as uncertain before retrying. |
| `EMAIL_NETWORK` | SMTP or a custom driver | The driver could not reach its provider. | Treat the outcome as uncertain before retrying. |
| `EMAIL_PROVIDER_FAILED` | Core client, SMTP, or a custom driver | Delivery failed outside a more specific portable category. | Inspect protected diagnostics and provider delivery logs. |

The core client itself produces `EMAIL_INVALID_MESSAGE` and `EMAIL_PROVIDER_FAILED`; the discovered Runtime Helper also produces `EMAIL_NOT_CONFIGURED`. SMTP maps common Nodemailer signals into the other codes. A custom driver should throw `ViteHubError` when it can classify a failure more precisely.

The package does not retry automatically. A timeout or disconnected response can occur after a provider accepted the message, so a blind retry can send a duplicate. Put retry and idempotency policy in Queue, Workflow, or the provider adapter that has enough information to make that decision.

## Configure Vite discovery

The ViteHub preset keeps Email opt-in:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", email: true })],
})
```

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `projectRoot` | `string` | Automatically detected from the Vite root | Changes where `server/email.ts` or `server.email.ts` is discovered. A relative value resolves from the Vite root. |

Only one Email Definition is allowed. The integration binds it through an internal virtual module and marks `@vite-hub/email` for server bundling. It does not serialize drivers, emit provider output, or move credentials into Vite config.

## Troubleshoot common failures

### `No Email Definition was discovered`

Verify that `vitehub({ preset: "node", email: true })` is registered and that exactly one `server/email.ts` or `server.email.ts` exists below the detected project root. Applications using the owner integration directly can register `hubEmail()` instead. If the Vite root is nested, register `vitehub({ preset: "node", email: { projectRoot } })` explicitly. Restart the development server, then call `email.send()` again.

### `Only one Email Definition is allowed`

The error lists every matching file. Remove or rename the duplicate so only one supported Email Definition remains, then restart the development server and confirm it starts without the discovery error.

### `SMTP delivery failed.`

Read the `EMAIL_*` code first. For `EMAIL_AUTHENTICATION`, verify the username, password, sender authorization, port, and TLS mode. For `EMAIL_NETWORK` or `EMAIL_TIMEOUT`, verify DNS and outbound connectivity from the deployed server. Inspect `cause` and provider logs only on the server, then send to a real verified recipient and confirm the provider records the message.

### `Email message must include non-empty html or text`

Inspect the final message after template composition and confirm that either `html` or `text` contains non-whitespace content. The client rejects the message before calling the driver, so the provider has not received it.

## Compatibility and scope

- `vite-hub/email` and its `@vite-hub/email` owner package currently require Node.js 24 or later.
- Email Definition discovery requires Vite 8 or later; explicit `createEmail()` clients do not require Vite.
- The bundled SMTP adapter requires Nodemailer 9 and Node.js.
- Provider-neutral means the core contract does not select a delivery provider. It does not claim support for arbitrary JavaScript runtimes in this release.

This release owns outbound transactional delivery, in-memory attachments, dynamic Markdown composition, and test capture. It does not own queues, retries, scheduling, provider templates, inbound email, webhooks, suppression lists, tracking, HTML sanitization, or CSS inlining.

## Expose Email to an Agent

Use the official [`email()` Capability](/docs/capabilities/email) when a model should send through the discovered Email Definition.
The Capability fixes the sender in application code and exposes one plain-text `email_send` tool with optional policy; provider configuration and credentials stay in this primitive.

Dynamic Markdown remains an application composition boundary.
The official Capability does not render model-authored Markdown or expose HTML, headers, and attachments, so richer messages should use a trusted application template or a narrowly scoped Custom Capability.

## Next steps

- Use [Queue](/docs/server-primitives/queue) when a request should return before email delivery completes.
- Use [Schedule](/docs/server-primitives/schedule) or [Workflows](/docs/server-primitives/workflows) for recurring or durable delivery orchestration.
- Use [Env](/docs/server-primitives/env) for typed server credentials.
- Check [File conventions](/docs/reference/file-conventions) and [Errors and diagnostics](/docs/reference/errors-diagnostics) for the shared reference paths.
