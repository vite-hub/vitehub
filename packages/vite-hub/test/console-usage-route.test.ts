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

it.each([
  { costSupported: true, invoke: false, pricing: true },
  { costSupported: true, invoke: true, pricing: true },
  { costSupported: false, invoke: false, pricing: false },
  { costSupported: false, invoke: true, pricing: false },
])("reports cost support as $costSupported before the first invocation when pricing is $pricing and invoke is $invoke", async ({ costSupported, invoke, pricing }) => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  installConsoleAgentDefinitions([{
    definition: {
      capabilities: [pricing ? usage() : usage({ pricing: false })],
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
})
