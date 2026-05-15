import { describe, expectTypeOf, it } from "vitest"

import type { AgentAdapter, AgentRuntimeContext } from "../src/types.ts"
import type { WorkspaceAgentDefinition } from "../src/index.ts"
import { runAgent, streamAgent } from "../src/index.ts"

describe("agent public types", () => {
  it("accepts direct adapters as agent inputs", () => {
    const adapter: AgentAdapter = {
      generate: async () => ({ text: "ok" }),
      name: "direct",
    }
    const context = { runtime: "unknown" } as AgentRuntimeContext

    expectTypeOf(runAgent(adapter, context, { prompt: "hello" })).toMatchTypeOf<Promise<unknown>>()
    expectTypeOf(streamAgent(adapter, context, { prompt: "hello" })).toMatchTypeOf<Promise<unknown>>()
  })

  it("accepts skills-enabled workspace agents", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expectTypeOf(defineAgent({
      model: {} as never,
    })).not.toMatchTypeOf<WorkspaceAgentDefinition>()

    expectTypeOf(defineAgent({
      skills: true,
      model: {} as never,
    })).toMatchTypeOf<WorkspaceAgentDefinition>()

    expectTypeOf(defineAgent({
      skills: {
        authoring: true,
        dir: "skills",
      },
      model: {} as never,
    })).toMatchTypeOf<WorkspaceAgentDefinition>()
  })
})
