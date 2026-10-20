import { afterEach, expect, it, vi } from "vitest"
import { defineAgent, defineCapability, runAgent, workflow } from "../src/index.ts"
import { setAgentHostCapabilities } from "../src/server/internal.ts"

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

it("forwards runtime capabilities through standalone scheduled runs", async () => {
  const connections = { runtime: vi.fn() }
  const agent = defineAgent({
    runtime: false,
    capabilities: [defineCapability({
      id: "runtime-capability-check",
      requires: [{ primitive: "connections" }],
      tools: context => ({
        runtime_capability: {
          name: "runtime_capability",
      execute: (_input: unknown) => Object.keys(context.capabilities),
        },
      }),
    })],
    driver: { async run({ tools }) {
      return (await tools?.runtime_capability?.execute?.({}) as string[]).includes("connections") ? "available" : "missing"
    } },
  })

  await expect(runAgent(agent, { prompt: "Check runtime" }, {
    output: "drained",
    runtimeContext: { capabilities: { connections } },
    schedule,
  })).resolves.toEqual([null, "available"])
})

function capabilityProbeAgent() {
  return defineAgent({
    runtime: false,
    capabilities: [defineCapability({
      id: "host-capability-probe",
      tools: context => ({
        host_capabilities: {
          name: "host_capabilities",
          execute: (_input: unknown) => ({ connections: context.capabilities.connections, kv: context.capabilities.kv }),
        },
      }),
    })],
    driver: { async run({ tools }) {
      return JSON.stringify(await tools?.host_capabilities?.execute?.({}))
    } },
  })
}

afterEach(() => setAgentHostCapabilities(undefined))

it("gives standalone runs the registered host runtime capabilities", async () => {
  setAgentHostCapabilities({ connections: { name: "host-connections" }, kv: { name: "host-kv" } })

  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check host" }, { output: "drained", schedule }))
    .resolves.toEqual([null, JSON.stringify({ connections: { name: "host-connections" }, kv: { name: "host-kv" } })])
})

it("lets runtimeContext capabilities override one host capability", async () => {
  setAgentHostCapabilities({ connections: { name: "host-connections" }, kv: { name: "host-kv" } })

  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check override" }, {
    output: "drained",
    runtimeContext: { capabilities: { connections: { name: "caller-connections" } } },
    schedule,
  })).resolves.toEqual([null, JSON.stringify({ connections: { name: "caller-connections" }, kv: { name: "host-kv" } })])
})

it("keeps standalone runs without host capabilities when no host registered them", async () => {
  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check standalone" }, { output: "drained", schedule }))
    .resolves.toEqual([null, JSON.stringify({})])
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

it("adds invocation capabilities after the Agent's own for one run only", async () => {
  const observed: string[][] = []
  const own = defineCapability({ id: "own", tools: { own_tool: { name: "own_tool" } } })
  const agent = defineAgent({
    runtime: false,
    capabilities: [own],
    driver: { run({ tools }) {
      observed.push(Object.keys(tools || {}))
      return "done"
    } },
  })
  const send = vi.fn(async () => "sent")
  const delivery = defineCapability({
    id: "job-delivery",
    tools: { send_message: { name: "send_message", execute: send } },
  })

  await expect(runAgent(agent, { prompt: "Send the brief" }, { output: "drained", schedule, capabilities: [delivery] }))
    .resolves.toEqual([null, "done"])
  await expect(runAgent(agent, { prompt: "Send the brief" }, { output: "drained", schedule }))
    .resolves.toEqual([null, "done"])
  expect(observed).toEqual([["own_tool", "send_message"], ["own_tool"]])
  expect(agent.capabilities?.map(capability => capability.id)).toEqual(["own"])
})

it("runs a discovered Agent inline when it receives invocation capabilities", async () => {
  const agent = defineAgent({ driver: { run: ({ tools }) => Object.keys(tools || {}).join(",") } })
  const delivery = defineCapability({ id: "job-delivery", tools: { send_message: { name: "send_message", execute: vi.fn() } } })
  await expect(runAgent(agent, { prompt: "Send" }, { output: "drained", schedule, capabilities: [delivery] }))
    .resolves.toEqual([null, "send_message"])
})

it("rejects invocation capabilities before starting an explicit Workflow", async () => {
  const run = vi.fn(() => "unreachable")
  const agent = defineAgent({ driver: { run }, runtime: workflow("durable-brief") })
  const delivery = defineCapability({ id: "job-delivery", tools: { send_message: { name: "send_message", execute: vi.fn() } } })
  await expect(runAgent(agent, { prompt: "Send" }, { output: "drained", schedule, capabilities: [delivery] }))
    .resolves.toEqual([expect.objectContaining({ message: expect.stringContaining("Invocation capabilities cannot be used") }), null])
  expect(run).not.toHaveBeenCalled()
})

it("rejects an invocation capability that repeats an Agent Capability id", async () => {
  const agent = defineAgent({
    runtime: false,
    capabilities: [defineCapability({ id: "delivery" })],
    driver: { run: () => "unreachable" },
  })
  const [error, result] = await runAgent(agent, {}, { output: "drained", capabilities: [defineCapability({ id: "delivery" })] })
  expect(error?.message).toContain("Duplicate capability id \"delivery\"")
  expect(result).toBeNull()
})

it("rejects an invocation capability that adds Workspace Sources", async () => {
  const run = vi.fn(() => "unreachable")
  const agent = defineAgent({ runtime: false, driver: { run } })
  const [error] = await runAgent(agent, {}, {
    output: "drained",
    capabilities: [defineCapability({ id: "docs", workspaceSources: {} })],
  })
  expect(error?.message).toContain("cannot contribute workspaceSources")
  expect(run).not.toHaveBeenCalled()
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

it("keeps a standalone input with a runtime field in tuple mode", async () => {
  const agent = defineAgent({ runtime: false, driver: { run: () => "standalone result" } })
  await expect(runAgent(agent, { runtime: "user data" } as never, { output: "drained" })).resolves.toEqual([null, "standalone result"])
})
