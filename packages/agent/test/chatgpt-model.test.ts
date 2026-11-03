import { afterEach, expect, it } from "vitest"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import * as v from "valibot"
import { chatgpt as chatgptGateway, openai } from "@vite-hub/gateways"
import { chatgpt } from "../../connections/src/chatgpt.ts"
import { defineConnection } from "../../connections/src/definition.ts"
import { useChatGPTCredential } from "../../connections/src/internal/agent-credential.ts"
import { createConnectionsRuntime } from "../../connections/src/runtime.ts"
import { createChatGPTFake } from "../../connections/test/chatgpt-fake.ts"
import { createStore } from "../../connections/test/helpers.ts"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { chatgptPlanRequest, collectStream } from "../src/internal/chatgpt-model.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const fake = await createChatGPTFake()
  cleanup.push(fake.close)
  const runtime = createConnectionsRuntime({
    definitions: { chatgpt: defineConnection({ provider: { ...chatgpt({ appName: "My SIWC app", appVersion: "1.0.0" }), api: `${fake.origin}/v1` }, access: { "agent:assistant": { read: true } } }) },
    store: createStore(), fetch: fake.fetch,
  })
  const authorization = await runtime.authorize({ name: "chatgpt", redirectUri: "http://127.0.0.1:1455/callback" })
  const callback = await fake.callback(authorization.url)
  await runtime.complete({ state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, clientId: callback.searchParams.get("client_id")! })
  const calls: string[] = []
  const agent = defineAgent({
    name: "assistant", runtime: false,
    capabilities: [defineCapability({ id: "siwc-test", tools: { siwc_echo: { name: "siwc_echo", description: "Echo a value.", inputSchema: v.object({ text: v.string() }), execute: async ({ text }) => { calls.push(text); return text } } } })],
    driver: { model: "gpt-6.1-sol", gateway: chatgptGateway(), instructions: "Reply with a short greeting." },
  })
  const host = {
    runtime: "vite" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => undefined,
    capabilities: { connections: { runtime: () => runtime, useChatGPTCredential: useChatGPTCredential(runtime) } },
  }
  return { calls, fake, run: () => runAgent(agent, host, { prompt: "Hello", context: { "chat.sessionId": "siwc-session" }, timeout: 30_000 }) }
}

it("answers on the ChatGPT plan over HTTP with the request that plan usage accepts", async () => {
  const test = await fixture()
  const result = await test.run()
  expect(result).toMatchObject({ text: "Hello from the local ChatGPT fake." })
  expect(test.fake.state.requests).toHaveLength(1)
  const request = test.fake.state.requests[0]!
  expect(request).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true, input: expect.any(Array), include: ["reasoning.encrypted_content"] })
  for (const key of ["temperature", "top_p", "max_output_tokens", "previous_response_id", "metadata", "user", "truncation"]) expect(key in request).toBe(false)
  expect(JSON.stringify(request)).not.toContain('"role":"system"')
  expect(JSON.stringify(request)).toContain("Reply with a short greeting.")
  expect(test.fake.state.originators).toEqual(["My SIWC app"])
  expect(JSON.stringify(result)).not.toMatch(/test-access-|test-refresh-/)
})

it("runs the Agent's tools between plan requests", async () => {
  const test = await fixture()
  test.fake.state.onResponse = () => test.fake.state.requests.length === 1
    ? { type: "function_call", id: "fc_siwc", call_id: "call_siwc", name: "siwc_echo", arguments: JSON.stringify({ text: "SIWC_TOOL_OK" }), status: "completed" }
    : undefined
  const result = await test.run()
  expect(test.calls).toEqual(["SIWC_TOOL_OK"])
  expect(test.fake.state.requests).toHaveLength(2)
  expect(test.fake.state.requests[0]?.tools).toEqual([expect.objectContaining({ type: "namespace", name: "functions", tools: [expect.objectContaining({ type: "function", name: "siwc_echo" })] })])
  expect(JSON.stringify(test.fake.state.requests[1]?.input)).toContain("function_call_output")
  expect(test.fake.state.requests[1]).toMatchObject({ store: false, stream: true })
  expect(result).toMatchObject({ text: "Hello from the local ChatGPT fake." })
})

it("maps plan errors to the ChatGPT diagnostics", async () => {
  const limit = await fixture()
  limit.fake.state.streamError = "subscription_sharing_usage_limit_exceeded"
  await expect(limit.run()).rejects.toMatchObject({ code: "AGENT_R1017" })
  const unauthorized = await fixture()
  unauthorized.fake.state.responseError = { code: "invalid_token", status: 401 }
  await expect(unauthorized.run()).rejects.toMatchObject({ code: "AGENT_R1016" })
})

it("rejects fields and tools that plan usage does not accept", () => {
  expect(chatgptPlanRequest({ model: "m", store: true, stream: false, temperature: 0.2, previous_response_id: "resp_1", input: [{ role: "system", content: "Rules" }] }))
    .toEqual({ model: "m", store: false, stream: true, input: [{ role: "developer", content: "Rules" }] })
  expect(() => chatgptPlanRequest({ tools: [{ type: "image_generation" }] })).toThrow(expect.objectContaining({ code: "AGENT_R1019" }))
})

it.each(["text", "reasoning"] as const)("preserves %s order when a source arrives before its end", async (type) => {
  const source = { type: "source", sourceType: "url", id: "source-1", url: "https://example.com" } as const
  const parts: LanguageModelV4StreamPart[] = [
    { type: `${type}-start`, id: "part-1", providerMetadata: { openai: { itemId: "item-1" } } },
    { type: `${type}-delta`, id: "part-1", delta: "Hello", providerMetadata: { openai: { delta: true } } },
    source,
    { type: `${type}-delta`, id: "part-1", delta: " world" },
    { type: `${type}-end`, id: "part-1", providerMetadata: { openai: { complete: true } } },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 3, total: 3 },
      outputTokens: { reasoning: 0, text: 1, total: 1 },
    } },
  ]
  const result = await collectStream({ stream: new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(part)
    controller.close()
  } }) })
  expect(result.content).toEqual([
    { type, text: "Hello world", providerMetadata: { openai: { itemId: "item-1", delta: true, complete: true } } },
    source,
  ])
})

it.each(["function", "custom", "programmatic_tool_calling", "shell", "apply_patch"])("rejects top-level %s tools locally", (type) => {
  expect(() => chatgptPlanRequest({ tools: [{ type, name: "tool" }] })).toThrow(expect.objectContaining({ code: "AGENT_R1019" }))
})

it("accepts namespaced function/custom tools and web search", () => {
  const tools = [
    { type: "namespace", name: "functions", tools: [{ type: "function", name: "echo" }, { type: "custom", name: "custom" }] },
    { type: "web_search" }, { type: "web_search_preview" },
  ]
  expect(chatgptPlanRequest({ tools }).tools).toEqual(tools)
})

it("rejects unsupported tools inside namespaces", () => {
  expect(() => chatgptPlanRequest({ tools: [{ type: "namespace", name: "functions", tools: [{ type: "programmatic_tool_calling" }] }] }))
    .toThrow(expect.objectContaining({ code: "AGENT_R1019" }))
})

it("accepts only chatgpt() with a model ID as the gateway of a model-backed Driver", () => {
  expect(() => defineAgent({ name: "a", runtime: false, driver: { model: "gpt-5.1-mini", gateway: openai() as never } })).toThrow(expect.objectContaining({ code: "AGENT_R0976" }))
  expect(() => defineAgent({ name: "a", runtime: false, driver: { model: () => "gpt-6.1-sol", gateway: chatgptGateway() } })).toThrow(expect.objectContaining({ code: "AGENT_R0514" }))
})
