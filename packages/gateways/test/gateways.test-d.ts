import { describe, expectTypeOf, it } from "vitest"

import { anthropic, ask, chatgpt, cliproxy, cloudflare, defineAiGateway, litellm, ollama, openai, openrouter, typesafe, vercel } from "../src/index.ts"

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
      // @ts-expect-error A Driver-only gateway has no ask().
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
})
