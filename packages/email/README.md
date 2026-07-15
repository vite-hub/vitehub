# `@vite-hub/email`

`@vite-hub/email` sends transactional email through a ViteHub-owned message and driver contract. The core works with any host or provider driver; the optional SMTP driver uses Nodemailer on Node.js.

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

Define the delivery driver in `server/email.ts`:

```ts
import { defineEmail } from "@vite-hub/email"
import { smtp } from "@vite-hub/email/drivers/smtp"

const smtpURL = process.env.SMTP_URL
if (!smtpURL) throw new Error("SMTP_URL is required")

export default defineEmail({
  driver: smtp(smtpURL),
})
```

Server code can now use the discovered Runtime Helper:

```ts
import { email } from "@vite-hub/email/server"

await email.send({
  from: "hello@example.com",
  to: "maxi@example.com",
  subject: "Welcome",
  text: "Welcome to ViteHub.",
})
```

Successful sends return a provider message ID and the driver name. Delivery failures throw `EmailError` with a stable code.

## Render Dynamic Markdown

`renderEmailMarkdown()` composes `@vite-hub/markdown-template` data, conditions, fragments, and caller-resolved imports before Comark renders the HTML body.

```ts
import { renderEmailMarkdown } from "@vite-hub/email/markdown"

const body = await renderEmailMarkdown("# Welcome {{ user.name }}\n\nYour workspace is ready.", {
  data: { user: { name: "Maxi" } },
})

await email.send({
  ...body,
  from: "hello@example.com",
  to: "maxi@example.com",
  subject: "Your workspace is ready",
})
```

The `html` body contains rendered HTML. The `text` fallback contains the fully composed Markdown, so it stays readable without adding a second conversion policy.

## Test without delivering

```ts
import { createTestEmail } from "@vite-hub/email/test"

const mail = createTestEmail()
await mail.send({
  from: "hello@example.com",
  to: "maxi@example.com",
  subject: "Welcome",
  text: "Hello",
})

expect(mail.messages[0]?.subject).toBe("Welcome")
```

Each test client owns an isolated mailbox. Captured messages are copied before storage, and `clear()` resets the mailbox and deterministic message IDs.

## Bring another provider

Implement `EmailDriver` and pass it to `createEmail({ driver })`, or return it from the discovered Email Definition. Provider SDK types and response payloads stay behind the driver boundary.

This first release owns outbound transactional delivery, in-memory attachments, Markdown composition, and test capture. It does not own queues, retries, scheduling, provider templates, inbound email, webhooks, suppression lists, or tracking. Compose those workflows with their owning primitives.
