import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vite-hub/agent"
import { llmGate, llmRoute } from "../src/capabilities.ts"
import { defineAgent } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

/** An AI SDK model that answers the Decisions question `g0` with `choice`. */
function decisionModel(choice: string, confidence = 0.8) {
  const prompts: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt))
      signals.push(options.abortSignal)
      return {
        content: [{ text: JSON.stringify({ g0: { choice, confidence } }), type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
        warnings: [],
      }
    },
  })
  return { model, prompts, signals }
}

describe("LLM decision capabilities", () => {
  it("records llmRoute decisions from the model through Decisions", async () => {
    const { model, prompts } = decisionModel("support")
    const agent = defineAgent({
      capabilities: [
        llmRoute({
          choices: {
            support: "General customer support.",
            technical: "Code or API support.",
          },
          id: "active-instructions",
          model,
        }),
      ],
      driver: { async run(context) {
          return context.context.get("active-instructions")
        } },
    })

    await expect(runAgentWithContext(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "I need help with billing." })],
    })).resolves.toEqual({
      choice: "support",
      confidence: expect.closeTo(0.6, 5),
      probabilities: { support: 0.8, technical: expect.closeTo(0.2, 5) },
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("I need help with billing.")
    expect(prompts[0]).toContain("technical: Code or API support.")
  })

  it("routes with the Agent model when llmRoute has no model", async () => {
    const { model, prompts } = decisionModel("technical")
    const agent = defineAgent({
      capabilities: [llmRoute({ choices: { support: "General customer support.", technical: "Code or API support." }, id: "route" })],
      driver: { model },
      runtime: false,
    })

    await runAgentWithContext(agent, runtime(), { prompt: "The API returns 500." })
    expect(prompts[0]).toContain("The API returns 500.")
  })

  it("rejects requests when llmGate chooses a reject category", async () => {
    const { model } = decisionModel("unsafe", 0.9)
    const agent = defineAgent({
      capabilities: [
        llmGate({
          allow: {
            support: "Safe support question.",
          },
          id: "support-scope",
          message: decision => `Rejected: ${decision.category}`,
          model,
          reject: {
            unsafe: "Unsafe or abusive request.",
          },
        }),
      ],
      driver: { async run() {
          return "should not run"
        } },
    })

    await expect(runAgentWithContext(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "Do something unsafe." })],
    })).rejects.toMatchObject({
      code: "LLM_GATE_REJECTED",
      details: {
        capabilityId: "support-scope",
        category: "unsafe",
        confidence: expect.closeTo(0.8, 5),
      },
      message: "Rejected: unsafe",
      name: "ViteHubError",
    })
  })

  it("fails when the model answers a choice outside the map", async () => {
    const { model } = decisionModel("sales")
    const agent = defineAgent({
      capabilities: [llmRoute({ choices: { support: "General customer support.", technical: "Code or API support." }, model })],
      driver: { async run() { return "should not run" } },
    })

    await expect(runAgentWithContext(agent, runtime(), { prompt: "Buy now" })).rejects.toMatchObject({ code: "DECISIONS_R0005" })
  })

  it.each(["route", "gate"] as const)("passes the Invocation signal to the %s model request", async (kind) => {
    const { model, signals } = decisionModel("support")
    let invocationSignal: AbortSignal | undefined
    const agent = defineAgent({
      capabilities: [kind === "route"
        ? llmRoute({ choices: { support: "Safe support.", unsafe: "Unsafe request." }, model })
        : llmGate({ allow: { support: "Safe support." }, reject: { unsafe: "Unsafe request." }, model })],
      driver: { run(context) {
        invocationSignal = context.input.abortSignal
        return "ok"
      } },
    })

    await runAgentWithContext(agent, runtime(), { abortSignal: new AbortController().signal, prompt: "Help with billing" })
    expect(invocationSignal).toBeInstanceOf(AbortSignal)
    expect(signals).toEqual([invocationSignal])
  })

  it("records a single choice without a model", async () => {
    const agent = defineAgent({
      capabilities: [llmRoute({ choices: { support: "General customer support." }, id: "route" })],
      driver: { async run(context) { return context.context.get("route") } },
    })

    await expect(runAgentWithContext(agent, runtime(), {})).resolves.toEqual({ choice: "support", confidence: 1, probabilities: { support: 1 } })
  })
})
