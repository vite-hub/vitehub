import { describe, expectTypeOf, it } from "vitest"

import { claudeCodeDriver, codexDriver, defineAgent, runAgentInline, type AgentRuntimeContext } from "../src/index.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

describe("provider Agent Driver types", () => {
  it("preserves structured output inference with invocation options", () => {
    const schema = {} as StandardSchemaV1<unknown, { summary: string }>
    const codex = defineAgent({
      driver: codexDriver({ output: { schema } }).withCallOptions<{ checkout: string }>(),
    })
    const claude = defineAgent({
      driver: claudeCodeDriver({ output: { schema } }).withCallOptions<{ checkout: string }>(),
    })

    expectTypeOf(runAgentInline(codex, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
    expectTypeOf(runAgentInline(claude, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
  })
})
