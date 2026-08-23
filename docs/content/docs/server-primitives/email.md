---
title: Email
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 14
icon: i-lucide-mail
---

Use Email to send transactional messages from server code through any Unemail driver. ViteHub configures the driver, normalizes delivery errors, renders trusted Markdown templates, and provides an in-memory test client.

## Before you begin

The quick start takes about ten minutes and sends a real message through Resend. You need:

- Node.js 24.15 or later and an existing Vite 8 or later server application.
- pnpm and a POSIX-compatible shell for the commands below.
- A Resend API key and a sender address accepted by Resend.
- A real recipient address you can check.

## Send your first message

::steps{level="3"}

### Install the email dependencies

```bash [Terminal]
pnpm add vite-hub
```

`vite-hub` includes Email runtime support and composes providers from Unemail.

### Configure Resend

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'unemail/driver/resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
    },
  })],
})
```

The driver subpath selects the upstream Unemail provider. The Env declaration is serialized, but its source value is resolved in the server runtime for every send, so the API key stays out of build output and request-scoped Cloudflare secrets stay current. Literal options and non-secret Env defaults are serialized into the build; never use literal options for credentials, and ViteHub rejects defaults on declarations marked secret.

### Provide the Resend secret

Set `RESEND_API_KEY` in the server process:

```bash [Terminal]
export RESEND_API_KEY='re_...'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

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
| `email.send(message)` | A Vite app configures one Unemail provider through `vitehub({ email: { driver, options } })`. |
| `createEmail({ driver })` | Low-level integrations that do not use Vite create and own a client explicitly. |
| `createTestEmail()` | A test needs deterministic in-memory capture without delivery. |

## Public imports

Use the `vite-hub` paths for framework APIs. Select providers through an `unemail/driver/*` subpath string in Vite config.

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `createEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailMessage`, `EmailDriver`, `EmailDriverFactory`, `EmailDriverSource`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `vite-hub/runtime` | `ViteHubError`, `getViteHubErrorShape` | Shared operational error contract. |
| `vite-hub/email/server` | `email` | None |
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

`EmailAttachment` also accepts optional `contentType`, `cid`, and `disposition: 'attachment' | 'inline'`. `EmailMessage` includes Unemail's scheduling, provider-template, tagging, tracking, unsubscribe, sandbox, metadata, and personalization fields.

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

### Discover application email templates

Put reusable templates under `server/emails`. ViteHub discovers Markdown files
recursively and creates a typed `#vitehub/emails/<name>` import from each path.

```md [server/emails/welcome.md]
# Welcome {{ user.name }}

Your workspace is ready.
```

```ts [server/welcome.ts]
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

`server/emails/monthly/recap.md` becomes
`#vitehub/emails/monthly/recap`. ViteHub generates exact module declarations in
`.vitehub/types/email.d.ts` and bundles the templates for provider builds under
`.vitehub/email/templates`.

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `data` | `Record<string, unknown>` | `{}` | Supplies scalar bindings, Markdown fragments, and conditional values. |
| `resolveImport` | `RenderEmailMarkdownOptions['resolveImport']` | None | Resolves relative imports synchronously or asynchronously. Return `{ id, template }`, or `undefined` when an import is unavailable. No files or URLs are read without it. |
| `sourceId` | `string` | `'<template>'` | Identifies the root template to the import resolver and cycle detector. |
| `maxImportDepth` | `number` | `4` | Limits nested imports. It must be a non-negative integer. |

::warning
`renderEmailMarkdown()` does not sanitize authored HTML, trusted Markdown fragments, or imported templates, and it does not inline email CSS. Use scalar `{{ value }}` bindings for untrusted text. Sanitize any untrusted content before intentionally passing it through a `{{{ fragment }}}` binding or an imported template.
::

## Provider behavior for Resend

Use the quick-start `vitehub({ email: { driver: 'unemail/driver/resend', options } })` configuration. A successful result has `driver: 'resend'`. ViteHub maps Unemail errors to `EMAIL_*` codes and keeps the original error in `cause`.

## Configure another provider

Set `email.driver` to another `unemail/driver/*` subpath and declare its serializable options in the same Vite config. Keep credentials in Server Env or the deployment platform's secret store, and pass them as Env declarations without defaults. When Unemail does not support a provider, add the driver upstream with its `defineDriver()` contract so every consumer benefits instead of adding a ViteHub-only adapter.

## Test without delivery

The framework distribution does not re-export test utilities. Install the Email
owner package as a development dependency when tests use its in-memory client.

```bash [Terminal]
pnpm add -D @vite-hub/email
```

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

Use `createMemoryEmailDriver()` when another client or test harness needs to manage the in-memory driver directly.

## Handle delivery errors

Use the `EMAIL_*` code for control flow and `details.driver` to identify the failing adapter. ViteHub keeps the original Unemail error in `cause` while exposing a safe public message.

```ts [server/send.ts]
import { getViteHubErrorShape } from 'vite-hub/runtime'
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
| `EMAIL_NOT_CONFIGURED` | Runtime configuration or Unemail `INVALID_OPTIONS` | The provider or required driver options are missing. | Fix configuration; do not retry unchanged. |
| `EMAIL_AUTHENTICATION` | Unemail `AUTH` | Delivery credentials were rejected. | Fix credentials before retrying. |
| `EMAIL_RATE_LIMITED` | Unemail `RATE_LIMIT` | The provider reported throttling. | Apply an application-owned retry policy. |
| `EMAIL_TIMEOUT` | Unemail `TIMEOUT` | Delivery did not complete before the transport timeout. | Treat the outcome as uncertain before retrying. |
| `EMAIL_NETWORK` | Unemail `NETWORK` | The driver could not reach its provider. | Treat the outcome as uncertain before retrying. |
| `EMAIL_PROVIDER_FAILED` | Unemail `PROVIDER`, `UNSUPPORTED`, or `CANCELLED`; invalid success results | Delivery failed outside a more specific category. | Inspect protected diagnostics and provider delivery logs. |

Provider-specific classification and retry metadata come from Unemail. ViteHub only maps its stable generic codes and validates that a successful result includes a non-empty message ID.

The package does not retry automatically. A timeout or disconnected response can occur after a provider accepted the message, so a blind retry can send a duplicate. Put retry and idempotency policy in Queue, Workflow, or the provider adapter that has enough information to make that decision.

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
      driver: 'unemail/driver/resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
    },
  })],
})
```

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `driver` | `` `unemail/driver/${string}` `` | Required | Selects one upstream Unemail driver through its exact package subpath. |
| `options` | `EnvRuntimeConfigOptions` | `{}` | Supplies serializable non-secret literals and runtime Env declarations. Env source values resolve in the server runtime for every send; literals and non-secret defaults are included in build output, while defaults on secret declarations are rejected. |

The integration serializes the driver subpath, literal options, and Env declarations into a server-only generated module. Credential values remain in the runtime environment when they are supplied through an Env source without a default.

## Troubleshoot common failures

### `No Email provider is configured`

Configure `vitehub({ email: { driver, options } })`. Applications using the owner integration directly configure `hubEmail({ driver, options })`. Restart the development server, then call `email.send()` again.

### `Email delivery failed through <driver>.`

Read the `EMAIL_*` code first. For `EMAIL_AUTHENTICATION`, verify the provider credentials and sender authorization. For `EMAIL_NETWORK` or `EMAIL_TIMEOUT`, verify DNS and outbound connectivity from the deployed server. Inspect `cause` and provider logs only on the server.

## Requirements

- `vite-hub/email` requires Node.js 24.15 or later. The direct `@vite-hub/email` package requires Node.js 24 or later.
- Email provider configuration requires Vite 8 or later; explicit `createEmail()` clients do not require Vite.
- Provider runtime support comes from the selected Unemail driver.

ViteHub does not independently certify provider behavior. ViteHub owns provider composition, runtime delivery, normalized errors, dynamic Markdown composition, and test capture. Unemail owns provider drivers, message features, and transport behavior; Queue, Workflow, and Schedule remain the orchestration layer.

## Expose Email to an Agent

Use the official [`email()` Capability](/docs/capabilities/email) when a model needs to send through the configured Email provider.
The Capability fixes the sender in application code and exposes one plain-text `email_send` tool with optional policy; provider configuration and credentials stay in this primitive.

Dynamic Markdown remains an application composition boundary.
The official Capability doesn't render model-authored Markdown or expose HTML, headers, and attachments. Use a trusted application template or a narrowly scoped Custom Capability for richer messages.

## Next steps

- Use [Queue](/docs/server-primitives/queue) when a request must return before email delivery completes.
- Use [Schedule](/docs/server-primitives/schedule) or [Workflows](/docs/server-primitives/workflows) for recurring or durable delivery orchestration.
- Use [Env](/docs/server-primitives/env) for typed server credentials.
- Check [Errors and diagnostics](/docs/reference/errors-diagnostics) for the shared error contract.
