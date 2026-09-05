import { expect, it } from "vitest"
import { defineAgent, runScheduledAgent } from "../src/index.ts"
import { toAgentRunResult } from "../src/output.ts"

it("returns the final scheduled response without requiring invocation telemetry", async () => {
  const agent = defineAgent({ driver: { async *run() {
    yield { type: "text-delta", phase: "commentary", text: "Inspecting the checks", id: "progress" }
    yield { type: "text-delta", phase: "final", text: "Repair ", id: "answer" }
    yield { type: "text-delta", phase: "final", text: "complete.", id: "answer" }
    yield { type: "finish" }
  } } })
  const result = await runScheduledAgent(agent, { id: "scheduled-final-result", scheduledAt: new Date() })
  expect(toAgentRunResult(result).text).toBe("Repair complete.")
})


it("propagates scheduled stream failures and closes the generator", async () => {
  let closed = false
  const agent = defineAgent({ driver: { async *run() {
    try {
      yield { type: "text-delta", phase: "commentary", text: "Starting" }
      throw new Error("provider disconnected")
    }
    finally { closed = true }
  } } })
  await expect(runScheduledAgent(agent, { id: "scheduled-failure", scheduledAt: new Date() })).rejects.toThrow("provider disconnected")
  expect(closed).toBe(true)
})

it("validates a structured scheduled result and returns its typed fields", async () => {
  const agent = defineAgent({ driver: {
    output: { schema: { "~standard": { version: 1 as const, vendor: "test", validate(value: unknown) {
      return value && typeof value === "object" && "text" in value && value.text === "Done"
        ? { value: { text: "Done", disposition: "park" } }
        : { issues: [{ message: "Invalid result" }] }
    } } } },
    async *run() {
      yield { type: "text-delta", phase: "final", text: '{"text":"Done","disposition":"park"}' }
      yield { type: "finish" }
    },
  } })
  expect(await runScheduledAgent(agent, { id: "scheduled-structured", scheduledAt: new Date() })).toMatchObject({ text: "Done", disposition: "park" })
})
