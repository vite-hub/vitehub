import { describe, expect, it, vi } from "vitest"
import { agentEnvAccess } from "@vite-hub/env/internal/agent"
import { readAgentEnvIdentity } from "../src/env-identity.ts"
import { defineAgent, runAgent } from "../src/index.ts"
import type { AgentRuntimeContext } from "../src/types.ts"

it("rejects caller-created Agent identities and copies through the exported mint", async () => {
  let identity: object | undefined
  const definition = defineAgent({
    name: "owner",
    runtime: false,
    driver: { run: () => "done" },
    hooks: { "agent:finish"({ runtime }) { identity = runtime.agentIdentity } },
  })
  expect(await runAgent(definition, {})).toEqual([null, "done"])
  expect(identity).toBeDefined()
  expect(readAgentEnvIdentity(identity!)).toBe("owner")
  expect(agentEnvAccess(identity as { name: string }).actor).toEqual({ kind: "agent", id: "owner" })
  for (const forged of [undefined, null, "owner", 1, { name: "owner" }, { ...identity }, Object.create(identity!), JSON.parse(JSON.stringify(identity))]) {
    expect(readAgentEnvIdentity(forged)).toBeUndefined()
    expect(() => agentEnvAccess(forged)).toThrow(expect.objectContaining({ code: "ENV_BRIDGE_UNTRUSTED" }))
  }
})

it("replaces the parent identity when a different Definition reuses its runtime", async () => {
  let parentRuntime: AgentRuntimeContext | undefined
  const parent = defineAgent({ name: "parent", runtime: false, driver: { run: () => "parent" },
    hooks: { "agent:finish"({ runtime }) { parentRuntime = runtime } },
  })
  await runAgent(parent, {})
  for (const name of ["child", undefined]) {
    let identity: object | undefined
    const child = defineAgent({ name, runtime: false, driver: { run: () => "child" },
      hooks: { "agent:finish"({ runtime }) { identity = runtime.agentIdentity } },
    })
    await runAgent(child, parentRuntime!, {})
    expect(identity ? readAgentEnvIdentity(identity) : undefined).toBe(name)
  }
})

it("lists static Gmail tools without minting Connection authority", async () => {
  const { gmail } = await import("../src/capabilities/gmail.ts")
  const client = vi.fn()
  const capability = gmail()
  if (typeof capability.tools !== "function") throw new Error("Expected Gmail tool resolver")
  const tools = await capability.tools({
    capabilities: { connections: { runtime: () => ({ client }) } },
    context: new Map(),
  } as never)
  expect(Object.keys(tools ?? {}).sort()).toEqual(["gmail_read", "gmail_search"])
  expect(client).not.toHaveBeenCalled()
})

it.each([
  { name: undefined, hostName: undefined },
  { name: undefined, hostName: "host-alias" },
  { name: "definition-owner", hostName: "host-alias" },
])("keeps host attribution separate from Connection authority with %j", async ({ name, hostName }) => {
  const { markDiscoveredAgentName } = await import("../src/internal/discovered-agent-name.ts")
  const { useAgentConnectionClient } = await import("../src/capabilities/connection.ts")
  const client = vi.fn((_name, options) => {
    expect(options.access.actor).toEqual({ kind: "agent", id: name ?? "discovered-owner" })
    return { fetch: async () => new Response("ok"), call: async () => "ok" }
  })
  const definition = defineAgent({
    runtime: false,
    name,
    capabilities: [{ id: "connection-check", tools(context) {
      const connection = useAgentConnectionClient(context, "service", "test")
      return { check: { description: "Check identity", execute: () => connection.fetch("https://service.example") } }
    } }],
    driver: { async run(context) {
      expect(context.agentIdentity?.name).toBe(hostName)
      return await context.tools?.check.execute?.({}, {})
    } },
  })
  markDiscoveredAgentName(definition, "discovered-owner")
  await runAgent(definition, {
    runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn(),
    capabilities: { connections: { runtime: () => ({ client }) } },
    ...(hostName ? { agentIdentity: { name: hostName } } : {}),
  }, {})
  expect(client).toHaveBeenCalledOnce()
})

describe("Connection access parents from extends", () => {
  async function parentsSeenBy(definition: object, context: Record<string, unknown> = {}): Promise<string[]> {
    const { envAccessAgentParents } = await import("@vite-hub/env/internal/connections")
    let parents: string[] | undefined
    const client = vi.fn((_name: string, options: { access: Parameters<typeof envAccessAgentParents>[0] }) => {
      parents = envAccessAgentParents(options.access)
      return { fetch: async () => new Response("ok"), call: async () => "ok" }
    })
    await runAgent(definition as never, {
      runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn(),
      capabilities: { connections: { runtime: () => ({ client }) } },
      ...context,
    }, {})
    expect(client).toHaveBeenCalledOnce()
    return parents!
  }

  async function connectionAgent(options: { name: string }) {
    const { useAgentConnectionClient } = await import("../src/capabilities/connection.ts")
    return defineAgent({
      runtime: false,
      name: options.name,
      capabilities: [{ id: "connection-check", tools(context) {
        const connection = useAgentConnectionClient(context, "service", "test")
        return { check: { description: "Check parents", execute: () => connection.fetch("https://service.example") } }
      } }],
      driver: { async run(context) { return await context.tools?.check.execute?.({}, {}) } },
    })
  }

  it("gives a registered child and grandchild their parents, nearest first", async () => {
    const { markDiscoveredAgentName } = await import("../src/internal/discovered-agent-name.ts")
    const bot = await connectionAgent({ name: "bot" })
    const dev = defineAgent({ extends: bot as never, name: "bot-dev" })
    const canary = defineAgent({ extends: dev as never, name: "bot-canary" })
    // Discovery names a definition without an explicit name from its file.
    const unnamed = defineAgent({ extends: dev as never })
    markDiscoveredAgentName(bot, "bot")
    markDiscoveredAgentName(dev, "bot-dev")
    markDiscoveredAgentName(canary, "bot-canary")
    markDiscoveredAgentName(unnamed, "bot-preview")
    expect(await parentsSeenBy(bot)).toEqual([])
    expect(await parentsSeenBy(dev)).toEqual(["bot"])
    expect(await parentsSeenBy(canary)).toEqual(["bot-dev", "bot"])
    expect(await parentsSeenBy(unnamed)).toEqual(["bot-dev", "bot"])
  })

  it("keeps the parents when discovery decorates a registered definition", async () => {
    const { markDiscoveredAgentName } = await import("../src/internal/discovered-agent-name.ts")
    const { inheritAgentLayerOptions } = await import("../src/agent-layers.ts")
    const bot = await connectionAgent({ name: "bot" })
    const dev = defineAgent({ extends: bot as never, name: "bot-dev" })
    // Discovery copies a definition to add Workspace defaults, as the generated registry does.
    const decorated: object = Object.assign({}, dev)
    inheritAgentLayerOptions(dev, decorated)
    markDiscoveredAgentName(decorated, "bot-dev")
    expect(await parentsSeenBy(decorated)).toEqual(["bot"])
  })

  it("gives an inline Agent that runAgent() runs no parents", async () => {
    const bot = await connectionAgent({ name: "bot" })
    const inline = defineAgent({ extends: bot as never, name: "bot-inline" })
    expect(await parentsSeenBy(inline)).toEqual([])
  })

  it("ignores parents in the host identity that the caller passes", async () => {
    const { markDiscoveredAgentName } = await import("../src/internal/discovered-agent-name.ts")
    const agent = await connectionAgent({ name: "worker" })
    markDiscoveredAgentName(agent, "worker")
    expect(await parentsSeenBy(agent, { agentIdentity: { name: "worker", parents: ["bot"] } })).toEqual([])
  })
})
