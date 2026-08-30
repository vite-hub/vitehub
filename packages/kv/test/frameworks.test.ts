import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/cloudflare"
import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

async function resolveConfigWithNitro<T extends object>(config: Parameters<typeof resolveConfig>[0] & { nitro: T }) {
  // SAFETY: resolveConfig preserves the caller-provided Nitro object while adding Vite's resolved fields.
  return await resolveConfig(config, "build") as Awaited<ReturnType<typeof resolveConfig>> & { nitro: T }
}

interface TestBuildConfig {
  build: { outDir: string }
  command: "build"
  nitro?: Record<string, unknown>
  plugins?: Array<{ name: string }>
  root: string
}

function testHook<T>(hook: unknown, contract: T): T {
  if (!hook) throw new TypeError("Expected Vite plugin hook.")
  void contract
  const handler = Reflect.has(Object(hook), "handler") ? Reflect.get(Object(hook), "handler") : hook
  // SAFETY: Tests select hooks from concrete plugins and provide the exact argument subset each hook reads.
  return handler as T
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
    const resolveId = testHook(plugin.resolveId, (
      _id: string,
      _importer: string | undefined,
      _options: { ssr: boolean },
    ): unknown | Promise<unknown> => undefined)

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
    const configResolved = testHook(plugin.configResolved, (_config: unknown): void | Promise<void> => undefined)

    await configResolved({
      kv: {
        base: ".top-level/kv",
        driver: "fs-lite",
      },
    })

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
    const virtualHookContract = (_id: string): string | undefined | Promise<string | undefined> => undefined
    const resolveId = testHook(plugin.resolveId, virtualHookContract)
    const load = testHook(plugin.load, virtualHookContract)
    const resolvedId = await resolveId(KV_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const kv =")
    expect(code).toContain(".virtual/kv")
  })

  it("externalizes only the unused package-owned Upstash driver in server builds", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite" })
    const resolveId = testHook(plugin.resolveId, (
      _id: string,
      _importer: string | undefined,
      _options: { ssr: boolean },
    ): unknown | Promise<unknown> => undefined)

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
    const resolveUpstashId = testHook(upstashPlugin.resolveId, resolveId)
    expect(await resolveUpstashId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toBeUndefined()
  })

  it("anchors generated Cloudflare runtime imports to the KV package", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
    const virtualHookContract = (_id: string): string | undefined | Promise<string | undefined> => undefined
    const resolveId = testHook(plugin.resolveId, virtualHookContract)
    const load = testHook(plugin.load, virtualHookContract)
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
    const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)

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
        // SAFETY: Vite accepts config hooks that add framework-owned Nitro fields outside its core config type.
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

  it("preserves a later manual same-binding namespace in Nitro output", async () => {
    const { hubKv } = await import("../src/vite.ts")
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-manual-override-"))

    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      // SAFETY: the fixture supplies the Vite builder fields used by Nitro and hubKv.
      const builder = await createBuilder({
        kv: { binding: "KV", driver: "cloudflare-kv-binding", namespaceId: "generated-id" },
        logLevel: "silent",
        nitro: { preset: "cloudflare-module" },
        plugins: [
          hubKv(),
          // SAFETY: Vite accepts config hooks that add Nitro-owned configuration fields.
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
          // SAFETY: Nitro's runtime-loaded plugin conforms to Vite's plugin contract.
          nitro() as never,
        ],
        root,
      } as Parameters<typeof createBuilder>[0])

      await builder.buildApp()

      await expect(readFile(join(root, ".output", "server", "wrangler.json"), "utf8").then(JSON.parse))
        .resolves.toHaveProperty("kv_namespaces", [{ binding: "KV", id: "user-id" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("preserves a later KV option override in Nitro output", async () => {
    const { hubKv } = await import("../src/vite.ts")
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-option-override-"))

    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      // SAFETY: the fixture supplies the Vite builder fields used by Nitro and hubKv.
      const builder = await createBuilder({
        kv: { binding: "KV", driver: "cloudflare-kv-binding", namespaceId: "initial-id" },
        logLevel: "silent",
        nitro: { preset: "cloudflare-module" },
        plugins: [
          hubKv(),
          {
            name: "later-kv-override",
            config: () => ({
              kv: { binding: "KV", driver: "cloudflare-kv-binding" as const, namespaceId: "resolved-id" },
            }),
          },
          // SAFETY: Nitro's runtime-loaded plugin conforms to Vite's plugin contract.
          nitro() as never,
        ],
        root,
      } as Parameters<typeof createBuilder>[0])

      await builder.buildApp()

      await expect(readFile(join(root, ".output", "server", "wrangler.json"), "utf8").then(JSON.parse))
        .resolves.toHaveProperty("kv_namespaces", [{ binding: "KV", id: "resolved-id" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("contributes bindings after late Nitro ownership becomes mutable", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
    const configure = testHook(plugin.config, (_value: { plugins: Array<{ name: string }> }): void | Promise<void> => undefined)
    const configureResolved = testHook(plugin.configResolved, (_value: {
      kv?: unknown
      nitro: Record<string, unknown>
      plugins: Array<{ name: string }>
      root: string
    }): void | Promise<void> => undefined)
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
      const lifecycleContract = (): Promise<void> | void => undefined
      await testHook(plugin.buildStart, lifecycleContract)()
      await testHook(plugin.buildEnd, lifecycleContract)()
      await testHook(plugin.closeBundle, async () => undefined)()
    }

    try {
      const standalone = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
      const configResolvedContract = (_value: TestBuildConfig): void => undefined
      await testHook(standalone.configResolved, configResolvedContract)({ build: { outDir: "dist" }, command: "build", root })
      await runCloseBundle(standalone)
      const outputRoot = createDefaultCloudflareOutputRoot(root)
      const wranglerFile = join(outputRoot, "wrangler.json")
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([{ binding: "KV" }])

      const nitro = hubKv({ binding: "KV", driver: "cloudflare-kv-binding" })
      await testHook(nitro.configResolved, configResolvedContract)({
        build: { outDir: "dist" },
        command: "build",
        nitro: { cloudflare: { wrangler: { kv_namespaces: [{ binding: "KV", id: "nitro-id" }] } } },
        plugins: [{ name: "nitro:main" }],
        root,
      })
      await runCloseBundle(nitro)

      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([{ binding: "KV", id: "nitro-id" }])
      expect(existsSync(join(outputRoot, ".vitehub-kv-bindings.json"))).toBe(false)

      await runCloseBundle(nitro)
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([{ binding: "KV", id: "nitro-id" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
