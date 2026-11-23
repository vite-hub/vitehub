import { afterEach, describe, expect, it, vi } from "vitest"

import type { EmailMessage } from "../src/types.ts"

const sendMail = vi.fn()
const close = vi.fn()
const createTransport = vi.fn(() => ({ close, sendMail }))

vi.mock("nodemailer", () => ({ createTransport }))

const { createEmail } = await import("../src/client.ts")
const { default: smtp } = await import("../src/drivers/smtp.ts")

const message: EmailMessage = {
  attachments: [{ content: new Uint8Array([1, 2, 3]), filename: "report.bin" }],
  bcc: "audit@example.com",
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  replyTo: "support@example.com",
  subject: "Welcome",
  text: "Hello",
  to: ["ada@example.com", { email: "grace@example.com", name: "Grace" }],
}

const context = { attempt: 1, driver: "smtp", meta: {} }

afterEach(() => {
  vi.clearAllMocks()
})

describe("SMTP Email driver", () => {
  it("sends the portable message through nodemailer and returns its message id", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "<1@example.com>" })
    const driver = smtp({ host: "smtp.example.com", pass: "secret", port: "2525", user: "mailer" })

    const [error, sent] = await driver.send(message, context)

    expect(error).toBeUndefined()
    expect(sent).toMatchObject({ driver: "smtp", id: "<1@example.com>" })
    expect(createTransport).toHaveBeenCalledWith({
      auth: { pass: "secret", user: "mailer" },
      host: "smtp.example.com",
      port: 2525,
      requireTLS: true,
      secure: false,
    })
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      bcc: ["audit@example.com"],
      from: "\"ViteHub\" <hello@example.com>",
      headers: { "X-Trace-Id": "trace-1" },
      html: "<p>Hello</p>",
      replyTo: ["support@example.com"],
      subject: "Welcome",
      text: "Hello",
      to: ["ada@example.com", "\"Grace\" <grace@example.com>"],
    }))
    expect(sendMail.mock.calls[0]?.[0].attachments[0].content).toEqual(Buffer.from([1, 2, 3]))
    expect(close).toHaveBeenCalledOnce()
  })

  it("reads secure and the default port from string options", async () => {
    sendMail.mockResolvedValue({ messageId: "<2@example.com>" })

    await smtp({ host: "smtp.example.com", secure: "true" }).send(message, context)
    await smtp({ host: "smtp.example.com", port: 465 }).send(message, context)
    await smtp({ host: "smtp.example.com" }).send(message, context)

    expect(createTransport.mock.calls).toEqual([
      [{ host: "smtp.example.com", port: 465, secure: true }],
      [{ host: "smtp.example.com", port: 465, secure: true }],
      [{ host: "smtp.example.com", port: 587, secure: false }],
    ])
  })

  it("requires STARTTLS for login unless the connection already uses TLS", async () => {
    const auth = { user: "mailer", pass: "secret" }
    const host = "smtp.example.com"
    sendMail.mockResolvedValue({ messageId: "<tls@example.com>" })

    await smtp({ host, ...auth }).send(message, context)
    await smtp({ host, ...auth, port: 465 }).send(message, context)

    expect(createTransport.mock.calls).toEqual([
      [{ auth, host, port: 587, requireTLS: true, secure: false }],
      [{ auth, host, port: 465, requireTLS: false, secure: true }],
    ])
  })

  it.each([
    [{ host: "" }, "host is required."],
    [{ host: "smtp.example.com", port: "smtp" }, "port must be an integer from 1 to 65535."],
    [{ host: "smtp.example.com", secure: "yes" }, "secure must be true or false."],
    [{ host: "smtp.example.com", user: "mailer" }, "user and pass must be set together."],
  ])("rejects invalid options %o", (options, text) => {
    expect(() => smtp(options)).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED", driver: "smtp", message: text }))
  })

  it.each([
    [{ code: "EAUTH", responseCode: 535 }, "AUTH", false],
    [{ code: "ECONNECTION" }, "NETWORK", true],
    [{ code: "ETIMEDOUT" }, "TIMEOUT", true],
    [{ code: "EENVELOPE", responseCode: 550 }, "INVALID_OPTIONS", false],
    [{ code: "ECONNECTION", responseCode: 421 }, "RATE_LIMIT", true],
    [{ code: "EENVELOPE", responseCode: 450 }, "RATE_LIMIT", true],
    [{ code: "EENVELOPE", responseCode: 451 }, "RATE_LIMIT", true],
    [{ code: "EENVELOPE", responseCode: 452 }, "RATE_LIMIT", true],
    [{ code: "EMESSAGE", responseCode: 451 }, "RATE_LIMIT", true],
    [{ code: "EMESSAGE", responseCode: 554 }, "PROVIDER", false],
  ])("maps nodemailer error %o to %s", async (failure, code, retryable) => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error("SMTP failed"), failure))

    const [error] = await smtp({ host: "smtp.example.com" }).send(message, context)

    expect(error).toMatchObject({ code, driver: "smtp", retryable })
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects fields that SMTP cannot send before it connects", async () => {
    const [error] = await smtp({ host: "smtp.example.com" }).send({ ...message, idempotencyKey: "welcome-1" }, context)

    expect(error).toMatchObject({ code: "UNSUPPORTED", driver: "smtp", message: "The smtp driver does not support idempotency keys." })
    expect(createTransport).not.toHaveBeenCalled()
  })

  it("sends through createEmail()", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "<3@example.com>" })

    await expect(createEmail({ driver: smtp({ host: "smtp.example.com" }) }).send(message))
      .resolves.toEqual([undefined, { driver: "smtp", id: "<3@example.com>" }])
  })

  it("adds unsubscribe headers on direct sends and through createEmail()", async () => {
    const driver = smtp({ host: "smtp.example.com" })
    const subscription = { ...message, unsubscribe: { url: "https://example.com/unsubscribe" } }
    sendMail.mockResolvedValue({ messageId: "<subscription@example.com>" })

    await expect(driver.send(subscription, context)).resolves.toEqual([undefined, expect.anything()])
    await expect(createEmail({ driver }).send(subscription)).resolves.toEqual([undefined, expect.anything()])
    expect(sendMail).toHaveBeenCalledTimes(2)
    expect(sendMail.mock.calls[0]?.[0].headers).toEqual({
      "X-Trace-Id": "trace-1",
      "List-Unsubscribe": "<https://example.com/unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    })
    expect(sendMail.mock.calls[1]?.[0].headers).toEqual(sendMail.mock.calls[0]?.[0].headers)
  })

  it("reports rejected recipients without suggesting a retry of the entire message", async () => {
    const accepted = ["ada@example.com", "audit@example.com"]
    const rejected = ["grace@example.com"]
    const messageId = "<partial@example.com>"
    sendMail.mockResolvedValueOnce({ accepted, rejected, messageId })
    const email = createEmail({ driver: smtp({ host: "smtp.example.com" }) })

    await expect(email.send(message)).resolves.toEqual([
      expect.objectContaining({
        code: "EMAIL_PROVIDER_FAILED",
        cause: expect.objectContaining({
          retryable: false,
          cause: { accepted, rejected, messageId },
        }),
      }),
      undefined,
    ])
    expect(close).toHaveBeenCalledOnce()
  })
})

describe("SMTP Email driver without nodemailer", () => {
  it("throws EMAIL_SMTP_NODEMAILER_MISSING on send", async () => {
    vi.resetModules()
    vi.doMock("nodemailer", () => {
      throw Object.assign(new Error("Cannot find package 'nodemailer'"), { code: "ERR_MODULE_NOT_FOUND" })
    })
    const { createEmail: createIsolatedEmail } = await import("../src/client.ts")
    const { default: isolatedSmtp } = await import("../src/drivers/smtp.ts")

    await expect(createIsolatedEmail({ driver: isolatedSmtp({ host: "smtp.example.com" }) }).send(message))
      .rejects.toMatchObject({ code: "EMAIL_SMTP_NODEMAILER_MISSING", fix: expect.stringContaining("pnpm add nodemailer") })
    vi.doUnmock("nodemailer")
  })
})
