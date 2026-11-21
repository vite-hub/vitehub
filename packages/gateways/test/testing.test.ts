import { describe, expect, it, vi } from "vitest"

import { ask } from "../src/index.ts"
import { getPublicAiGatewayDiagnostic } from "../src/internal.ts"
import { hasValidChoiceAnswer } from "../src/jev.ts"
import { answers, scriptedAsk } from "../src/testing.ts"

const questions = {
  category: ask.choice("Which category fits?", { groceries: "Food shops.", other: "Anything else.", rent: "Housing." }),
  fits: ask.chance("Does any category fit?"),
  size: ask.score("How large is it?", ["Small.", "Medium.", "Large."]),
  spam: ask.if("Is it spam?"),
  tone: ask.switch("Which tone?", { calm: null, angry: null }),
}

const firstAnswer = (_key: string, question: Parameters<typeof answers.first>[0]) => answers.first(question)

describe("scriptedAsk()", () => {
  it("answers each question from the script, records the call, and reports usage", async () => {
    const onUsage = vi.fn()
    const controller = new AbortController()
    const { calls, gateway } = scriptedAsk((key, question) => key === "category" ? answers.choice(question, "rent", 0.7) : answers.first(question), { usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 } })
    const [error, output] = await gateway.ask("Pay the landlord", questions, { onUsage, signal: controller.signal })
    expect(error).toBeUndefined()
    expect(output).toEqual({
      category: { choice: "rent", confidence: expect.closeTo(0.55), probabilities: { groceries: expect.closeTo(0.15), other: expect.closeTo(0.15), rent: 0.7 }, type: "choice" },
      fits: { chance: 1, type: "chance" },
      size: expect.objectContaining({ score: 0, type: "score" }),
      spam: true,
      tone: "calm",
    })
    expect(calls).toEqual([{ questions, signal: controller.signal, state: "Pay the landlord" }])
    expect(onUsage).toHaveBeenCalledWith({ provider: "scripted", usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 } })
  })

  it("returns GATEWAYS_R0008 and GATEWAYS_R0009 with public text, and reports no usage", async () => {
    const onUsage = vi.fn()
    const [rejected] = await scriptedAsk(firstAnswer, { error: "GATEWAYS_R0008" }).gateway.ask("x", questions, { onUsage })
    expect(rejected).toMatchObject({ code: "GATEWAYS_R0008", providerStatus: 401, status: 503 })
    expect(getPublicAiGatewayDiagnostic(rejected)?.message).toContain("rejected the API key with HTTP 401")
    const [failing] = await scriptedAsk(firstAnswer, { error: "GATEWAYS_R0009" }).gateway.ask("x", questions, { onUsage })
    expect(failing).toMatchObject({ code: "GATEWAYS_R0009", providerStatus: 503, status: 502 })
    expect(getPublicAiGatewayDiagnostic(failing)?.message).toContain("failed with HTTP 503 after 3 attempts")
    expect(onUsage).not.toHaveBeenCalled()
  })

  it("throws for a missing answer and for a choice answer that a real gateway rejects", async () => {
    const missing = scriptedAsk(() => undefined as never).gateway
    await expect(missing.ask("x", { fits: questions.fits })).rejects.toMatchObject({ code: "GATEWAYS_JEV_RESPONSE_INVALID" })
    const wrong = scriptedAsk(() => ({ choice: "rent", confidence: 1, probabilities: { rent: 2 }, type: "choice" })).gateway
    await expect(wrong.ask("x", { category: questions.category })).rejects.toMatchObject({ code: "GATEWAYS_JEV_RESPONSE_INVALID" })
  })

  it("stops on an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(scriptedAsk(firstAnswer).gateway.ask("x", questions, { signal: controller.signal })).rejects.toThrow()
  })

  it("rejects answers that do not match their questions", async () => {
    const cases = [
      [questions.spam, answers.chance(0)],
      [questions.tone, "unknown"],
      [questions.fits, true],
      [questions.size, answers.chance(1)],
      [questions.category, { choice: "rent", confidence: 0.4, probabilities: { groceries: 0.6, other: 0, rent: 0.4 }, type: "choice" as const }],
    ] as const
    for (const [question, answer] of cases) {
      await expect(scriptedAsk(() => answer).gateway.ask("x", { question })).rejects.toThrow()
    }
  })
})

describe("answers", () => {
  it("builds choice answers that pass the Jev check", () => {
    expect(hasValidChoiceAnswer(questions.category, answers.choice(questions.category, "groceries"))).toBe(true)
    expect(hasValidChoiceAnswer(questions.category, answers.choice(questions.category, "other", 1 / 3))).toBe(true)
    expect(hasValidChoiceAnswer(questions.category, answers.first(questions.category))).toBe(true)
  })

  it("builds a score answer with its legend and ratio", () => {
    expect(answers.score(questions.size, 2)).toEqual({
      confidence: 1,
      legend: { 0: "Small.", 1: "Medium.", 2: "Large." },
      probabilities: { 0: 0, 1: 0, 2: 1 },
      ratio: 1,
      score: 2,
      type: "score",
    })
  })

  it("throws GATEWAYS_TESTING_ANSWER_INVALID for a wrong label, level, probability, or question type", () => {
    const code = { code: "GATEWAYS_TESTING_ANSWER_INVALID" }
    expect(() => answers.choice(questions.category, "food" as never)).toThrow(expect.objectContaining(code))
    expect(() => answers.choice(questions.category, "other", 0.2)).toThrow(expect.objectContaining(code))
    expect(() => answers.choice(questions.fits, "yes")).toThrow(expect.objectContaining(code))
    expect(() => answers.score(questions.size, 3)).toThrow(expect.objectContaining(code))
    expect(() => answers.chance(1.5)).toThrow(expect.objectContaining(code))
  })
})
