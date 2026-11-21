import { jsonSchema, tool } from "ai"
import { describe, expect, it, vi } from "vitest"

import { emulate } from "@vite-hub/gateways"
import { languageModel } from "@vite-hub/gateways/ai-sdk"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { emulateModels } from "../src/test/emulate-models.ts"

import type { EmulatedModelRule } from "../src/test/emulate-models.ts"

const weatherRules: EmulatedModelRule[] = [
  { id: "weather-call", match: { textContains: "weather", tool: "getWeather", hasToolResult: false }, times: 1, reply: [{ type: "tool_call", name: "getWeather", arguments: { city: "Paris" } }] },
  { id: "weather-answer", match: { hasToolResult: true }, reply: [{ type: "text", text: "It is 20 C in Paris." }] },
]

function weatherAgent(api: "chat" | "messages" | "responses") {
  const getWeather = vi.fn(async ({ city }: { city: string }) => ({ city, celsius: 20 }))
  const agent = defineAgent({
    runtime: false,
    driver: {
      model: languageModel(emulate(), api === "messages" ? "claude-sonnet-4-5" : "gpt-5.1", { api }),
      instructions: "Answer weather questions with the getWeather tool.",
    },
    capabilities: [defineCapability({
      id: "weather",
      tools: () => ({
        getWeather: tool({
          description: "Get the weather of a city.",
          inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }),
          execute: getWeather,
        }),
      }),
    })],
  })
  return { agent, getWeather }
}

describe("emulateModels()", () => {
  it.each(["responses", "chat", "messages"] as const)("runs a %s model Driver Agent through a tool call and its result", async (api) => {
    await using ai = await emulateModels({ rules: weatherRules })
    const { agent, getWeather } = weatherAgent(api)

    const [error, result] = await runAgent(agent, { prompt: "What is the weather in Paris?" })

    expect(error).toBeUndefined()
    expect(result?.text).toBe("It is 20 C in Paris.")
    expect(getWeather).toHaveBeenCalledWith({ city: "Paris" }, expect.anything())
    expect((await ai.calls()).map(call => call.matched?.id)).toEqual(["weather-call", "weather-answer"])
    expect((await ai.rules()).rules.map(rule => [rule.id, rule.remaining])).toEqual([["weather-call", 0], ["weather-answer", null]])
  })

  it.each(["EMULATE_BASE_URL", "PORTLESS_URL"])("routes a plain model ID and controls to the listener despite %s", async (override) => {
    vi.stubEnv("EMULATE_BASE_URL", undefined)
    vi.stubEnv("PORTLESS_URL", undefined)
    vi.stubEnv(override, "http://localhost:9")
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    await using ai = await emulateModels({ rules: [{ id: "hello", match: { model: "openai/gpt-5.1", textContains: "Hello" }, reply: [{ type: "text", text: "Hi from a rule." }] }] })
    const agent = defineAgent({ runtime: false, driver: { model: "openai/gpt-5.1" } })

    expect(ai.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const [error, result] = await runAgent(agent, { prompt: "Hello" })

    expect(error).toBeUndefined()
    expect(result?.text).toBe("Hi from a rule.")
    expect((await ai.calls()).map(call => [call.matched?.id, call.format])).toEqual([["hello", "openai-responses"]])
  })

  it("returns the missing rule as YAML when strict mode rejects a request", async () => {
    await using ai = await emulateModels({ strict: undefined, rules: weatherRules })
    const { agent } = weatherAgent("responses")

    const [error] = await runAgent(agent, { prompt: "Hello" })

    expect(error?.code).toBe("AGENT_RUN_FAILED")
    expect(errorText(error)).toContain('No AI rule matched model "gpt-5.1" with tools ["getWeather"].')
    expect(errorText(error)).toContain("Add a matching rule to your seed configuration:\nai:\n  rules:\n    - id: matching-reply\n      match:\n        model: \"gpt-5.1\"\n        format: openai-responses")
    expect((await ai.calls()).map(call => call.matched)).toEqual([null])
  })

  it("keeps strict mode off when explicitly requested", async () => {
    await using ai = await emulateModels({ strict: false })
    expect(await ai.rules()).toMatchObject({ strict: false })
  })

  it("replaces the rules, keeps strict mode, and resets to the seed", async () => {
    await using ai = await emulateModels({ rules: weatherRules })
    const { agent } = weatherAgent("chat")

    const replaced = await ai.setRules([{ id: "greeting", match: { textContains: "Hello" }, reply: [{ type: "text", text: "Hi from a new rule." }] }])
    expect(replaced).toMatchObject({ strict: true, rules: [{ id: "greeting", remaining: null }] })
    await expect(runAgent(agent, { prompt: "Hello" })).resolves.toEqual([undefined, expect.objectContaining({ text: "Hi from a new rule." })])
    await expect(runAgent(agent, { prompt: "Goodbye" })).resolves.toEqual([expect.objectContaining({ code: "AGENT_RUN_FAILED" }), undefined])

    await ai.reset()
    expect(await ai.calls()).toEqual([])
    expect((await ai.rules()).rules.map(rule => rule.id)).toEqual(["weather-call", "weather-answer"])

    await expect(ai.setRules([{ id: "bad", match: {}, reply: "text" } as never])).rejects.toMatchObject({
      code: "AGENT_EMULATOR_RULES_INVALID",
      message: "[vitehub] The AI emulator rejected the rules: rules[0].reply: expected an array of reply events",
    })
  })

  it("rejects an invalid seed with a named diagnostic", async () => {
    await expect(emulateModels({ rules: [{ id: "bad", match: {}, reply: "text" } as never] })).rejects.toMatchObject({
      code: "AGENT_EMULATOR_RULES_INVALID",
      message: expect.stringContaining("rules[0].reply"),
    })
    expect(process.env.VITEHUB_MODELS).toBeUndefined()
  })

  it("sets both env vars while it runs and restores them when it closes", async () => {
    vi.stubEnv("VITEHUB_EMULATE_URL", "http://127.0.0.1:9")
    vi.stubEnv("VITEHUB_MODELS", undefined)
    let url: string
    {
      await using ai = await emulateModels()
      url = ai.url
      expect(url).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/)
      expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
      expect(process.env.VITEHUB_MODELS).toBe("emulate")
    }
    expect(process.env.VITEHUB_EMULATE_URL).toBe("http://127.0.0.1:9")
    expect("VITEHUB_MODELS" in process.env).toBe(false)
    await expect(fetch(`${url}/_ai/rules`)).rejects.toThrow()
  })

  it("fails a call after close with a named diagnostic, and close is idempotent", async () => {
    const ai = await emulateModels()
    await Promise.all([ai.close(), ai.close()])
    await expect(ai.calls()).rejects.toMatchObject({ code: "AGENT_EMULATOR_CLOSED" })
  })

  it("rejects overlapping startup without changing routing and restores both variables", async () => {
    vi.stubEnv("VITEHUB_EMULATE_URL", "http://127.0.0.1:9")
    vi.stubEnv("VITEHUB_MODELS", "off")
    const [first, second] = await Promise.allSettled([emulateModels(), emulateModels()])
    try {
      expect(first.status).toBe("fulfilled")
      expect(second).toMatchObject({ status: "rejected", reason: { code: "AGENT_EMULATOR_SCOPE_ACTIVE" } })
      if (first.status === "fulfilled") expect(process.env.VITEHUB_EMULATE_URL).toBe(first.value.url)
      expect(process.env.VITEHUB_MODELS).toBe("emulate")
    }
    finally {
      if (second.status === "fulfilled") await second.value.close()
      if (first.status === "fulfilled") await first.value.close()
    }
    expect(process.env.VITEHUB_EMULATE_URL).toBe("http://127.0.0.1:9")
    expect(process.env.VITEHUB_MODELS).toBe("off")
    await using next = await emulateModels()
    expect(process.env.VITEHUB_EMULATE_URL).toBe(next.url)
  })

  it("names the packages to install when they are missing", async () => {
    vi.resetModules()
    vi.doMock("@emulators/ai", () => {
      throw new Error("Cannot find package '@emulators/ai'")
    })
    try {
      const { emulateModels } = await import("../src/test/emulate-models.ts")
      await expect(emulateModels()).rejects.toMatchObject({
        code: "AGENT_EMULATOR_PACKAGES_MISSING",
        message: "[vitehub] The AI emulator of emulateModels() and agent.models.emulate needs the optional packages @emulators/core and @emulators/ai.",
        fix: expect.stringContaining("pnpm add -D @emulators/core@0.14.0 @emulators/ai@0.14.0"),
      })
      expect(process.env.VITEHUB_MODELS).toBeUndefined()
    }
    finally {
      vi.doUnmock("@emulators/ai")
    }
  })
})

function errorText(error: unknown): string {
  const parts: string[] = []
  for (let current = error; current instanceof Error; current = current.cause) {
    parts.push(current.message)
    if ("responseBody" in current && typeof current.responseBody === "string") parts.push(current.responseBody)
  }
  return parts.join("\n")
}
