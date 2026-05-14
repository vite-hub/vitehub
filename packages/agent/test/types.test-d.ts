import { describe, expectTypeOf, it } from "vitest"

import type { AgentAdapter, AgentRuntimeContext } from "../src/types.ts"
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
})
