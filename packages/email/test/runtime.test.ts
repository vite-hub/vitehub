import { afterEach, expect, it, vi } from "vitest"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import type { EmailDriver, EmailMessage } from "../src/index.ts"

const fixture = vi.hoisted(() => ({
  initialize: vi.fn(),
  send: vi.fn(async () => ({
    data: { at: new Date(), driver: "fixture", id: "provider-1" },
    error: null,
  })),
}))

const definition = {
  driver: {
    initialize: fixture.initialize,
    name: "fixture",
    send: fixture.send,
  } satisfies EmailDriver,
}

const message: EmailMessage = {
  from: "hello@example.com",
  subject: "Welcome",
  text: "Hello",
  to: "maxi@example.com",
}

afterEach(async () => {
  await enableViteHubTestMode().reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("vitehub.email.definition")]
  vi.clearAllMocks()
  vi.resetModules()
})

it("rejects missing configuration before capturing a test email", async () => {
  vi.doMock("#vitehub/email/definition", () => ({ default: undefined }))
  const { email } = await import("../src/index.ts")
  const mode = enableViteHubTestMode()

  await expect(email.send(message)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
  expect(mode.peek("email")).toBeUndefined()
})

it.each(["imported", "generated"])("captures test emails with an %s definition without starting its driver", async (source) => {
  vi.doMock("#vitehub/email/definition", () => ({ default: source === "imported" ? definition : undefined }))
  const { email } = await import("../src/index.ts")
  if (source === "generated") Reflect.set(globalThis, Symbol.for("vitehub.email.definition"), definition)
  const mode = enableViteHubTestMode()

  await expect(email.send(message)).resolves.toEqual([undefined, { driver: "memory", id: "memory-1" }])
  expect(mode.peek<{ messages: EmailMessage[] }>("email")?.messages).toEqual([message])
  expect(fixture.initialize).not.toHaveBeenCalled()
  expect(fixture.send).not.toHaveBeenCalled()
})

it("keeps the configured driver's lifecycle across sends", async () => {
  vi.doMock("#vitehub/email/definition", () => ({ default: definition }))
  const { email } = await import("../src/index.ts")

  await email.send(message)
  await email.send(message)

  expect(fixture.initialize).toHaveBeenCalledOnce()
  expect(fixture.send).toHaveBeenCalledTimes(2)
})

it("resolves a generated definition installed after the server module loads", async () => {
  vi.doMock("#vitehub/email/definition", () => ({ default: undefined }))
  const { email } = await import("../src/index.ts")

  ;(globalThis as Record<PropertyKey, unknown>)[Symbol.for("vitehub.email.definition")] = definition

  await email.send(message)
  await email.send(message)

  expect(fixture.initialize).toHaveBeenCalledOnce()
  expect(fixture.send).toHaveBeenCalledTimes(2)
})
