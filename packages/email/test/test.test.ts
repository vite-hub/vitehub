import { describe, expect, it } from "vitest"

import { createMemoryEmailDriver, createTestEmail } from "../src/test.ts"

import type { EmailMessage } from "../src/index.ts"

const message: EmailMessage = {
  from: "hello@example.com",
  subject: "Welcome",
  text: "Hello",
  to: "maxi@example.com",
}

describe("createTestEmail", () => {
  it("captures independent message copies in delivery order", async () => {
    const client = createTestEmail()
    const first = structuredClone(message)

    await expect(client.send(first)).resolves.toEqual({ driver: "memory", id: "memory-1" })
    first.subject = "Changed later"
    await client.send({ ...message, subject: "Second" })

    expect(client.messages).toEqual([message, { ...message, subject: "Second" }])
  })

  it("isolates mailboxes and clears one mailbox without affecting another", async () => {
    const first = createTestEmail()
    const second = createTestEmail()
    await first.send(message)
    await second.send(message)

    first.clear()

    expect(first.messages).toEqual([])
    expect(second.messages).toHaveLength(1)
  })
})

it("exposes the memory driver for custom test clients", async () => {
  const driver = createMemoryEmailDriver()
  await expect(driver.send(message, { attempt: 1, driver: "memory", meta: {} })).resolves.toMatchObject({
    data: { driver: "memory", id: "memory-1" },
    error: null,
  })
  expect(driver.messages).toEqual([message])
})
