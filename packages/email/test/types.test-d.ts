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
import { email } from "../src/index.ts"
import { createTestEmail, type TestEmailClient } from "../src/test.ts"
import { hubEmail } from "../src/vite.ts"
import resend from "../src/drivers/resend.ts"

resend({ apiKey: "re_secret" }) satisfies EmailDriver
const _lazyDriver = (() => resend({ apiKey: "re_secret" })) satisfies EmailDriverFactory
declare const message: EmailMessage

// @ts-expect-error Email messages have one envelope sender.
const multipleSenders: EmailMessage = { from: ["first@example.com", "second@example.com"], subject: "Hello", to: "reader@example.com" }
void multipleSenders

// @ts-expect-error A message needs `text` or `html`.
const withoutBody: EmailMessage = { from: "hello@example.com", subject: "Hello", to: "reader@example.com" }
void withoutBody

// @ts-expect-error ViteHub Email does not send provider templates. Render the template to `html`.
const providerTemplate: EmailMessage = { from: "hello@example.com", html: "<p>Hi</p>", subject: "Hello", template: { id: "welcome" }, to: "reader@example.com" }
void providerTemplate

// @ts-expect-error ViteHub Email does not send React elements. Render them to `html`.
const reactBody: EmailMessage = { from: "hello@example.com", react: {}, subject: "Hello", text: "Hi", to: "reader@example.com" }
void reactBody

const htmlOnly: EmailMessage = { from: "hello@example.com", html: "<p>Hi</p>", subject: "Hello", to: "reader@example.com" }
const textOnly: EmailMessage = { from: "hello@example.com", subject: "Hello", text: "Hi", to: "reader@example.com" }
void htmlOnly
void textOnly

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
