import { expect, it, vi } from "vitest"

import type { EmailDriver, EmailMessage } from "../src/index.ts"

const fixture = vi.hoisted(() => ({
  initialize: vi.fn(),
  send: vi.fn(async () => ({
    data: { at: new Date(), driver: "fixture", id: "provider-1" },
    error: null,
  })),
}))

vi.mock("#vitehub/email/definition", () => ({
  default: {
    driver: {
      initialize: fixture.initialize,
      name: "fixture",
      send: fixture.send,
    } satisfies EmailDriver,
  },
}))

import { email } from "../src/server.ts"

const message: EmailMessage = {
  from: "hello@example.com",
  subject: "Welcome",
  text: "Hello",
  to: "maxi@example.com",
}

it("keeps the configured driver's lifecycle across sends", async () => {
  await email.send(message)
  await email.send(message)

  expect(fixture.initialize).toHaveBeenCalledOnce()
  expect(fixture.send).toHaveBeenCalledTimes(2)
})
