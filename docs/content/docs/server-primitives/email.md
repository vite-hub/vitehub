---
title: Email
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 14
icon: i-lucide-mail
---

Email sends outbound transactional messages through one stable Runtime Helper. Unemail owns the message and driver contracts, while ViteHub owns Definition discovery, runtime access, normalized errors, Markdown composition, and deterministic test capture.

The examples below use the canonical `vite-hub` application imports and provider drivers from `unemail`.

## Before you begin

The quick start takes about ten minutes and sends a real message through Resend. You need:

- Node.js 24 or later and an existing Vite 8 or later server application.
- pnpm and a POSIX-compatible shell for the commands below.
- A Resend API key and a sender address accepted by Resend.
- A real recipient address you can check.

Install the Unemail driver package explicitly so the provider choice stays visible in the application.

## Send your first message

::steps{level="3"}

### Install the email dependencies

```bash [Terminal]
pnpm add vite-hub unemail
```

`vite-hub` provides Email discovery and runtime imports. `unemail` provides Resend, SMTP, SES, Postmark, Mailgun, SendGrid, Cloudflare Email, and other delivery drivers.

### Register Email discovery

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", email: true })],
})
```

### Provide the Resend secret

Set `RESEND_API_KEY` in the server process:

```bash [Terminal]
export RESEND_API_KEY='re_...'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

### Define the delivery driver

```ts [server/email.ts]
import { defineEmail } from 'vite-hub/email'
import resend from 'unemail/driver/resend'

export default defineEmail({
  driver: () => resend({ apiKey: process.env.RESEND_API_KEY ?? '' }),
})
```

### Send from server code

Replace both addresses with values accepted by Resend. The request performs a real delivery.

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
  "driver": "resend"
}
```

Resend supplies `id`. Confirm delivery in the recipient inbox or the provider's delivery log; an accepted message ID does not guarantee final inbox placement.

::

## Choose the client surface

| Surface | Use it when |
| --- | --- |
| `email.send(message)` | A Vite app discovers one Email Definition through `vitehub({ preset: "node", email: true })`. |
| `createEmail({ driver })` | A server integration creates and owns the driver explicitly. Vite discovery is not required. |
| `createTestEmail()` | A test needs deterministic in-memory capture without delivery. |

## Public imports

Applications should use the canonical `vite-hub` paths for framework APIs and import provider drivers directly from `unemail`.

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `createEmail`, `defineEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailMessage`, `EmailDriver`, `EmailDriverFactory`, `EmailDriverSource`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `@vite-hub/runtime` | `ViteHubError`, `getViteHubErrorShape` | Shared operational error contract. |
| `vite-hub/email/server` | `email` | — |
| `vite-hub/email/markdown` | `renderEmailMarkdown` | `RenderEmailMarkdownOptions`, `RenderedEmailMarkdown` |
| `unemail/driver/*` | Provider drivers | Provider options and capabilities are owned by Unemail. |
| `@vite-hub/email/test` | `createTestEmail`, `createMemoryEmailDriver` | `TestEmailClient`, `MemoryEmailDriver` |
| `@vite-hub/email/vite` | `hubEmail` | `EmailVitePluginOptions`, `EmailVitePlugin`, `EmailVitePluginAPI` |

The direct `@vite-hub/email`, `@vite-hub/email/server`, and `@vite-hub/email/markdown` paths remain stable for focused libraries and applications that install the owner package without the framework distribution.

## Message contract

`email.send()` and explicit clients accept Unemail's `EmailMessage`.

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One address or a non-empty address array. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | Optional portable recipient fields. |
| `subject` | `string` | Yes | The message subject. |
| `html`, `text` | `string` | No | Body alternatives supported by the active driver. |
| `headers` | `Record<string, string>` | No | Custom headers supported by the active driver. |
| `attachments` | `readonly EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a non-empty filename. |

`EmailAttachment` also accepts optional `contentType`, `cid`, and `disposition: 'attachment' | 'inline'`. `EmailMessage` additionally exposes Unemail's scheduling, provider-template, tagging, tracking, unsubscribe, sandbox, metadata, and personalization fields.

The active Unemail driver owns field support, validation, address rules, message limits, and sender authorization. Check its `flags` and provider documentation before using optional fields.

Every successful send returns `Promise<EmailSendResult>`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | The non-empty message ID returned by the driver. |
| `driver` | `string` | The Unemail driver that accepted the message. |

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

## Configure Resend

Import Resend directly from Unemail. Keep the ViteHub driver factory lazy so request-scoped Worker bindings are read for every send instead of being captured in module state.

```ts [server/email.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineEmail } from 'vite-hub/email'
import resend from 'unemail/driver/resend'

export default defineEmail({
  driver: () => resend({ apiKey: useServerEnv().resendApiKey.unseal() }),
})
```

Declare `resendApiKey` as secret Server Env sourced from `RESEND_API_KEY`, or return a credential from another server-only secret store. A successful result has `driver: 'resend'`. ViteHub maps Unemail's generic error taxonomy to stable `EMAIL_*` codes and keeps the original Unemail error in `cause`.

## Configure SMTP

Unemail's SMTP driver has no Nodemailer dependency. Validate required environment values before constructing its options so a missing credential cannot silently become a different connection attempt.

```ts [server/email.ts]
import { defineEmail } from 'vite-hub/email'
import smtp from 'unemail/driver/smtp'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export default defineEmail({
  driver: () => smtp({
    host: requiredEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: requiredEnv('SMTP_USER'),
    password: requiredEnv('SMTP_PASSWORD'),
  }),
})
```

Keep credentials in Server Env or the deployment platform's secret store, and never put them in Vite Integration options.

## Implement another provider

Use any driver exported by `unemail/driver/*`, then pass it directly or through a lazy factory to `defineEmail()`. When Unemail does not yet support a provider, add the driver upstream with Unemail's `defineDriver()` contract so every consumer benefits instead of adding a ViteHub-only adapter.

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

Use the `EMAIL_*` code for control flow and `details.driver` to identify the failing adapter. ViteHub keeps the original Unemail error in `cause` while exposing a safe public message.

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
| `EMAIL_NOT_CONFIGURED` | Runtime discovery or Unemail `INVALID_OPTIONS` | The Definition or required driver options are missing. | Fix configuration; do not retry unchanged. |
| `EMAIL_AUTHENTICATION` | Unemail `AUTH` | Delivery credentials were rejected. | Fix credentials before retrying. |
| `EMAIL_RATE_LIMITED` | Unemail `RATE_LIMIT` | The provider reported throttling. | Apply an application-owned retry policy. |
| `EMAIL_TIMEOUT` | Unemail `TIMEOUT` | Delivery did not complete before the transport timeout. | Treat the outcome as uncertain before retrying. |
| `EMAIL_NETWORK` | Unemail `NETWORK` | The driver could not reach its provider. | Treat the outcome as uncertain before retrying. |
| `EMAIL_PROVIDER_FAILED` | Unemail `PROVIDER`, `UNSUPPORTED`, or `CANCELLED`; invalid success results | Delivery failed outside a more specific category. | Inspect protected diagnostics and provider delivery logs. |

Provider-specific classification and retry metadata come from Unemail. ViteHub only maps its stable generic codes and validates that a successful result includes a non-empty message ID.

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

### `Email delivery failed through <driver>.`

Read the `EMAIL_*` code first. For `EMAIL_AUTHENTICATION`, verify the provider credentials and sender authorization. For `EMAIL_NETWORK` or `EMAIL_TIMEOUT`, verify DNS and outbound connectivity from the deployed server. Inspect `cause` and provider logs only on the server.

## Compatibility and scope

- `vite-hub/email` and its `@vite-hub/email` owner package currently require Node.js 24 or later.
- Email Definition discovery requires Vite 8 or later; explicit `createEmail()` clients do not require Vite.
- Provider runtime support comes from the selected Unemail driver.

ViteHub does not independently certify provider behavior. ViteHub owns discovery, runtime delivery, normalized errors, dynamic Markdown composition, and test capture. Unemail owns provider drivers, message features, and transport behavior; Queue, Workflow, and Schedule remain the orchestration layer.

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
