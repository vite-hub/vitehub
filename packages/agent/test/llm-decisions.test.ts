import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vite-hub/agent"
import { llmGate, llmRoute } from "../src/capabilities.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

function mockAiDecision(output: unknown) {
  const generateText = vi.fn(async (input: unknown) => ({ ...input as Record<string, unknown>, output }))
  vi.doMock("ai", () => ({
    generateText,
    jsonSchema: (schema: unknown, options?: unknown) => ({ options, schema }),
    Output: {
      object: (options: unknown) => options,
    },
  }))
  return generateText
}

describe("LLM decision capabilities", () => {
  it("records llmRoute decisions in the invocation context", async () => {
    const generateText = mockAiDecision({ choice: "support", confidence: 0.8, reason: "User asks for account help." })

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [
          llmRoute({
            choices: {
              support: "General customer support.",
              technical: "Code or API support.",
            },
            id: "active-instructions",
            model: "router-model" as never,
          }),
        ],
        driver: { async run(context) {
            return context.context.get("active-instructions")
          } },
      })

      await expect(runAgent(agent, runtime(), {
        messages: [createMessage({ role: "user", text: "I need help with billing." })],
      })).resolves.toEqual({
        choice: "support",
        confidence: 0.8,
        reason: "User asks for account help.",
      })
      expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
        model: "router-model",
      }))
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("rejects requests when llmGate chooses a reject category", async () => {
    mockAiDecision({ allowed: false, category: "unsafe", reason: "The request is unsafe." })

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [
          llmGate({
            allow: {
              support: "Safe support question.",
            },
            id: "support-scope",
            message: decision => `Rejected: ${decision.category}`,
            model: "gate-model" as never,
            reject: {
              unsafe: "Unsafe or abusive request.",
            },
          }),
        ],
        driver: { async run() {
            return "should not run"
          } },
      })

      await expect(runAgent(agent, runtime(), {
        messages: [createMessage({ role: "user", text: "Do something unsafe." })],
      })).rejects.toMatchObject({
        code: "LLM_GATE_REJECTED",
        details: {
          capabilityId: "support-scope",
          category: "unsafe",
          reason: "The request is unsafe.",
        },
        message: "Rejected: unsafe",
        name: "ViteHubError",
      })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("bounds the public rejection reason", async () => {
    mockAiDecision({ allowed: false, category: "unsafe", reason: "x".repeat(20_000) })

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [llmGate({
          allow: { support: "Safe support question." },
          model: "gate-model" as never,
          reject: { unsafe: "Unsafe request." },
        })],
        driver: { async run() { return "should not run" } },
      })

      await expect(runAgent(agent, runtime(), {
        messages: [createMessage({ role: "user", text: "Do something unsafe." })],
      })).rejects.toMatchObject({
        code: "LLM_GATE_REJECTED",
        details: { reason: "x".repeat(16_384) },
      })
    }
    finally {
      vi.doUnmock("ai")
    }
  })
})
