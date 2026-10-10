import { expect, it, vi } from "vitest"
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
