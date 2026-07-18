import { expectTypeOf, it } from "vitest"

import {
  createEmail,
  defineEmail,
  EmailError,
  type EmailAddress,
  type EmailClient,
  type EmailDefinition,
  type EmailDriver,
  type EmailErrorOptions,
  type EmailMessage,
  type EmailSendResult,
} from "../src/index.ts"
import { renderEmailMarkdown } from "../src/markdown.ts"
import { email } from "../src/server.ts"
import { createTestEmail, type TestEmailClient } from "../src/test.ts"

declare const driver: EmailDriver
declare const message: EmailMessage

// @ts-expect-error An EmailMessage requires an HTML or text body.
const messageWithoutBody: EmailMessage = {
  from: "hello@example.com",
  subject: "Welcome",
  to: "maxi@example.com",
}
void messageWithoutBody

it("exports the portable Email contract", () => {
  expectTypeOf<EmailAddress>().toEqualTypeOf<string | { email: string; name?: string }>()
  expectTypeOf(createEmail).parameters.toEqualTypeOf<[options: EmailDefinition]>()
  expectTypeOf(createEmail).returns.toEqualTypeOf<EmailClient>()
  expectTypeOf(defineEmail).parameters.toEqualTypeOf<[definition: EmailDefinition]>()
  expectTypeOf(email.send).parameters.toEqualTypeOf<[message: EmailMessage]>()
  expectTypeOf(email.send).returns.toEqualTypeOf<Promise<EmailSendResult>>()
  expectTypeOf(driver.send).returns.toEqualTypeOf<Promise<{ id: string }>>()
  expectTypeOf(message.to).toEqualTypeOf<EmailAddress | readonly EmailAddress[]>()
})

it("exports the structured Email error contract", () => {
  expectTypeOf(EmailError).toBeConstructibleWith({
    code: "provider",
    details: { operation: "send" },
    driver: "fixture",
    message: "Email delivery failed.",
  } satisfies EmailErrorOptions)
  expectTypeOf(new EmailError("network", "SMTP delivery failed.", { driver: "smtp" }).driver)
    .toEqualTypeOf<string | undefined>()
  // @ts-expect-error Email details expose only the owned driver and send operation.
  new EmailError({ code: "provider", details: { responseBody: "secret" }, message: "Delivery failed." })
  // @ts-expect-error Email has no public operation other than send.
  new EmailError({ code: "provider", details: { operation: "delete" }, message: "Delivery failed." })
  // @ts-expect-error Email codes are a closed ViteHub-owned union.
  new EmailError({ code: "smtp-auth-secret", message: "Delivery failed." })
  // @ts-expect-error The positional constructor uses the same closed code union.
  new EmailError("smtp-auth-secret", "Delivery failed.")
})

it("exports Markdown and test helpers from dedicated entrypoints", () => {
  expectTypeOf(renderEmailMarkdown).returns.toEqualTypeOf<Promise<{ html: string; text: string }>>()
  expectTypeOf(createTestEmail).returns.toEqualTypeOf<TestEmailClient>()
})
