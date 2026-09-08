import { expect, it, vi } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../../agent/src/invocations.ts"
import invocationsHandler from "../src/console/runtime/server/invocations.get.ts"

const getConsoleInvocations = vi.hoisted(() => vi.fn())
vi.mock("../src/console/runtime/server/invocations.ts", () => ({ getConsoleInvocations }))

it.each(["list", "ids"])("polls 50 session summaries using only finish observations through %s", async (mode) => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = new Date().toISOString()
  for (let index = 0; index < 50; index++) {
    store.create({
      createdAt: timestamp,
      id: `session-${index}`,
      observations: [{
        attributes: { output: "large tool payload" },
        name: "agent.tool.call",
        sequence: 1,
        timestamp,
        type: "run",
      }, {
        attributes: { "usage.record": { usage: { totalTokens: 42 } } },
        name: "agent.invocation.finish",
        sequence: 2,
        timestamp,
        type: "run",
      }],
      status: "completed",
      traceId: `trace-${index}`,
      updatedAt: timestamp,
    })
  }
  const get = vi.spyOn(store, "get")
  getConsoleInvocations.mockReturnValue(defineAgentInvocations({ store }))
  const url = new URL("http://localhost/invocations")
  if (mode === "ids") {
    for (let index = 0; index < 50; index++) url.searchParams.append("id", `session-${index}`)
  }
  const result = await invocationsHandler({ method: "GET", req: { url } })
  expect(result.invocations).toHaveLength(50)
  for (const summary of result.invocations) {
    expect(summary).toMatchObject({ usage: { totalTokens: 42 } })
    expect(summary).not.toHaveProperty("observations")
  }
  expect(get).toHaveBeenCalledTimes(50)
  for (const call of get.mock.calls) {
    expect(call[1]).toEqual({ observationNames: ["agent.invocation.finish"] })
  }
})
