import { expectTypeOf, it } from "vitest"

import type { Result } from "@vite-hub/runtime"

import {
  createEmail,
  type EmailAddress,
  type EmailAddressList,
  type EmailClient,
  type EmailDefinition,
  type EmailDriver,
  type EmailDriverFactory,
  type EmailErrorCode,
  type EmailMessage,
  type EmailSendResult,
} from "../src/index.ts"
import { renderEmailMarkdown } from "../src/markdown.ts"
import { email } from "../src/server.ts"
import { createTestEmail, type TestEmailClient } from "../src/test.ts"
import { hubEmail } from "../src/vite.ts"
import resend from "../src/drivers/resend.ts"

resend({ apiKey: "re_secret" }) satisfies EmailDriver
const _lazyDriver = (() => resend({ apiKey: "re_secret" })) satisfies EmailDriverFactory
declare const message: EmailMessage

// @ts-expect-error Email messages have one envelope sender.
const multipleSenders: EmailMessage = { from: ["first@example.com", "second@example.com"], subject: "Hello", to: "reader@example.com" }
void multipleSenders

hubEmail({ driver: "resend" })
// @ts-expect-error Email requires a configured provider.
hubEmail()
// @ts-expect-error File discovery is not an Email configuration model.
hubEmail({ projectRoot: ".." })

// @ts-expect-error EmailAddress represents one mailbox, not a recipient list.
const address: EmailAddress = ["hello@example.com"]
void address

it("exports the portable Email contract", () => {
  expectTypeOf<EmailAddress>().toEqualTypeOf<string | { email: string; name?: string }>()
  expectTypeOf(createEmail).parameters.toEqualTypeOf<[options: EmailDefinition]>()
  expectTypeOf(createEmail).returns.toEqualTypeOf<EmailClient>()
  expectTypeOf(email.send).parameters.toEqualTypeOf<[message: EmailMessage]>()
  expectTypeOf(email.send).returns.toEqualTypeOf<Promise<Result<EmailSendResult, EmailErrorCode>>>()
  expectTypeOf(message.to).toEqualTypeOf<EmailAddressList>()
  expectTypeOf(message.from).toEqualTypeOf<EmailAddress>()
})

it("types the codes that send returns", async () => {
  expectTypeOf<EmailErrorCode>().toEqualTypeOf<
    "EMAIL_AUTHENTICATION" | "EMAIL_INVALID_MESSAGE" | "EMAIL_NETWORK" | "EMAIL_PROVIDER_FAILED" | "EMAIL_RATE_LIMITED" | "EMAIL_TIMEOUT"
  >()

  const [error, sent] = await email.send(message)
  if (error) {
    expectTypeOf(error.code).toEqualTypeOf<EmailErrorCode>()
    expectTypeOf(error.why).toEqualTypeOf<string>()
    expectTypeOf(error.fix).toEqualTypeOf<string | undefined>()
    expectTypeOf(error.docs).toEqualTypeOf<string | undefined>()
    expectTypeOf(sent).toEqualTypeOf<undefined>()
    // @ts-expect-error `EMAIL_NOT_CONFIGURED` throws, so `send()` never returns it.
    void (error.code === "EMAIL_NOT_CONFIGURED")
    return
  }
  expectTypeOf(sent).toEqualTypeOf<EmailSendResult>()
})

it("exports Markdown and test helpers from dedicated entrypoints", () => {
  expectTypeOf(renderEmailMarkdown).returns.toEqualTypeOf<Promise<{ html: string; text: string }>>()
  expectTypeOf(createTestEmail).returns.toEqualTypeOf<TestEmailClient>()
})
