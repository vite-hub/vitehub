import { afterEach, expect, it, vi } from "vitest"
import { defineAgent, defineCapability, runAgent, agentWorkflow } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { setAgentHostCapabilities } from "../src/server/internal.ts"
import { installAgentRegistry } from "#vitehub/agent/registry"

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
    schedule,
    tools: { send_message: { name: "send_message", execute: send } },
  })).resolves.toEqual([undefined, expect.objectContaining({ text: "Roast sent" })])
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
    runtimeContext: { capabilities: { connections } },
    schedule,
  })).resolves.toEqual([undefined, expect.objectContaining({ text: "available" })])
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

  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check host" }, { schedule }))
    .resolves.toEqual([undefined, expect.objectContaining({ text: JSON.stringify({ connections: { name: "host-connections" }, kv: { name: "host-kv" } }) })])
})

it("loads the host routes before a standalone run, so a Schedule gets their capabilities", async () => {
  // The routes load on their first request. Here no request came first, as in a Worker that a cron trigger starts.
  installAgentRegistry({ default: {}, metadata: {}, loadAgentHost: async () => setAgentHostCapabilities({ kv: { name: "host-kv" } }) })
  try {
    await expect(runAgent(capabilityProbeAgent(), { prompt: "Check host" }, { schedule }))
      .resolves.toEqual([undefined, expect.objectContaining({ text: JSON.stringify({ kv: { name: "host-kv" } }) })])
  }
  finally {
    installAgentRegistry({ default: {}, metadata: {} })
  }
})

it("lets runtimeContext capabilities override one host capability", async () => {
  setAgentHostCapabilities({ connections: { name: "host-connections" }, kv: { name: "host-kv" } })

  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check override" }, {
    runtimeContext: { capabilities: { connections: { name: "caller-connections" } } },
    schedule,
  })).resolves.toEqual([undefined, expect.objectContaining({ text: JSON.stringify({ connections: { name: "caller-connections" }, kv: { name: "host-kv" } }) })])
})

it("keeps standalone runs without host capabilities when no host registered them", async () => {
  await expect(runAgent(capabilityProbeAgent(), { prompt: "Check standalone" }, { schedule }))
    .resolves.toEqual([undefined, expect.objectContaining({ text: JSON.stringify({}) })])
})

it("runs an explicit Workflow Agent inline with invocation tools", async () => {
  const send = vi.fn(async () => "sent")
  const agent = defineAgent({
    driver: { async run({ tools }) {
      return await tools?.send_message?.execute?.({ text: "Roast" })
    } },
    runtime: agentWorkflow("durable-roast"),
  })
  await expect(runAgent(agent, { prompt: "Write the roast" }, {
    schedule,
    tools: { send_message: { name: "send_message", execute: send } },
  })).resolves.toEqual([undefined, expect.objectContaining({ text: "sent" })])
  expect(send).toHaveBeenCalledOnce()
})

it("rejects invocation tool name collisions", async () => {
  const agent = defineAgent({
    capabilities: [defineCapability({ id: "tools", tools: { send_message: { name: "send_message" } } })],
    driver: { run: () => "unreachable" },
  })
  await expect(runAgent(agent, {}, {
    tools: { send_message: { name: "send_message", execute: vi.fn() } },
  })).resolves.toEqual([expect.objectContaining({ code: "AGENT_RUN_FAILED", cause: expect.objectContaining({ message: expect.stringContaining("Invocation tool name already exists") }) }), undefined])
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
  await runAgentWithContext(agent, runtime, {}, { tools: { send_message: { name: "send_message", execute: vi.fn() } } })
  await runAgentWithContext(agent, runtime, {})
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

  await expect(runAgent(agent, { prompt: "Send the brief" }, { schedule, capabilities: [delivery] }))
    .resolves.toEqual([undefined, expect.objectContaining({ text: "done" })])
  await expect(runAgent(agent, { prompt: "Send the brief" }, { schedule }))
    .resolves.toEqual([undefined, expect.objectContaining({ text: "done" })])
  expect(observed).toEqual([["own_tool", "send_message"], ["own_tool"]])
  expect(agent.capabilities?.map(capability => capability.id)).toEqual(["own"])
})

it("runs a discovered Agent inline when it receives invocation capabilities", async () => {
  const agent = defineAgent({ driver: { run: ({ tools }) => Object.keys(tools || {}).join(",") } })
  const delivery = defineCapability({ id: "job-delivery", tools: { send_message: { name: "send_message", execute: vi.fn() } } })
  await expect(runAgent(agent, { prompt: "Send" }, { schedule, capabilities: [delivery] }))
    .resolves.toEqual([undefined, expect.objectContaining({ text: "send_message" })])
})

it("rejects an invocation capability that repeats an Agent Capability id", async () => {
  const agent = defineAgent({
    runtime: false,
    capabilities: [defineCapability({ id: "delivery" })],
    driver: { run: () => "unreachable" },
  })
  const [error, result] = await runAgent(agent, {}, { capabilities: [defineCapability({ id: "delivery" })] })
  expect(error?.code).toBe("AGENT_RUN_FAILED")
  expect(String(error?.cause)).toContain("Duplicate capability id \"delivery\"")
  expect(result).toBeUndefined()
})

it("rejects an invocation capability that adds Workspace Sources", async () => {
  const run = vi.fn(() => "unreachable")
  const agent = defineAgent({ runtime: false, driver: { run } })
  const [error] = await runAgent(agent, {}, {
    capabilities: [defineCapability({ id: "docs", workspaceSources: {} })],
  })
  expect(String(error?.cause)).toContain("cannot contribute workspaceSources")
  expect(run).not.toHaveBeenCalled()
})

it("rejects unsupported behavior in nested invocation capabilities", async () => {
  const run = vi.fn(() => "unreachable")
  const agent = defineAgent({ runtime: false, driver: { run } })
  const nested = defineCapability({ id: "nested-docs", workspaceSources: {} })
  const wrapper = defineCapability({ id: "wrapper", capabilities: [nested] })
  const [error] = await runAgent(agent, {}, {
    capabilities: [wrapper],
  })
  expect(String(error?.cause)).toContain("cannot contribute workspaceSources")
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
    return await runAgentWithContext(child, context, {})
  } } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }
  await expect(runAgentWithContext(parent, runtime, {}, { tools: { send_message: { name: "send_message", execute: send } } })).resolves.toBe("child done")
  expect(send).not.toHaveBeenCalled()
})

it("runs a discovered Agent inline with an empty tool set", async () => {
  const agent = defineAgent({ driver: { run: () => "inline" } })
  await expect(runAgent(agent, {}, { tools: {} })).resolves.toEqual([undefined, expect.objectContaining({ text: "inline" })])
})

it("keeps option-like input fields as input", async () => {
  const input = { prompt: "user prompt", output: "json", runtime: "unknown" as const, waitUntil: vi.fn() }
  const agent = defineAgent({ runtime: false, driver: { run(context) {
    expect(context.prompt).toBe(input.prompt)
    expect((context.input as typeof context.input & { output?: string }).output).toBe("json")
    return "standalone result"
  } } })
  await expect(runAgent(agent, input as never)).resolves.toEqual([undefined, expect.objectContaining({ text: "standalone result" })])
  expect(input.waitUntil).not.toHaveBeenCalled()

  const failure = new Error("driver failed")
  const failingAgent = defineAgent({ runtime: false, driver: { run() { throw failure } } })
  await expect(runAgent(failingAgent, input as never)).resolves.toEqual([expect.objectContaining({ code: "AGENT_RUN_FAILED", cause: failure }), undefined])
})
