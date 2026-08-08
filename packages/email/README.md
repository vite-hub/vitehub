# `@vite-hub/email`

`@vite-hub/email` sends outbound transactional email through one portable message and driver contract. Use the discovered `email` Runtime Helper in a ViteHub app, create an explicit client for manual integration, or provide your own delivery driver.

Applications that install the `vite-hub` framework distribution can use `vite-hub/email`, `vite-hub/email/server`, `vite-hub/email/markdown`, and the dependency-free `vite-hub/email/drivers/resend` adapter. SMTP, test utilities, and direct Vite Integration control stay on this owner package.

## Requirements

- Node.js 24 or later.
- Vite 8 or later when you use Email Definition discovery.
- A Resend API key when you use the dependency-free Resend driver.
- Nodemailer 9 only when you use the optional SMTP driver.

The package does not choose an email provider or read credentials from Vite config. Your Email Definition owns the driver and its server-only credentials.

## Quickstart

Install the package and Nodemailer for SMTP delivery:

```bash
pnpm add @vite-hub/email nodemailer
```

Register Email discovery with Vite:

```ts
// vite.config.ts
import { hubEmail } from "@vite-hub/email/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubEmail()],
})
```

Set `SMTP_URL` in the server runtime environment, then define the delivery driver:

```ts
// server/email.ts
import { defineEmail } from "@vite-hub/email"
import { smtp } from "@vite-hub/email/drivers/smtp"

const smtpURL = process.env.SMTP_URL
if (!smtpURL) throw new Error("SMTP_URL is required")

export default defineEmail({
  driver: smtp(smtpURL),
})
```

Keep `SMTP_URL` in a local or deployment secret store. Do not expose it through a `VITE_`-prefixed environment variable.

For Resend, no provider package is required. Pass a string or a sync/async getter; getters are resolved for every send so request-scoped Worker secrets are not cached:

```ts
// server/email.ts
import { defineEmail } from "@vite-hub/email"
import { resend } from "@vite-hub/email/drivers/resend"

export default defineEmail({
  driver: resend({
    apiKey: () => process.env.RESEND_API_KEY ?? "",
  }),
})
```

Server code can now use the discovered Runtime Helper:

```ts
import { email } from "@vite-hub/email/server"

const result = await email.send({
  from: "hello@example.com",
  to: "you@example.com",
  subject: "Welcome",
  text: "Welcome to ViteHub.",
})
```

A successful send returns `{ id, driver }`; the provider supplies `id`. Invalid messages and delivery failures throw `ViteHubError` with a stable `EMAIL_*` code. SMTP, Resend, and core-wrapped provider failures keep protected diagnostics in `cause` while exposing a safe message. Custom drivers should use the same shared contract when they classify a failure directly.

## Grant an Agent permission to send

The official [`email()` Agent Capability](https://vitehub.dev/docs/capabilities/email) exposes one policy-controlled plain-text send tool through the discovered Email Definition. The application fixes the sender and keeps provider credentials below the Capability boundary; richer messages remain application-owned compositions.

## Compose dynamic Markdown

`renderEmailMarkdown()` resolves `@vite-hub/markdown-template` data, conditions, fragments, and caller-provided imports before Comark renders the HTML body.

```ts
import { email } from "@vite-hub/email/server"
import { renderEmailMarkdown } from "@vite-hub/email/markdown"

const body = await renderEmailMarkdown("# Welcome {{ user.name }}\n\nYour workspace is ready.", {
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

The renderer does not sanitize authored HTML, trusted Markdown fragments, or imported templates, and it does not inline email CSS. Use scalar `{{ value }}` bindings for untrusted text, and sanitize untrusted content before passing it through a `{{{ fragment }}}` binding or import.

## Test without delivery

`createTestEmail()` uses an isolated in-memory mailbox and the same validation path as a production client:

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

## Use another provider

Implement `EmailDriver.send(message)` and return `{ id }`, then pass the driver to `createEmail({ driver })` or expose it from the discovered Email Definition. ViteHub validates the portable message before delivery and normalizes the public result to `{ id, driver }`; provider SDK types and response payloads stay inside the adapter.

This release owns outbound transactional delivery, in-memory attachments, dynamic Markdown composition, and test capture. Queues, retries, scheduling, provider templates, inbound email, webhooks, suppression lists, and tracking remain with their owning primitives or delivery providers.

Read the complete [Email guide and API reference](https://vitehub.dev/docs/server-primitives/email).
