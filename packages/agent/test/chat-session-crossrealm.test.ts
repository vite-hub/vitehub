import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveChatSessionId } from "../src/chat-message-input.ts"

describe("chat session cross-realm dates", () => {
  it("uses a foreign createdAt Date as the manual session boundary", () => {
    const createdAt = runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date
    expect(resolveChatSessionId([{ createdAt, parts: [], role: "user" }], true)).toBe("manual:1767323045000")
  })
})
