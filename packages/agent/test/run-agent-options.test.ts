import { expect, it, vi } from "vitest"
import { defineAgent, defineCapability, runAgent, workflow } from "../src/index.ts"

const schedule = {
  id: "friday-2026-09-25",
  runId: "friday-run",
  scheduledAt: new Date("2026-09-25T15:00:00.000Z"),
}

it("runs a discovered Agent inline with an invocation-only tool and settled schedule text", async () => {
  const send = vi.fn(async () => "sent")
  const agent = defineAgent({
    driver: { async run({ context, tools }) {
      expect(context.get("schedule")).toMatchObject({ id: schedule.id, runId: schedule.runId })
      expect(await tools?.send_message?.execute?.({ text: "Roast" })).toBe("sent")
      return "Roast sent"
    } },
  })

  expect(agent.runtime).toMatchObject({ discoveryDefault: true, kind: "workflow" })
  await expect(runAgent(agent, { prompt: "Write the roast" }, {
    output: "drained",
    schedule,
    tools: { send_message: { name: "send_message", execute: send } },
  })).resolves.toEqual([null, "Roast sent"])
  expect(send).toHaveBeenCalledWith({ text: "Roast" })
})

it("rejects callable tools before starting an explicit Workflow", async () => {
  const run = vi.fn(() => "unreachable")
  const agent = defineAgent({ driver: { run }, runtime: workflow("durable-roast") })
  await expect(runAgent(agent, { prompt: "Write the roast" }, {
    output: "drained",
    schedule,
    tools: { send_message: { name: "send_message", execute: vi.fn() } },
  })).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining("Invocation tools cannot be used") }), null])
  expect(run).not.toHaveBeenCalled()
})

it("rejects invocation tool name collisions", async () => {
  const agent = defineAgent({
    capabilities: [defineCapability({ id: "tools", tools: { send_message: { name: "send_message" } } })],
    driver: { run: () => "unreachable" },
  })
  await expect(runAgent(agent, {}, {
    output: "drained",
    tools: { send_message: { name: "send_message", execute: vi.fn() } },
  })).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining("Invocation tool name already exists") }), null])
})

it("does not expose invocation tools to a later run", async () => {
  const observed: string[][] = []
  const agent = defineAgent({
    runtime: false,
    driver: { run({ tools }) {
      observed.push(Object.keys(tools || {}))
      return "done"
    } },
  })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }
  await runAgent(agent, runtime, {}, { tools: { send_message: { name: "send_message", execute: vi.fn() } } })
  await runAgent(agent, runtime, {})
  expect(observed).toEqual([["send_message"], []])
})

it("does not pass invocation tools to a delegated Agent", async () => {
  const send = vi.fn()
  const child = defineAgent({ runtime: false, driver: { run({ tools }) {
    expect(tools?.send_message).toBeUndefined()
    return "child done"
  } } })
  const parent = defineAgent({ runtime: false, driver: { async run(context) {
    const { tools } = context
    expect(tools?.send_message).toBeDefined()
    return await runAgent(child, context, {})
  } } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }
  await expect(runAgent(parent, runtime, {}, { tools: { send_message: { name: "send_message", execute: send } } })).resolves.toBe("child done")
  expect(send).not.toHaveBeenCalled()
})

it("keeps an empty tool set from changing Workflow selection", async () => {
  const agent = defineAgent({ driver: { run: () => "inline" } })
  const [error, result] = await runAgent(agent, {}, { tools: {}, output: "drained" })
  expect(error?.message).toContain("cannot discover an Agent Workflow")
  expect(result).toBeNull()
})

it("keeps contextual calls direct when their input has an option-like property", async () => {
  const agent = defineAgent({ runtime: false, driver: { run({ input }) {
    expect((input as typeof input & { output?: string }).output).toBe("json")
    return "direct result"
  } } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }
  await expect(runAgent(agent, runtime, { output: "json" } as never)).resolves.toBe("direct result")
})
