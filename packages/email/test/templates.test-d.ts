import { expectTypeOf, it } from "vitest"

import { createEmail, email } from "../src/index.ts"
import type { EmailDefinition, EmailTemplateName } from "../src/index.ts"

// The same augmentation that `.vitehub/types/email-templates.d.ts` holds for these two templates:
// `server/emails/welcome.md` reads `{{ data.user.name }}` and `::if{:condition="data.trial"}`,
// `server/emails/monthly/recap.md` reads no data, and `server/emails/top-repository.md` reads
// `::if{:condition="data.topRepository"}` and then `{{ data.topRepository.name }}` inside the branch.
declare module "../src/index.ts" {
  interface EmailTemplateRegistry {
    "welcome": {
      "user": {
        "name": string | number | boolean
      }
      "trial"?: unknown
    }
    "monthly/recap": Record<string, never>
    "top-repository": {
      "topRepository"?: {
        "name"?: string | number | boolean | null
      } | null
    }
  }
}

declare const definition: EmailDefinition
const envelope = { from: "hello@example.com", subject: "Welcome", to: "maxi@example.com" }

it("lists the template names", () => {
  expectTypeOf<EmailTemplateName>().toEqualTypeOf<"welcome" | "monthly/recap" | "top-repository">()
})

it("types data from the template", () => {
  void email.send({ ...envelope, template: "welcome", data: { user: { name: "Maxi" } } })
  void email.send({ ...envelope, template: "welcome", data: { trial: true, user: { name: 42 } } })
  void email.send({ ...envelope, template: "monthly/recap" })
  // A database row gives `null` for a missing value. The `::if` branch does not render, as for `undefined`.
  const row: { topRepository: { name: string } | null } = { topRepository: null }
  void email.send({ ...envelope, template: "top-repository", data: row })

  // @ts-expect-error `server/emails/missing.md` does not exist.
  void email.send({ ...envelope, template: "missing" })
  // @ts-expect-error `welcome` reads `data.user.name`, so `data` is required.
  void email.send({ ...envelope, template: "welcome" })
  // @ts-expect-error `{{ data.user.name }}` needs a string, number, or boolean.
  void email.send({ ...envelope, template: "welcome", data: { user: { name: { first: "Maxi" } } } })
  // @ts-expect-error `welcome` does not read `data.usr`.
  void email.send({ ...envelope, template: "welcome", data: { user: { name: "Maxi" }, usr: "typo" } })
  // @ts-expect-error The template renders the body, so `html` is not allowed.
  void email.send({ ...envelope, template: "monthly/recap", html: "<p>Hi</p>" })
})

it("still sends a message with a body", async () => {
  const [error, sent] = await email.send({ ...envelope, text: "Hello" })
  if (error) expectTypeOf(error.code).toEqualTypeOf<"EMAIL_AUTHENTICATION" | "EMAIL_INVALID_MESSAGE" | "EMAIL_NETWORK" | "EMAIL_PROVIDER_FAILED" | "EMAIL_RATE_LIMITED" | "EMAIL_TEMPLATE_RENDER_FAILED" | "EMAIL_TIMEOUT">()
  else expectTypeOf(sent).toEqualTypeOf<{ driver: string, id: string }>()
  void email.send({ ...envelope, html: "<p>Hello</p>" })
  // @ts-expect-error A message without a template needs `text` or `html`.
  void email.send({ ...envelope })
})

it("keeps template sends on the `email` helper", () => {
  const client = createEmail(definition)
  // @ts-expect-error `createEmail()` clients do not render templates.
  void client.send({ ...envelope, template: "welcome", data: { user: { name: "Maxi" } } })
})
