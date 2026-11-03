import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { emailOperations } from "../src/operations.ts"
import { createEmailDevOutboxDriver } from "../src/runtime/outbox.ts"

import type { EmailDriver, EmailMessage } from "../src/types.ts"

vi.mock("#vitehub/email/definition", () => ({}))

const outboxState = Symbol.for("vitehub.email.outbox")
const captureState = Symbol.for("vitehub.email.devCapture")

afterEach(() => {
  Reflect.deleteProperty(globalThis, outboxState)
  Reflect.deleteProperty(globalThis, captureState)
})

const registry = createOperationRegistry([{ operations: emailOperations }])
const access = { mode: "local", sections: "all" } as const

function call(name: string, input: unknown = {}, sections: "all" | readonly string[] = "all") {
  return runOperation(registry, name, input, { access: { mode: "app", sections }, surface: "console", user: null })
}

const message: EmailMessage = {
  attachments: [{ content: "x".repeat(2048), contentType: "application/pdf", filename: "invoice.pdf" }],
  from: "hello@example.com",
  headers: { "X-Api-Key": "re_live_secret" },
  html: "<p>Hi</p>",
  subject: "Invoice",
  text: "Your invoice.",
  to: "ada@example.com",
}

async function capture(input: EmailMessage = message): Promise<void> {
  const driver: EmailDriver = await createEmailDevOutboxDriver({ deliver: false, driver: () => {
    throw new Error("The provider driver must not be created.")
  }, provider: "resend", runtimeId: "app" })
  await driver.send(input, { attempt: 1, driver: driver.name, meta: {} })
}

describe("email outbox operations", () => {
  it("lists, shows, and clears the captured messages", async () => {
    await capture()
    await capture({ ...message, subject: "Reminder" })

    const list = await call("email.outbox-list")
    expect(list).toMatchObject({ ok: true, value: { limit: 50 } })
    expect(list.ok && (list.value as { messages: Array<{ id: string, subject: string }> }).messages.map(row => [row.id, row.subject])).toEqual([["outbox-2", "Reminder"], ["outbox-1", "Invoice"]])
    expect(list.ok && JSON.stringify(list.value)).not.toContain("Your invoice.")

    const shown = await call("email.outbox-show", { id: "outbox-1" })
    expect(shown).toMatchObject({ ok: true, value: { message: { headers: { "X-Api-Key": "[redacted]" }, html: "<p>Hi</p>", id: "outbox-1", text: "Your invoice." } } })

    expect(await call("email.outbox-show", { id: "outbox-9" })).toMatchObject({ code: "EMAIL_OUTBOX_MESSAGE_NOT_FOUND", ok: false, status: 404 })
    expect(await call("email.outbox-show", {})).toMatchObject({ code: "INTERNAL_R0022", ok: false, status: 400 })

    expect(await call("email.outbox-clear")).toMatchObject({ ok: true, value: { cleared: 2 } })
    expect(await call("email.outbox-list")).toMatchObject({ ok: true, value: { limit: 50, messages: [] } })
  })

  it("answers an empty list before the first send", async () => {
    expect(await call("email.outbox-list")).toMatchObject({ ok: true, value: { limit: null, messages: [] } })
  })

  it("reports a disabled outbox", async () => {
    Reflect.set(globalThis, captureState, false)
    expect(await call("email.outbox-list")).toMatchObject({ code: "EMAIL_OUTBOX_DISABLED", fix: expect.stringContaining("outbox: false"), ok: false, status: 409 })
  })

  it("answers only to a call whose access includes the email section", async () => {
    await capture()
    expect(await call("email.outbox-list", {}, ["kv"])).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    expect(await call("email.outbox-clear", {}, ["email"])).toMatchObject({ ok: true })
    const direct = await runOperation(registry, "email.outbox-list", {}, { access, surface: "cli", user: null })
    expect(direct.ok).toBe(true)
  })

  it("marks clearing as destructive and the rest as safe", () => {
    expect(Object.fromEntries(registry.list().map(operation => [operation.name, operation.kind]))).toEqual({
      "email.outbox-clear": "destructive",
      "email.outbox-list": "read",
      "email.outbox-show": "read",
      "email.preview": "read",
    })
  })
})
