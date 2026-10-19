import { defineAgent, runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { describe, expect, it, vi } from "vitest"

import { createUsageSummary } from "../src/console/runtime/server/usage.ts"

describe("Console usage of a truncated finish observation", () => {
  it("keeps the usage totals when a long result text truncates the finish observation", async () => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxStringLength: 128 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        async run() {
          return { text: "long answer ".repeat(64), usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
        },
      },
      invocations,
      runtime: false,
    })
    await runAgent(agent, { memo: vi.fn(), run: { runId: "long-result" }, runtime: "unknown", waitUntil: vi.fn() }, {})

    const record = await invocations.getByRunId("long-result")
    const finish = record?.observations.find(observation => observation.name === "agent.invocation.finish")
    // The result text exceeds the string limit, so the Agent marks the whole observation truncated.
    expect(finish?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(finish?.attributes?.["usage.record"]).toMatchObject({ usage: { totalTokens: 5 } })

    const summary = await createUsageSummary(invocations, { now: new Date(Date.now() + 1_000) })
    expect(summary).toMatchObject({
      available: true,
      // The partial notice still tells the reader that some evidence was bounded.
      partial: true,
      totals: { inputTokens: 2, inputTokensAvailable: true, invocations: 1, outputTokens: 3, totalTokens: 5, totalTokensAvailable: true },
    })
  })
})
