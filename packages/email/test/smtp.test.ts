import { beforeEach, describe, expect, it, vi } from "vitest"

const nodemailer = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}))

vi.mock("nodemailer", () => ({
  default: { createTransport: nodemailer.createTransport },
}))

import { createEmail } from "../src/index.ts"
import { smtp } from "../src/drivers/smtp.ts"

beforeEach(() => {
  nodemailer.createTransport.mockReset()
  nodemailer.sendMail.mockReset()
  nodemailer.createTransport.mockReturnValue({ sendMail: nodemailer.sendMail })
  nodemailer.sendMail.mockResolvedValue({ messageId: "smtp-1" })
})

describe("smtp", () => {
  it("maps the portable message contract to Nodemailer", async () => {
    const transport = { auth: { pass: "secret", user: "user" }, host: "smtp.example.com", port: 587 }
    const client = createEmail({ driver: smtp(transport) })

    await expect(client.send({
      attachments: [{
        cid: "logo",
        content: new Uint8Array([1, 2, 3]),
        contentDisposition: "inline",
        contentType: "image/png",
        filename: "logo.png",
      }],
      bcc: "audit@example.com",
      cc: [{ email: "reviewer@example.com", name: "Reviewer" }],
      from: { email: "hello@example.com", name: "ViteHub" },
      headers: { "X-Trace-Id": "trace-1" },
      html: "<p>Hello</p>",
      replyTo: "support@example.com",
      subject: "Welcome",
      text: "Hello",
      to: ["maxi@example.com"],
    })).resolves.toEqual({ driver: "smtp", id: "smtp-1" })

    expect(nodemailer.createTransport).toHaveBeenCalledWith(transport)
    expect(nodemailer.sendMail).toHaveBeenCalledWith({
      attachments: [{
        cid: "logo",
        content: Buffer.from([1, 2, 3]),
        contentDisposition: "inline",
        contentType: "image/png",
        filename: "logo.png",
      }],
      bcc: ["audit@example.com"],
      cc: [{ address: "reviewer@example.com", name: "Reviewer" }],
      from: { address: "hello@example.com", name: "ViteHub" },
      headers: { "X-Trace-Id": "trace-1" },
      html: "<p>Hello</p>",
      replyTo: ["support@example.com"],
      subject: "Welcome",
      text: "Hello",
      to: ["maxi@example.com"],
    })
  })

  it.each([
    [{ code: "EAUTH", message: "Authentication failed" }, "EMAIL_AUTHENTICATION"],
    [{ code: "ETIMEDOUT", message: "Timed out" }, "EMAIL_TIMEOUT"],
    [{ code: "ECONNECTION", message: "Connection refused" }, "EMAIL_NETWORK"],
    [{ message: "Too many messages, rate limit exceeded", responseCode: 451 }, "EMAIL_RATE_LIMITED"],
    [{ code: "EENVELOPE", message: "Bad envelope" }, "EMAIL_PROVIDER_FAILED"],
  ])("normalizes Nodemailer failures", async (cause, code) => {
    nodemailer.sendMail.mockRejectedValue(cause)
    const client = createEmail({ driver: smtp("smtp://localhost") })

    await expect(client.send({
      from: "hello@example.com",
      subject: "Welcome",
      text: "Hello",
      to: "maxi@example.com",
    })).rejects.toMatchObject({
      cause,
      code,
      details: { driver: "smtp" },
      message: "[vitehub] SMTP delivery failed.",
    })
  })

  it("keeps provider details out of the public error message", async () => {
    const cause = new Error("Authentication failed for smtp-user@example.com with secret-123")
    nodemailer.sendMail.mockRejectedValue(cause)
    const client = createEmail({ driver: smtp("smtp://localhost") })

    await expect(client.send({
      from: "hello@example.com",
      subject: "Welcome",
      text: "Hello",
      to: "maxi@example.com",
    })).rejects.toMatchObject({
      cause,
      message: "[vitehub] SMTP delivery failed.",
    })
  })

  it("rejects a missing provider message id", async () => {
    nodemailer.sendMail.mockResolvedValue({})
    const driver = smtp("smtp://localhost")

    await expect(driver.send({
      from: "hello@example.com",
      subject: "Welcome",
      text: "Hello",
      to: "maxi@example.com",
    })).rejects.toEqual(expect.objectContaining({
      code: "EMAIL_PROVIDER_FAILED",
      details: { driver: "smtp" },
    }))
  })
})
