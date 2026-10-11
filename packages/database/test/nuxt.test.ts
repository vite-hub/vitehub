import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { hubDb } from "../src/nuxt.ts"
import { resolveConfigValue } from "../src/config-value.ts"
import { resolveRuntimeCloudflareConfig } from "../src/internal/cloudflare.ts"
import { runtimeConfig } from "../src/runtime/definition-config.ts"
import type { ResolvedDBViteConfig } from "../src/types.ts"

import type { Plugin } from "vite"

const cloudflareBridgeState = vi.hoisted(() => ({
  activeEnv: undefined as Record<string, unknown> | undefined,
  fallbackEnv: Object.defineProperties({ FALLBACK: "fallback", SHARED: "fallback" }, {
    DB: { value: "binding" },
    NATIVE: { value: "native" },
  }),
}))

vi.mock("cloudflare:workers", () => ({ env: cloudflareBridgeState.fallbackEnv }))
vi.mock("@vite-hub/database/runtime/state", () => ({
  setActiveCloudflareEnv: (env: Record<string, unknown>) => {
    cloudflareBridgeState.activeEnv = env
    ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = env
  },
}))

function createNuxt(options: Record<string, unknown>) {
  const hooks: Record<string, ((value: Record<string, unknown>) => Promise<void> | void)[]> = {}
  const watchHooks: Array<(event: string, path: string) => Promise<void> | void> = []
  return {
    hooks,
    watchHooks,
    nuxt: {
      options,
      hook(name: string, callback: (value: Record<string, unknown>) => Promise<void> | void) {
        if (name === "builder:watch") {
          // SAFETY: Nuxt supplies the native builder:watch event and file path to this callback.
          watchHooks.push(callback as unknown as (event: string, path: string) => Promise<void> | void)
          return
        }
        hooks[name] ||= []
        hooks[name]!.push(callback)
      },
    },
  }
}

async function callHook(hooks: Record<string, ((value: Record<string, unknown>) => Promise<void> | void)[]>, name: string, value: Record<string, unknown>) {
  for (const callback of hooks[name] || []) {
    await callback(value)
  }
}

describe("Database Nuxt integration", () => {
  it("wires a D1 database resource into Nuxt Content and Wrangler config", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      dev: false,
      modules: ["@nuxt/content"],
      nitro: {
        preset: "cloudflare_module",
        cloudflare: {
          wrangler: {
            d1_databases: [
              {
                binding: "EXISTING",
                database_id: "existing-id",
                database_name: "existing-db",
              },
            ],
          },
        },
      },
      rootDir: "/tmp/vitehub-db-nuxt",
      vite: {
        plugins: [],
      },
    })
    const module = hubDb()

    expect(module.getModuleDependencies(nuxt)).toEqual({
      "@nuxt/content": {
        overrides: {
          database: {
            type: "d1",
            bindingName: "DB",
          },
        },
      },
    })

    await module(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "d1",
        bindingName: "DB",
      },
    })
    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "EXISTING",
              database_id: "existing-id",
              database_name: "existing-db",
            },
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
    })
    expect(nuxt.options.vite).toMatchObject({
      plugins: [
        expect.objectContaining({ name: "@vite-hub/database/vite" }),
      ],
    })

    const nitroConfig = {
      cloudflare: {
        wrangler: {},
      },
      exportConditions: ["workerd"],
      handlers: [],
      runtimeConfig: {
        content: {},
      },
    }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toEqual({
      alias: {
        "#vitehub/database/definition-defaults": "/tmp/vitehub-db-nuxt/.vitehub/database/definition-defaults.mjs",
        "@vite-hub/database/drizzle": "/tmp/vitehub-db-nuxt/.vitehub/database/cloudflare-runtime.mjs",
      },
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
      exportConditions: ["vitehub-hosted", "workerd"],
      handlers: [
        {
          handler: ".vitehub/nitro/database/middleware.ts",
          middleware: true,
          route: "/**",
        },
      ],
      rollupConfig: {
        external: ["cloudflare:workers"],
      },
      runtimeConfig: {
        content: {
          database: {
            type: "d1",
            bindingName: "DB",
          },
        },
      },
    })
    const middleware = await readFile("/tmp/vitehub-db-nuxt/.vitehub/nitro/database/middleware.ts", "utf8")
    expect(middleware).toContain("setActiveCloudflareEnv")
    expect(middleware).toContain(".__env__ ?? vitehubEnv")
  })

  it("merges split Cloudflare bindings with request-local precedence", async () => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-database-"))
    await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
    const middlewarePath = join(rootDir, ".vitehub/nitro/database/middleware.ts")
    const previousEnv = (globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__
    try {
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = Object.defineProperty(Object.create({ INHERITED: "inherited-binding" }), "DB", { value: "native-binding" })
      const middleware = (await import(`${pathToFileURL(middlewarePath).href}?t=${Date.now()}`)).default
      middleware({
        context: {
          _platform: { cloudflare: { env: { PLATFORM: "platform", SHARED: "platform" } } },
          cloudflare: { env: { CONTEXT: "context", SHARED: "context" } },
        },
        env: { DB: "event-binding", EVENT: "event", SHARED: "event" },
        req: { runtime: { cloudflare: { env: { REQUEST: "request", SHARED: "request" } } } },
      })

      expect(cloudflareBridgeState.activeEnv).toEqual({
        CONTEXT: "context",
        DB: "event-binding",
        EVENT: "event",
        PLATFORM: "platform",
        REQUEST: "request",
        SHARED: "event",
      })
      expect(cloudflareBridgeState.activeEnv?.DB).toBe("event-binding")
      middleware({})
      expect(cloudflareBridgeState.activeEnv?.DB).toBe("native-binding")
      expect(Object.hasOwn(cloudflareBridgeState.activeEnv!, "DB")).toBe(true)
      expect(Object.hasOwn(cloudflareBridgeState.activeEnv!, "INHERITED")).toBe(false)
      expect(cloudflareBridgeState.activeEnv?.INHERITED).toBeUndefined()
      expect(cloudflareBridgeState.activeEnv).not.toHaveProperty("EVENT")
      expect(cloudflareBridgeState.activeEnv).not.toHaveProperty("REQUEST")
    }
    finally {
      ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = previousEnv
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("aliases the hosted runtime from the ViteHub project root", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      dev: false,
      nitro: {
        preset: "cloudflare_module",
      },
      rootDir: "/tmp/vitehub-db-nuxt",
      srcDir: "/tmp/vitehub-db-nuxt/app",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = {}
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": "/tmp/vitehub-db-nuxt/.vitehub/database/cloudflare-runtime.mjs",
      },
    })
  })

  it("keeps the hosted runtime at the ViteHub project root with a custom Vite root", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "vercel" },
      rootDir: "/tmp/vitehub-db-nuxt",
      srcDir: "/tmp/vitehub-db-nuxt/app",
      vite: { root: "/tmp/vitehub-db-nuxt/custom-vite-root" },
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = {}
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": "/tmp/vitehub-db-nuxt/.vitehub/database/vercel-runtime.mjs",
      },
    })
  })

  it("uses local sqlite for Nuxt Content during dev without changing the D1 provider binding", async () => {
    const { nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
        local: {
          filename: ".data/custom-content.sqlite",
        },
      },
      dev: true,
      modules: ["@nuxt/content"],
      rootDir: "/tmp/vitehub-db-nuxt-dev",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "sqlite",
        filename: ".data/custom-content.sqlite",
      },
    })
    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
    })
  })

  it.each([
    ["absent", ""],
    ["empty", "cloudflare: {},"],
    ["HTTP only", "cloudflare: { http: true },"],
    ["binding only", "cloudflare: { binding: 'DB' },"],
  ])("materializes discovered migrations with %s Cloudflare settings in Nitro's output", async (_label, cloudflare) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-migrations-"))
    const definition = join(rootDir, "server/databases/config.ts")
    const migrationsDir = join(rootDir, "server/databases/migrations")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      'import { defineDatabase } from "@vite-hub/database"',
      `export default defineDatabase({ ${cloudflare} schema: {} })`,
      "",
    ].join("\n"))
    await mkdir(migrationsDir, { recursive: true })
    await Promise.all([
      writeFile(join(migrationsDir, "0001_portable.sql"), "SELECT 1;\n"),
      writeFile(join(migrationsDir, "journal.json"), "{}\n"),
    ])

    try {
      const { hooks, nuxt } = createNuxt({
        database: {
          driver: "d1",
          databaseId: "content-id",
          databaseName: "content-db",
        },
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      const nitroConfig = {}
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).toHaveProperty(
        "cloudflare.wrangler.d1_databases.0.migrations_dir",
        ".vitehub/database/migrations",
      )

      const modules = (nitroConfig as { modules: Array<(nitro: unknown) => void> }).modules
      let compiled: (() => Promise<void>) | undefined
      modules[0]!({
        hooks: { hook: (_name: "compiled", callback: () => Promise<void>) => { compiled = callback } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      await compiled!()

      const outputMigrationsDir = resolve(rootDir, ".output/server/.vitehub/database/migrations")
      await expect(readFile(join(outputMigrationsDir, "0001_portable.sql"), "utf8")).resolves.toBe("SELECT 1;\n")
      await expect(readFile(join(outputMigrationsDir, "journal.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each([true, false])("handles a separate opaque D1 resource with HTTP available: %s", async (http) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-separate-migrations-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      'import { defineDatabase } from "@vite-hub/database"',
      "const appDatabase = {",
      "  cloudflare: { binding: 'APP_DB', databaseId: 'app-id', databaseName: 'app-db' },",
      "}",
      "export default defineDatabase({",
      "  // The application database is a separate D1 resource.",
      "  ...appDatabase,",
      "  schema: {},",
      "})",
      "",
    ].join("\n"))

    try {
      const { hooks, nuxt } = createNuxt({
        database: {
          driver: "d1",
          databaseId: "content-id",
          databaseName: "content-db",
          ...(http ? { cloudflare: { http: true } } : {}),
        },
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      const nitroConfig = {}
      if (!http) {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_B0003" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).not.toHaveProperty(
        "cloudflare.wrangler.d1_databases.0.migrations_dir",
      )
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["missing-id", "missing-name", "provisioned-id", "http", "libsql", "vercel", "inherited"] as const)("validates owned native D1 projection before Nuxt output for %s access", async (access) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-owned-projection-"))
    const definition = join(rootDir, "server/databases/config.ts")
    const originalId = process.env.VITEHUB_TEST_NATIVE_APP_ID
    const originalName = process.env.VITEHUB_TEST_NATIVE_APP_NAME
    delete process.env.VITEHUB_TEST_NATIVE_APP_ID
    delete process.env.VITEHUB_TEST_NATIVE_APP_NAME
    const inherited = access === "inherited"
    const http = access === "http" || access === "vercel"
    const cloudflare = inherited ? "" : `binding: 'APP_DB', databaseId: ${access === "missing-name" ? "'application-id'" : "process.env.VITEHUB_TEST_NATIVE_APP_ID"}, databaseName: ${access === "missing-name" ? "process.env.VITEHUB_TEST_NATIVE_APP_NAME" : "'application-db'"}, ${http ? "http: true," : ""}`
    try {
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, `export default defineDatabase({ cloudflare: { ${cloudflare} }, ${access === "libsql" ? "connection: { url: 'libsql://application.example' }," : ""} schema: {} })\n`)
      if (access === "provisioned-id") {
        await mkdir(join(rootDir, ".vitehub"), { recursive: true })
        await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "application-id" } } }))
      }
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ ...(inherited ? {} : { databaseId: "content-id" }), databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "content-id", database_name: "content-db" }] } }, output: { serverDir: join(rootDir, ".output/server") }, preset: access === "vercel" ? "vercel" : "cloudflare_module" }
      if (access === "missing-id" || access === "missing-name") {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_B0005" })
        await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ database: (nuxt.options.vite as { database: unknown }).database, root: rootDir })
      plugin.nitro.setup({ hooks: { hook() {} }, options: nitroConfig })
      expect(nitroConfig.cloudflare.wrangler.d1_databases).toHaveLength(access === "provisioned-id" ? 2 : 1)
      if (access === "provisioned-id") expect(nitroConfig.cloudflare.wrangler.d1_databases[1]).toMatchObject({ binding: "APP_DB", database_id: "application-id", database_name: "application-db" })
      await expect(readFile(join(rootDir, `.vitehub/database/${access === "vercel" ? "vercel" : "cloudflare"}-runtime.mjs`), "utf8")).resolves.toContain("useDatabase")
    }
    finally {
      if (originalId === undefined) delete process.env.VITEHUB_TEST_NATIVE_APP_ID
      else process.env.VITEHUB_TEST_NATIVE_APP_ID = originalId
      if (originalName === undefined) delete process.env.VITEHUB_TEST_NATIVE_APP_NAME
      else process.env.VITEHUB_TEST_NATIVE_APP_NAME = originalName
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("maintains the discovered database runtime for Nitro development", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-local-"))
    const buildDir = join(rootDir, ".nuxt")
    const serverDir = join(rootDir, "app/server")
    const runtimeFile = join(buildDir, "vitehub/database/local-runtime.mjs")
    const writeDefinition = async (name: string) => {
      const file = join(serverDir, `databases/${name}/config.ts`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, [
        'import { defineDatabase } from "@vite-hub/database"',
        `export default defineDatabase({ name: ${JSON.stringify(name)}, schema: {} })`,
        "",
      ].join("\n"))
    }

    try {
      await writeDefinition("analytics")
      const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, serverDir, vite: {} })
      await hubDb({ connection: { authToken: "dev-token", url: "libsql://dev.example.com" } })(undefined, nuxt)

      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toEqual({ "@vite-hub/database/drizzle": runtimeFile })
      await expect(readFile(runtimeFile, "utf8")).resolves.toMatch(
        /databases\/analytics\/config\.ts[\s\S]+"connection":\{"authToken":"dev-token","url":"libsql:\/\/dev\.example\.com"\}[\s\S]+"analytics":[\s\S]+export const databases[\s\S]+export const db[\s\S]+export const schema/,
      )

      await rm(join(serverDir, "databases/analytics"), { force: true, recursive: true })
      await writeDefinition("reports")
      await callHook(hooks, "nitro:config", nitroConfig)
      const updatedRuntime = await readFile(runtimeFile, "utf8")
      expect(updatedRuntime).toContain("databases/reports/config.ts")
      expect(updatedRuntime).not.toContain("databases/analytics/config.ts")

      const customAlias = { alias: { "@vite-hub/database/drizzle": "#custom-database" } }
      await callHook(hooks, "nitro:config", customAlias)
      expect(customAlias.alias).toEqual({ "@vite-hub/database/drizzle": "#custom-database" })
      await expect(readFile(runtimeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

      await callHook(hooks, "nitro:config", nitroConfig)
      await rm(serverDir, { force: true, recursive: true })
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toBeUndefined()
      await expect(readFile(runtimeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["default", "nested", "nested-src"] as const)("refreshes Nitro development resource projections after Definition edits at the %s project root", async (location) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-hmr-"))
    const projectRoot = location === "default" ? rootDir : join(rootDir, "packages/database")
    const buildDir = join(rootDir, ".nuxt")
    const srcDir = join(rootDir, "app")
    const definition = join(projectRoot, location === "nested-src" ? "src/database.ts" : "server/databases/config.ts")
    const runtimeFile = join(buildDir, "vitehub/database/local-runtime.mjs")
    await mkdir(dirname(definition), { recursive: true })
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({
      cloudflare: { d1Nuxt: { "host-db": "host-provisioned-id" } },
    }))
    const writeInheritedDefinition = () => writeFile(definition, "export default defineDatabase({ schema: {} })\n")
    const readDefaults = async (): Promise<ResolvedDBViteConfig["definitionDefaults"]> => {
      const module = await readFile(runtimeFile, "utf8")
      return JSON.parse(/const definitionDefaults = (.+)\n/.exec(module)![1]!)
    }
    try {
      await writeInheritedDefinition()
      const { hooks, nuxt, watchHooks } = createNuxt({ buildDir, dev: true, rootDir, srcDir, vite: {} })
      await hubDb({ binding: "HOST_DB", databaseName: "host-db", driver: "d1", ...(location === "default" ? {} : { projectRoot }) })(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toEqual({ "@vite-hub/database/drizzle": runtimeFile })
      const inherited = { drizzle: {}, name: "default", schema: {} }
      const initial = runtimeConfig(inherited, await readDefaults()).cloudflare
      expect(initial?.binding).toBe("HOST_DB")
      expect(resolveConfigValue(initial?.databaseId)).toBe("host-provisioned-id")

      const owned = { ...inherited, cloudflare: { binding: "HOST_DB", databaseId: "application-id", databaseName: "application-db" } }
      await writeFile(definition, [
        `const cloudflare = ${JSON.stringify(owned.cloudflare)}`,
        "export default defineDatabase({ cloudflare, schema: {} })",
        "",
      ].join("\n"))
      for (const callback of watchHooks) await callback("change", relative(srcDir, definition))
      const updatedDefaults = await readDefaults()
      expect(updatedDefaults.cloudflareProjections?.default?.resource).toBe("opaque")
      const updated = runtimeConfig(owned, updatedDefaults).cloudflare
      expect(updated?.binding).toBeUndefined()
      expect(resolveConfigValue(updated?.databaseId)).toBe("application-id")
      expect(nuxt.options.watch).toContain(dirname(definition))

      await writeInheritedDefinition()
      for (const callback of watchHooks) await callback("change", definition)
      expect(runtimeConfig(inherited, await readDefaults()).cloudflare?.binding).toBe("HOST_DB")

      await rm(dirname(definition), { force: true, recursive: true })
      for (const callback of watchHooks) await callback("unlinkDir", dirname(definition))
      expect(nitroConfig.alias).toBeUndefined()
      await expect(readFile(runtimeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await mkdir(dirname(definition), { recursive: true })
      await writeInheritedDefinition()
      for (const callback of watchHooks) await callback("addDir", dirname(definition))
      expect(nitroConfig.alias).toEqual({ "@vite-hub/database/drizzle": runtimeFile })
      expect(runtimeConfig(inherited, await readDefaults()).cloudflare?.binding).toBe("HOST_DB")

      const customConfig = { alias: { "@vite-hub/database/drizzle": "#custom-database" } }
      await callHook(hooks, "nitro:config", customConfig)
      for (const callback of watchHooks) await callback("change", definition)
      expect(customConfig.alias).toEqual({ "@vite-hub/database/drizzle": "#custom-database" })
      await expect(readFile(runtimeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("deduplicates D1 bindings already merged into Nuxt and Nitro config", async () => {
    const binding = {
      binding: "DB",
      database_id: "content-id",
      database_name: "content-db",
    }
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      dev: false,
      nitro: {
        cloudflare: {
          wrangler: {
            d1_databases: [binding, binding],
          },
        },
      },
      rootDir: "/tmp/vitehub-db-nuxt-deduplicated",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [binding],
        },
      },
    })

    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [binding, binding],
        },
      },
    }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.cloudflare.wrangler.d1_databases).toEqual([binding])
  })

  it("does not emit an invalid Wrangler D1 binding when the resource is incomplete", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseName: "content-db",
      },
      dev: false,
      modules: ["@nuxt/content"],
      rootDir: "/tmp/vitehub-db-nuxt-unresolved",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "d1",
        bindingName: "DB",
      },
    })
    expect(nuxt.options.nitro).toBeUndefined()
    await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
      "Cloudflare D1 database \"default\" requires database.databaseId or provision state",
    )
  })

  it("reports a missing D1 database name separately from a missing id", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        databaseId: "content-id",
        driver: "d1",
      },
      dev: false,
      rootDir: "/tmp/vitehub-db-nuxt-missing-name",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
      "Cloudflare D1 output requires database.databaseName",
    )
    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("rejects a whitespace-only D1 name even when Nitro provides a matching blank name", async () => {
    const { hooks, nuxt } = createNuxt({
      database: { databaseId: "content-id", databaseName: "   ", driver: "d1" },
      dev: false,
      rootDir: join(tmpdir(), "vitehub-db-nuxt-blank-name"),
      vite: {},
    })
    await hubDb()(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", {
      cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "content-id", database_name: "   " }] } },
      preset: "cloudflare_module",
    })).rejects.toMatchObject({ code: "DATABASE_B0001" })
  })

  it("accepts a complete matching D1 binding from Nitro Wrangler config", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseName: "content-db",
      },
      dev: false,
      rootDir: "/tmp/vitehub-db-nuxt-existing-binding",
      vite: {},
    })

    await hubDb()(undefined, nuxt)
    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [{
            binding: "DB",
            database_id: "content-id",
            database_name: "content-db",
          }],
        },
      },
      preset: "cloudflare_module",
    }

    await expect(callHook(hooks, "nitro:config", nitroConfig)).resolves.toBeUndefined()
    expect(nitroConfig.cloudflare.wrangler.d1_databases).toHaveLength(1)
  })

  it("rejects a matching binding name for a different D1 database", async () => {
    const { hooks, nuxt } = createNuxt({
      database: { driver: "d1", databaseName: "content-db" },
      dev: false,
      rootDir: "/tmp/vitehub-db-nuxt-wrong-existing-binding",
      vite: {},
    })
    await hubDb()(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", {
      cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "other-id", database_name: "other-db" }] } },
      preset: "cloudflare_module",
    })).rejects.toThrow("requires database.databaseId or provision state")
  })

  it("uses provisioned D1 ids in Nuxt Cloudflare output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-provisioned-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      'import { defineDatabase } from "@vite-hub/database"',
      "export default defineDatabase({ schema: {} })",
      "",
    ].join("\n"))
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({
      cloudflare: { d1: { default: "definition-id" }, d1Nuxt: { "content-db": "provisioned-id" } },
    }))

    try {
      const { hooks, nuxt } = createNuxt({
        database: {
          driver: "d1",
          databaseName: {
            default: "content-db",
            kind: "env-variable",
            source: { kind: "env", name: "VITEHUB_TEST_D1_NAME" },
          },
        },
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      const nitroConfig = {}
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).toHaveProperty("cloudflare.wrangler.d1_databases.0", {
        binding: "DB",
        database_id: "provisioned-id",
        database_name: "content-db",
        migrations_dir: ".vitehub/database/migrations",
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["absent", "unset environment"] as const)("uses provisioned D1 ids with an %s id in the hosted Vercel runtime", async (idSource) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-vercel-provisioned-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      'import { defineDatabase } from "@vite-hub/database"',
      "export default defineDatabase({ schema: {} })",
      "",
    ].join("\n"))
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({
      cloudflare: { d1Nuxt: { "content-db": "provisioned-id" } },
    }))

    vi.stubEnv("VITEHUB_TEST_PROVISIONED_D1_ID", "")
    try {
      const { hooks, nuxt } = createNuxt({
        database: {
          driver: "d1",
          ...(idSource === "unset environment" ? {
            databaseId: {
              kind: "env-variable",
              source: { kind: "env", name: "VITEHUB_TEST_PROVISIONED_D1_ID" },
            },
          } : {}),
          databaseName: "content-db",
        },
        dev: false,
        nitro: { preset: "vercel" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      const module = await readFile(join(rootDir, ".vitehub/database/vercel-runtime.mjs"), "utf8")
      const expression = /db: createHostedDrizzleDb\((\{[\s\S]*?\}), schema_0\)/.exec(module)?.[1]
      expect(expression).toBeDefined()
      const config = Function("definition_0", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ drizzle: {}, schema: {} }, resolveRuntimeCloudflareConfig)
      expect(resolveConfigValue(config.cloudflare.databaseId)).toBe("provisioned-id")
      expect(config.cloudflare.databaseName).toBe("content-db")
      const viteOptions = (nuxt.options.vite as { database: { databaseId: Parameters<typeof resolveConfigValue>[0] } }).database
      expect(resolveConfigValue(viteOptions.databaseId)).toBe("provisioned-id")
      if (idSource === "unset environment") {
        vi.stubEnv("VITEHUB_TEST_PROVISIONED_D1_ID", "runtime-id")
        expect(resolveConfigValue(config.cloudflare.databaseId)).toBe("runtime-id")
        expect(resolveConfigValue(viteOptions.databaseId)).toBe("runtime-id")
      }
    }
    finally {
      vi.unstubAllEnvs()
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("preserves Nuxt D1 HTTP defaults in the development runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-d1-dev-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: {} })\n")

    try {
      const { hooks, nuxt } = createNuxt({
        database: {
          binding: "CONTENT_DB",
          cloudflare: { http: { authToken: "proxy-token", url: "https://d1.example.com/raw" } },
          databaseId: "content-id",
          databaseName: "content-db",
          driver: "d1",
          migrationsTable: "__content_migrations",
          previewDatabaseId: "preview-id",
        },
        dev: true,
        rootDir,
        vite: {},
      })
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      const module = await readFile(join(rootDir, ".vitehub/database/local-runtime.mjs"), "utf8")
      const defaults = JSON.parse(/const definitionDefaults = (.+)\n/.exec(module)![1]!)
      expect(defaults.cloudflare).toEqual({
        binding: "CONTENT_DB",
        databaseId: "content-id",
        databaseName: "content-db",
        http: { authToken: "proxy-token", url: "https://d1.example.com/raw" },
        migrationsTable: "__content_migrations",
        previewDatabaseId: "preview-id",
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("does not consume default Definition provision state for the Nuxt resource", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-definition-state-"))
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({
      cloudflare: { d1: { default: "definition-id" } },
    }))
    try {
      const { hooks, nuxt } = createNuxt({
        database: { driver: "d1", databaseName: "content-db" },
        dev: false,
        rootDir,
        vite: {},
      })
      await hubDb()(undefined, nuxt)

      await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
        "requires database.databaseId or provision state",
      )
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("keeps an existing database Vite plugin", async () => {
    const existingPlugin = { name: "@vite-hub/database/vite" }
    const { nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      rootDir: "/tmp/vitehub-db-nuxt-existing-plugin",
      vite: {
        plugins: [existingPlugin],
      },
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.vite).toMatchObject({
      plugins: [existingPlugin],
    })
  })

  it("selects the hosted definition runtime in production without a D1 bridge", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "vercel" },
      rootDir: "/tmp/vitehub-db-nuxt-hosted",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = { exportConditions: ["node"] }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.exportConditions).toEqual(["vitehub-hosted", "node"])
  })

  it.each([
    ["cloudflare-module", "cloudflare"],
    ["vercel", "vercel"],
  ])("aliases the Drizzle runtime to the generated %s database module", async (preset, provider) => {
    const rootDir = `/tmp/vitehub-db-nuxt-${provider}-runtime`
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset },
      rootDir,
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig: Record<string, unknown> = { preset }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.alias).toEqual({
      "#vitehub/database/definition-defaults": join(rootDir, ".vitehub/database/definition-defaults.mjs"),
      "@vite-hub/database/drizzle": join(rootDir, `.vitehub/database/${provider}-runtime.mjs`),
    })
  })

  it("selects the hosted definition runtime for Deno deployments", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "deno-deploy" },
      rootDir: "/tmp/vitehub-db-nuxt-deno",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = { exportConditions: ["deno"] }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.exportConditions).toEqual(["vitehub-hosted", "deno"])
  })

  it.each([undefined, "DB", "APP_DB"])("keeps Nuxt host and owned Definition resources separate with binding %s", async (binding) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-owned-binding-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, `export default defineDatabase({ cloudflare: { ${binding ? `binding: ${JSON.stringify(binding)},` : ""} databaseId: 'application-id', databaseName: 'application-db' }, schema: {} })\n`)
    try {
      const { hooks, nuxt } = createNuxt({ dev: false, modules: ["@nuxt/content"], rootDir, vite: {} })
      await hubDb({ databaseId: "content-id", databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { d1_databases: [] as unknown[] } }, output: { serverDir: join(rootDir, ".output/server") }, preset: "cloudflare_module" }
      if (binding !== "APP_DB") {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toThrow("distinct Cloudflare D1 binding")
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ database: (nuxt.options.vite as { database: unknown }).database, root: rootDir })
      plugin.nitro.setup({ hooks: { hook() {} }, options: nitroConfig })
      expect(nitroConfig.cloudflare.wrangler.d1_databases).toEqual([
        { binding: "DB", database_id: "content-id", database_name: "content-db" },
        expect.objectContaining({ binding: "APP_DB", database_id: "application-id", database_name: "application-db" }),
      ])
      expect(nuxt.options.content).toEqual({ database: { bindingName: "DB", type: "d1" } })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["integration", "nitro"] as const)("allows the owned Definition to share an identical Nuxt host resource from %s", async (source) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-shared-binding-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ cloudflare: { databaseId: 'content-id', databaseName: 'content-db' }, schema: {} })\n")
    try {
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ ...(source === "integration" ? { databaseId: "content-id" } : {}), databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig = {
        cloudflare: { wrangler: { d1_databases: source === "nitro" ? [{ binding: "DB", database_id: "content-id", database_name: "content-db" }] : [] } },
        preset: "cloudflare_module",
      }
      await expect(callHook(hooks, "nitro:config", nitroConfig)).resolves.toBeUndefined()
      expect(nitroConfig.cloudflare.wrangler.d1_databases).toEqual([{ binding: "DB", database_id: "content-id", database_name: "content-db" }])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["env-id", "env-name", "provisioned-id", "separate-env"] as const)("shares the Nuxt host binding only for static identity with %s", async (identity) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-static-identity-"))
    const definition = join(rootDir, "server/databases/config.ts")
    const originalId = process.env.VITEHUB_TEST_NATIVE_APP_ID
    const originalName = process.env.VITEHUB_TEST_NATIVE_APP_NAME
    delete process.env.VITEHUB_TEST_NATIVE_APP_ID
    process.env.VITEHUB_TEST_NATIVE_APP_NAME = "content-db"
    try {
      await mkdir(dirname(definition), { recursive: true })
      const databaseId = identity === "provisioned-id" ? "" : `databaseId: ${identity === "env-name" ? "'content-id'" : "process.env.VITEHUB_TEST_NATIVE_APP_ID"},`
      const databaseName = identity === "env-name" ? "process.env.VITEHUB_TEST_NATIVE_APP_NAME" : "'content-db'"
      await writeFile(definition, `export default defineDatabase({ cloudflare: { ${identity === "separate-env" ? "binding: 'APP_DB'," : ""} ${databaseId} databaseName: ${databaseName} }, schema: {} })\n`)
      if (identity !== "env-name") {
        await mkdir(join(rootDir, ".vitehub"), { recursive: true })
        await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "content-id" } } }))
      }
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ databaseId: "content-id", databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { d1_databases: [] as unknown[] } }, output: { serverDir: join(rootDir, ".output/server") }, preset: "cloudflare_module" }
      if (identity === "env-id" || identity === "env-name") {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_B0004" })
        await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ database: (nuxt.options.vite as { database: unknown }).database, root: rootDir })
      plugin.nitro.setup({ hooks: { hook() {} }, options: nitroConfig })
      expect(nitroConfig.cloudflare.wrangler.d1_databases).toHaveLength(identity === "separate-env" ? 2 : 1)
    }
    finally {
      if (originalId === undefined) delete process.env.VITEHUB_TEST_NATIVE_APP_ID
      else process.env.VITEHUB_TEST_NATIVE_APP_ID = originalId
      if (originalName === undefined) delete process.env.VITEHUB_TEST_NATIVE_APP_NAME
      else process.env.VITEHUB_TEST_NATIVE_APP_NAME = originalName
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("rejects an owned native binding collision during Nuxt dev refresh and recovers after a distinct binding", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-dev-binding-"))
    const definition = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: {} })\n")
    try {
      const { hooks, nuxt, watchHooks } = createNuxt({ buildDir: join(rootDir, ".nuxt"), dev: true, rootDir, vite: {} })
      await hubDb({ databaseId: "content-id", databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      const runtimeFile = join(rootDir, ".nuxt/vitehub/database/local-runtime.mjs")
      const initial = await readFile(runtimeFile, "utf8")
      await writeFile(definition, "export default defineDatabase({ cloudflare: { databaseId: 'application-id', databaseName: 'application-db' }, schema: {} })\n")
      for (const callback of watchHooks) await expect(callback("change", definition)).rejects.toMatchObject({ code: "DATABASE_B0004" })
      expect(await readFile(runtimeFile, "utf8")).toBe(initial)
      await writeFile(definition, "export default defineDatabase({ cloudflare: { binding: 'APP_DB', databaseId: 'application-id', databaseName: 'application-db' }, schema: {} })\n")
      for (const callback of watchHooks) await callback("change", definition)
      const refreshed = await readFile(runtimeFile, "utf8")
      const defaults = JSON.parse(/const definitionDefaults = (.+)\n/.exec(refreshed)![1]!) as ResolvedDBViteConfig["definitionDefaults"]
      expect(defaults.cloudflareProjections.default?.binding).toBe("APP_DB")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("propagates Nuxt D1 options to direct definition defaults", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-binding-"))
    const { nuxt } = createNuxt({
      database: {
        binding: "CONTENT_DB",
        cloudflare: { http: true },
        databaseId: "content-id",
        databaseName: "content-db",
        driver: "d1",
        migrationsTable: "__content_migrations",
        previewDatabaseId: "preview-id",
      },
      rootDir,
      vite: {},
    })

    try {
      await hubDb()(undefined, nuxt)

      const plugin = (nuxt.options.vite as { plugins: Plugin[] }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({
        database: undefined,
        root: rootDir,
      })
      const id = await (plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>)(
        "#vitehub/database/definition-defaults",
      )
      const code = await (plugin.load as (id: string) => string | undefined | Promise<string | undefined>)(id!)

      const defaults = Function(`return (${code!.replace(/^export default /, "")})`)()
      expect(defaults.cloudflare).toEqual({
        binding: "CONTENT_DB",
        databaseId: "content-id",
        databaseName: "content-db",
        http: true,
        migrationsTable: "__content_migrations",
        previewDatabaseId: "preview-id",
      })
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["inherited", "configured"])("keeps Database generation rooted at Nuxt projectRoot for a %s resource when Vite uses another root", async (resource) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-project-root-"))
    const projectRoot = join(rootDir, "packages", "db")
    const definition = join(projectRoot, "server", "databases", "config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, `export default defineDatabase({ ${resource === "configured" ? "cloudflare: { binding: 'APP_DB', databaseName: 'application-db' }," : ""} schema: {} })\n`)
    if (resource === "configured") {
      await mkdir(join(rootDir, "app", ".vitehub"), { recursive: true })
      await writeFile(join(rootDir, "app", ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "application-id" } } }))
      await mkdir(join(projectRoot, ".vitehub"))
      await writeFile(join(projectRoot, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "unrelated-nested-id" } } }))
    }

    try {
      const { hooks, nuxt } = createNuxt({
        dev: false,
        rootDir,
        serverDir: join(rootDir, "server"),
        vite: { plugins: [], root: "app" },
      })
      await hubDb({
        databaseId: "content-id",
        databaseName: "content-db",
        driver: "d1",
        projectRoot: "packages/db",
      })(undefined, nuxt)

      const plugin = (nuxt.options.vite as { plugins: Plugin[] }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({
        database: (nuxt.options.vite as { database: unknown }).database,
        root: join(rootDir, "app"),
      })

      expect(plugin.api.getConfig()?.rootDir).toBe(projectRoot)
      await expect(readFile(join(projectRoot, ".vitehub/types/database.d.ts"), "utf8"))
        .resolves.toContain('declare module "vite-hub/database/drizzle"')

      const nitroConfig = { alias: {}, modules: [], preset: "cloudflare_module" }
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toEqual({
        "#vitehub/database/definition-defaults": join(projectRoot, ".vitehub/database/definition-defaults.mjs"),
        "@vite-hub/database/drizzle": join(projectRoot, ".vitehub/database/cloudflare-runtime.mjs"),
      })
      expect(nitroConfig.modules).toHaveLength(resource === "inherited" ? 1 : 0)
      if (resource === "inherited") return
      const defaultsFile = join(projectRoot, ".vitehub/database/definition-defaults.mjs")
      const { default: defaults } = await import(pathToFileURL(defaultsFile).href)
      expect(defaults.cloudflareProjections.default).toEqual({ binding: "APP_DB", provisionedId: "application-id", resource: "configured" })
      expect(plugin.api.getConfig()?.databases.default?.cloudflare?.databaseId).toBe("application-id")

      await rm(join(rootDir, "app", ".vitehub/provision.json"))
      await expect(callHook(hooks, "nitro:config", { alias: {}, modules: [], preset: "cloudflare_module" })).rejects.toMatchObject({ code: "DATABASE_B0005" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("preserves the local definition runtime for production Node builds", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "node-server" },
      rootDir: "/tmp/vitehub-db-nuxt-node",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = { exportConditions: ["node"] }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.exportConditions).toEqual(["node"])
  })

  it("can be disabled from top-level Nuxt database config", async () => {
    const { nuxt } = createNuxt({
      database: false,
      rootDir: "/tmp/vitehub-db-nuxt-disabled",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options).toEqual({
      database: false,
      rootDir: "/tmp/vitehub-db-nuxt-disabled",
      vite: {},
    })
  })
})
