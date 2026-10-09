# `@vite-hub/email`

`@vite-hub/email` connects declaratively configured provider drivers to ViteHub runtime delivery, normalized errors, Dynamic Markdown, and deterministic test capture.

Applications that install the `vite-hub` framework distribution can use `vite-hub/email`, `vite-hub/email/server`, and `vite-hub/email/markdown`. Import built-in provider drivers from `@vite-hub/email/drivers/*`; test utilities and direct Vite Integration control stay on this owner package.

## Requirements

- Node.js 24 or later.
- Vite 8 or later for provider configuration and generated runtime wiring.
- The credentials required by your selected driver.

The Vite integration composes one ViteHub-owned provider driver from a stable name and runtime Env declarations.

## Quickstart

Install the package:

```bash
pnpm add @vite-hub/email @vite-hub/env
```

Configure the provider with Vite:

```ts
// vite.config.ts
import { hubEmail } from "@vite-hub/email/vite"
import { env } from "@vite-hub/env"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubEmail({
    driver: "resend",
    options: {
      apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
    },
  })],
})
```

Set `RESEND_API_KEY` in the server runtime environment. Keep provider credentials in a local or deployment secret store; only the Env declaration is evaluated during Vite config, while the credential resolves for every send. Literal options and non-secret Env defaults are included in build output, so never use literal options for credentials; ViteHub rejects defaults on declarations marked secret. Do not expose credentials through a `VITE_`-prefixed environment variable.

Server code can now use the configured Runtime Helper:

```ts
import { email } from "@vite-hub/email/server"

const result = await email.send({
  from: "hello@example.com",
  to: "you@example.com",
  subject: "Welcome",
  text: "Welcome to ViteHub.",
})
```

A successful send returns `{ id, driver }`; the provider supplies `id`. ViteHub maps provider failures to stable `EMAIL_*` codes and keeps the original error in `cause`.

## Grant an Agent permission to send

The official [`email()` Agent Capability](https://vitehub.dev/docs/email/agent-capability) exposes one policy-controlled plain-text send tool through the configured Email provider. The application fixes the sender and keeps provider credentials below the Capability boundary; richer messages remain application-owned compositions.

## Compose dynamic Markdown

`renderEmailMarkdown()` resolves `@vite-hub/markdown-template` data, conditions, and fragments before Comark renders the HTML body.

```ts
import { email } from "@vite-hub/email/server"
import { renderEmailMarkdown } from "@vite-hub/email/markdown"

const body = await renderEmailMarkdown("# Welcome {{ data.user.name }}\n\nYour workspace is ready.", {
  data: { user: { name: "Maxi" } },
})

await email.send({
  ...body,
  from: "hello@example.com",
  to: "you@example.com",
  subject: "Your workspace is ready",
})
```

`html` contains rendered HTML. `text` contains the fully composed Markdown, which remains readable in text clients and keeps composition deterministic. Supply your own `text` when you need a marker-free plain-text version.

### Discover application templates

Place reusable Markdown under `server/emails`:

```md
# Welcome {{ data.user.name }}

Your workspace is ready.
```

ViteHub turns `server/emails/welcome.md` into a typed async renderer:

```ts
import renderWelcome from "#vitehub/emails/welcome"

const markdown = await renderWelcome({ user: { name: "Maxi" } })
```

Nested paths keep their relative name. For example,
`server/emails/monthly/recap.md` becomes
`#vitehub/emails/monthly/recap`. The Vite integration writes exact module types
to `.vitehub/types/email.d.ts` and bundles templates for provider builds under
`.vitehub/email/templates`.

The renderer does not sanitize authored HTML or trusted Markdown fragments, and it does not inline email CSS. Use scalar `{{ data.value }}` bindings for untrusted text, and sanitize untrusted content before passing it through a `:insert{:markdown="data.fragment"}` component.

## Test without delivery

`createTestEmail()` uses an isolated in-memory mailbox with the same message contract as a production client:

```ts
import { expect, it } from "vitest"
import { createTestEmail } from "@vite-hub/email/test"

it("sends a welcome email", async () => {
  const mail = createTestEmail()

  await expect(mail.send({
    from: "hello@example.com",
    to: "you@example.com",
    subject: "Welcome",
    text: "Hello",
  })).resolves.toEqual({ driver: "memory", id: "memory-1" })

  expect(mail.messages[0]?.subject).toBe("Welcome")
})
```

Captured messages are cloned before storage. `clear()` empties the mailbox and restarts deterministic IDs at `memory-1`.

## Inspect development sends

In `vite dev`, `hubEmail()` wraps the provider driver with a development outbox. Each `email.send()` call records the headers, recipients, subject, text and HTML bodies, attachment metadata, provider name, and delivery result in the memory of the server runtime. Build output never contains the outbox.

By default the outbox records each message and then delivers it through the provider. Pending deliveries appear as Sending. Each development runtime has separate messages, limits, and outbox IDs. Configure it with `outbox`:

```ts
hubEmail({
  driver: "resend",
  options: { apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }) },
  // Record messages without a provider request. Keep the newest 100 messages.
  outbox: { deliver: false, limit: 100 },
})
```

`limit` defaults to `50` and accepts 1 to 1000. `outbox: false` disables the outbox. A restart clears it. Header and metadata values with secret names, and credentials in delivery errors, are redacted. Message bodies are kept as rendered.

Read the outbox from a running Vite + Nitro Development Server, or render a template without sending it:

```bash
pnpm vitehub email outbox list
pnpm vitehub email outbox show outbox-1 --html
pnpm vitehub email outbox clear
pnpm vitehub email preview welcome --data '{"user":{"name":"Maxi"}}'
```

Application code can select its generated outbox identity through the public server export:

```ts
import { emailOutboxRuntimeId } from "@vite-hub/email/server"
import { listEmailOutbox, getEmailOutboxMessage, clearEmailOutbox } from "@vite-hub/email/runtime/console"

const captured = listEmailOutbox(emailOutboxRuntimeId)
const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
clearEmailOutbox(emailOutboxRuntimeId)
```

Pass this identity to each reader to inspect this application's configured Email client. Calls without an identity use the standalone default store. Production and disabled outboxes expose `"disabled"` and contain no captured messages.

`emailConsoleSection` adds an **Email** section to the ViteHub Console. It passes the generated definition's `outboxRuntimeId` to `readEmailOutboxConsoleRecords(runtimeId)` from `@vite-hub/email/runtime/console` on each request and shows the HTML body as escaped source text. It never renders captured HTML.

## Use another provider

Set `driver` to `resend` or `cloudflare-email` and declare its options in `hubEmail({ driver, options })`. Programmatic clients can implement the exported `EmailDriver` interface or import a built-in driver from `@vite-hub/email/drivers/*`.

`createEmail()` initializes a driver object once per client, shares pending initialization across concurrent sends, and retries after initialization fails. A driver factory resolves and initializes a driver for each send so request-scoped provider options stay current. The development outbox preserves these lifecycle rules.

Read the complete [Email guide and API reference](https://vitehub.dev/docs/email).
