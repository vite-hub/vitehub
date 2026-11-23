import { describe, expect, it } from "vitest"

import { hubKV } from "../src/vite.ts"

import type { KVOptions } from "../src/types.ts"

type PrerenderConfig = { virtual?: Record<string, string | (() => string)> }

async function prerenderConfig(options: KVOptions, hosting?: string): Promise<{ module: string | undefined, prerender: PrerenderConfig }> {
  const plugin = hubKV(options, hosting ? { hosting } : {})
  const config = typeof plugin.config === "object" ? plugin.config.handler : plugin.config
  await Reflect.apply(config!, {}, [{ root: "/app" }, { command: "build", mode: "production" }])
  const hooks: Array<(config: PrerenderConfig) => void> = []
  plugin.nitro.setup({ hooks: { hook: (_name, callback) => hooks.push(callback) }, options: {} })
  const prerender: PrerenderConfig = { virtual: { "#nitro/existing": "export default 1" } }
  for (const hook of hooks) hook(prerender)
  const module = prerender.virtual?.["#vitehub/kv/config"]
  return { module: typeof module === "function" ? module() : module, prerender }
}

describe("the KV config in a Nitro prerender build", () => {
  it("adds the configured store as a Nitro virtual module", async () => {
    const { module, prerender } = await prerenderConfig({ base: "/srv/kv", driver: "fs-lite" })
    expect(prerender.virtual?.["#nitro/existing"]).toBe("export default 1")
    expect(module).toContain(`export const kv = {"store":{"driver":"fs-lite","base":"/srv/kv"}};`)
    expect(module).toContain("export const durabilityReportsStores = true;")
  })

  it("gives a Cloudflare store its local folder", async () => {
    const { module } = await prerenderConfig({ binding: "CACHE", driver: "cloudflare" }, "cloudflare")
    expect(module).toContain(`"localBase":".vitehub/data/kv-cloudflare/CACHE"`)
  })

  it("uses a local Cloudflare store even when development uses the remote binding", async () => {
    const { module } = await prerenderConfig({ binding: "CACHE", driver: "cloudflare", remote: true }, "cloudflare")
    expect(module).toContain(`"localBase":".vitehub/data/kv-cloudflare/CACHE"`)
    expect(module).not.toContain(`"remote":true`)
  })

  it("does not apply development-only remote validation during prerender", async () => {
    const { module } = await prerenderConfig({ remote: true }, "node")
    expect(module).toContain(`"driver":"fs-lite"`)
  })

  it.each([{}, { driver: "deno-kv" as const }])("adds no module for a Deno KV store: %j", async (options) => {
    expect((await prerenderConfig(options, "deno")).module).toBeUndefined()
  })
})
