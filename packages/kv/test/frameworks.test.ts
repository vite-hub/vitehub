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

describe("hubKV", () => {
  it.each(["redis", "upstash"])("scopes the disabled KV %s optional-peer resolver to ViteHub's own imports", async (driver) => {
    const { hubKVOptionalPeerResolver } = await import("../src/vite.ts")
    const plugin = hubKVOptionalPeerResolver()
    const resolveId = testHook(plugin.resolveId, (
      _id: string,
      _importer: string | undefined,
      _options: { ssr: boolean },
    ): unknown | Promise<unknown> => undefined)

    const id = `@vite-hub/kv/runtime/${driver}-driver`
    expect(await resolveId(id, "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toEqual({
      external: true,
      id,
    })
    expect(await resolveId("@upstash/redis", "/app/node_modules/unstorage/dist/drivers/upstash.mjs", { ssr: true })).toBeUndefined()
    expect(await resolveId(id, "/app/server/storage.ts", { ssr: true })).toBeUndefined()
    expect(await resolveId(id, "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: false })).toBeUndefined()
    expect(await resolveId("unstorage/drivers/upstash", "/app/server/storage.ts", { ssr: true })).toBeUndefined()
  })

  it("filters the resolveId and load hooks to the ids that they handle", async () => {
    const { hubKV, hubKVOptionalPeerResolver } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite" })
    const idFilter = (hook: unknown) => Reflect.get(Object(Reflect.get(Object(hook), "filter")), "id") as RegExp
    const matches = (pattern: RegExp, ids: string[]) => ids.filter(id => pattern.test(id))

    const nearMisses = ["@vite-hub/kv/runtime", "@vite-hub/kv/vite", "@vite-hub/kvx", "#vitehub/kv/config.mjs", "cloudflare:sockets", "/app/server/api/kv.ts"]
    expect(matches(idFilter(plugin.resolveId), ["@vite-hub/kv", "@vite-hub/kv/runtime/redis-driver", "@vite-hub/kv/runtime/upstash-driver", "cloudflare:workers", "#vitehub/kv/config", ...nearMisses]))
      .toEqual(["@vite-hub/kv", "@vite-hub/kv/runtime/redis-driver", "@vite-hub/kv/runtime/upstash-driver", "cloudflare:workers", "#vitehub/kv/config"])
    expect(matches(idFilter(plugin.load), ["\0#vitehub/kv/runtime", "\0#vitehub/kv/config", "#vitehub/kv/config", "\0#vitehub/kv/config.mjs"]))
      .toEqual(["\0#vitehub/kv/runtime", "\0#vitehub/kv/config"])
    expect(matches(idFilter(hubKVOptionalPeerResolver().resolveId), ["@vite-hub/kv/runtime/redis-driver", "@vite-hub/kv/runtime/upstash-driver", "cloudflare:workers", "@vite-hub/kv", ...nearMisses]))
      .toEqual(["@vite-hub/kv/runtime/redis-driver", "@vite-hub/kv/runtime/upstash-driver", "cloudflare:workers"])
  })

  it("resolves KV config from the Vite layer", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite", base: ".cache/kv" })

    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".cache/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("reads only the plugin options, not a top-level Vite key", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite", base: ".inline/kv" })
    const configResolved = testHook(plugin.configResolved, (_config: unknown): void | Promise<void> => undefined)

    await configResolved({
      root: process.cwd(),
      kv: {
        base: ".top-level/kv",
        driver: "fs-lite",
      },
    })

    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".inline/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("exposes resolved config through a stable ViteHub import path", async () => {
    const { KV_VIRTUAL_CONFIG_ID, hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite", base: ".virtual/kv" })
    const virtualHookContract = (_id: string): string | undefined | Promise<string | undefined> => undefined
    const resolveId = testHook(plugin.resolveId, virtualHookContract)
    const load = testHook(plugin.load, virtualHookContract)
    const resolvedId = await resolveId(KV_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const kv =")
    expect(code).toContain(".virtual/kv")
  })

  it("externalizes only the unused package-owned Upstash driver in server builds", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite" })
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

    const upstashPlugin = hubKV({ driver: "upstash" })
    const resolveUpstashId = testHook(upstashPlugin.resolveId, resolveId)
    expect(await resolveUpstashId("@vite-hub/kv/runtime/upstash-driver", "/app/node_modules/@vite-hub/kv/dist/index.js", { ssr: true })).toBeUndefined()
  })

  it("anchors generated Cloudflare runtime imports to the KV package", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
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
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
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

  it("registers the Cloudflare request env middleware once, before other middleware", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const middleware = resolve(import.meta.dirname, "../dist/runtime/cloudflare-request-env.js")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
    const config = { nitro: { handlers: [{ handler: "server/middleware/auth.ts", middleware: true }] } }
    const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)

    await configure(config)
    await configure(config)

    expect(config.nitro.handlers).toEqual([
      { handler: middleware, middleware: true },
      { handler: "server/middleware/auth.ts", middleware: true },
    ])
    expect(existsSync(middleware)).toBe(true)
  })

  it("mounts the default store at `kv` and named stores at `kv-<name>` in Nitro storage", async () => {
    const { hubKV, kvStorageDriver } = await import("../src/vite.ts")
    const plugin = hubKV({ stores: { default: { driver: "fs-lite" }, sessions: { driver: "fs-lite" } } })
    const config: { nitro: Record<string, unknown> } = { nitro: {} }
    const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)

    await configure(config)

    expect(config.nitro.kv).toEqual({
      "kv": { driver: kvStorageDriver },
      "kv-sessions": { driver: kvStorageDriver, store: "sessions" },
    })
    expect(existsSync(kvStorageDriver)).toBe(true)
  })

  it("keeps a `kv` mount that the app set, in `kv` or the deprecated `storage` option", async () => {
    const { hubKV, kvStorageDriver } = await import("../src/vite.ts")
    const appMount = { driver: "redis", url: "redis://localhost" }
    const own = { nitro: { kv: { kv: appMount } } }
    const legacy = { nitro: { storage: { kv: appMount } } as Record<string, unknown> }
    for (const config of [own, legacy]) {
      const configure = testHook(hubKV({ driver: "fs-lite" }).config, (_value: typeof config): void | Promise<void> => undefined)
      await configure(config)
    }

    expect(own.nitro.kv).toEqual({ kv: appMount })
    expect(legacy.nitro.kv).toBeUndefined()
    expect(Object.values(own.nitro.kv)).not.toContainEqual({ driver: kvStorageDriver })
  })

  it("adds no storage mount when KV is disabled", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const config: { nitro: Record<string, unknown> } = { nitro: {} }
    await testHook(hubKV(false).config, (_value: typeof config): void | Promise<void> => undefined)(config)
    expect(config.nitro.kv).toBeUndefined()
  })

  it("does not register the Cloudflare request env middleware for a local store", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "fs-lite" })
    const config: { nitro: { handlers?: unknown[] } } = { nitro: {} }
    const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)

    await configure(config)

    expect(config.nitro.handlers).toBeUndefined()
  })

  it.each(["before", "after"])("reconciles the request env middleware when Nitro setup runs %s config resolution", async (setupOrder) => {
    const { hubKV } = await import("../src/vite.ts")
    const middleware = resolve(import.meta.dirname, "../dist/runtime/cloudflare-request-env.js")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
    const auth = { handler: "server/middleware/auth.ts", middleware: true }
    const options = { handlers: [auth] }
    const config = { plugins: [{ name: "nitro:main" }], root: "/app" }
    const configureResolved = testHook(plugin.configResolved, (_value: typeof config): void | Promise<void> => undefined)

    if (setupOrder === "before") plugin.nitro.setup({ options })
    await configureResolved(config)
    if (setupOrder === "after") plugin.nitro.setup({ options })

    expect(options).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "KV" }])
    expect(options.handlers).toEqual([{ handler: middleware, middleware: true }, auth])

    await configureResolved(config)
    expect(options.handlers).toEqual([{ handler: middleware, middleware: true }, auth])
  })

  it("reads provisioned Cloudflare KV namespace ids into Nitro-owned output", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-provision-"))
    try {
      await mkdir(join(root, ".vitehub"), { recursive: true })
      await writeFile(join(root, ".vitehub", "provision.json"), `${JSON.stringify({ cloudflare: { kv: { default: "provisioned-id" } } })}\n`)
      const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding", namespaceName: "app-cache" })
      const config = { nitro: {}, root }
      const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)

      await configure(config)

      expect(config.nitro).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "KV", id: "provisioned-id" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("contributes the Cloudflare KV provision step with the configured KV options", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ driver: "cloudflare-kv-binding", namespaceName: "app-cache" })
    const config = { root: "/app" }
    const configure = testHook(plugin.config, (_value: typeof config): void | Promise<void> => undefined)
    await configure(config)

    const cli = plugin.vitehub?.cli
    const contributor = typeof cli === "function" ? await cli() : cli
    const steps = contributor?.provision ?? []
    const warnings: string[] = []
    const actions = await steps[0]?.plan({
      env: {},
      fetch: async () => { throw new Error("must not call the provider API without credentials") },
      logger: { log: () => {}, warn: message => warnings.push(message) },
    })

    expect(steps.map(step => ({ id: step.id, provider: step.provider }))).toEqual([{ id: "kv:cloudflare-kv", provider: "cloudflare" }])
    expect(actions).toEqual([])
    expect(warnings).toEqual(["kv: skipping Cloudflare KV, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN."])
  })

  it("preserves a later manual namespace with the same binding", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const nitro = {}

    const resolved = await resolveConfigWithNitro({
      nitro,
      plugins: [
        hubKV({ binding: "KV", driver: "cloudflare-kv-binding", namespaceId: "generated-id" }),
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
    const { hubKV } = await import("../src/vite.ts")
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-manual-override-"))

    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      // SAFETY: the fixture supplies the Vite builder fields used by Nitro and hubKV.
      const builder = await createBuilder({
        logLevel: "silent",
        nitro: { preset: "cloudflare-module" },
        plugins: [
          hubKV({ binding: "KV", driver: "cloudflare-kv-binding", namespaceId: "generated-id" }),
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

  it("contributes bindings after late Nitro ownership becomes mutable", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
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

  it("contributes bindings to a resolved Nitro config supplied by ViteHub", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const plugin = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
    const configure = testHook(plugin.config, (_value: Record<string, unknown>): void | Promise<void> => undefined)
    const configureResolved = testHook(plugin.configResolved, (_value: {
      kv?: unknown
      nitro: Record<string, unknown>
      plugins: Array<{ name: string }>
      root: string
    }): void | Promise<void> => undefined)

    await configure({})
    const resolved = { kv: undefined, nitro: {}, plugins: [], root: "/app" }
    await configureResolved(resolved)

    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.kv_namespaces", [{ binding: "KV" }])
  })

  it("cleans prior standalone bindings when Nitro takes output ownership", async () => {
    const { hubKV } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-nitro-transition-"))
    const runCloseBundle = async (plugin: ReturnType<typeof hubKV>) => {
      const lifecycleContract = (): Promise<void> | void => undefined
      await testHook(plugin.buildStart, lifecycleContract)()
      await testHook(plugin.buildEnd, lifecycleContract)()
      await testHook(plugin.closeBundle, async () => undefined)()
    }

    try {
      const standalone = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
      const configResolvedContract = (_value: TestBuildConfig): void => undefined
      await testHook(standalone.configResolved, configResolvedContract)({ build: { outDir: "dist" }, command: "build", root })
      await runCloseBundle(standalone)
      const outputRoot = createDefaultCloudflareOutputRoot(root)
      const wranglerFile = join(outputRoot, "wrangler.json")
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([{ binding: "KV" }])

      const nitro = hubKV({ binding: "KV", driver: "cloudflare-kv-binding" })
      nitro.nitro.setup({
        options: {
          cloudflare: {
            wrangler: {
              kv_namespaces: [{ binding: "KV", id: "hook-id" }],
            },
          },
        },
      })
      await testHook(nitro.configResolved, configResolvedContract)({
        build: { outDir: "dist" },
        command: "build",
        nitro: {
          cloudflare: {
            wrangler: {
              kv_namespaces: [
                { binding: "KV", experimental_remote: true, id: "nitro-id", preview_id: "preview-id", staging_id: undefined },
                { binding: "INVALID", id: 42, preview_id: 42 },
              ],
            },
          },
        },
        plugins: [{ name: "nitro:main" }],
        root,
      })
      await runCloseBundle(nitro)

      const nitroNamespace = { binding: "KV", experimental_remote: true, id: "nitro-id", preview_id: "preview-id" }
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([nitroNamespace])
      expect(existsSync(join(outputRoot, ".vitehub-kv-bindings.json"))).toBe(false)

      await runCloseBundle(nitro)
      expect(JSON.parse(await readFile(wranglerFile, "utf8")).kv_namespaces).toEqual([nitroNamespace])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
