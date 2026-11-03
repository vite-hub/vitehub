import { afterEach, describe, expect, it } from "vitest"

import { emailConsoleSection } from "../src/console.ts"
import {
  emailConsoleHtmlSourceLimit,
  listEmailOutbox,
  readEmailOutboxConsoleRecords,
} from "../src/runtime/console.ts"
import { createEmailDevOutboxDriver } from "../src/runtime/outbox.ts"
import { emailProviderError } from "../src/provider.ts"

import type { EmailDriver, EmailMessage } from "../src/types.ts"

const outboxState = Symbol.for("vitehub.email.outbox")

afterEach(() => {
  Reflect.deleteProperty(globalThis, outboxState)
})

const message: EmailMessage = {
  attachments: [{ content: "x".repeat(2048), contentType: "application/pdf", filename: "invoice.pdf" }],
  from: "hello@example.com",
  headers: { "X-Api-Key": "re_live_secret" },
  html: "<p onclick=\"steal()\">Hi <img src=x onerror=alert(1)></p>",
  subject: "Invoice",
  text: "Your invoice.",
  to: "ada@example.com",
}

async function capture(input: EmailMessage = message, limit?: number): Promise<void> {
  const driver: EmailDriver = await createEmailDevOutboxDriver({ deliver: false, driver: () => {
    throw new Error("The provider driver must not be created.")
  }, limit, provider: "resend" })
  await driver.send(input, { attempt: 1, driver: driver.name, meta: {} })
}

describe("Email outbox runtime reader", () => {
  it("returns no records without an outbox", () => {
    expect(readEmailOutboxConsoleRecords()).toEqual([])
    expect(listEmailOutbox()).toEqual({ limit: null, messages: [] })
  })

  it("maps captured messages to Console records without secrets", async () => {
    await capture()
    await capture({ ...message, subject: "Reminder" })

    const records = readEmailOutboxConsoleRecords()
    expect(records.map(record => record.id)).toEqual(["outbox-2", "outbox-1"])
    const record = records[1]!
    expect(record.cells).toEqual({
      captured: expect.any(String),
      delivery: "Captured only",
      provider: "resend",
      subject: "Invoice",
      to: "ada@example.com",
    })
    const fields = Object.fromEntries(record.fields.map(field => [field.label, field.value]))
    expect(fields).toMatchObject({
      "Attachments": "invoice.pdf (application/pdf, 2.0 KB)",
      "Delivery": "Captured only",
      "From": "hello@example.com",
      "Headers": "X-Api-Key: [redacted]",
      "Text body": "Your invoice.",
    })
    expect(new Set(record.fields.map(field => field.label)).size).toBe(record.fields.length)
    expect(JSON.stringify(records)).not.toContain("re_live_secret")
  })

  it("names the delivery state in one status word and keeps the details in the Delivery field", async () => {
    const send = async (driver: EmailDriver) => {
      const outbox = await createEmailDevOutboxDriver({ deliver: true, driver: () => driver, provider: "resend" })
      await outbox.send(message, { attempt: 1, driver: outbox.name, meta: {} })
    }
    await send({ name: "resend", send: () => ({ data: { at: new Date(), driver: "resend", id: "re_1" }, error: null }) })
    await send({ name: "resend", send: () => ({ data: null, error: emailProviderError("resend", "AUTH", "Resend rejected the API key.") }) })

    const [failed, sent] = readEmailOutboxConsoleRecords()
    expect(failed?.cells.delivery).toBe("Failed")
    expect(failed?.fields.find(field => field.label === "Delivery")?.value).toBe("Failed (AUTH): Resend rejected the API key.")
    expect(sent?.cells.delivery).toBe("Sent")
    expect(sent?.fields.find(field => field.label === "Delivery")?.value).toBe("Sent (re_1)")
  })

  it("returns HTML as plain source text and truncates long HTML", async () => {
    await capture()
    await capture({ ...message, html: `<div>${"a".repeat(emailConsoleHtmlSourceLimit + 10)}</div>` })

    const [long, short] = readEmailOutboxConsoleRecords()
    const shortHtml = short?.fields.find(field => field.label === "HTML source")?.value
    expect(shortHtml).toBe(message.html)
    const longHtml = long?.fields.find(field => field.label === "HTML source")?.value
    expect(typeof longHtml).toBe("string")
    expect(String(longHtml)).toHaveLength(emailConsoleHtmlSourceLimit + "\n... 21 more characters. Use `vitehub email outbox show outbox-2 --html`.".length)
    expect(String(longHtml)).toContain("Use `vitehub email outbox show outbox-2 --html`.")
  })

  it("declares a runtime record-table section that the Console renders as text", async () => {
    expect(emailConsoleSection).toMatchObject({
      id: "email",
      runtime: { export: "readEmailOutboxConsoleRecords", module: "@vite-hub/email/runtime/console" },
      view: { kind: "record-table" },
    })
    expect(emailConsoleSection.view.columns.map(column => column.key)).toEqual(["subject", "to", "provider", "delivery", "captured"])
    const records = await import("../src/runtime/console.ts")
    expect(records[emailConsoleSection.runtime.export as "readEmailOutboxConsoleRecords"]).toBeTypeOf("function")
  })
})
