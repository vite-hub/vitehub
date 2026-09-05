import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { usage } from "@vite-hub/agent/capabilities"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import usageHandler from "../src/console/runtime/server/usage.get.ts"

it("registers one production Usage GET endpoint when configuration is reapplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-usage-route-"))
  try {
    const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node", sections: ["agents", "usage"] })
    const hook = plugin.config
    if (!hook) throw new Error("Missing Console config hook")
    const handler = "handler" in hook ? hook.handler : hook
    const config = { root, vitehubCliDiscovery: true, nitro: { handlers: [] as Array<{ handler: string, route: string, method?: string }> } }
    for (let pass = 0; pass < 2; pass++) await Reflect.apply(handler, plugin, [config, { command: "build", mode: "production" }])
    expect(config.nitro.handlers.filter(handler => handler.route === "/api/_vitehub/console/usage")).toEqual([
      { handler: expect.stringMatching(/server\/usage\.get\.js$/), route: "/api/_vitehub/console/usage", method: "get" },
    ])
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
      expect(await usageHandler({
        method: "GET",
        req: { url: `http://localhost/api/_vitehub/console/usage${query}` },
      })).toMatchObject({ available: false, costSupported })
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
    expect(await usageHandler({
      method: "GET",
      req: { url: `http://localhost/api/_vitehub/console/usage${query}` },
    })).toMatchObject({ costSupported: true, totals: { costUsd: "0.01", costEstimated: false } })
  }
})
