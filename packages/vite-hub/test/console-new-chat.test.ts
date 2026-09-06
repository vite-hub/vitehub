import { describe, expect, it } from "vitest"

import { resolveConsoleNewChatAgent } from "../src/console/runtime/components/console-new-chat.ts"

describe("console new chat agent", () => {
  it("keeps the selected agent when it can start invocations", () => {
    expect(resolveConsoleNewChatAgent("support", { support: { profiles: [] } })).toBe("support")
  })

  it("falls back to an invokable agent for a historical selection", () => {
    expect(resolveConsoleNewChatAgent("chat", { bot: { profiles: [] } })).toBe("bot")
  })

  it("returns no target when the console has no invokable agents", () => {
    expect(resolveConsoleNewChatAgent("chat", {})).toBeUndefined()
  })
})
