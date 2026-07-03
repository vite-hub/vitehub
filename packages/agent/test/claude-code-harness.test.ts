import { describe, expect, it, vi } from "vitest"

import type { HarnessV1, HarnessV1PromptTurnOptions, HarnessV1StreamPart } from "@ai-sdk/harness"

const createAiSdkClaudeCode = vi.hoisted(() =>
  vi.fn(settings => ({
    settings,
    async doStart() {
      return {
        sessionId: "test-session",
        isResume: false,
        async doPromptTurn(options: HarnessV1PromptTurnOptions) {
          options.emit({ type: "stream-start" })
          options.emit({
            type: "finish",
            finishReason: "stop",
            totalUsage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          } as unknown as HarnessV1StreamPart)
          return { done: Promise.resolve() }
        },
      }
    },
  })),
)

vi.mock("@ai-sdk/harness-claude-code", () => ({
  createClaudeCode: createAiSdkClaudeCode,
}))

describe("createClaudeCode", () => {
  it("defaults to direct Anthropic auth so host AI Gateway env does not leak into Claude Code", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    createClaudeCode()

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({ auth: { anthropic: {} } })
  })

  it("preserves explicit Claude Code auth settings", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    createClaudeCode({ auth: { gateway: { apiKey: "gateway-key" } }, maxTurns: 3 })

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({
      auth: { gateway: { apiKey: "gateway-key" } },
      maxTurns: 3,
    })
  })

  it("surfaces empty zero-token Claude Code turns as harness errors", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")
    const events: HarnessV1StreamPart[] = []
    const session = await (createClaudeCode() as HarnessV1).doStart({} as Parameters<HarnessV1["doStart"]>[0])

    await session.doPromptTurn({
      prompt: "hello",
      emit: event => events.push(event),
    })

    expect(events.map(event => event.type)).toEqual(["stream-start", "error"])
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: expect.objectContaining({
        message: expect.stringContaining("Claude Code returned no output"),
      }),
    })
  })
})
