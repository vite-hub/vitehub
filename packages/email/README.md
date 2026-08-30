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

The official [`email()` Agent Capability](https://vitehub.dev/docs/capabilities/email) exposes one policy-controlled plain-text send tool through the configured Email provider. The application fixes the sender and keeps provider credentials below the Capability boundary; richer messages remain application-owned compositions.

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

### Discover application templates

Place reusable Markdown under `server/emails`:

```md
# Welcome {{ user.name }}

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

The renderer does not sanitize authored HTML, trusted Markdown fragments, or imported templates, and it does not inline email CSS. Use scalar `{{ value }}` bindings for untrusted text, and sanitize untrusted content before passing it through a `{{{ fragment }}}` binding or import.

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

## Use another provider

Set `driver` to `resend` or `cloudflare-email` and declare its options in `hubEmail({ driver, options })`. Programmatic clients can implement the exported `EmailDriver` interface or import a built-in driver from `@vite-hub/email/drivers/*`.

## Migrating from Unemail driver paths

Replace `driver: "unemail/driver/resend"` with `driver: "resend"`. Replace `driver: "unemail/driver/cloudflare-email"` with `driver: "cloudflare-email"`. Direct imports move to `@vite-hub/email/drivers/resend` and `@vite-hub/email/drivers/cloudflare-email`.

ViteHub no longer installs or executes the `unemail` package. GitHub's unresolved critical package-name advisory covers every published version even though the current `0.5.0` tarball has npm provenance and no lifecycle install hook. Removing the dependency clears that advisory without claiming the current tarball is proven malicious.

ViteHub owns the portable message and driver contracts, its built-in Resend and Cloudflare Email transports, runtime delivery, normalized errors, Dynamic Markdown composition, and test capture.

Read the complete [Email guide and API reference](https://vitehub.dev/docs/server-primitives/email).
