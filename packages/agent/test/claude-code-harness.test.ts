import { describe, expect, it, vi } from "vitest"

const createAiSdkClaudeCode = vi.hoisted(() => vi.fn(settings => ({ settings })))

vi.mock("@ai-sdk/harness-claude-code", () => ({
  createClaudeCode: createAiSdkClaudeCode,
}))

describe("createClaudeCode", () => {
  it("defaults to direct Anthropic auth so host AI Gateway env does not leak into Claude Code", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    expect(createClaudeCode()).toEqual({ settings: { auth: { anthropic: {} } } })
  })

  it("preserves explicit Claude Code auth settings", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    createClaudeCode({ auth: { gateway: { apiKey: "gateway-key" } }, maxTurns: 3 })

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({
      auth: { gateway: { apiKey: "gateway-key" } },
      maxTurns: 3,
    })
  })
})
