import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { hubDb } from "../src/nuxt.ts"

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
  },
}))

function createNuxt(options: Record<string, unknown>) {
  const hooks: Record<string, ((value: Record<string, unknown>) => Promise<void> | void)[]> = {}
  return {
    hooks,
    nuxt: {
      options,
      hook(name: string, callback: (value: Record<string, unknown>) => Promise<void> | void) {
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
    const rootDir = process.cwd()
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

      ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = Object.defineProperty({}, "DB", { value: "native-binding" })
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
    }
    finally {
      ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = previousEnv
      await rm(middlewarePath, { force: true })
    }
  })

  it("aliases the hosted runtime from the Nuxt source directory", async () => {
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
        "@vite-hub/database/drizzle": "/tmp/vitehub-db-nuxt/app/.vitehub/database/cloudflare-runtime.mjs",
      },
    })
  })

  it("aliases the hosted runtime from a custom Vite root", async () => {
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
        "@vite-hub/database/drizzle": "/tmp/vitehub-db-nuxt/custom-vite-root/.vitehub/database/vercel-runtime.mjs",
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

  it("materializes discovered migrations in Nitro's Cloudflare output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-migrations-"))
    const definition = join(rootDir, "server/databases/config.ts")
    const migrationsDir = join(rootDir, "server/databases/migrations")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      'import { defineDatabase } from "@vite-hub/database"',
      "export default defineDatabase({ schema: {} })",
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

  it("does not assign migrations from a definition with its own D1 resource to the Nuxt binding", async () => {
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
        },
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      const nitroConfig = {}
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).not.toHaveProperty(
        "cloudflare.wrangler.d1_databases.0.migrations_dir",
      )
    }
    finally {
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

  it("keeps the Nuxt host binding out of definition defaults", async () => {
    const { nuxt } = createNuxt({
      database: {
        binding: "CONTENT_DB",
        driver: "d1",
      },
      rootDir: "/tmp/vitehub-db-nuxt-binding",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const plugin = (nuxt.options.vite as { plugins: Plugin[] }).plugins[0]!
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      database: undefined,
      root: "/tmp/vitehub-db-nuxt-binding",
    })
    const id = await (plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>)(
      "#vitehub/database/definition-defaults",
    )
    const code = await (plugin.load as (id: string) => string | undefined | Promise<string | undefined>)(id!)

    expect(code).not.toContain('"binding":"CONTENT_DB"')
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
