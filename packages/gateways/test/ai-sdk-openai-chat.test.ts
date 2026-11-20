import { generateText, streamText, tool } from "ai"
import { describe, expect, it, vi } from "vitest"

import { languageModel } from "../src/ai-sdk.ts"
import { ask, defineAiGateway, openai, openrouter } from "../src/index.ts"

// The app installed `@ai-sdk/openai` for OpenAI, and not `@ai-sdk/openai-compatible`.
vi.mock("@ai-sdk/openai-compatible", () => {
  throw new Error("Cannot find package '@ai-sdk/openai-compatible'")
})

const chatCompletion = (content = "Hi") => Response.json({
  choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
  created: 1,
  id: "chatcmpl-1",
  model: "gpt-5-mini",
  object: "chat.completion",
  usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
})

const receiptJsonSchema = {
  type: "object",
  properties: { total: { type: "number" }, currency: { type: "string" } },
  required: ["total"],
}

const receipt = {
  "~standard": {
    jsonSchema: { input: () => receiptJsonSchema, output: () => receiptJsonSchema },
    validate: (value: unknown) => {
      if (typeof value === "object" && value !== null && "total" in value && typeof value.total === "number") {
        return { value: { total: value.total, currency: "currency" in value ? String(value.currency) : "USD" } }
      }
      return { issues: [{ message: "Expected a receipt total" }] }
    },
    vendor: "test",
    version: 1 as const,
  },
}

const callOptions = {
  prompt: "Hello",
  providerOptions: { openai: { parallelToolCalls: true, parallel_tool_calls: false, n: 1, top_logprobs: 2, logprobs: true } },
  tools: { lookup: tool({ inputSchema: receipt }) },
}

function sent(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) {
  const [url, init] = fetch.mock.calls[0]!
  return { body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers), url: String(url) }
}

describe("languageModel(openai(), id) without @ai-sdk/openai-compatible", () => {
  it("calls OpenAI Chat Completions with @ai-sdk/openai", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const model = languageModel(openai({ apiKey: "oa-key", headers: { "x-team": "evals" } }), "gpt-5-mini", { fetch })
    expect(model).toMatchObject({ modelId: "gpt-5-mini", provider: "openai.chat" })

    await expect(generateText({ model, ...callOptions })).resolves.toMatchObject({ text: "Hi", usage: { inputTokens: 2, outputTokens: 1 } })
    const request = sent(fetch)
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions")
    expect(request.headers.get("authorization")).toBe("Bearer oa-key")
    expect(request.headers.get("x-team")).toBe("evals")
    expect(request.body).toMatchObject({ model: "gpt-5-mini", parallel_tool_calls: false, n: 1, top_logprobs: 2, logprobs: true })
  })

  it("keeps ask() schemas with optional fields in JSON mode and validates the reply locally", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } }
      return body.response_format?.type === "json_object"
        ? chatCompletion('{"total":10}')
        : Response.json({ error: { message: "Optional fields are not allowed in strict schemas" } }, { status: 400 })
    })
    const model = languageModel(openai({ apiKey: "oa-key" }), "gpt-5-mini", { fetch })

    await expect(ask("Return a receipt as JSON", { model, schema: receipt })).resolves.toEqual([undefined, { total: 10, currency: "USD" }])
    expect(sent(fetch).body.response_format).toEqual({ type: "json_object" })
  })

  it("asks for token counts in streamed responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi", role: "assistant" }, index: 0 }], created: 1, id: "c", model: "m", object: "chat.completion.chunk" })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], created: 1, id: "c", model: "m", object: "chat.completion.chunk", usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }))
    const result = streamText({ model: languageModel(openai({ apiKey: "oa-key" }), "gpt-5-mini", { fetch }), ...callOptions })
    expect(await result.text).toBe("Hi")
    expect(await result.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 })
    expect(sent(fetch).body).toMatchObject({ parallel_tool_calls: false, stream: true, stream_options: { include_usage: true } })
  })

  it("still names @ai-sdk/openai-compatible for another gateway's chat model", async () => {
    const model = languageModel(openrouter({ apiKey: "or-key" }), "google/gemini-3-flash", { fetch: vi.fn<typeof globalThis.fetch>() })
    await expect(generateText({ model, prompt: "Hello" })).rejects.toMatchObject({
      code: "GATEWAYS_R0010",
      message: expect.stringContaining("pnpm add @ai-sdk/openai-compatible"),
    })
  })

  it("does not select the native SDK for a custom gateway with the OpenAI name and URL", async () => {
    const gateway = defineAiGateway({ name: "openai", baseURL: { "openai-compatible": "https://api.openai.com/v1" }, apiKey: "oa-key" })
    const model = languageModel(gateway, "gpt-5-mini")
    await expect(generateText({ model, prompt: "Hello" })).rejects.toMatchObject({
      code: "GATEWAYS_R0010",
      message: expect.stringContaining("pnpm add @ai-sdk/openai-compatible"),
    })
  })
})
