import { describe, expect, it } from "vitest"

import { createNitroServerKit } from "../src/nitro-kit.ts"

describe("Nitro server kit", () => {
  it("preserves user config while isolating generated registrations", () => {
    const existing = { handler: "server/api/health.ts", route: "/api/health", method: "get" }
    const config = { preset: "node-server", handlers: [existing], plugins: ["server/plugin.ts"], rollupConfig: { external: ["cloudflare:workers"] } }
    const kit = createNitroServerKit(config)

    kit.addHandler(existing)
    kit.addHandler({ handler: ".vitehub/api.ts", route: "/api/generated", method: "get" })
    kit.addPlugin("server/plugin.ts")
    kit.addPlugin(".vitehub/plugin.ts", "start")

    expect(kit.config).toEqual({
      preset: "node-server",
      handlers: [existing, { handler: ".vitehub/api.ts", route: "/api/generated", method: "get" }],
      plugins: [".vitehub/plugin.ts", "server/plugin.ts"],
      rollupConfig: { external: ["cloudflare:workers"] },
    })
    expect(config).toEqual({ preset: "node-server", handlers: [existing], plugins: ["server/plugin.ts"], rollupConfig: { external: ["cloudflare:workers"] } })
  })

  it("does not collapse registrations that share a route but differ by method", () => {
    const kit = createNitroServerKit()

    kit.addHandler({ handler: ".vitehub/route.ts", route: "/api/items", method: "get" })
    kit.addHandler({ handler: ".vitehub/route.ts", route: "/api/items", method: "post" })

    expect(kit.config.handlers).toHaveLength(2)
  })

  it("keeps registration mutations connected after filtering an exposed array", () => {
    const kit = createNitroServerKit({ handlers: [{ handler: "stale.ts" }], plugins: ["stale-plugin.ts"] })

    const handlers = kit.config.handlers as unknown[]
    handlers.splice(0, handlers.length, { handler: "kept.ts" })
    const plugins = kit.config.plugins as unknown[]
    plugins.splice(0, plugins.length, "kept-plugin.ts")

    kit.addHandler({ handler: "generated.ts" })
    kit.addPlugin("generated-plugin.ts")

    expect(kit.config.handlers).toEqual([{ handler: "kept.ts" }, { handler: "generated.ts" }])
    expect(kit.config.plugins).toEqual(["kept-plugin.ts", "generated-plugin.ts"])
  })
})
