---
title: Email server API
description: Send messages, compose dynamic Markdown, and capture email in tests from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

Import framework APIs from `vite-hub` paths. Pick `resend`, `cloudflare`, or `log` in the Vite config. `email.canSend` is `false` with `log` or without Email. See [Run without a provider](/docs/email/configure#run-without-a-provider).

| Import | Runtime values | Public types |
| --- | --- | --- |
| `vite-hub` | `vitehub` | Framework Vite Integration options. |
| `vite-hub/email` | `email` (`email.send()`, `email.canSend`), `createEmail` | `EmailAddress`, `EmailAddressList`, `EmailAttachment`, `EmailEnvelope`, `EmailMessage`, `EmailSendMessage`, `EmailTemplateMessage`, `EmailTemplateName`, `EmailTemplateRegistry`, `RenderedEmail`, `EmailDriver`, `EmailDriverFactory`, `EmailDriverSource`, `EmailDefinition`, `EmailClient`, `EmailSendResult`, `EmailErrorCode` |
| `vite-hub/runtime` | `Result`, `ResultError` | Shared `[error, data]` contract of runtime operations. |
| `vite-hub/email/markdown` | `renderEmailMarkdown` | `RenderEmailMarkdownOptions`, `RenderedEmail` |
| `vite-hub/email/vue` | `EmailSubject` | `EmailVueContext` |
| `@vite-hub/email/drivers/*` | Programmatic provider drivers | Built-in Resend, Cloudflare Email, and log drivers. |
| `@vite-hub/email/test` | `createTestEmail`, `createMemoryEmailDriver` | `TestEmailClient`, `MemoryEmailDriver` |
| `@vite-hub/email/vite` | `hubEmail`, `emailConsoleSection` | `EmailOptions`, `EmailOutboxOptions`, `EmailVitePlugin`, `EmailVitePluginAPI` |
| `@vite-hub/email/runtime/console` | `listEmailOutbox`, `getEmailOutboxMessage`, `clearEmailOutbox`, `readEmailOutboxConsoleRecords` | `EmailOutboxMessage`, `EmailOutboxList`, `EmailOutboxDelivery`, `EmailOutboxAttachment` |

The direct `@vite-hub/email` and `@vite-hub/email/markdown` paths remain stable for focused libraries and applications that install the owner package without the framework distribution.

## Message contract

`email.send()` and `createEmail()` clients take an `EmailMessage`. `email.send()` also takes a template name and its `data` instead of a body. See [Send a template](#send-a-template).

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `from` | `EmailAddress` | Yes | One sender as a string or `{ email, name? }`. |
| `to` | `EmailAddressList` | Yes | One address or a non-empty array. |
| `cc`, `bcc`, `replyTo` | `EmailAddressList` | No | More recipients. |
| `subject` | `string` | Yes | The message subject. |
| `text`, `html` | `string` | One of them | The plain-text body, the HTML body, or both. |
| `headers` | `Record<string, string>` | No | Custom headers. |
| `attachments` | `readonly EmailAttachment[]` | No | In-memory string or `Uint8Array` content with a non-empty filename. |
| `unsubscribe` | `{ url?, mailto?, oneClick? }` | No | Adds the `List-Unsubscribe` headers. |
| `tags`, `metadata` | `readonly { name, value }[]`, `Record<string, string>` | No | Resend only. |
| `scheduledAt` | `string \| Date` | No | Resend only. |
| `idempotencyKey` | `string` | No | Resend only. |

`EmailAttachment` also takes optional `contentType`, `cid`, and `disposition: 'attachment' | 'inline'`. The Cloudflare Email driver returns an error for the fields marked Resend only.

A message without `text`, `html`, or `template` does not compile, and `send()` returns `EMAIL_INVALID_MESSAGE` for it. ViteHub does not render provider templates, React, JSX, MJML, Handlebars, or Liquid. Render the body yourself, for example with [`renderEmailMarkdown()`](#compose-dynamic-markdown) or `render()` from `@react-email/render`, and pass the result:

```ts [server/welcome.ts]
import { email } from 'vite-hub/email'

function renderWelcome(workspaceUrl: string) {
  return `<p>Your workspace is ready. <a href="${workspaceUrl}">Open it</a>.</p>`
}

export async function sendWelcome(to: string, workspaceUrl: string) {
  const [error] = await email.send({ from: 'hello@example.com', to, subject: 'Welcome', html: renderWelcome(workspaceUrl) })
  if (error) throw error
}
```

The driver decides address rules, message limits, and sender authorization. Check the provider docs for those limits.

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

`renderEmailMarkdown()` returns `{ subject?, html, text }`, the same contract as a template module. `html` is the rendered HTML. `text` is the filled Markdown. `subject` is set when the Markdown starts with `subject:` frontmatter. Text clients can read it, but it can keep Markdown markers such as `**`. Pass your own `text` when you need plain text without markers.

### Send a template

Put templates under `server/emails`. ViteHub finds Markdown (`.md`) and
[Vue](#vue-templates) (`.vue`) files in all subfolders. A file or folder whose
name starts with `_`, such as `server/emails/_partials/footer.md`, is a partial:
ViteHub does not discover it as a template or include it automatically. To reuse
a Markdown partial, load the trusted Markdown in your application and pass it as
data to `:insert`, for example `:insert{:markdown="data.footer"}`. A Vue template
imports its `_` partials as components. Pass the template name as `template` and its
values as `data`. `email.send()` renders the template once to a subject, an HTML
body, and a text body, then sends the message.

Set the subject with `subject:` frontmatter. It can read `{{ data.* }}` values.
ViteHub fills it as plain text, so Markdown markers in it stay as they are.

```md [server/emails/welcome.md]
---
subject: Welcome, {{ data.user.name }}
---

# Welcome {{ data.user.name }}

::if{:condition="data.trial"}
Your trial is active.
::
```

```ts [server/welcome.ts]
import { email } from 'vite-hub/email'

export async function sendWelcome(name: string, to: string) {
  const [error, sent] = await email.send({
    template: 'welcome',
    data: { user: { name } },
    from: 'verified-sender@example.com',
    to,
  })
  if (error) throw error
  return sent
}
```

A `subject` in the message overrides the subject of the template. A template
without `subject:` frontmatter needs `subject` in the message: TypeScript
requires it, and `send()` throws `EMAIL_TEMPLATE_SUBJECT_REQUIRED` for an
untyped call without it. A non-string `subject` or any other frontmatter key
stops the build with `EMAIL_TEMPLATE_FRONTMATTER_INVALID`.

TypeScript completes `template` with the names under `server/emails`, and types
`data` from the `data.*` values that the template and its subject read:

| In the template | Type in `data` |
| --- | --- |
| `{{ data.x }}` or a bound attribute such as `{:href="data.x"}` | `string \| number \| boolean` |
| `:insert{:markdown="data.x"}` | `string` |
| `::if{:condition="data.x"}` and the other condition props | Optional `unknown` |
| A value that the template reads only inside an `::if` branch | Optional, and also takes `null`, such as a database column with no value |

An unknown name, a missing value, or a value of the wrong type does not compile.
The build reports `EMAIL_TEMPLATE_SYNTAX_INVALID` when a template uses an old
binding such as `{{ name }}` instead of `{{ data.name }}`, or puts either form
inside inline code or a code block, where it stays as text.
When `data` does not fit at runtime, `send()` returns
`EMAIL_TEMPLATE_RENDER_FAILED`. A name that no template has throws
`EMAIL_TEMPLATE_NOT_FOUND`. A message with `template` cannot also set `html` or
`text`. `createEmail()` clients do not render templates.

### Vue templates

A `.vue` file under `server/emails` is also a template. ViteHub compiles it with
the `@vitejs/plugin-vue` of your Vite config, and renders it on the server with
`vue/server-renderer`. Install `vue` in the app. Nuxt adds the plugin for you.
In a Vite or Nitro app, add `vue()` from `@vitejs/plugin-vue` to the Vite
`plugins`.

```vue [server/emails/invite.vue] fragment
<script setup lang="ts">
import { EmailSubject } from 'vite-hub/email/vue'
import Layout from './_layout.vue'

defineProps<{ name: string, team: string, trial?: boolean }>()
</script>

<template>
  <Layout>
    <EmailSubject>Join {{ team }}</EmailSubject>
    <h1>Hi {{ name }}</h1>
    <p>Join <strong>{{ team }}</strong> today.</p>
    <p v-if="trial">Your trial is active.</p>
  </Layout>
</template>
```

```vue [server/emails/_layout.vue] fragment
<template>
  <table role="presentation"><tbody><tr><td><slot /></td></tr></tbody></table>
  <p>Sent by Acme</p>
</template>
```

```ts [server/invite.ts] fragment
const [error] = await email.send({
  template: 'invite',
  data: { name: 'Ada', team: 'Docs', trial: true },
  from: 'verified-sender@example.com',
  to,
  subject: 'Join Docs',
})
```

- The props of the component are the `data` of the template. TypeScript checks
  `data` against `defineProps`.
- `<EmailSubject>` sets the rendered subject to the text of its slot and adds
  nothing to the HTML. A component may not render the subject on every path,
  so TypeScript requires `subject` on Vue template sends. A subject supplied
  in the message overrides the rendered subject.
- `_layout.vue` is a partial, so it is not a template. Templates import partials
  as Vue components.
- Import each component and function that the template uses. Email templates
  compile apart from the app, so Nuxt auto-imports do not apply to them.
- ViteHub removes the Vue comment markers from `html`, and makes `text` from
  the HTML: headings, bold text, links, and lists keep their Markdown markers.

The build stops with `EMAIL_VUE_MISSING` when the app cannot import `vue`, and
with `EMAIL_VUE_PLUGIN_MISSING` when the Vite config has no
`@vitejs/plugin-vue`. A server with Vue templates bundles `vue` and
`vue/server-renderer`.

`server/emails/monthly/recap.md` is the template `monthly/recap`. To render a
template without sending it, import `#vitehub/emails/monthly/recap`. It
exports an async function that takes the same `data` and returns
`{ subject?, html, text }`, the `RenderedEmail` type.
ViteHub writes the template types to `.vitehub/types/email-templates.d.ts` and
`.vitehub/types/email.d.ts`, and bundles the templates for builds under
`.vitehub/email/templates`. An app without templates gets no template types.

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
