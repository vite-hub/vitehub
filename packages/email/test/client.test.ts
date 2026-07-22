import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { createEmail } from "../src/index.ts"
import { email } from "../src/server.ts"

import type { EmailDriver, EmailMessage } from "../src/index.ts"

const message: EmailMessage = {
  attachments: [{ content: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream", filename: "report.bin" }],
  bcc: "audit@example.com",
  cc: [{ email: "reviewer@example.com", name: "Reviewer" }],
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  replyTo: "support@example.com",
  subject: "Welcome",
  text: "Hello",
  to: ["maxi@example.com"],
}

const sparseArray: unknown[] = []
sparseArray.length = 1

function fixtureDriver(send = vi.fn(async () => ({ id: "provider-1" }))): EmailDriver {
  return { name: "fixture", send }
}

describe("createEmail", () => {
  it("preserves the portable message contract and normalizes the result", async () => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await expect(client.send(message)).resolves.toEqual({ driver: "fixture", id: "provider-1" })
    expect(driver.send).toHaveBeenCalledWith(message)
  })

  it.each([
    [{ ...message, from: "" }, "from"],
    [{ ...message, subject: "" }, "subject"],
    [{ ...message, to: [] }, "to"],
    [{ ...message, to: sparseArray }, "to"],
    [{ ...message, html: undefined, text: undefined }, "html or text"],
    [{ ...message, html: 1 }, "html"],
    [{ ...message, text: 1 }, "text"],
    [{ ...message, cc: {} }, "cc"],
    [{ ...message, headers: { "X-Trace-Id": 1 } }, "headers"],
    [{ ...message, attachments: {} }, "attachments"],
    [{ ...message, attachments: null }, "attachments"],
    [{ ...message, attachments: sparseArray }, "attachments"],
    [{ ...message, attachments: [{ content: {}, filename: "report.bin" }] }, "attachments"],
    [{ ...message, attachments: [{ content: "report", contentDisposition: "download", filename: "report.txt" }] }, "attachments"],
  ])("rejects an invalid message before delivery", async (invalid, field) => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await expect(client.send(invalid as unknown as EmailMessage)).rejects.toMatchObject({
      code: "EMAIL_INVALID_MESSAGE",
      details: { driver: "fixture" },
      message: expect.stringContaining(field),
    })
    expect(driver.send).not.toHaveBeenCalled()
  })

  it("normalizes unknown driver failures", async () => {
    const cause = new Error("provider unavailable")
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => {
        throw cause
      })),
    })

    await expect(client.send(message)).rejects.toMatchObject({
      cause,
      code: "EMAIL_PROVIDER_FAILED",
      details: { driver: "fixture" },
      message: "[vitehub] Email delivery failed through fixture.",
    })
  })

  it("preserves normalized driver errors", async () => {
    const error = new ViteHubError("EMAIL_RATE_LIMITED", "Try again later.", { details: { driver: "fixture" } })
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => {
        throw error
      })),
    })

    await expect(client.send(message)).rejects.toBe(error)
  })
})

it("reports a missing discovered Email Definition", async () => {
  await expect(email.send(message)).rejects.toMatchObject({
    code: "EMAIL_NOT_CONFIGURED",
    message: "[vitehub] No Email Definition was discovered. Add `server/email.ts` or `server.email.ts`.",
  })
})
