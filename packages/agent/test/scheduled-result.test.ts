import { expect, it, vi } from "vitest"
import { createAgentInspectionMetadata, defineAgent, runScheduledAgent } from "../src/index.ts"
import { toAgentRunResult } from "../src/output.ts"

it.each(["response", "ui-message"] as const)("settles scheduled %s streams before releasing capacity", async (kind) => {
  let release!: () => void
  let start!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { start = resolve })
  const finish = vi.fn()
  const run = vi.fn(() => {
    const stream = new ReadableStream({
      async start(controller) {
        start()
        await gate
        controller.enqueue(kind === "response"
          ? new TextEncoder().encode("Done")
          : { type: "text-delta", id: "answer", delta: "Done" })
        controller.close()
      },
    })
    return kind === "response" ? new Response(stream) : { toUIMessageStream: () => stream }
  })
  const agent = defineAgent({ driver: { capacity: { concurrency: 1 }, run }, hooks: { "agent:finish": finish } })
  const settled = vi.fn()
  const pending = runScheduledAgent(agent, { id: `scheduled-${kind}`, scheduledAt: new Date() }).then((result) => {
    settled()
    return result
  })
  await started
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).not.toHaveBeenCalled()
  expect(finish).not.toHaveBeenCalled()
  expect(createAgentInspectionMetadata(agent).config?.driver.capacity).toMatchObject({ active: 1 })
  release()
  expect(toAgentRunResult(await pending).text).toBe("Done")
  expect(finish).toHaveBeenCalledOnce()
  expect(createAgentInspectionMetadata(agent).config?.driver.capacity).toMatchObject({ active: 0 })
  expect(toAgentRunResult(await runScheduledAgent(agent, { id: `scheduled-${kind}-next`, scheduledAt: new Date() })).text).toBe("Done")
  expect(run).toHaveBeenCalledTimes(2)
})

it.each(["response", "ui-message"] as const)("propagates scheduled %s failures and releases capacity", async (kind) => {
  const failure = new Error("provider disconnected")
  const error = vi.fn()
  const agent = defineAgent({
    driver: {
      capacity: { concurrency: 1 },
      run() {
        const stream = new ReadableStream({ pull(controller) { controller.error(failure) } })
        return kind === "response" ? new Response(stream) : { toUIMessageStream: () => stream }
      },
    },
    hooks: { "agent:error": error },
  })
  await expect(runScheduledAgent(agent, { id: `scheduled-${kind}-failure`, scheduledAt: new Date() })).rejects.toThrow("provider disconnected")
  expect(createAgentInspectionMetadata(agent).config?.driver.capacity).toMatchObject({ active: 0 })
  expect(error).toHaveBeenCalledOnce()
})

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
