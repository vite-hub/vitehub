import { APICallError } from "@ai-sdk/provider"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, expectTypeOf, it } from "vitest"

import { languageModel } from "../src/ai-sdk.ts"
import { ask, openrouter } from "../src/index.ts"

interface Receipt {
  merchant: string
  amount: number
}

const receiptJsonSchema = {
  properties: { amount: { type: "number" }, merchant: { type: "string" } },
  required: ["merchant", "amount"],
  type: "object",
}

function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "merchant") === "string" && typeof Reflect.get(value, "amount") === "number"
}

/** A Standard Schema with JSON Schema conversion, as Zod 4 and ArkType make. */
const receipt = {
  "~standard": {
    jsonSchema: { input: () => structuredClone(receiptJsonSchema), output: () => structuredClone(receiptJsonSchema) },
    types: undefined as { input: unknown, output: Receipt } | undefined,
    validate: (value: unknown) => isReceipt(value)
      ? { value: { ...value, merchant: value.merchant.toUpperCase() } }
      : { issues: [{ message: "Expected a number", path: [{ key: "amount" }] }] },
    vendor: "test",
    version: 1 as const,
  },
}

function model(reply: () => string) {
  const calls: { prompt: unknown, responseFormat: unknown }[] = []
  const mock = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt, responseFormat: options.responseFormat })
      return {
        content: [{ text: reply(), type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 20, total: 20 }, outputTokens: { reasoning: 0, text: 5, total: 5 } },
        warnings: [],
      }
    },
  })
  return { calls, mock }
}

describe("ask(prompt, { model, schema? })", () => {
  it("returns the data that the schema validated, from one request", async () => {
    const { calls, mock } = model(() => JSON.stringify({ amount: -34.9, merchant: "Mercadona" }))
    const usage: unknown[] = []
    const [error, data] = await ask("MERCADONA 23.10 -34.90 EUR", {
      instructions: "Read the bank transaction.",
      model: mock,
      onUsage: entry => usage.push(entry),
      schema: receipt,
    })

    expect(error).toBeUndefined()
    // The schema output, after its own transforms.
    expect(data).toEqual({ amount: -34.9, merchant: "MERCADONA" })
    expectTypeOf(data).toEqualTypeOf<Receipt | undefined>()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.responseFormat).toMatchObject({ schema: { ...receiptJsonSchema, additionalProperties: false }, type: "json" })
    expect(calls[0]!.prompt).toEqual([
      { content: "Read the bank transaction.", role: "system" },
      { content: [{ text: "MERCADONA 23.10 -34.90 EUR", type: "text" }], role: "user" },
    ])
    expect(usage).toEqual([{ model: "mock-model-id", provider: "mock-provider", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }])
  })

  it("returns GATEWAYS_ASK_OUTPUT_INVALID when the answer does not match the schema", async () => {
    const { mock } = model(() => JSON.stringify({ amount: "a lot", merchant: "Mercadona" }))
    const [error, data] = await ask("MERCADONA 23.10 -34.90 EUR", { model: mock, schema: receipt })
    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_OUTPUT_INVALID", message: "[vitehub] The model answer to ask() is not JSON that the schema accepts: amount: Expected a number" })
    expect(error?.cause).toMatchObject({ name: "AI_NoObjectGeneratedError" })
  })

  it("returns GATEWAYS_ASK_OUTPUT_INVALID when the answer is not JSON", async () => {
    const { mock } = model(() => "Mercadona, 34.90")
    const [error] = await ask("MERCADONA 23.10 -34.90 EUR", { model: mock, schema: receipt })
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_OUTPUT_INVALID" })
  })

  it.each(["content-filter", "length"] as const)("returns GATEWAYS_ASK_OUTPUT_INVALID for an empty %s response", async (reason) => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [],
        finishReason: { raw: reason, unified: reason },
        usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 20, total: 20 }, outputTokens: { reasoning: 0, text: 0, total: 0 } },
        warnings: [],
      }),
    })
    const [error, data] = await ask("MERCADONA 23.10 -34.90 EUR", { model: mock, schema: receipt })
    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_OUTPUT_INVALID", cause: { name: "AI_NoOutputGeneratedError" } })
  })

  it("returns GATEWAYS_ASK_MODEL_FAILED with the HTTP status when the provider fails", async () => {
    const providerError = new APICallError({ isRetryable: false, message: "Unauthorized", requestBodyValues: {}, statusCode: 401, url: "https://openrouter.ai/api/v1/chat/completions" })
    const mock = new MockLanguageModelV3({ doGenerate: async () => { throw providerError } })
    const [error, data] = await ask("MERCADONA 23.10 -34.90 EUR", { model: mock, schema: receipt })
    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_MODEL_FAILED", message: "[vitehub] The ask() model request failed with HTTP 401." })
    expect(error?.cause).toBe(providerError)
  })

  it("throws a gateway setup error, such as a missing key, instead of returning it", async () => {
    const model = languageModel(openrouter({ apiKey: "" }), "google/gemini-3-flash")
    await expect(ask("MERCADONA 23.10 -34.90 EUR", { model, schema: receipt })).rejects.toMatchObject({ code: "GATEWAYS_R0002" })
  })

  it("throws GATEWAYS_ASK_SCHEMA_INVALID for a schema without JSON Schema conversion", async () => {
    const { calls, mock } = model(() => "{}")
    const { jsonSchema: _, ...standard } = receipt["~standard"]
    await expect(ask("MERCADONA", { model: mock, schema: { "~standard": { ...standard, vendor: "valibot" } } })).rejects.toMatchObject({
      code: "GATEWAYS_ASK_SCHEMA_INVALID",
      message: "ask() needs a schema that converts to JSON Schema, and this valibot schema does not",
    })
    // @ts-expect-error A plain JSON Schema is not a Standard Schema.
    await expect(ask("MERCADONA", { model: mock, schema: receiptJsonSchema })).rejects.toMatchObject({ code: "GATEWAYS_ASK_SCHEMA_INVALID" })
    expect(calls).toHaveLength(0)
  })

  it("throws GATEWAYS_ASK_PROMPT_INVALID for an empty prompt", async () => {
    const { mock } = model(() => "{}")
    await expect(ask(" ", { model: mock, schema: receipt })).rejects.toMatchObject({ code: "GATEWAYS_ASK_PROMPT_INVALID" })
  })

  it("returns the answer text without a schema", async () => {
    const { calls, mock } = model(() => "Mercadona charged 34.90 EUR on 23 October.")
    const usage: unknown[] = []
    const [error, text] = await ask("Summarize: MERCADONA 23.10 -34.90 EUR", {
      instructions: "Answer in one sentence.",
      model: mock,
      onUsage: entry => usage.push(entry),
    })

    expect(error).toBeUndefined()
    expect(text).toBe("Mercadona charged 34.90 EUR on 23 October.")
    expectTypeOf(text).toEqualTypeOf<string | undefined>()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.responseFormat).toBeUndefined()
    expect(calls[0]!.prompt).toEqual([
      { content: "Answer in one sentence.", role: "system" },
      { content: [{ text: "Summarize: MERCADONA 23.10 -34.90 EUR", type: "text" }], role: "user" },
    ])
    expect(usage).toEqual([{ model: "mock-model-id", provider: "mock-provider", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }])
  })

  it.each(["content-filter", "length"] as const)("returns GATEWAYS_ASK_OUTPUT_INVALID for a %s response without text", async (reason) => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [],
        finishReason: { raw: reason, unified: reason },
        usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 20, total: 20 }, outputTokens: { reasoning: 0, text: 0, total: 0 } },
        warnings: [],
      }),
    })
    const [error, text] = await ask("Summarize: MERCADONA 23.10 -34.90 EUR", { model: mock })
    expect(text).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_OUTPUT_INVALID", message: `[vitehub] The model answer to ask() has no text. The model stopped with finish reason "${reason}".` })
  })

  it("returns GATEWAYS_ASK_MODEL_FAILED without a schema when the provider fails", async () => {
    const providerError = new APICallError({ isRetryable: false, message: "Too Many Requests", requestBodyValues: {}, statusCode: 429, url: "https://openrouter.ai/api/v1/chat/completions" })
    const mock = new MockLanguageModelV3({ doGenerate: async () => { throw providerError } })
    const controller = new AbortController()
    const [error, text] = await ask("Summarize: MERCADONA 23.10 -34.90 EUR", { model: mock, signal: controller.signal })
    expect(text).toBeUndefined()
    expect(error).toMatchObject({ code: "GATEWAYS_ASK_MODEL_FAILED", message: "[vitehub] The ask() model request failed with HTTP 429." })
  })

  it("keeps the Jev question builders on ask", () => {
    expect(ask.if("Is it spam?")).toEqual({ instructions: "Is it spam?", threshold: 0.5, type: "if" })
    expect(Object.keys(ask).sort()).toEqual(["chance", "choice", "each", "if", "score", "switch"])
  })
})
