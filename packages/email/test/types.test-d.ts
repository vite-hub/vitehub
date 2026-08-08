import { expectTypeOf, it } from "vitest"

import {
  createEmail,
  defineEmail,
  type EmailAddress,
  type EmailClient,
  type EmailDefinition,
  type EmailDriver,
  type EmailDriverFactory,
  type EmailMessage,
  type EmailSendResult,
} from "../src/index.ts"
import { renderEmailMarkdown } from "../src/markdown.ts"
import { email } from "../src/server.ts"
import { createTestEmail, type TestEmailClient } from "../src/test.ts"
import resend from "unemail/driver/resend"

resend({ apiKey: "secret" }) satisfies EmailDriver
const lazyDriver = (() => resend({ apiKey: "secret" })) satisfies EmailDriverFactory
defineEmail({ driver: lazyDriver })
declare const message: EmailMessage

it("exports the portable Email contract", () => {
  expectTypeOf<EmailAddress>().toEqualTypeOf<
    string | { email: string; name?: string } | readonly (string | { email: string; name?: string })[]
  >()
  expectTypeOf(createEmail).parameters.toEqualTypeOf<[options: EmailDefinition]>()
  expectTypeOf(createEmail).returns.toEqualTypeOf<EmailClient>()
  expectTypeOf(defineEmail).parameters.toEqualTypeOf<[definition: EmailDefinition]>()
  expectTypeOf(email.send).parameters.toEqualTypeOf<[message: EmailMessage]>()
  expectTypeOf(email.send).returns.toEqualTypeOf<Promise<EmailSendResult>>()
  expectTypeOf(message.to).toEqualTypeOf<EmailAddress>()
})

it("exports Markdown and test helpers from dedicated entrypoints", () => {
  expectTypeOf(renderEmailMarkdown).returns.toEqualTypeOf<Promise<{ html: string; text: string }>>()
  expectTypeOf(createTestEmail).returns.toEqualTypeOf<TestEmailClient>()
})
