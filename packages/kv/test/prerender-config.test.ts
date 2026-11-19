import { describe, expect, it } from "vitest"

import { hubKV } from "../src/vite.ts"

type PrerenderConfig = { virtual?: Record<string, string | (() => string)> }

describe("the KV config in a Nitro prerender build", () => {
  // Nitro prerenders with a second Rolldown build that runs no Vite plugins, so it needs the config as a Nitro module.
  it("adds the build config as a Nitro virtual module", async () => {
    const plugin = hubKV({ base: "/srv/kv", driver: "fs-lite" })
    const config = typeof plugin.config === "object" ? plugin.config.handler : plugin.config
    await Reflect.apply(config!, {}, [{ root: "/app" }, { command: "build", mode: "production" }])
    const hooks: Array<(config: PrerenderConfig) => void> = []
    plugin.nitro.setup({ hooks: { hook: (_name, callback) => hooks.push(callback) }, options: {} })

    const prerender: PrerenderConfig = { virtual: { "#nitro/existing": "export default 1" } }
    for (const hook of hooks) hook(prerender)

    expect(prerender.virtual?.["#nitro/existing"]).toBe("export default 1")
    const module = prerender.virtual?.["#vitehub/kv/config"]
    const source = typeof module === "function" ? module() : module
    expect(source).toContain(`export const kv = ${JSON.stringify(plugin.api.getConfig().kv)};`)
    expect(source).toContain("\"base\":\"/srv/kv\"")
  })
})
