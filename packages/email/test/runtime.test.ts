import { afterEach, expect, it, vi } from "vitest"

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

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("vitehub.email.definition")]
  vi.clearAllMocks()
  vi.resetModules()
})

it("keeps the configured driver's lifecycle across sends", async () => {
  vi.doMock("#vitehub/email/definition", () => ({ default: definition }))
  const { email } = await import("../src/server.ts")

  await email.send(message)
  await email.send(message)

  expect(fixture.initialize).toHaveBeenCalledOnce()
  expect(fixture.send).toHaveBeenCalledTimes(2)
})

it("resolves a generated definition installed after the server module loads", async () => {
  vi.doMock("#vitehub/email/definition", () => ({ default: undefined }))
  const { email } = await import("../src/server.ts")

  ;(globalThis as Record<PropertyKey, unknown>)[Symbol.for("vitehub.email.definition")] = definition

  await email.send(message)
  await email.send(message)

  expect(fixture.initialize).toHaveBeenCalledOnce()
  expect(fixture.send).toHaveBeenCalledTimes(2)
})
