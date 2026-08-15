import { describe, expectTypeOf, it } from "vitest"

import { claudeCodeDriver, codexDriver, defineAgent, runAgentInline, type AgentRuntimeContext } from "../src/index.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

describe("provider Agent Driver types", () => {
  it("carries invocation options into trusted-host Box callbacks", () => {
    const driver = codexDriver({ model: "gpt-5.6-sol" }).withCallOptions<{ checkout: string }>()

    defineAgent({
      box: {
        runtime: "trusted-host",
        cwd: ({ input }) => {
          expectTypeOf(input.options).toEqualTypeOf<{ checkout: string } | undefined>()
          return input.options!.checkout
        },
      },
      driver,
    })
  })

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
