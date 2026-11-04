import { generateText, streamText } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

import { anthropic, chatgpt, cloudflare, cloudflareAccess, defineAiGateway, ollama, openai, openrouter, typesafe, vercel } from "../src/index.ts"
import { languageModel } from "../src/ai-sdk.ts"

import type { AiGatewayContext } from "../src/types.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

const chatCompletion = () => Response.json({
  choices: [{ finish_reason: "stop", index: 0, message: { content: "Hi", role: "assistant" } }],
  created: 1,
  id: "chatcmpl-1",
  model: "model",
  object: "chat.completion",
  usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
})

const anthropicMessage = () => Response.json({
  content: [{ text: "Hi", type: "text" }],
  id: "msg_1",
  model: "claude",
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: { input_tokens: 2, output_tokens: 1 },
})

const openaiResponse = () => Response.json({
  created_at: 1,
  id: "resp_1",
  model: "gpt",
  object: "response",
  output: [{ content: [{ annotations: [], text: "Hi", type: "output_text" }], id: "msg_1", role: "assistant", status: "completed", type: "message" }],
  status: "completed",
  usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 },
})

function sent(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0) {
  const [url, init] = fetch.mock.calls[index]!
  return { body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers), url: String(url) }
}

describe("languageModel()", () => {
  it("calls OpenAI Chat Completions at the openai-compatible URL by default", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-key")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const model = languageModel(openrouter(), "google/gemini-3-flash", { fetch })
    expect(model).toMatchObject({ modelId: "google/gemini-3-flash", provider: "openrouter.chat", specificationVersion: "v4" })

    await expect(generateText({ model, prompt: "Hello" })).resolves.toMatchObject({ text: "Hi", usage: { inputTokens: 2, outputTokens: 1 } })
    const request = sent(fetch)
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(request.headers.get("authorization")).toBe("Bearer or-key")
    expect(request.body).toMatchObject({ model: "google/gemini-3-flash" })
  })

  it("asks for token counts in streamed chat responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi", role: "assistant" }, index: 0 }], created: 1, id: "c", model: "m", object: "chat.completion.chunk" })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], created: 1, id: "c", model: "m", object: "chat.completion.chunk", usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }))
    const result = streamText({ model: languageModel(ollama({ url: "http://gpu:11434" }), "llama3.3", { fetch }), prompt: "Hello" })
    expect(await result.text).toBe("Hi")
    expect(await result.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 })
    const request = sent(fetch)
    expect(request.url).toBe("http://gpu:11434/v1/chat/completions")
    expect(request.headers.get("authorization")).toBe("Bearer ollama")
    expect(request.body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })

  it("calls Anthropic Messages at the claude-code URL with the gateway's auth header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => anthropicMessage())
    await expect(generateText({ model: languageModel(anthropic({ apiKey: "ant-key" }), "claude-sonnet-5-5", { fetch }), prompt: "Hello" })).resolves.toMatchObject({ text: "Hi" })
    await generateText({ model: languageModel(openrouter({ apiKey: "or-key" }), "anthropic/claude-sonnet-5-5", { api: "messages", fetch }), prompt: "Hello" })

    const direct = sent(fetch, 0)
    expect(direct.url).toBe("https://api.anthropic.com/v1/messages")
    expect(direct.headers.get("x-api-key")).toBe("ant-key")
    expect(direct.headers.has("authorization")).toBe(false)
    const routed = sent(fetch, 1)
    expect(routed.url).toBe("https://openrouter.ai/api/v1/messages")
    expect(routed.headers.get("authorization")).toBe("Bearer or-key")
    expect(routed.headers.has("x-api-key")).toBe(false)
  })

  it("calls OpenAI Responses at the openai-compatible URL, or at the codex URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => openaiResponse())
    await expect(generateText({ model: languageModel(openai({ apiKey: "oa-key" }), "gpt-5", { api: "responses", fetch }), prompt: "Hello" })).resolves.toMatchObject({ text: "Hi" })
    const codexOnly = defineAiGateway({ apiKey: "proxy-key", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" })
    await generateText({ model: languageModel(codexOnly, "gpt-5", { fetch }), prompt: "Hello" })

    expect(sent(fetch, 0)).toMatchObject({ url: "https://api.openai.com/v1/responses" })
    expect(sent(fetch, 0).headers.get("authorization")).toBe("Bearer oa-key")
    expect(sent(fetch, 1)).toMatchObject({ url: "https://proxy.example/v1/responses" })
    expect(sent(fetch, 1).headers.get("authorization")).toBe("Bearer proxy-key")
  })

  it.each(["openai-compatible", "codex"] as const)("keeps the gateway x-api-key authoritative for Responses through %s", async (route) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => JSON.parse(String(init?.body)).stream
      ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: await openaiResponse().json() })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : openaiResponse())
    let apiKey = "proxy-key"
    const definition = { apiKey: async () => apiKey, auth: "x-api-key", headers: { "x-custom": "value" }, name: "internal" } as const
    const options = { api: "responses", fetch } as const
    const model = route === "codex"
      ? languageModel(defineAiGateway({ ...definition, baseURL: { codex: "https://proxy.example/v1" } }), "gpt-5", options)
      : languageModel(defineAiGateway({ ...definition, baseURL: { "openai-compatible": "https://proxy.example/v1" } }), "gpt-5", options)
    await expect(generateText({ headers: { "authorization": "Bearer wrong", "x-api-key": "wrong", "x-call": "value" }, model, prompt: "Hello" })).resolves.toMatchObject({ text: "Hi" })
    apiKey = "rotated-key"
    await streamText({ headers: { "Authorization": "Bearer wrong", "X-Api-Key": "wrong", "x-call": "value" }, model, prompt: "Hello" }).usage

    expect(fetch).toHaveBeenCalledTimes(2)
    for (const index of [0, 1]) {
      expect(sent(fetch, index).url).toBe("https://proxy.example/v1/responses")
      expect(sent(fetch, index).headers.get("x-api-key")).toBe(index === 0 ? "proxy-key" : "rotated-key")
      expect(sent(fetch, index).headers.has("authorization")).toBe(false)
      expect(sent(fetch, index).headers.get("x-custom")).toBe("value")
      expect(sent(fetch, index).headers.get("x-call")).toBe("value")
    }
  })

  it.each([
    { api: "chat", response: chatCompletion },
    { api: "responses", response: openaiResponse },
    { api: "messages", response: anthropicMessage },
  ] as const)("reads $api URL capabilities without resolving gateway values", async ({ api, response }) => {
    const apiKey = vi.fn(async (_context: AiGatewayContext) => "proxy-key")
    const baseURL = vi.fn(async (_context: AiGatewayContext) => "https://proxy.example")
    const header = vi.fn(async (_context: AiGatewayContext) => "value")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response())
    const gateway = defineAiGateway({ apiKey, baseURL: { "claude-code": baseURL, "openai-compatible": baseURL }, headers: { "x-custom": header }, name: "internal" })
    const model = languageModel(gateway, "model", { api, fetch })
    const urls = await model.supportedUrls
    if (api === "chat") expect(urls).toEqual({})
    else {
      expect(urls["image/*"]?.some(pattern => pattern.test("https://example.com/image.png"))).toBe(true)
      expect(urls["application/pdf"]?.some(pattern => pattern.test("https://example.com/document.pdf"))).toBe(true)
    }
    for (const resolver of [apiKey, baseURL, header]) expect(resolver).not.toHaveBeenCalled()

    const controller = new AbortController()
    await generateText({ abortSignal: controller.signal, model, prompt: "Hello" })
    for (const resolver of [apiKey, baseURL, header]) {
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal)
    }
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("cancels a pending credential lookup with the model request", async () => {
    const controller = new AbortController()
    const reason = new Error("Cancelled credential lookup")
    let start: () => void = () => undefined
    const started = new Promise<void>((resolve) => { start = resolve })
    const apiKey = vi.fn(async ({ abortSignal }: AiGatewayContext) => {
      if (!abortSignal) throw new Error("Credential lookup needs the request abort signal")
      start()
      await new Promise<void>((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
      })
      return "proxy-key"
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
    const gateway = defineAiGateway({ apiKey, baseURL: { "openai-compatible": "https://proxy.example" }, name: "internal" })
    const request = generateText({ abortSignal: controller.signal, maxRetries: 0, model: languageModel(gateway, "model", { fetch }), prompt: "Hello" })
    const cancelled = started.then(() => controller.abort(reason))
    await expect(request).rejects.toBe(reason)
    await cancelled
    expect(apiKey).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([undefined, false, true])("preserves OpenRouter Responses store options (%s)", async (store) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => openaiResponse())
    const model = languageModel(openrouter({ apiKey: "or-key" }), "openai/gpt-5", { api: "responses", fetch })
    await generateText({ model, prompt: "Hello", providerOptions: { openai: { ...(store === undefined ? {} : { store }), parallelToolCalls: false } } })
    expect(sent(fetch).url).toBe("https://openrouter.ai/api/v1/responses")
    expect(sent(fetch).body).toMatchObject({ parallel_tool_calls: false })
    if (store === undefined) expect(sent(fetch).body).not.toHaveProperty("store")
    else expect(sent(fetch).body).toMatchObject({ store })
  })

  it.each([undefined, true])("applies OpenRouter Responses store options to streams (%s)", async (store) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: await openaiResponse().json() })}\n\n`, { headers: { "content-type": "text/event-stream" } }))
    const model = languageModel(openrouter({ apiKey: "or-key" }), "openai/gpt-5", { api: "responses", fetch })
    const result = streamText({ model, prompt: "Hello", ...(store === undefined ? {} : { providerOptions: { openai: { store } } }) })
    await result.usage
    expect(sent(fetch).body).toMatchObject({ stream: true })
    if (store === undefined) expect(sent(fetch).body).not.toHaveProperty("store")
    else expect(sent(fetch).body).toMatchObject({ store })
  })

  it("rejects Cloudflare Responses before sending a request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    // @ts-expect-error Cloudflare /compat implements only Chat Completions.
    expect(() => languageModel(cloudflare({ providerApiKey: "key" }), "openai/gpt-5", { api: "responses", fetch })).toThrow(expect.objectContaining({ code: "GATEWAYS_R0004" }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { api: "chat", path: "/v1/chat/completions", response: chatCompletion },
    { api: "responses", path: "/v1/responses", response: openaiResponse },
    { api: "messages", path: "/claude-code/v1/messages", response: anthropicMessage },
  ] as const)("preserves Vercel OIDC authentication for $api models", async ({ api, path, response }) => {
    vi.stubEnv("VITEHUB_VERCEL_API_KEY", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("VITEHUB_VERCEL_OIDC_TOKEN", undefined)
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-token")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response())
    const gateway = vercel({ headers: { "Ai-Gateway-Auth-Method": "api-key", "x-custom": "value" } })
    await generateText({ model: languageModel(gateway, "model", { api, fetch }), prompt: "Hello" })
    expect(sent(fetch).url).toBe(`https://ai-gateway.vercel.sh${path}`)
    expect(sent(fetch).headers.get("authorization")).toBe("Bearer oidc-token")
    expect(sent(fetch).headers.get("ai-gateway-auth-method")).toBe("oidc")
    expect(sent(fetch).headers.get("x-custom")).toBe("value")
  })

  it.each(["explicit", "resolver", "env", "vitehub"] as const)("keeps Vercel %s API keys authoritative even when they equal the OIDC token", async (source) => {
    vi.stubEnv("VITEHUB_VERCEL_API_KEY", source === "vitehub" ? "same-value" : undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", source === "env" ? "same-value" : undefined)
    vi.stubEnv("VITEHUB_VERCEL_OIDC_TOKEN", undefined)
    vi.stubEnv("VERCEL_OIDC_TOKEN", "same-value")
    const gateway = vercel({
      ...(source === "explicit" ? { apiKey: "same-value" } : source === "resolver" ? { apiKey: async () => "same-value" } : {}),
      headers: { "ai-gateway-auth-method": "oidc" },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    await generateText({ model: languageModel(gateway, "model", { fetch }), prompt: "Hello" })
    expect(sent(fetch).headers.get("authorization")).toBe("Bearer same-value")
    expect(sent(fetch).headers.get("ai-gateway-auth-method")).toBe("api-key")
  })

  it("refreshes the Vercel credential source and token for each model request", async () => {
    vi.stubEnv("VITEHUB_VERCEL_API_KEY", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("VITEHUB_VERCEL_OIDC_TOKEN", "first-token")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const model = languageModel(vercel({ headers: { "AI-GATEWAY-AUTH-METHOD": "oidc" } }), "model", { fetch })
    await generateText({ model, prompt: "Hello" })
    vi.stubEnv("AI_GATEWAY_API_KEY", "api-key")
    await generateText({ model, prompt: "Hello" })
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("VITEHUB_VERCEL_OIDC_TOKEN", "rotated-token")
    await generateText({ model, prompt: "Hello" })

    expect(sent(fetch, 0).headers.get("authorization")).toBe("Bearer first-token")
    expect(sent(fetch, 0).headers.get("ai-gateway-auth-method")).toBe("oidc")
    expect(sent(fetch, 1).headers.get("authorization")).toBe("Bearer api-key")
    expect(sent(fetch, 1).headers.get("ai-gateway-auth-method")).toBe("api-key")
    expect(sent(fetch, 2).headers.get("authorization")).toBe("Bearer rotated-token")
    expect(sent(fetch, 2).headers.get("ai-gateway-auth-method")).toBe("oidc")
  })

  it("does not fall back to OIDC when an explicit Vercel API key is empty", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-token")
    const fetch = vi.fn<typeof globalThis.fetch>()
    const model = languageModel(vercel({ apiKey: undefined }), "model", { fetch })
    await expect(generateText({ maxRetries: 0, model, prompt: "Hello" })).rejects.toMatchObject({ code: "GATEWAYS_R0002" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("routes Cloudflare AI Gateway models with stored provider keys, a request key, or both", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account")
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "docs")
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_TOKEN", "cf-token")
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_API_KEY", undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    await generateText({ model: languageModel(cloudflare(), "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", { fetch }), prompt: "Hello" })
    await generateText({ model: languageModel(cloudflare({ providerApiKey: "openai-key", token: undefined }), "openai/gpt-5", { fetch }), prompt: "Hello" })

    const stored = sent(fetch, 0)
    expect(stored.url).toBe("https://gateway.ai.cloudflare.com/v1/account/docs/compat/chat/completions")
    expect(stored.headers.get("cf-aig-authorization")).toBe("Bearer cf-token")
    expect(stored.headers.has("authorization")).toBe(false)
    expect(stored.body).toMatchObject({ model: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" })
    const requestKey = sent(fetch, 1)
    expect(requestKey.headers.get("authorization")).toBe("Bearer openai-key")
    expect(requestKey.headers.has("cf-aig-authorization")).toBe(false)
  })

  it("keeps the TypeSafe key of cloudflare().ask() out of its model requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const gateway = cloudflare({ accountId: "account", gatewayId: "docs", providerApiKey: undefined, token: "cf-token", typesafeApiKey: "ts-key" })
    await generateText({ model: languageModel(gateway, "openai/gpt-5", { fetch }), prompt: "Hello" })
    expect(sent(fetch).headers.has("authorization")).toBe(false)
    expect(sent(fetch).headers.get("cf-aig-authorization")).toBe("Bearer cf-token")
    // SAFETY: The type rejects apiKey; this checks the runtime error for JavaScript callers.
    expect(() => cloudflare({ apiKey: "ts-key" } as never)).toThrow(expect.objectContaining({ code: "GATEWAYS_R0001", message: expect.stringContaining("typesafeApiKey") }))
  })

  it("fails before any request when Cloudflare has neither a token nor a provider key", async () => {
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_TOKEN", undefined)
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_API_KEY", undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const model = languageModel(cloudflare({ accountId: "account", gatewayId: "docs" }), "openai/gpt-5", { fetch })
    await expect(generateText({ maxRetries: 0, model, prompt: "Hello" })).rejects.toMatchObject({ code: "GATEWAYS_R0002", message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_TOKEN") })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends extra headers and reads the key again for each request", async () => {
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "id")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "secret")
    vi.stubEnv("OPENROUTER_API_KEY", "first")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => chatCompletion())
    const model = languageModel(openrouter({ headers: cloudflareAccess() }), "m", { fetch })
    await generateText({ model, prompt: "Hello" })
    vi.stubEnv("OPENROUTER_API_KEY", "rotated")
    await generateText({ model, prompt: "Hello" })

    expect(sent(fetch, 0).headers.get("cf-access-client-id")).toBe("id")
    expect(sent(fetch, 0).headers.get("authorization")).toBe("Bearer first")
    expect(sent(fetch, 1).headers.get("authorization")).toBe("Bearer rotated")
  })

  it("rejects a model API that the gateway does not serve when the model is created", () => {
    // @ts-expect-error openai() has no claude-code URL.
    expect(() => languageModel(openai({ apiKey: "k" }), "gpt-5", { api: "messages" })).toThrow(expect.objectContaining({ code: "GATEWAYS_R0004" }))
    // @ts-expect-error typesafe() serves no model API.
    expect(() => languageModel(typesafe({ apiKey: "k" }), "jev")).toThrow(expect.objectContaining({ code: "GATEWAYS_R0004" }))
    expect(() => languageModel(openai({ apiKey: "k" }), " ")).toThrow(expect.objectContaining({ code: "GATEWAYS_R0001" }))
    // @ts-expect-error chatgpt() is a Codex Driver descriptor, not a model gateway.
    expect(() => languageModel(chatgpt(), "gpt-5")).toThrow(expect.objectContaining({ code: "GATEWAYS_R0001" }))
  })
})
