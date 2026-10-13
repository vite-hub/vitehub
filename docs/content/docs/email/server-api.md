---
title: Email server API
description: Send messages, compose dynamic Markdown, and capture email in tests from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

Use the `vite-hub` paths for framework APIs. Select `resend` or `cloudflare-email` in Vite config.

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `createEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailMessage`, `EmailDriver`, `EmailDriverFactory`, `EmailDriverSource`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `vite-hub/runtime` | `ViteHubError`, `getViteHubErrorShape` | Shared operational error contract. |
| `vite-hub/email/server` | `email` | None |
| `vite-hub/email/markdown` | `renderEmailMarkdown` | `RenderEmailMarkdownOptions`, `RenderedEmailMarkdown` |
| `@vite-hub/email/drivers/*` | Programmatic provider drivers | Built-in Resend and Cloudflare Email drivers. |
| `@vite-hub/email/test` | `createTestEmail`, `createMemoryEmailDriver` | `TestEmailClient`, `MemoryEmailDriver` |
| `@vite-hub/email/vite` | `hubEmail`, `emailConsoleSection` | `EmailVitePluginOptions`, `EmailOutboxOptions`, `EmailVitePlugin`, `EmailVitePluginAPI` |
| `@vite-hub/email/runtime/console` | `listEmailOutbox`, `getEmailOutboxMessage`, `clearEmailOutbox`, `readEmailOutboxConsoleRecords` | `EmailOutboxMessage`, `EmailOutboxList`, `EmailOutboxDelivery`, `EmailOutboxAttachment` |

The direct `@vite-hub/email`, `@vite-hub/email/server`, and `@vite-hub/email/markdown` paths remain stable for focused libraries and applications that install the owner package without the framework distribution.

## Message contract

`email.send()` and explicit clients accept ViteHub's portable `EmailMessage`.

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One address or a non-empty address array. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | Optional portable recipient fields. |
| `subject` | `string` | Yes | The message subject. |
| `html`, `text` | `string` | No | Body alternatives supported by the active driver. |
| `headers` | `Record<string, string>` | No | Custom headers supported by the active driver. |
| `attachments` | `readonly EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a non-empty filename. |

`EmailAttachment` also accepts optional `contentType`, `cid`, and `disposition: 'attachment' | 'inline'`. `EmailMessage` retains scheduling, provider-template, tagging, tracking, unsubscribe, sandbox, metadata, and personalization fields. Built-in drivers forward only the fields their provider supports.

The active driver owns field support, validation, address rules, message limits, and sender authorization. Check the ViteHub driver reference and provider documentation before using optional fields.

Every successful send returns `Promise<EmailSendResult>`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | The non-empty message ID returned by the driver. |
| `driver` | `string` | The provider driver that accepted the message. |

## Compose dynamic Markdown

`renderEmailMarkdown()` first composes the template through `@vite-hub/markdown-template`, then parses the composed Markdown with Comark and renders HTML.

```ts [server/welcome.ts]
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email/server'

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
# Welcome {{ data.user.name }}

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

::warning
`renderEmailMarkdown()` does not sanitize authored HTML or trusted Markdown fragments, and it does not inline email CSS. Use scalar `{{ data.value }}` bindings for untrusted text. Sanitize any untrusted content before intentionally passing it through a `:insert{:markdown="data.fragment"}` binding.
::

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
