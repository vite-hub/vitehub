import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { usage } from "@vite-hub/agent/capabilities"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { readConsoleUsage as usageHandlerRoute } from "../src/console/runtime/server/usage.get.ts"
import { allowed } from "./support/console-access.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"
import { consoleEvent } from "./console-event.ts"

const usageHandler = allowed(usageHandlerRoute)

it("registers no Usage HTTP endpoint, since the Usage operation serves the data, when configuration is reapplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-usage-route-"))
  try {
    const plugin = consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, sections: ["agents", "usage"] })
    const hook = plugin.config
    if (!hook) throw new Error("Missing Console config hook")
    const handler = "handler" in hook ? hook.handler : hook
    const config = { root, vitehubCliDiscovery: true, nitro: { handlers: [] as Array<{ handler: string, route: string, method?: string }> } }
    for (let pass = 0; pass < 2; pass++) await Reflect.apply(handler, plugin, [config, { command: "build", mode: "production" }])
    expect(config.nitro.handlers.filter(handler => handler.route === "/_vitehub/api/usage")).toEqual([])
    expect(config.nitro.handlers.filter(handler => handler.route === "/_vitehub/rpc")).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([["env", "kv"], ["usage"]] as const)("does not register the Usage endpoint without the Agents section (%j)", async (...sections) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-usage-route-"))
  try {
    const plugin = consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, sections: [...sections] })
    const hook = plugin.config
    if (!hook) throw new Error("Missing Console config hook")
    const handler = "handler" in hook ? hook.handler : hook
    const config = { root, vitehubCliDiscovery: true, nitro: { handlers: [] as Array<{ handler: string, route: string, method?: string }> } }
    await Reflect.apply(handler, plugin, [config, { command: "build", mode: "production" }])
    const routes = config.nitro.handlers.map(handler => handler.route)
    expect(routes).not.toContain("/_vitehub/api/status")
    // Without an invocation journal, this handler fails with an unhandled 500.
    expect(routes).not.toContain("/_vitehub/api/usage")
  } finally { await rm(root, { recursive: true, force: true }) }
})

const pricingCases = [
  { name: "default", capability: () => usage(), costSupported: true },
  { name: "disabled", capability: () => usage({ pricing: false }), costSupported: false },
  { name: "custom", capability: () => usage({ pricing: () => ({ usd: "0.001", estimated: true, source: "custom" }) }), costSupported: true },
]

it.each([false, true].flatMap(invoke => pricingCases.map(pricing => ({ ...pricing, invoke }))))(
  "reports $name pricing before the first invocation when invoke is $invoke", async ({ capability, costSupported, invoke }) => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleAgentDefinitions([{
      definition: {
        capabilities: [capability()],
        invocations,
        async resolve() { throw new Error("Usage inspection must not invoke the Agent") },
      },
      fallbackName: "usage-agent",
    }], { projectRoot: process.cwd(), invoke })

    for (const query of ["", "?agent=usage-agent"]) {
      expect(await usageHandler(consoleEvent({ url: `http://localhost/_vitehub/api/usage${query}` }))).toMatchObject({ available: false, costSupported })
    }
  },
)

it.each([false, true])("keeps provider-recorded cost when pricing is disabled and invoke is %s", async (invoke) => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = new Date().toISOString()
  await store.create({
    agentName: "usage-agent",
    completedAt: timestamp,
    createdAt: timestamp,
    id: "provider-cost",
    observations: [{
      attributes: {
        "usage.record": {
          cost: { usd: "0.01", estimated: false, source: "provider" },
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      },
      name: "agent.invocation.finish",
      sequence: 1,
      timestamp,
      type: "lifecycle",
    }],
    status: "completed",
    traceId: "provider-cost",
    updatedAt: timestamp,
  })
  const invocations = defineAgentInvocations({ store })
  installConsoleAgentDefinitions([{
    definition: {
      capabilities: [usage({ pricing: false })],
      invocations,
      async resolve() { throw new Error("Usage inspection must not invoke the Agent") },
    },
    fallbackName: "usage-agent",
  }], { projectRoot: process.cwd(), invoke })

  for (const query of ["", "?agent=usage-agent"]) {
    expect(await usageHandler(consoleEvent({ url: `http://localhost/_vitehub/api/usage${query}` }))).toMatchObject({ costSupported: true, totals: { costUsd: "0.01", costEstimated: false } })
  }
})
