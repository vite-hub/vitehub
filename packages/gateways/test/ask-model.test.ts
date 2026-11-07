import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it } from "vitest"

import { ask, askWithModel } from "../src/index.ts"

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
    const answers = await askWithModel(mock).ask("BAR PEPE 12.50 EUR", {
      category: ask.choice("Which category fits this bank transaction?", { eatingOut: "Restaurants and cafes.", groceries: "Food shopping.", other: null }),
      recurring: ask.if("Is it a recurring payment?", { threshold: 0.6 }),
      risk: ask.score("How risky is it?", ["None", "Some", "High"]),
      team: ask.switch("Which team answers?", ["billing", "support"]),
      urgent: ask.chance("Is it urgent?"),
    }, { onUsage: entry => usage.push(entry) })

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
    const { team } = await askWithModel(mock).ask("Invoice 42", { team: ask.choice("Which team?", ["billing", "support"]) })
    expect(team).toMatchObject({ choice: "billing", confidence: 0, probabilities: { billing: 0.5, support: 0.5 } })
  })

  it("rejects an answer that is not an option", async () => {
    const { mock } = model({ team: { choice: "sales", confidence: 0.9 } })
    await expect(askWithModel(mock).ask("Invoice 42", { team: ask.choice("Which team?", ["billing", "support"]) })).rejects.toMatchObject({ code: "GATEWAYS_R0012" })
  })

  it("sends no request without questions", async () => {
    const { calls, mock } = model({})
    await expect(askWithModel(mock).ask("Invoice 42", {})).resolves.toEqual({})
    expect(calls).toHaveLength(0)
  })
})
