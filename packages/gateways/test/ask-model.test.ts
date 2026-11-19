import { createOpenAI } from "@ai-sdk/openai"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it, vi } from "vitest"

import { languageModel } from "../src/ai-sdk.ts"
import { ask, askWithModel, openrouter } from "../src/index.ts"

function model(answers: unknown) {
  const calls: { prompt: unknown, responseFormat: unknown }[] = []
  const mock = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt, responseFormat: options.responseFormat })
      return {
        content: [{ text: JSON.stringify(answers), type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 12, total: 12 }, outputTokens: { reasoning: 0, text: 3, total: 3 } },
        warnings: [],
      }
    },
  })
  return { calls, mock }
}

describe("askWithModel()", () => {
  it("answers every question type in one request", async () => {
    const { calls, mock } = model({
      category: { choice: "eatingOut", confidence: 0.8 },
      recurring: { chance: 0.7 },
      risk: { confidence: 1, level: 2 },
      team: { choice: "billing", confidence: 0.9 },
      urgent: { chance: 0.2 },
    })
    const usage: unknown[] = []
    const [error, answers] = await askWithModel(mock).ask("BAR PEPE 12.50 EUR", {
      category: ask.choice("Which category fits this bank transaction?", { eatingOut: "Restaurants and cafes.", groceries: "Food shopping.", other: null }),
      recurring: ask.if("Is it a recurring payment?", { threshold: 0.6 }),
      risk: ask.score("How risky is it?", ["None", "Some", "High"]),
      team: ask.switch("Which team answers?", ["billing", "support"]),
      urgent: ask.chance("Is it urgent?"),
    }, { onUsage: entry => usage.push(entry) })

    expect(error).toBeUndefined()
    if (!answers) throw error
    expect(calls).toHaveLength(1)
    expect(answers.category).toEqual({ choice: "eatingOut", confidence: expect.closeTo(0.7, 5), probabilities: { eatingOut: 0.8, groceries: expect.closeTo(0.1, 5), other: expect.closeTo(0.1, 5) }, type: "choice" })
    expect(answers.recurring).toBe(true)
    expect(answers.risk).toMatchObject({ confidence: 1, probabilities: { 0: 0, 1: 0, 2: 1 }, ratio: 1, score: 2, type: "score" })
    expect(answers.team).toBe("billing")
    expect(answers.urgent).toEqual({ chance: 0.2, type: "chance" })
    expect(usage).toEqual([{ model: "mock-model-id", provider: "mock-provider", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }])

    const prompt = JSON.stringify(calls[0]!.prompt)
    expect(prompt).toContain("BAR PEPE 12.50 EUR")
    expect(prompt).toContain("eatingOut: Restaurants and cafes.")
    expect(calls[0]!.responseFormat).toMatchObject({ schema: { properties: { category: { properties: { choice: { enum: ["eatingOut", "groceries", "other"] } } } }, required: ["category", "recurring", "risk", "team", "urgent"] }, type: "json" })
  })

  it("never ranks the chosen option below the others", async () => {
    const { mock } = model({ team: { choice: "billing", confidence: 0.1 } })
    const [, answers] = await askWithModel(mock).ask("Invoice 42", { team: ask.choice("Which team?", ["billing", "support"]) })
    expect(answers?.team).toMatchObject({ choice: "billing", confidence: 0, probabilities: { billing: 0.5, support: 0.5 } })
  })

  it("rejects an answer that is not an option", async () => {
    const { mock } = model({ team: { choice: "sales", confidence: 0.9 } })
    await expect(askWithModel(mock).ask("Invoice 42", { team: ask.choice("Which team?", ["billing", "support"]) })).rejects.toMatchObject({ code: "GATEWAYS_R0012" })
  })

  it("returns GATEWAYS_ASK_MODEL_FAILED when the model request fails", async () => {
    const failure = Object.assign(new Error("Too Many Requests"), { statusCode: 429 })
    const mock = new MockLanguageModelV3({ doGenerate: async () => { throw failure } })

    const [error, answers] = await askWithModel(mock).ask("Invoice 42", { team: ask.choice("Which team?", ["billing", "support"]) })

    expect(answers).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_MODEL_FAILED" })
    expect(error?.message).toContain("HTTP 429")
  })

  it.each([null, '{"spam":{"chance":0.9}}'])("returns a failure for a provider error finish with content %j", async (content) => {
    const fetch = async () => Response.json({
      choices: [{ error: { code: "server_error", message: "Generation failed" }, finish_reason: "error", index: 0, message: { content, role: "assistant" } }],
      created: 1,
      id: "chatcmpl-1",
      model: "model",
      object: "chat.completion",
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    })
    const model = languageModel(openrouter({ apiKey: "test-key" }), "model", { fetch })

    const [error, answers] = await askWithModel(model).ask("Invoice 42", { spam: ask.if("Is it spam?") })

    expect(answers).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_MODEL_FAILED" })
  })

  it("throws when the provider API key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined)
    try {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const model = createOpenAI({ fetch }).chat("gpt-5")

      await expect(askWithModel(model).ask("Invoice 42", { spam: ask.if("Is it spam?") })).rejects.toMatchObject({ name: "AI_LoadAPIKeyError" })
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("throws when the state cannot be serialized", async () => {
    const { calls, mock } = model({})
    const state = { amount: 42n }

    await expect(askWithModel(mock).ask(state, { spam: ask.if("Is it spam?") })).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it("sends no request without questions", async () => {
    const { calls, mock } = model({})
    await expect(askWithModel(mock).ask("Invoice 42", {})).resolves.toEqual([undefined, {}])
    expect(calls).toHaveLength(0)
  })
})
