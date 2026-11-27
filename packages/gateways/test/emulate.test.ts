import { Output, generateObject, generateText, jsonSchema, stepCountIs, streamText, tool } from "ai"
import { createEmulator } from "emulate"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { emulate } from "../src/index.ts"
import { languageModel } from "../src/ai-sdk.ts"
import { resolveAiGatewayRoute } from "../src/internal.ts"

import type { AiFormat, AiSeedConfig } from "@emulators/ai"
import type { Emulator } from "emulate"
import type { AiGateway } from "../src/index.ts"

const apis = [
  { api: "chat", format: "openai-chat", model: "gpt-5.1" },
  { api: "responses", format: "openai-responses", model: "gpt-5.1" },
  { api: "messages", format: "anthropic-messages", model: "claude-sonnet-4-5" },
] as const

type Rule = NonNullable<AiSeedConfig["rules"]>[number]

function rules(api: string, format: AiFormat): Rule[] {
  return [
    { id: `${api}-tool-call`, match: { format, textContains: "weather", tool: "getWeather", hasToolResult: false }, times: 1, reply: [{ type: "tool_call", name: "getWeather", arguments: { city: "Paris" } }] },
    { id: `${api}-tool-result`, match: { format, hasToolResult: true }, reply: [{ type: "text", text: "It is 20 C in Paris." }] },
    { id: `${api}-object`, match: { format, textContains: "city as JSON" }, reply: [{ type: "object", value: { city: "Paris" } }] },
    { id: `${api}-stream`, match: { format, textContains: "Hello", stream: true }, reply: [{ type: "text", text: "Streamed hello." }] },
    { id: `${api}-text`, match: { format, textContains: "Hello", stream: false }, reply: [{ type: "text", text: "Hello from the emulator." }] },
  ]
}

let emulator: Emulator

beforeAll(async () => {
  const seed: AiSeedConfig = { strict: true, rules: apis.flatMap(({ api, format }) => rules(api, format)) }
  emulator = await createEmulator({ service: "ai", port: 0, seed: { ai: seed } })
})

afterAll(async () => {
  await emulator?.close()
})

beforeEach(async () => {
  await fetch(`${emulator.url}/_ai/calls`, { method: "DELETE" })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function matchedRules(): Promise<unknown[]> {
  const calls = await (await fetch(`${emulator.url}/_ai/calls`)).json() as { matched: { id?: string } | null }[]
  return calls.map(call => call.matched?.id ?? call.matched)
}

describe("emulate()", () => {
  it.each(apis)("answers $api text, stream, tool, and object requests from scripted rules", async ({ api, model: id }) => {
    const model = languageModel(emulate({ url: emulator.url }), id, { api })
    expect(model.provider).toBe(`emulate.${api}`)

    await expect(generateText({ model, prompt: "Hello" })).resolves.toMatchObject({ text: "Hello from the emulator." })

    const stream = streamText({ model, prompt: "Hello" })
    expect(await stream.text).toBe("Streamed hello.")

    const getWeather = tool({
      description: "Get the weather of a city.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }),
      execute: async ({ city }) => ({ city, celsius: 20 }),
    })
    const withTool = await generateText({ model, prompt: "What is the weather in Paris?", tools: { getWeather }, stopWhen: stepCountIs(2) })
    expect(withTool.steps[0]?.toolCalls).toMatchObject([{ toolName: "getWeather", input: { city: "Paris" } }])
    expect(withTool.steps[0]?.toolResults).toMatchObject([{ toolName: "getWeather", output: { city: "Paris", celsius: 20 } }])
    expect(withTool.text).toBe("It is 20 C in Paris.")

    const object = await generateObject({
      model,
      prompt: "Give the city as JSON.",
      schema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }),
    })
    expect(object.object).toEqual({ city: "Paris" })

    expect(await matchedRules()).toEqual([`${api}-text`, `${api}-stream`, `${api}-tool-call`, `${api}-tool-result`, `${api}-object`])
  })

  it.each(apis)("sends the output schema on $api, so an object without a rule passes the schema", async ({ api, model: id }) => {
    const unseeded = await createEmulator({ service: "ai", port: 0 })
    try {
      const { output } = await generateText({
        model: languageModel(emulate({ url: unseeded.url }), id, { api }),
        prompt: "Give the city.",
        output: Output.object({ schema: jsonSchema<{ city: string, celsius: number }>({ type: "object", properties: { city: { type: "string" }, celsius: { type: "number" } }, required: ["city", "celsius"], additionalProperties: false }) }),
      })
      expect(output).toEqual({ city: expect.any(String), celsius: expect.any(Number) })
      const calls = await (await fetch(`${unseeded.url}/_ai/calls`)).json() as { matched: unknown }[]
      expect(calls).toMatchObject([{ matched: { default: "json_schema" } }])
    }
    finally {
      await unseeded.close()
    }
  })

  it("routes AI SDK requests without a key and has no Codex URL", async () => {
    expect(emulate({ url: "http://127.0.0.1:4100/v1/" }).baseURL).toEqual({ "claude-code": "http://127.0.0.1:4100", "openai-compatible": "http://127.0.0.1:4100/v1" })
    vi.stubEnv("VITEHUB_EMULATE_URL", undefined)
    vi.stubEnv("OPENAI_API_KEY", "must-not-be-read")
    expect(await resolveAiGatewayRoute(emulate(), "openai-compatible", {})).toEqual({ apiKey: "emulate", auth: "bearer", baseURL: "http://localhost:4014/v1", headers: [] })
    expect(await resolveAiGatewayRoute(emulate(), "claude-code", {})).toMatchObject({ apiKey: "emulate", baseURL: "http://localhost:4014" })
    // @ts-expect-error The emulator rejects the tools that the Codex CLI sends, so the Codex Driver cannot take emulate().
    const codexGateway: AiGateway<{ routes: "codex" }> = emulate()
    expect(codexGateway.baseURL).not.toHaveProperty("codex")
  })

  it("reads VITEHUB_EMULATE_URL, and url overrides it", async () => {
    vi.stubEnv("VITEHUB_EMULATE_URL", emulator.url)
    await expect(generateText({ model: languageModel(emulate(), "gpt-5.1", { api: "responses" }), prompt: "Hello" })).resolves.toMatchObject({ text: "Hello from the emulator." })
    const env = vi.fn(async () => "http://127.0.0.1:9")
    expect(await resolveAiGatewayRoute(emulate(), "openai-compatible", { env })).toMatchObject({ baseURL: "http://127.0.0.1:9/v1" })
    expect(env).toHaveBeenCalledWith("emulate", "url")

    vi.stubEnv("VITEHUB_EMULATE_URL", "http://127.0.0.1:9")
    await expect(generateText({ model: languageModel(emulate({ url: emulator.url }), "gpt-5.1", { api: "chat" }), prompt: "Hello" })).resolves.toMatchObject({ text: "Hello from the emulator." })
    expect(await matchedRules()).toEqual(["responses-text", "chat-text"])
  })
})
