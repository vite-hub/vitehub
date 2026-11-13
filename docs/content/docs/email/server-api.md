---
title: Email server API
description: Send messages, compose dynamic Markdown, and capture email in tests from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

Import framework APIs from `vite-hub` paths. Pick `resend` or `cloudflare-email` in the Vite config.

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `email`, `createEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailMessage`, `EmailDriver`, `EmailDriverFactory`, `EmailDriverSource`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `vite-hub/runtime` | `Result`, `ResultError` | Shared `[error, data]` contract of runtime operations. |
| `vite-hub/email/markdown` | `renderEmailMarkdown` | `RenderEmailMarkdownOptions`, `RenderedEmailMarkdown` |
| `@vite-hub/email/drivers/*` | Programmatic provider drivers | Built-in Resend and Cloudflare Email drivers. |
| `@vite-hub/email/test` | `createTestEmail`, `createMemoryEmailDriver` | `TestEmailClient`, `MemoryEmailDriver` |
| `@vite-hub/email/vite` | `hubEmail`, `emailConsoleSection` | `EmailOptions`, `EmailOutboxOptions`, `EmailVitePlugin`, `EmailVitePluginAPI` |
| `@vite-hub/email/runtime/console` | `listEmailOutbox`, `getEmailOutboxMessage`, `clearEmailOutbox`, `readEmailOutboxConsoleRecords` | `EmailOutboxMessage`, `EmailOutboxList`, `EmailOutboxDelivery`, `EmailOutboxAttachment` |

The direct `@vite-hub/email` and `@vite-hub/email/markdown` paths remain stable for focused libraries and applications that install the owner package without the framework distribution.

## Message contract

`email.send()` and `createEmail()` clients take an `EmailMessage`.

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One address or a non-empty array. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | More recipients. |
| `subject` | `string` | Yes | The message subject. |
| `html`, `text` | `string` | No | Body versions that the driver supports. |
| `headers` | `Record<string, string>` | No | Custom headers that the driver supports. |
| `attachments` | `readonly EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a non-empty filename. |

`EmailAttachment` also takes optional `contentType`, `cid`, and `disposition: 'attachment' | 'inline'`. `EmailMessage` also has scheduling, provider-template, tagging, tracking, unsubscribe, sandbox, metadata, and personalization fields. Built-in drivers pass on only the fields their provider supports.

The driver decides field support, validation, address rules, message limits, and sender authorization. Check the driver reference and provider docs before you use optional fields.

`send()` returns `Promise<Result<EmailSendResult, EmailErrorCode>>`, an `[error, sent]` tuple. When `error` is set, read `error.code`, `error.why`, and `error.fix` ([Limits and errors](/docs/email/limits-and-errors)). On success, `sent` is an `EmailSendResult`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | The non-empty message ID returned by the driver. |
| `driver` | `string` | The driver that accepted the message. |

## Compose dynamic Markdown

`renderEmailMarkdown()` fills the template with `@vite-hub/markdown-template`, then parses the result with Comark and renders HTML.

```ts [server/welcome.ts]
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email'

export async function sendWelcome(name: string, to: string) {
  const body = await renderEmailMarkdown([
    '# Welcome {{ data.user.name }}',
    '',
    'Your **ViteHub** workspace is ready.',
    '',
    '::if{:condition="data.user.trial"}',
    'Your trial is active.',
    '::',
  ].join('\n'), {
    data: { user: { name, trial: true } },
  })

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

`html` is the rendered HTML. `text` is the filled Markdown. Text clients can read it, but it can keep Markdown markers such as `**`. Pass your own `text` when you need plain text without markers.

### Discover application email templates

Put templates under `server/emails`. ViteHub finds Markdown files in all
subfolders and creates a typed `#vitehub/emails/<name>` import for each.

```md [server/emails/welcome.md]
# Welcome {{ data.user.name }}

Your workspace is ready.
```

```ts [server/welcome.ts] fragment
import renderWelcome from '#vitehub/emails/welcome'
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email'

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

`server/emails/monthly/recap.md` becomes `#vitehub/emails/monthly/recap`.
ViteHub writes the module types to `.vitehub/types/email.d.ts` and bundles the
templates for builds under `.vitehub/email/templates`.

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `data` | `Record<string, unknown>` | `{}` | Scalar values, Markdown fragments, and values for conditions. |

::warning
`renderEmailMarkdown()` does not sanitize HTML you write or trusted Markdown fragments, and it does not inline email CSS. Use scalar `{{ data.value }}` bindings for untrusted text. Sanitize untrusted content before you pass it through a `:insert{:markdown="data.fragment"}` binding.
::

## Test without delivery

The framework distribution does not re-export test utilities. Keep the Email
owner package as a runtime dependency when tests use its in-memory client.

```bash [Terminal]
pnpm add @vite-hub/email
```

```ts [welcome.test.ts]
import { expect, it } from 'vitest'
import { createTestEmail } from 'vite-hub/email/test'

it('sends the welcome message', async () => {
  const mail = createTestEmail()

  await expect(mail.send({
    from: 'hello@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })).resolves.toEqual([undefined, { driver: 'memory', id: 'memory-1' }])

  expect(mail.messages[0]?.subject).toBe('Welcome')
})
```

Each test client has its own mailbox. It stores copies of messages in send order. `clear()` empties the mailbox and resets the next ID to `memory-1`.

Use `createMemoryEmailDriver()` when another client or test harness needs the in-memory driver directly.
