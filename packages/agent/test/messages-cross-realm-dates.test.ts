import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMessage, validateMessage } from "../src/messages.ts"

describe("Agent message date boundaries", () => {
  it("normalizes a foreign Date when creating a message", () => {
    const createdAt = runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date
    const message = createMessage({ createdAt, role: "user", text: "hello" })
    expect(message.createdAt).toBe("2026-01-02T03:04:05.000Z")
  })

  it("rejects a foreign Date in an already assembled message", () => {
    const createdAt = runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date
    expect(() => validateMessage({ createdAt, id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" })).toThrow()
  })
})
