import { expectTypeOf, it } from "vitest"

import {
  createEmail,
  defineEmail,
  type EmailAddress,
  type EmailClient,
  type EmailDefinition,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
} from "../src/index.ts"
import { resend } from "../src/drivers/resend.ts"
import { renderEmailMarkdown } from "../src/markdown.ts"
import { email } from "../src/server.ts"
import { createTestEmail, type TestEmailClient } from "../src/test.ts"

declare const driver: EmailDriver

resend({ apiKey: "secret" }) satisfies EmailDriver
resend({ apiKey: () => "secret" }) satisfies EmailDriver
resend({ apiKey: async () => "secret" }) satisfies EmailDriver
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

it("exports Markdown and test helpers from dedicated entrypoints", () => {
  expectTypeOf(renderEmailMarkdown).returns.toEqualTypeOf<Promise<{ html: string; text: string }>>()
  expectTypeOf(createTestEmail).returns.toEqualTypeOf<TestEmailClient>()
})
