import { describe, expect, it } from "vitest"

describe("package surface", () => {
  it("exposes the public runtime export", async () => {
    const kvPackage = await import("../src/index.ts")

    expect("kv" in kvPackage).toBe(true)
  })
})

describe("hubKv", () => {
  it("resolves KV config from the Vite layer", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".cache/kv" })

    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".cache/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("lets top-level Vite config override inline plugin options", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".inline/kv" })
    const configResolved = plugin.configResolved as unknown as (config: unknown) => void | Promise<void>

    await configResolved({
      kv: {
        base: ".top-level/kv",
        driver: "fs-lite",
      },
    } as never)

    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".top-level/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("exposes resolved config through a stable ViteHub import path", async () => {
    const { KV_VIRTUAL_CONFIG_ID, hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".virtual/kv" })
    const resolveId = plugin.resolveId as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(KV_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const kv =")
    expect(code).toContain(".virtual/kv")
  })

  it("externalizes only the optional Upstash peer in server builds", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite" })
    const resolveId = plugin.resolveId as unknown as (
      id: string,
      importer: string | undefined,
      options: { ssr: boolean },
    ) => unknown | Promise<unknown>

    expect(await resolveId("@upstash/redis", undefined, { ssr: true })).toEqual({
      external: true,
      id: "@upstash/redis",
    })
    expect(await resolveId("@upstash/redis", undefined, { ssr: false })).toBeUndefined()
    expect(await resolveId("unstorage/drivers/fs-lite", undefined, { ssr: true })).toBeUndefined()
  })

  it("anchors generated Cloudflare runtime imports to the KV package", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
    const resolveId = plugin.resolveId as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId("@vite-hub/kv")
    const code = await load(resolvedId!)

    expect(code).not.toContain(`from "unstorage"`)
    expect(code).not.toContain(`from "unstorage/drivers/cloudflare-kv-binding"`)
    expect(code).toContain("cloudflare-kv-binding")
  })
})
