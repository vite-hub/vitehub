import { describe, expectTypeOf, it } from "vitest"

import { anthropic, ask, chatgpt, cliproxy, cloudflare, defineAiGateway, litellm, ollama, openai, openrouter, typesafe, vercel } from "../src/index.ts"

import { languageModel } from "../src/ai-sdk.ts"

import type { LanguageModelV4 } from "@ai-sdk/provider"
import type { AiGateway, AiGatewayAsk, AskChoiceAnswer } from "../src/index.ts"

describe("AI gateway capabilities", () => {
  it("keeps ChatGPT credentials and model calls behind the Agent runtime", () => {
    const gateway = chatgpt({ connection: "personal" })
    expectTypeOf(gateway.kind).toEqualTypeOf<"chatgpt">()
    // @ts-expect-error A descriptor cannot resolve tokens in application code.
    void gateway.apiKey
    // @ts-expect-error Model calls on this grant require a future model Driver integration.
    void gateway.ask
  })
  it("gives ask() only to gateways that answer Jev questions", () => {
    expectTypeOf(typesafe().ask).toEqualTypeOf<AiGatewayAsk>()
    expectTypeOf(vercel().ask).toEqualTypeOf<AiGatewayAsk>()
    expectTypeOf(cloudflare().ask).toEqualTypeOf<AiGatewayAsk>()
    for (const gateway of [cliproxy(), litellm(), ollama(), openrouter(), openai(), anthropic(), defineAiGateway({ apiKey: "k", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" })]) {
      // @ts-expect-error A model-only gateway has no ask().
      void gateway.ask("state", { spam: ask.if("Is it spam?") })
    }
  })

  it("types the answers from the questions", () => {
    const answers = typesafe().ask("Invoice 42", { label: ask.choice("Which label?", ["invoice", "none"]), spam: ask.if("Is it spam?") })

    expectTypeOf(answers).resolves.toEqualTypeOf<{
      readonly label: AskChoiceAnswer<{ invoice: null, none: null }>
      readonly spam: boolean
    }>()
  })

  it("accepts every gateway as AiGateway", () => {
    expectTypeOf(vercel()).toExtend<AiGateway>()
    expectTypeOf(cliproxy()).toExtend<AiGateway>()
    expectTypeOf(typesafe()).toExtend<AiGateway<{ ask: true }>>()
  })

  it("types the model APIs that each gateway serves", () => {
    const codexGateway = (gateway: AiGateway<{ routes: "codex" }>) => gateway
    const claudeGateway = (gateway: AiGateway<{ routes: "claude-code" }>) => gateway
    codexGateway(openrouter())
    codexGateway(vercel())
    codexGateway(defineAiGateway({ apiKey: "k", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" }))
    claudeGateway(anthropic())
    // @ts-expect-error anthropic() does not serve Codex.
    codexGateway(anthropic())
    // @ts-expect-error openai() does not serve Claude Code.
    claudeGateway(openai())
    // @ts-expect-error cloudflare() serves AI SDK models and ask(), not Drivers.
    codexGateway(cloudflare())
    // @ts-expect-error typesafe() serves no model API.
    codexGateway(typesafe())
  })

  it("accepts only gateways and model APIs that serve AI SDK models", () => {
    expectTypeOf(languageModel(openrouter(), "google/gemini-3-flash")).toEqualTypeOf<LanguageModelV4>()
    languageModel(openrouter(), "m", { api: "messages" })
    languageModel(openai(), "m", { api: "responses" })
    languageModel(cloudflare(), "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast")
    languageModel(defineAiGateway({ apiKey: "k", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" }), "m", { api: "responses" })
    // @ts-expect-error A codex-only gateway has no Chat Completions URL.
    languageModel(defineAiGateway({ apiKey: "k", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" }), "m", { api: "chat" })
    // @ts-expect-error anthropic() serves Anthropic Messages only.
    languageModel(anthropic(), "m", { api: "chat" })
    // @ts-expect-error typesafe() serves no model API.
    languageModel(typesafe(), "m")
    // @ts-expect-error cloudflare() takes typesafeApiKey or providerApiKey, not apiKey.
    cloudflare({ apiKey: "k" })
  })
})
