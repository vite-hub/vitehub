import { describe, expectTypeOf, it } from "vitest"

import { claudeCodeDriver, codexDriver, defineAgent, runAgentInline, type AgentRuntimeContext } from "../src/index.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

describe("provider Agent Driver types", () => {
  it("preserves structured output inference while invocation input evidences its options", () => {
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const schema = {} as StandardSchemaV1<unknown, { summary: string }>
    const codex = defineAgent({
      driver: codexDriver({ output: { schema } }),
    })
    const claude = defineAgent({
      driver: claudeCodeDriver({ output: { schema } }),
    })
    const driver = codexDriver({ output: { schema } })

    // @ts-expect-error Built-in drivers do not claim call options without an input-bearing Agent contract.
    void driver.withCallOptions

    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    expectTypeOf(runAgentInline(codex, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    expectTypeOf(runAgentInline(claude, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
  })
})
