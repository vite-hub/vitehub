import { describe, expectTypeOf, it } from "vitest"

import { ask } from "../src/ask.ts"
import { anthropic, cliproxy, cloudflare, defineAiGateway, litellm, ollama, openai, openrouter, typesafe, vercel } from "../src/gateways.ts"
import { defineAgent } from "../src/index.ts"

import type { AiGateway, AiGatewayAsk } from "../src/gateways.ts"
import type { AskChoiceAnswer } from "../src/ask.ts"

describe("AI gateway capabilities", () => {
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

  it("accepts every gateway as driver.gateway", () => {
    expectTypeOf(vercel()).toExtend<AiGateway>()
    expectTypeOf(cliproxy()).toExtend<AiGateway>()
    defineAgent({ driver: { gateway: vercel(), kind: "codex" } })
    defineAgent({ driver: { gateway: cliproxy(), kind: "claude-code" } })
  })
})
