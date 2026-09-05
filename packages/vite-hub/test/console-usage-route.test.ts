import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { consoleVitePlugin } from "../src/console/vite.ts"

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
