import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/cloudflare"
import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

async function resolveConfigWithNitro<T extends object>(config: Parameters<typeof resolveConfig>[0] & { nitro: T }) {
  return await resolveConfig(config, "build") as Awaited<ReturnType<typeof resolveConfig>> & { nitro: T }
}

describe("package surface", () => {
  it("exposes the public runtime export", async () => {
    const kvPackage = await import("../src/index.ts")

    expect("kv" in kvPackage).toBe(true)
  })
})

describe("hubKv", () => {
  it("scopes the disabled KV optional-peer resolver to ViteHub's own imports", async () => {
    const { hubKvOptionalPeerResolver } = await import("../src/vite.ts")
    const plugin = hubKvOptionalPeerResolver()
    const resolveId = plugin.resolveId as unknown as (
      id: string,
      importer: string | undefined,
      options: { ssr: boolean },
    ) => unknown | Promise<unknown>

    expect(await resolveId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toEqual({
      external: true,
      id: "@vite-hub/kv/runtime/upstash-driver",
    })
    expect(await resolveId("@upstash/redis", "/app/node_modules/unstorage/dist/drivers/upstash.mjs", { ssr: true })).toBeUndefined()
    expect(await resolveId("@vite-hub/kv/runtime/upstash-driver", "/app/server/storage.ts", { ssr: true })).toBeUndefined()
    expect(await resolveId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: false })).toBeUndefined()
    expect(await resolveId("unstorage/drivers/upstash", "/app/server/storage.ts", { ssr: true })).toBeUndefined()
  })

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

  it("externalizes only the unused package-owned Upstash driver in server builds", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite" })
    const resolveId = plugin.resolveId as unknown as (
      id: string,
      importer: string | undefined,
      options: { ssr: boolean },
    ) => unknown | Promise<unknown>

    expect(await resolveId("@upstash/redis", "/app/node_modules/unstorage/dist/drivers/upstash.mjs", { ssr: true })).toBeUndefined()
    expect(await resolveId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toEqual({
      external: true,
      id: "@vite-hub/kv/runtime/upstash-driver",
    })
    expect(await resolveId("@upstash/redis", undefined, { ssr: false })).toBeUndefined()
    expect(await resolveId("unstorage/drivers/fs-lite", undefined, { ssr: true })).toBeUndefined()
    expect(await resolveId("@upstash/redis", "/app/server/redis.ts", { ssr: true })).toBeUndefined()
    expect(await resolveId("@vite-hub/kv/runtime/upstash-driver", "/app/server/storage.ts", { ssr: true })).toBeUndefined()
    expect(await resolveId("unstorage/drivers/upstash", "/app/server/storage.ts", { ssr: true })).toBeUndefined()

    const upstashPlugin = hubKv({ driver: "upstash" })
    const resolveUpstashId = upstashPlugin.resolveId as typeof resolveId
    expect(await resolveUpstashId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toBeUndefined()
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

  it("contributes ID-less Cloudflare KV bindings to Nitro-owned output", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
    const config = {
      nitro: {
        cloudflare: {
          wrangler: {
            observability: { enabled: true },
          },
        },
      },
    }
    const configure = plugin.config as unknown as (value: typeof config) => void | Promise<void>

    await configure(config)

    expect(config.nitro.cloudflare.wrangler).toEqual({
      kv_namespaces: [{ binding: "KV" }],
      observability: { enabled: true },
    })
  })

  it("reconciles a later KV plugin override into Nitro-owned output", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const nitro = {
      cloudflare: {
        wrangler: {
          kv_namespaces: [{ binding: "MANUAL", id: "manual-namespace" }],
          observability: { enabled: true },
        },
      },
    }

    const resolved = await resolveConfigWithNitro({
      kv: { binding: "INITIAL", driver: "cloudflare-kv-binding" },
      nitro,
      plugins: [
        hubKv(),
        { name: "nitro:main" },
        {
          name: "later-kv-override",
          config: () => ({
            kv: {
              binding: "RESOLVED",
              driver: "cloudflare-kv-binding" as const,
              namespaceId: "resolved-namespace",
            },
          }),
        },
      ],
    })

    expect(resolved.nitro.cloudflare.wrangler).toEqual({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "RESOLVED", id: "resolved-namespace" },
      ],
      observability: { enabled: true },
    })
  })

  it("reconciles KV added by a later plugin into Nitro-owned output", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const nitro = {}

    const resolved = await resolveConfigWithNitro({
      nitro,
      plugins: [
        hubKv(),
        { name: "nitro:main" },
        {
          name: "later-kv-config",
          config: () => ({ kv: { binding: "LATE", driver: "cloudflare-kv-binding" as const } }),
        },
      ],
    })

    expect(resolved.nitro).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "LATE" }])
  })

  it("preserves a later manual namespace with the same binding", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const nitro = {}

    const resolved = await resolveConfigWithNitro({
      kv: { binding: "KV", driver: "cloudflare-kv-binding", namespaceId: "generated-id" },
      nitro,
      plugins: [
        hubKv(),
        { name: "nitro:main" },
        {
          name: "later-manual-namespace",
          config: () => ({
            nitro: {
              cloudflare: {
                wrangler: {
                  kv_namespaces: [{ binding: "KV", id: "user-id" }],
                },
              },
            },
          }),
        } as never,
      ],
    })

    expect(resolved.nitro).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "KV", id: "user-id" }])
  })

  it("contributes bindings after late Nitro ownership becomes mutable", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
    const configure = plugin.config as unknown as (value: object) => void | Promise<void>
    const configureResolved = plugin.configResolved as unknown as (value: object) => void | Promise<void>
    const config = { plugins: [{ name: "nitro:main" }] }

    await configure(config)
    const resolved = { ...config, kv: undefined, nitro: {}, root: "/app" }
    await configureResolved(resolved)

    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.kv_namespaces", [{ binding: "KV" }])
  })

  it("cleans prior standalone bindings when Nitro takes output ownership", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-transition-"))
    const runCloseBundle = async (plugin: ReturnType<typeof hubKv>) => {
      const hook = plugin.closeBundle as { handler: () => Promise<void> }
      await hook.handler()
    }

    try {
      const standalone = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
      await (standalone.configResolved as unknown as (value: object) => void)({ command: "build", root })
      await runCloseBundle(standalone)
      const outputRoot = createDefaultCloudflareOutputRoot(root)
      const wranglerFile = join(outputRoot, "wrangler.json")
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([{ binding: "KV" }])

      const nitro = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
      await (nitro.configResolved as unknown as (value: object) => void)({ command: "build", nitro: {}, plugins: [{ name: "nitro:main" }], root })
      await runCloseBundle(nitro)

      expect(existsSync(wranglerFile)).toBe(false)
      expect(existsSync(join(outputRoot, ".vitehub-kv-bindings.json"))).toBe(false)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
