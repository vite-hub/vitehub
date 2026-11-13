import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { hubDb as publishedHubDb } from "@vite-hub/database/nuxt"
import { build } from "esbuild"
import { afterAll, describe, expect, it, vi } from "vitest"
import { getResolvedFeatureOptions, VITEHUB_FEATURES } from "@vite-hub/internal/build/vite"

import { hubDb } from "../src/nuxt.ts"
import { resolveConfigValue } from "../src/config-value.ts"
import { resolveRuntimeCloudflareConfig } from "../src/internal/cloudflare.ts"
import { runtimeConfig } from "../src/runtime/definition-config.ts"
import { createUseDatabase } from "../src/runtime/use-database.ts"
import type { ResolvedDBViteConfig } from "../src/types.ts"

import type { Plugin } from "vite"

const cloudflareBridgeState = vi.hoisted(() => ({
  activeEnv: undefined as Record<string, unknown> | undefined,
  scopedEnv: undefined as Record<string, unknown> | undefined,
  fallbackEnv: Object.defineProperties({ FALLBACK: "fallback", SHARED: "fallback" }, {
    DB: { value: "binding" },
    NATIVE: { value: "native" },
  }),
}))

vi.mock("cloudflare:workers", () => ({ env: cloudflareBridgeState.fallbackEnv }))
vi.mock("@vite-hub/database/runtime/state", () => ({
  getRequestCloudflareEnv: (event: { "~standard"?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } } }) => event["~standard"]?.runtime?.cloudflare?.env,
  runWithDatabaseRequest: (_event: unknown, next: () => unknown) => next(),
  runWithActiveCloudflareEnv: (env: Record<string, unknown>, callback: () => unknown) => {
    cloudflareBridgeState.scopedEnv = env
    try {
      return callback()
    }
    finally {
      cloudflareBridgeState.scopedEnv = undefined
    }
  },
  setActiveCloudflareEnv: (env: Record<string, unknown>) => {
    cloudflareBridgeState.activeEnv = env
    ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = env
  },
}))

// Each run gets its own fixture directories, so two runs at the same time do not overwrite each other.
const tmp = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-test-"))
afterAll(async () => await rm(tmp, { force: true, recursive: true }))

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
      rootDir: `${tmp}/vitehub-db-nuxt`,
      vite: {
        plugins: [],
      },
    })
    const module = hubDb({
      driver: "d1",
      databaseId: "content-id",
      databaseName: "content-db",
    })

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
          compatibility_flags: ["nodejs_als"],
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
        "#vitehub/database/definition-defaults": `${tmp}/vitehub-db-nuxt/.vitehub/database/definition-defaults.mjs`,
        "#vitehub/database/definition-runtime": expect.stringMatching(/\/runtime\/d1\.(?:js|ts)$/),
        "@vite-hub/database/drizzle": `${tmp}/vitehub-db-nuxt/.vitehub/database/cloudflare-runtime.mjs`,
      },
      cloudflare: {
        wrangler: {
          compatibility_flags: ["nodejs_als"],
          d1_databases: [
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
              migrations_dir: ".vitehub/database/migrations/DB",
            },
          ],
        },
      },
      modules: [expect.any(Function), expect.any(Function), expect.any(Function)],
      exportConditions: ["vitehub-hosted", "workerd"],
      handlers: [
        {
          handler: ".vitehub/nitro/database/request-stats.ts",
          middleware: true,
        },
        {
          handler: ".vitehub/nitro/database/middleware.ts",
          middleware: true,
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
    const middleware = await readFile(`${tmp}/vitehub-db-nuxt/.vitehub/nitro/database/middleware.ts`, "utf8")
    expect(middleware).toContain("setActiveCloudflareEnv")
    expect(middleware).toContain(".__env__ ?? vitehubEnv")
  })

  it("does not add Cloudflare async context flags to non-Cloudflare Nitro output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-provider-"))
    try {
      const { hooks, nuxt } = createNuxt({ dev: false, nitro: { preset: "vercel" }, rootDir, vite: {} })
      await hubDb()(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { compatibility_flags: ["existing"] } } }
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.cloudflare.wrangler.compatibility_flags).toEqual(["existing"])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("merges the request's Cloudflare bindings over the native bindings", async () => {
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
      const request = (env?: Record<string, unknown>) => ({ "~standard": { runtime: env ? { cloudflare: { env } } : {} } })
      middleware(request({ DB: "event-binding", EVENT: "event", SHARED: "event" }), () => undefined)

      expect(cloudflareBridgeState.activeEnv).toEqual({
        DB: "event-binding",
        EVENT: "event",
        SHARED: "event",
      })
      expect(cloudflareBridgeState.activeEnv?.DB).toBe("event-binding")
      const response = middleware(request({ DB: "next-binding" }), () => {
        expect(cloudflareBridgeState.scopedEnv?.DB).toBe("next-binding")
        return "next-response"
      })
      expect(response).toBe("next-response")
      expect(cloudflareBridgeState.scopedEnv).toBeUndefined()
      middleware(request(), () => undefined)
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

  it("wires Postgres Hyperdrive bindings and runtime into Cloudflare Nitro output", async () => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-database-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), [
        "import { defineDatabase } from '@vite-hub/database'",
        "import { pgTable, text } from 'drizzle-orm/pg-core'",
        "export default defineDatabase({",
        "  dialect: 'postgresql',",
        "  cloudflare: { hyperdriveId: 'hyperdrive-id' },",
        "  connection: { url: process.env.DATABASE_URL },",
        "  schema: { notes: pgTable('notes', { title: text('title') }) },",
        "})",
        "",
      ].join("\n"))
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb()(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = { cloudflare: { wrangler: { hyperdrive: [{ binding: "OTHER", id: "other-id" }] } } }
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).toMatchObject({
        alias: { "@vite-hub/database/drizzle": join(rootDir, ".vitehub/database/cloudflare-runtime.mjs") },
        cloudflare: {
          wrangler: {
            hyperdrive: [
              { binding: "OTHER", id: "other-id" },
              { binding: "HYPERDRIVE", id: "hyperdrive-id" },
            ],
          },
        },
      })
      const runtime = await readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")
      expect(runtime).toContain("createPostgresDatabase({ ...definition_0, relations: relations_0, schema: schema_0 }, {\"binding\":\"HYPERDRIVE\"")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("aliases the hosted runtime from the ViteHub project root", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: {
        preset: "cloudflare_module",
      },
      rootDir: `${tmp}/vitehub-db-nuxt`,
      srcDir: `${tmp}/vitehub-db-nuxt/app`,
      vite: {},
    })

    await hubDb({
      driver: "d1",
      databaseId: "content-id",
      databaseName: "content-db",
    })(undefined, nuxt)

    const nitroConfig = {}
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": `${tmp}/vitehub-db-nuxt/.vitehub/database/cloudflare-runtime.mjs`,
      },
    })
  })

  it("keeps the hosted runtime at the ViteHub project root with a custom Vite root", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "vercel" },
      rootDir: `${tmp}/vitehub-db-nuxt`,
      srcDir: `${tmp}/vitehub-db-nuxt/app`,
      vite: { root: `${tmp}/vitehub-db-nuxt/custom-vite-root` },
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = {}
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": `${tmp}/vitehub-db-nuxt/.vitehub/database/vercel-runtime.mjs`,
      },
    })
  })

  it("uses local sqlite for Nuxt Content during dev without changing the D1 provider binding", async () => {
    const { nuxt } = createNuxt({
      dev: true,
      modules: ["@nuxt/content"],
      rootDir: `${tmp}/vitehub-db-nuxt-dev`,
      vite: {},
    })

    await hubDb({
      driver: "d1",
      databaseId: "content-id",
      databaseName: "content-db",
      local: {
        filename: ".data/custom-content.sqlite",
      },
    })(undefined, nuxt)

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
    const definition = join(rootDir, "server/databases/default.ts")
    const migrationsDir = join(rootDir, "server/databases/default/migrations")
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
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb({
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      })(undefined, nuxt)
      const nitroConfig = {}
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).toHaveProperty(
        "cloudflare.wrangler.d1_databases.0.migrations_dir",
        ".vitehub/database/migrations/DB",
      )

      const modules = (nitroConfig as { modules: Array<(nitro: unknown) => void> }).modules
      let compiled: (() => Promise<void>) | undefined
      modules[0]!({
        hooks: { hook: (name: string, callback: () => Promise<void>) => { if (name === "compiled") compiled = callback } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      await compiled!()

      const outputMigrationsDir = resolve(rootDir, ".output/server/.vitehub/database/migrations/DB")
      await expect(readFile(join(outputMigrationsDir, "0001_portable.sql"), "utf8")).resolves.toBe("SELECT 1;\n")
      await expect(readFile(join(outputMigrationsDir, "journal.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  // The first test also imports the Nitro builder, which can take longer than the default timeout.
  describe("a D1 binding that the project's wrangler.json also declares", { timeout: 30_000 }, () => {
    /** Runs the Database module, then Nitro's real Cloudflare preset, which merges the project file into its output. */
    async function writeWrangler(project: Record<string, unknown>, wrangler: Record<string, unknown> = {}, database: Record<string, unknown> = {}) {
      const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-wrangler-"))
      const definition = join(rootDir, "server/databases/default.ts")
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, 'import { defineDatabase } from "@vite-hub/database"\nexport default defineDatabase({ schema: {} })\n')
      await writeFile(join(rootDir, "wrangler.json"), JSON.stringify(project))
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })
      await hubDb({ driver: "d1", binding: "DB", databaseId: "content-id", databaseName: "content-db", ...database })(undefined, nuxt)
      const nitroConfig: { cloudflare?: { wrangler?: Record<string, unknown> }, modules?: NitroModule[] } = { cloudflare: { wrangler } }
      await callHook(hooks, "nitro:config", nitroConfig)
      const { createNitro } = await import("nitro/builder")
      const nitro = await createNitro({
        cloudflare: { deployConfig: true, wrangler: nitroConfig.cloudflare!.wrangler },
        compatibilityDate: "2026-10-01",
        dev: false,
        logLevel: 0,
        modules: nitroConfig.modules,
        preset: "cloudflare-module",
        rootDir,
      } as NitroConfig)
      return {
        rootDir,
        async compile() {
          try {
            await nitro.hooks.callHook("compiled", nitro)
            return JSON.parse(await readFile(join(nitro.options.output.serverDir, "wrangler.json"), "utf8")) as { d1_databases: unknown[], env?: Record<string, { d1_databases: unknown[] }> }
          }
          finally {
            await nitro.close()
          }
        },
      }
    }
    type NitroModule = Exclude<NonNullable<NitroConfig["modules"]>[number], string>
    type NitroConfig = NonNullable<Parameters<typeof import("nitro/builder")["createNitro"]>[0]>

    const generated = { binding: "DB", database_id: "content-id", database_name: "content-db", migrations_dir: ".vitehub/database/migrations/DB" }

    it.each([
      ["a full entry", { binding: "DB", database_id: "content-id", database_name: "content-db" }],
      ["an entry without database_id", { binding: "DB", database_name: "content-db" }],
      ["an entry without database_name", { binding: "DB", database_id: "content-id" }],
    ])("keeps one binding for %s", async (_label, entry) => {
      const { compile, rootDir } = await writeWrangler({ d1_databases: [entry, { binding: "OTHER", database_id: "other-id" }] })
      try {
        expect((await compile()).d1_databases).toEqual([generated, { binding: "OTHER", database_id: "other-id" }])
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    })

    it("fills fields ViteHub leaves out, but keeps its own migrations", async () => {
      const { compile, rootDir } = await writeWrangler({ d1_databases: [{
        binding: "DB",
        database_id: "content-id",
        migrations_dir: "old-migrations",
        migrations_pattern: "old-migrations/**/*.sql",
        migrations_table: "d1_migrations",
        preview_database_id: "preview-id",
      }] })
      try {
        expect((await compile()).d1_databases).toEqual([{ ...generated, migrations_table: "d1_migrations", preview_database_id: "preview-id" }])
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    })

    it("keeps one binding in each Wrangler environment", async () => {
      const production = { binding: "DB", database_id: "production-id", database_name: "production-db" }
      const { compile, rootDir } = await writeWrangler(
        { env: { production: { d1_databases: [{ ...production, preview_database_id: "production-preview" }] } } },
        { env: { production: { d1_databases: [production] } } },
      )
      try {
        const wrangler = await compile()
        expect(wrangler.d1_databases).toEqual([generated])
        expect(wrangler.env?.production?.d1_databases).toEqual([{ ...production, preview_database_id: "production-preview" }])
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    })

    it("takes the project's real id over an all-zero ViteHub id, and ViteHub's real id over an all-zero project id", async () => {
      const placeholder = "00000000-0000-4000-8000-000000000000"
      for (const [databaseId, projectId] of [[placeholder, "content-id"], ["content-id", placeholder]]) {
        const { compile, rootDir } = await writeWrangler({ d1_databases: [{ binding: "DB", database_id: projectId, database_name: "content-db" }] }, {}, { databaseId })
        try {
          expect((await compile()).d1_databases).toEqual([generated])
        }
        finally {
          await rm(rootDir, { force: true, recursive: true })
        }
      }
    })

    it("leaves out an id that stays all-zero, so Wrangler provisions the database", async () => {
      const placeholder = "00000000-0000-4000-8000-000000000000"
      const { compile, rootDir } = await writeWrangler({ d1_databases: [{ binding: "DB", database_id: placeholder, database_name: "content-db" }] }, {}, { databaseId: placeholder })
      try {
        expect((await compile()).d1_databases).toEqual([{ binding: "DB", database_name: "content-db", migrations_dir: generated.migrations_dir }])
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    })

    it.each(["00000000000000000000000000000000", "00000000-0000-4000-8000-000000000000"])("preserves an unresolved D1 preview id %s instead of falling back to production", async (placeholder) => {
      for (const [generatedPreview, projectPreview] of [[undefined, placeholder], [placeholder, undefined], [placeholder, placeholder], [placeholder, "preview-id"], ["preview-id", placeholder]]) {
        const projectEntry = { binding: "DB", database_id: "content-id", preview_database_id: projectPreview }
        const envEntry = { binding: "DB", database_id: "content-id", preview_database_id: generatedPreview }
        const { compile, rootDir } = await writeWrangler(
          { d1_databases: [projectEntry], env: { production: { d1_databases: [projectEntry] } } },
          { env: { production: { d1_databases: [envEntry] } } },
          { previewDatabaseId: generatedPreview },
        )
        const preview_database_id = [generatedPreview, projectPreview].includes("preview-id") ? "preview-id" : placeholder
        try {
          const wrangler = await compile()
          expect(wrangler.d1_databases).toEqual([{ ...generated, preview_database_id }])
          expect(wrangler.env?.production?.d1_databases).toEqual([{ ...envEntry, preview_database_id }])
        }
        finally {
          await rm(rootDir, { force: true, recursive: true })
        }
      }
    })

    it.each([
      ["database_id", { binding: "DB", database_id: "other-id" }],
      ["database_name", { binding: "DB", database_name: "other-db" }],
      ["preview_database_id", { binding: "DB", database_id: "content-id", preview_database_id: "preview-b" }],
    ])("fails when the project binding names another %s", async (field, entry) => {
      const database = field === "preview_database_id" ? { previewDatabaseId: "preview-a" } : {}
      const { compile, rootDir } = await writeWrangler({ d1_databases: [entry] }, {}, database)
      try {
        await expect(compile()).rejects.toMatchObject({ code: "DATABASE_WRANGLER_BINDING_CONFLICT", message: expect.stringContaining(field) })
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    })
  })

  it.each([
    ["src/database.ts", "default"],
    ["server/databases/default.ts", "default"],
    ["server/databases/orders/index.ts", "orders"],
  ])("projects the D1 Definition at %s before Vite builds and stages its SQL", async (path, name) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-d1-definition-"))
    const definition = join(rootDir, path)
    // `server/databases/<name>.ts` keeps its migrations in `server/databases/<name>/migrations/`.
    const migrationsDir = path.startsWith("server/") ? join(rootDir, "server/databases", name, "migrations") : join(dirname(definition), "migrations")
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(migrationsDir, { recursive: true })
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, `export default defineDatabase({
        name: ${JSON.stringify(name)},
        cloudflare: { binding: 'APP_DB', databaseId: 'app-id', databaseName: 'app-db', migrationsTable: 'app_migrations', previewDatabaseId: 'preview-id' },
        schema: {},
      })\n`)
      await writeFile(join(migrationsDir, "0001_users.sql"), "CREATE TABLE users (id INTEGER PRIMARY KEY);\n")
      await writeFile(join(migrationsDir, "journal.json"), "{}\n")
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })
      await hubDb({ driver: "d1" })(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig).toHaveProperty("cloudflare.wrangler.d1_databases", [{
        binding: "APP_DB",
        database_id: "app-id",
        database_name: "app-db",
        migrations_dir: ".vitehub/database/migrations/APP_DB",
        migrations_table: "app_migrations",
        preview_database_id: "preview-id",
      }])
      const modules = nitroConfig.modules as Array<(nitro: unknown) => void>
      const callbacks: Array<() => Promise<void>> = []
      for (const module of modules) module({
        hooks: { hook: (name: string, callback: () => Promise<void>) => { if (name === "compiled") callbacks.push(callback) } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      for (const compiled of callbacks) await compiled()
      const output = join(rootDir, ".output/server/.vitehub/database/migrations/APP_DB")
      await expect(readFile(join(output, "0001_users.sql"), "utf8"))
        .resolves.toBe("CREATE TABLE users (id INTEGER PRIMARY KEY);\n")
      await expect(readFile(join(output, "journal.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each([false, true])("keeps named D1 resources, migrations and provision state separate with Content=%s", async (content) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-named-d1-"))
    const projectRoot = join(rootDir, "service")
    const names = ["orders", "analytics"]
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "app/.vitehub"), { recursive: true })
      await writeFile(join(rootDir, "app/.vitehub/provision.json"), JSON.stringify({
        cloudflare: {
          d1: { default: "unrelated-default-id", orders: "orders-id", analytics: "analytics-id" },
          d1Nuxt: { "content-db": "content-id" },
        },
      }))
      for (const name of names) {
        const directory = join(projectRoot, `server/databases/${name}`)
        await mkdir(join(directory, "migrations"), { recursive: true })
        await writeFile(join(directory, "index.ts"), `export default defineDatabase({ name: '${name}', cloudflare: { databaseName: '${name}-db' }, schema: {} })\n`)
        await writeFile(join(directory, "migrations/0001_initial.sql"), `SELECT '${name}';\n`)
      }
      const { hooks, nuxt } = createNuxt({
        dev: false,
        modules: content ? ["@nuxt/content"] : [],
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: { root: "app" },
      })
      const module = hubDb({ driver: "d1", projectRoot: "service", ...(content ? { binding: "CONTENT_DB", databaseName: "content-db" } : {}) })
      expect(module.getModuleDependencies(nuxt)).toEqual(content
        ? { "@nuxt/content": { overrides: { database: { type: "d1", bindingName: "CONTENT_DB" } } } }
        : {})
      await module(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig).toHaveProperty("cloudflare.wrangler.d1_databases", [
        ...(content ? [{ binding: "CONTENT_DB", database_id: "content-id", database_name: "content-db" }] : []),
        ...[...names].sort().map(name => ({
          binding: `DB_${name.toUpperCase()}`,
          database_id: `${name}-id`,
          database_name: `${name}-db`,
          migrations_dir: `.vitehub/database/migrations/DB_${name.toUpperCase()}`,
        })),
      ])
      const callbacks: Array<() => Promise<void>> = []
      for (const module of nitroConfig.modules as Array<(nitro: unknown) => void>) module({
        hooks: { hook: (name: string, callback: () => Promise<void>) => { if (name === "compiled") callbacks.push(callback) } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      await Promise.all(callbacks.map(compiled => compiled()))
      for (const name of names) {
        await expect(readFile(join(rootDir, `.output/server/.vitehub/database/migrations/DB_${name.toUpperCase()}/0001_initial.sql`), "utf8"))
          .resolves.toBe(`SELECT '${name}';\n`)
      }
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([undefined, "custom-migrations"])("stages late inherited migrations in the accepted Wrangler directory: %s", async (migrationsDir) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-late-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1", databaseName: "existing" })(undefined, nuxt)
      const directory = join(rootDir, "server/databases/default")
      await mkdir(join(directory, "migrations"), { recursive: true })
      const definition = join(rootDir, "contributed.ts")
      await writeFile(definition, "export default defineDatabase({ schema: {} })")
      ;(nuxt.options.vite as { plugins: unknown[] }).plugins.push({ name: "late-module", vitehub: { databases: [{ name: "default", definition }] } })
      await writeFile(join(directory, "migrations/0001.sql"), "SELECT 1;")
      // Drizzle Kit 1.0 writes a folder per migration. Wrangler reads flat files, so the build writes `0000_init.sql`, the name that Drizzle Kit 0.x gave it.
      await mkdir(join(directory, "migrations/20261109120000_init"), { recursive: true })
      await writeFile(join(directory, "migrations/20261109120000_init/migration.sql"), "CREATE TABLE notes (id integer);")
      await writeFile(join(directory, "migrations/20261109120000_init/snapshot.json"), "{}")
      const binding = { binding: "DB", database_id: "existing-id", database_name: "existing", migrations_dir: migrationsDir }
      const config: Record<string, unknown> = { preset: "cloudflare_module", cloudflare: { wrangler: { d1_databases: [binding, { binding: "HOST_A", database_id: "a", database_name: "a" }, { binding: "HOST_B", database_id: "b", database_name: "b" }] } } }
      await callHook(hooks, "nitro:config", config)
      const callbacks: Array<() => Promise<void>> = []
      for (const module of config.modules as Array<(nitro: unknown) => void>) module({
        hooks: { hook: (name: string, callback: () => Promise<void>) => { if (name === "compiled") callbacks.push(callback) } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      await Promise.all(callbacks.map(callback => callback()))
      const finalBinding = (config.cloudflare as { wrangler: { d1_databases: Array<{ migrations_dir: string }> } }).wrangler.d1_databases[0]!
      expect(finalBinding.migrations_dir).toBe(migrationsDir ?? ".vitehub/database/migrations/DB")
      await expect(readFile(join(rootDir, ".output/server", finalBinding.migrations_dir, "0001.sql"), "utf8")).resolves.toBe("SELECT 1;")
      expect((await readdir(join(rootDir, ".output/server", finalBinding.migrations_dir))).toSorted()).toEqual(["0000_init.sql", "0001.sql"])
      await expect(readFile(join(rootDir, ".output/server", finalBinding.migrations_dir, "0000_init.sql"), "utf8")).resolves.toBe("CREATE TABLE notes (id integer);")
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each(["absolute", "../../server/databases/default/migrations", ".", "nested/../../outside"])("rejects unsafe inherited migration target %s before copying", async (target) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-unsafe-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      const source = join(rootDir, "server/databases/default/migrations")
      await mkdir(source, { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), "export default defineDatabase({ schema: {} })")
      await writeFile(join(source, "0001.sql"), "SELECT 1;")
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1", databaseName: "existing" })(undefined, nuxt)
      const config = { preset: "cloudflare_module", cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "existing-id", database_name: "existing", migrations_dir: target === "absolute" ? source : target }] } } }
      await expect(callHook(hooks, "nitro:config", config)).rejects.toThrow("must be a relative directory inside Nitro's server output")
      expect(config).not.toHaveProperty("modules")
      await expect(readFile(join(source, "0001.sql"), "utf8")).resolves.toBe("SELECT 1;")
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("requires explicit Content storage for a PostgreSQL-only Cloudflare app", async () => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-content-postgres-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), "export default defineDatabase({ dialect: 'postgresql', schema: {} })")
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, modules: ["@nuxt/content"], vite: {} })
      await hubDb()(undefined, nuxt)
      // Content's Cloudflare preset turns its default SQLite store into the DB binding.
      nuxt.options.content = { database: { type: "d1", bindingName: "DB" } }
      await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow("Nuxt Content on Cloudflare requires")
      const config = { preset: "cloudflare_module", cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "content-id", database_name: "content" }] } } }
      await expect(callHook(hooks, "nitro:config", config)).resolves.toBeUndefined()
      expect(config.cloudflare.wrangler.d1_databases).toHaveLength(1)
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])("keeps inherited and owned D1 migration directories disjoint with parallel=%s", async (parallel) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-inherited-d1-"))
    const names = ["default", "analytics"]
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      for (const name of names) {
        const directory = join(rootDir, `server/databases/${name}`)
        await mkdir(join(directory, "migrations"), { recursive: true })
        const cloudflare = name === "default" ? "" : "cloudflare: { binding: 'DB_ANALYTICS', databaseId: 'analytics-id', databaseName: 'analytics-db' },"
        await writeFile(join(directory, "index.ts"), `import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ name: '${name}', ${cloudflare} schema: {} })\n`)
        await writeFile(join(directory, `migrations/0001_${name}.sql`), `SELECT '${name}';\n`)
      }
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })
      await hubDb({ driver: "d1", binding: "CONTENT_DB", databaseId: "content-id", databaseName: "content-db" })(undefined, nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      const callbacks: Array<() => Promise<void>> = []
      for (const module of nitroConfig.modules as Array<(nitro: unknown) => void>) module({
        hooks: { hook: (name: string, callback: () => Promise<void>) => { if (name === "compiled") callbacks.push(callback) } },
        options: { output: { serverDir: join(rootDir, ".output/server") } },
      })
      if (parallel) await Promise.all(callbacks.map(compiled => compiled()))
      else for (const compiled of callbacks) await compiled()
      const bindings = (nitroConfig.cloudflare as { wrangler: { d1_databases: Array<{ binding: string, migrations_dir: string }> } }).wrangler.d1_databases
      for (const name of names) {
        const bindingName = name === "default" ? "CONTENT_DB" : "DB_ANALYTICS"
        const binding = bindings.find(item => item.binding === bindingName)!
        const output = join(rootDir, ".output/server", binding.migrations_dir)
        await expect(readdir(output)).resolves.toEqual([`0001_${name}.sql`])
        await expect(readFile(join(output, `0001_${name}.sql`), "utf8")).resolves.toBe(`SELECT '${name}';\n`)
      }
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([".vitehub/database/migrations/DB_ANALYTICS", ".vitehub/database/migrations/./DB_ANALYTICS", ".vitehub/database/migrations"])("rejects overlapping inherited migration target %s before copying", async (target) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-inherited-d1-"))
    const names = ["default", "analytics"]
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      for (const name of names) {
        const directory = join(rootDir, `server/databases/${name}`)
        await mkdir(join(directory, "migrations"), { recursive: true })
        const cloudflare = name === "default" ? "" : "cloudflare: { binding: 'DB_ANALYTICS', databaseId: 'analytics-id', databaseName: 'analytics-db' },"
        await writeFile(join(directory, "index.ts"), `import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ name: '${name}', ${cloudflare} schema: {} })\n`)
        await writeFile(join(directory, `migrations/0001_${name}.sql`), `SELECT '${name}';\n`)
      }
      const { hooks, nuxt } = createNuxt({
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })
      await hubDb({ driver: "d1", binding: "CONTENT_DB", databaseName: "content-db" })(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { d1_databases: [{ binding: "CONTENT_DB", database_id: "content-id", database_name: "content-db", migrations_dir: target }] } } }
      await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toThrow("D1 migration directories overlap")
      expect(nitroConfig).not.toHaveProperty("modules")
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([
    ["default", { databaseId: "configured-id" }, "DATABASE_MISSING_D1_RESOURCE", "cloudflare.databaseName"],
    ["orders", { databaseId: "configured-id" }, "DATABASE_MISSING_D1_RESOURCE", "cloudflare.databaseName"],
    ["default", { databaseName: "configured-db" }, "DATABASE_MISSING_D1_RESOURCE", "cloudflare.databaseId"],
    ["orders", { databaseName: "configured-db" }, "DATABASE_MISSING_D1_RESOURCE", "cloudflare.databaseId"],
  ] as const)("rejects incomplete D1 Definition %s with %j before Vite builds", async (name, cloudflare, code, missing) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-incomplete-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      const definition = join(rootDir, "server/databases", name, "index.ts")
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, `export default defineDatabase({ name: '${name}', cloudflare: ${JSON.stringify(cloudflare)}, schema: {} })\n`)
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, nuxt)

      await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toMatchObject({
        code,
        why: expect.stringContaining(missing),
      })
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each(["default", "orders"])("rejects D1 Definition %s without cloudflare options before Vite builds", async (name) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-unnamed-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      const definition = join(rootDir, "server/databases", name, "index.ts")
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, `export default defineDatabase({ name: '${name}', schema: {} })\n`)
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, nuxt)
      const config = { alias: {}, preset: "cloudflare_module" }

      await expect(callHook(hooks, "nitro:config", config)).rejects.toMatchObject({
        code: "DATABASE_MISSING_D1_RESOURCE",
        why: expect.stringContaining("`cloudflare.databaseName`"),
      })
      expect(config.alias).not.toHaveProperty("@vite-hub/database/drizzle")
      await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([
    ["no cloudflare options", {}],
    ["only a databaseId", { databaseId: "configured-id" }],
    ["only a databaseName", { databaseName: "configured-db" }],
  ])("writes types for a D1 Definition with %s in nuxt prepare and keeps the build check", async (_case, cloudflare) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-prepare-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), `export default defineDatabase({ cloudflare: ${JSON.stringify(cloudflare)}, schema: {} })\n`)
      const prepare = createNuxt({ _prepare: true, dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, prepare.nuxt)

      await expect(callHook(prepare.hooks, "nitro:config", { alias: {}, preset: "cloudflare_module" })).resolves.toBeUndefined()
      await expect(readFile(join(rootDir, ".vitehub/types/database.d.ts"), "utf8")).resolves.toContain("@vite-hub/database")
      // `tsconfig.server.json` points `@vite-hub/database/drizzle` to this module.
      await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).resolves.toContain("createHostedDrizzleDb")

      const build = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, build.nuxt)
      await expect(callHook(build.hooks, "nitro:config", { alias: {}, preset: "cloudflare_module" })).rejects.toMatchObject({ code: "DATABASE_MISSING_D1_RESOURCE" })
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([
    ["no use", undefined],
    ["a Database use", { name: "@vite-hub/connections/vite", vitehub: { databases: () => [{ database: "default", name: "connections", reason: "Stores Connection grants." }] } }],
  ])("checks the implicit default D1 Database only when a plugin needs it: %s", async (_case, plugin) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-implicit-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: { plugins: plugin ? [plugin] : [] } })
      // With D1 module options, the module D1 resource check covers the implicit default before this one.
      await hubDb()(undefined, nuxt)
      const config = { alias: {}, preset: "cloudflare_module" }
      const result = callHook(hooks, "nitro:config", config)
      if (!plugin) return await expect(result).resolves.toBeUndefined()
      await expect(result).rejects.toMatchObject({
        code: "DATABASE_MISSING_D1_RESOURCE",
        why: expect.stringContaining("`database.databaseName`"),
      })
      expect(config.alias).not.toHaveProperty("@vite-hub/database/drizzle")
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("keeps a D1 Definition without cloudflare options when the app sets the Database runtime alias", async () => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-custom-runtime-d1-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), "export default defineDatabase({ schema: {} })\n")
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, nuxt)
      const config = { alias: { "@vite-hub/database/drizzle": "/custom/database.mjs" }, preset: "cloudflare_module" }

      await callHook(hooks, "nitro:config", config)
      expect(config.alias["@vite-hub/database/drizzle"]).toBe("/custom/database.mjs")
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each([true, false])("handles a separate opaque D1 resource with HTTP available: %s", async (http) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-separate-migrations-"))
    const definition = join(rootDir, "server/databases/default.ts")
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
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb({
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
        ...(http ? { cloudflare: { http: true } } : {}),
      })(undefined, nuxt)
      const nitroConfig = {}
      if (!http) {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_OPAQUE_CLOUDFLARE_CONFIG" })
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
    const definition = join(rootDir, "server/databases/default.ts")
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
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_MISSING_D1_RESOURCE" })
        await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ [VITEHUB_FEATURES]: { database: getResolvedFeatureOptions(nuxt.options.vite as object, "database") }, root: rootDir })
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

  it.each([
    "cloudflare: { binding: 'DB' }, connection: { url: 'libsql://database.example.com' }",
    "cloudflare: { binding: 'DB' }, connection: { url: process.env.VITEHUB_NUXT_TEST_REMOTE_URL }",
    "cloudflare: { databaseId: 'configured-id', http: true }",
    "cloudflare: { databaseId: process.env.VITEHUB_NUXT_TEST_REMOTE_ID, http: true }",
    "cloudflare: { databaseId: 'configured-id', http: { url: 'https://database.example.com', authToken: 'test-token' } }",
  ])("does not require a D1 binding for an explicit remote Definition runtime: %s", async (options) => {
    const rootDir = await mkdtemp(join(process.cwd(), ".vitest-nuxt-remote-definition-"))
    try {
      await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), `export default defineDatabase({ ${options}, schema: {} })\n`)
      const { hooks, nuxt } = createNuxt({ dev: false, rootDir, vite: {} })
      await hubDb({ driver: "d1" })(undefined, nuxt)
      const config = { preset: "cloudflare_module" }
      if (options.includes("VITEHUB_NUXT_TEST_REMOTE_URL")) {
        await expect(callHook(hooks, "nitro:config", config)).rejects.toMatchObject({ code: "DATABASE_MISSING_D1_RESOURCE" })
      }
      else {
        await expect(callHook(hooks, "nitro:config", config)).resolves.toBeUndefined()
        expect(config).toHaveProperty("cloudflare.wrangler.d1_databases", [])
      }
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("creates Postgres clients in the Nitro development runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-local-postgres-"))
    const buildDir = join(rootDir, ".nuxt")
    try {
      await mkdir(join(rootDir, "server/databases"), { recursive: true })
      await writeFile(join(rootDir, "server/databases/default.ts"), "export default defineDatabase({ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} })\n")
      const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, vite: {} })
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      const code = await readFile(join(buildDir, "vitehub/database/local-runtime.mjs"), "utf8")
      // Development can run the Database on PGlite, so its module awaits PGlite when it has no server.
      expect(code).toMatch(/import \{ createDevPostgresDatabase \} from "file:.+\/runtime\/pglite\.js"/)
      expect(code).toContain("db: await createDevPostgresDatabase({ ...definition_0, relations: relations_0, schema: definition_0.schema }, {\"binding\":\"HYPERDRIVE\",\"url\":{\"kind\":\"env-variable\"")
      expect(code).toContain(`{"dataDir":${JSON.stringify(join(rootDir, ".vitehub/data/database/pglite"))},"migrationsDir":${JSON.stringify(join(rootDir, "server/databases/default/migrations"))}}`)
      expect(code).toContain("const relations_0 = mergeDatabaseRelations(\"default\", definition_0.schema, [definition_0.relations])")
      // The Nuxt alias of `@vite-hub/database/drizzle` has the same exports, so Workflow can import from it.
      expect(code).toContain("export function getPostgresConnectionUrl(name = \"default\")")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("keeps prototype-named Definitions addressable in Nitro development", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-local-proto-"))
    const buildDir = join(rootDir, ".nuxt")
    const definition = join(rootDir, "server/databases/__proto__/index.ts")
    try {
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, 'export default defineDatabase({ name: "__proto__", schema: {} })\n')
      const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, vite: {} })
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})
      const code = await readFile(join(buildDir, "vitehub/database/local-runtime.mjs"), "utf8")
      const evaluable = code.replace(/^(?:import .+|export .+ from .+)$/gm, "").replace(/^export /gm, "") + "\nreturn { databases, useDatabase }"
      const runtime = new Function("definition_0", "createDefinitionRuntime", "mergeDatabaseRelations", "createAgentDatabase", "createDatabaseBindingLookup", "defaultDatabaseNotConfiguredError", "createUseDatabase", evaluable)(
        { name: "__proto__", schema: { marker: "schema" } },
        () => ({ marker: "database" }),
        () => ({ marker: "relations" }),
        () => ({}),
        () => () => undefined,
        () => new Error("missing"),
        createUseDatabase,
      ) as { databases: Record<string, unknown>, useDatabase: (name: string) => unknown }

      expect(Object.hasOwn(runtime.databases, "__proto__")).toBe(true)
      expect(runtime.useDatabase("__proto__")).toEqual({ db: { marker: "database" }, relations: { marker: "relations" }, schema: { marker: "schema" } })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("adds contributed tables to the Nitro development runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-contributed-"))
    const buildDir = join(rootDir, ".nuxt")
    const definition = join(rootDir, "server/databases/default.ts")
    const contributor = { name: "history-owner/vite", vitehub: { databases: [{ definition: { export: "historySchema", module: "history-tables/schema" }, name: "history" }] } }
    const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, vite: { plugins: [contributor] } })
    try {
      await mkdir(dirname(definition), { recursive: true })
      await mkdir(join(rootDir, "node_modules/history-tables"), { recursive: true })
      await writeFile(join(rootDir, "node_modules/history-tables/package.json"), JSON.stringify({ exports: { "./schema": "./schema.mjs" }, name: "history-tables", type: "module" }))
      await writeFile(join(rootDir, "node_modules/history-tables/schema.mjs"), "export const historySchema = { historyRefs: {} }\n")
      await writeFile(definition, "export default defineDatabase({ schema: {} })\n")
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})
      const code = await readFile(join(buildDir, "vitehub/database/local-runtime.mjs"), "utf8")
      expect(code).toContain('import { historySchema as contributedSchema_0_0 } from "history-tables/schema"')
      const evaluable = code.replace(/^(?:import .+|export .+ from .+)$/gm, "").replace(/^export /gm, "") + "\nreturn { useDatabase }"
      const created: unknown[] = []
      const runtime = new Function("definition_0", "contributedSchema_0_0", "createDefinitionRuntime", "mergeDatabaseRelations", "createAgentDatabase", "createDatabaseBindingLookup", "defaultDatabaseNotConfiguredError", "createUseDatabase", evaluable)(
        { name: "default", relations: { marker: "own" }, schema: { notes: "notes" } },
        { historyRefs: "refs" },
        (input: unknown) => created.push(input),
        (database: string, schema: unknown, parts: unknown[]) => ({ database, parts, schema }),
        () => ({}),
        () => () => undefined,
        () => new Error("missing"),
        createUseDatabase,
      ) as { useDatabase: (name: string) => { schema: unknown } }

      const relations = { database: "default", parts: [{ marker: "own" }], schema: { historyRefs: "refs", notes: "notes" } }
      expect(runtime.useDatabase("default").schema).toEqual({ historyRefs: "refs", notes: "notes" })
      expect(created).toEqual([{ name: "default", relations, schema: { historyRefs: "refs", notes: "notes" } }])
    }
    finally {
      await callHook(hooks, "close", {})
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("gives contributed tables the implicit default Database in the Nitro development runtime when the app has no Definition", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-implicit-"))
    const buildDir = join(rootDir, ".nuxt")
    const contributor = { name: "history-owner/vite", vitehub: { databases: [{ definition: { export: "historySchema", module: "history-tables/schema" }, name: "history" }] } }
    const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, vite: { plugins: [contributor] } })
    try {
      await mkdir(join(rootDir, "node_modules/history-tables"), { recursive: true })
      await writeFile(join(rootDir, "node_modules/history-tables/package.json"), JSON.stringify({ exports: { "./schema": "./schema.mjs" }, name: "history-tables", type: "module" }))
      await writeFile(join(rootDir, "node_modules/history-tables/schema.mjs"), "export const historySchema = { historyRefs: {} }\n")
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})
      const code = await readFile(join(buildDir, "vitehub/database/local-runtime.mjs"), "utf8")
      expect(code).toMatch(/import definition_0 from ".*runtime\/default-database\.(?:js|ts)"/)
      expect(code).toContain('import { historySchema as contributedSchema_0_0 } from "history-tables/schema"')
    }
    finally {
      await callHook(hooks, "close", {})
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("reads tables that a later Nuxt module contributes through nuxt.options.vite.plugins", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-module-contributed-"))
    const buildDir = join(rootDir, ".nuxt")
    const definition = join(rootDir, "server/databases/default.ts")
    const { hooks, nuxt } = createNuxt({ buildDir, dev: true, rootDir, srcDir: join(rootDir, "app"), vite: {} })
    try {
      await mkdir(dirname(definition), { recursive: true })
      await mkdir(join(rootDir, "node_modules/history-tables"), { recursive: true })
      await writeFile(join(rootDir, "node_modules/history-tables/package.json"), JSON.stringify({ exports: { "./schema": "./schema.mjs" }, name: "history-tables", type: "module" }))
      await writeFile(join(rootDir, "node_modules/history-tables/schema.mjs"), "export const historySchema = { historyRefs: {} }\n")
      await writeFile(definition, "export default defineDatabase({ schema: {} })\n")
      await hubDb()(undefined, nuxt)
      // A Nuxt module that runs after the Database module adds its Vite plugin during setup.
      const contexts: unknown[] = []
      const vite = nuxt.options.vite as { plugins: unknown[] }
      vite.plugins.push({
        name: "history-owner/nuxt",
        vitehub: {
          databases: (context: unknown) => {
            contexts.push(context)
            return [{ definition: { export: "historySchema", module: "history-tables/schema" }, name: "history" }]
          },
        },
      })
      await callHook(hooks, "nitro:config", {})

      const code = await readFile(join(buildDir, "vitehub/database/local-runtime.mjs"), "utf8")
      expect(code).toContain('import { historySchema as contributedSchema_0_0 } from "history-tables/schema"')
      expect(contexts).toEqual([expect.objectContaining({ projectRoot: rootDir, root: join(rootDir, "app") })])
    }
    finally {
      await callHook(hooks, "close", {})
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("adds contributed tables to the hosted Nitro schema", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".nuxt-contributed-"))
    const definition = join(rootDir, "server/databases/default.ts")
    const tables = join(rootDir, "vendor/history.ts")
    const contributor = { name: "history-owner/vite", vitehub: { databases: [{ definition: { export: "historySchema", module: tables }, name: "history" }] } }
    try {
      await mkdir(dirname(definition), { recursive: true })
      await mkdir(dirname(tables), { recursive: true })
      await writeFile(join(rootDir, "package.json"), "{}\n")
      await writeFile(tables, "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'\nexport const historySchema = { historyRefs: sqliteTable('history_refs', { id: text('id') }) }\n")
      await writeFile(definition, "import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ connection: { url: 'libsql://db.example.com' }, schema: {} })\n")
      const { hooks, nuxt } = createNuxt({ dev: false, nitro: { preset: "vercel" }, rootDir, vite: { plugins: [contributor] } })
      await hubDb()(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      const schema = await readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")
      expect(schema).toContain('import { historySchema as contributedSchema_0 } from "../../../vendor/history.ts"')
      expect(schema).toContain("export { table_0 as historyRefs }")
      await expect(readFile(join(rootDir, ".vitehub/database/vercel-runtime.mjs"), "utf8")).resolves.toContain("schema/default.ts")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each([true, false])("maintains the discovered database runtime for local Nitro with dev=%s", async (dev) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-local-"))
    const buildDir = join(rootDir, ".nuxt")
    const serverDir = join(rootDir, "app/server")
    const runtimeFile = dev ? join(buildDir, "vitehub/database/local-runtime.mjs") : join(rootDir, ".vitehub/database/local-runtime.mjs")
    const writeDefinition = async (name: string) => {
      const file = join(serverDir, `databases/${name}/index.ts`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, [
        'import { defineDatabase } from "@vite-hub/database"',
        `export default defineDatabase({ name: ${JSON.stringify(name)}, schema: {} })`,
        "",
      ].join("\n"))
    }

    try {
      await writeDefinition("analytics")
      const { hooks, nuxt } = createNuxt({ buildDir, dev, nitro: { preset: "node-server" }, rootDir, serverDir, vite: {} })
      await hubDb({ connection: { authToken: "dev-token", url: "libsql://dev.example.com" } })(undefined, nuxt)

      const nitroConfig: Record<string, unknown> = {}
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toEqual({
        "@vite-hub/database/drizzle": runtimeFile,
        ...(dev ? { "#vitehub/database/definition-defaults": join(dirname(runtimeFile), "definition-defaults.mjs") } : {}),
      })
      if (dev) {
        await expect(readFile(join(dirname(runtimeFile), "definition-defaults.mjs"), "utf8")).resolves.toContain('"dev":true')
      }
      await expect(readFile(runtimeFile, "utf8")).resolves.toMatch(
        /databases\/analytics\/index\.ts[\s\S]+"connection":\{"authToken":"dev-token","url":"libsql:\/\/dev\.example\.com"\}[\s\S]+\["analytics"\]:[\s\S]+export const databases[\s\S]+export const db[\s\S]+export const schema/,
      )

      await rm(join(serverDir, "databases/analytics"), { force: true, recursive: true })
      await writeDefinition("reports")
      await callHook(hooks, "nitro:config", nitroConfig)
      const updatedRuntime = await readFile(runtimeFile, "utf8")
      expect(updatedRuntime).toContain("databases/reports/index.ts")
      expect(updatedRuntime).not.toContain("databases/analytics/index.ts")

      const customAlias = { alias: { "@vite-hub/database/drizzle": "#custom-database" } }
      await callHook(hooks, "nitro:config", customAlias)
      expect(customAlias.alias).toEqual({
        "@vite-hub/database/drizzle": "#custom-database",
        ...(dev ? { "#vitehub/database/definition-defaults": join(dirname(runtimeFile), "definition-defaults.mjs") } : {}),
      })
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
    const definition = join(projectRoot, location === "nested-src" ? "src/database.ts" : "server/databases/default.ts")
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
      expect(nitroConfig.alias).toEqual({
        "@vite-hub/database/drizzle": runtimeFile,
        "#vitehub/database/definition-defaults": join(dirname(runtimeFile), "definition-defaults.mjs"),
      })
      const inherited = { name: "default", schema: {} }
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
      expect(nitroConfig.alias).toEqual({
        "@vite-hub/database/drizzle": runtimeFile,
        "#vitehub/database/definition-defaults": join(dirname(runtimeFile), "definition-defaults.mjs"),
      })
      expect(runtimeConfig(inherited, await readDefaults()).cloudflare?.binding).toBe("HOST_DB")

      const customConfig = { alias: { "@vite-hub/database/drizzle": "#custom-database" } }
      await callHook(hooks, "nitro:config", customConfig)
      for (const callback of watchHooks) await callback("change", definition)
      expect(customConfig.alias).toEqual({
        "@vite-hub/database/drizzle": "#custom-database",
        "#vitehub/database/definition-defaults": join(dirname(runtimeFile), "definition-defaults.mjs"),
      })
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
      dev: false,
      nitro: {
        cloudflare: {
          wrangler: {
            d1_databases: [binding, binding],
          },
        },
      },
      rootDir: `${tmp}/vitehub-db-nuxt-deduplicated`,
      vite: {},
    })

    await hubDb({
      driver: "d1",
      databaseId: "content-id",
      databaseName: "content-db",
    })(undefined, nuxt)

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
      dev: false,
      modules: ["@nuxt/content"],
      rootDir: `${tmp}/vitehub-db-nuxt-unresolved`,
      vite: {},
    })

    await hubDb({
      driver: "d1",
      databaseName: "content-db",
    })(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "d1",
        bindingName: "DB",
      },
    })
    expect(nuxt.options.nitro).toBeUndefined()
    await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
      "Cloudflare D1 output needs `database.databaseId` or provision state for \"default\"",
    )
  })

  it("reports a missing D1 database name separately from a missing id", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      rootDir: `${tmp}/vitehub-db-nuxt-missing-name`,
      vite: {},
    })

    await hubDb({
      databaseId: "content-id",
      driver: "d1",
    })(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
      "Cloudflare D1 output needs `database.databaseName`",
    )
    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("rejects a whitespace-only D1 name even when Nitro provides a matching blank name", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      rootDir: join(tmp, "vitehub-db-nuxt-blank-name"),
      vite: {},
    })
    await hubDb({ databaseId: "content-id", databaseName: "   ", driver: "d1" })(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", {
      cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "content-id", database_name: "   " }] } },
      preset: "cloudflare_module",
    })).rejects.toMatchObject({ code: "DATABASE_MISSING_D1_RESOURCE", why: expect.stringContaining("`database.databaseName`") })
  })

  it("accepts a complete matching D1 binding from Nitro Wrangler config", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      rootDir: `${tmp}/vitehub-db-nuxt-existing-binding`,
      vite: {},
    })

    await hubDb({
      driver: "d1",
      databaseName: "content-db",
    })(undefined, nuxt)
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
      dev: false,
      rootDir: `${tmp}/vitehub-db-nuxt-wrong-existing-binding`,
      vite: {},
    })
    await hubDb({ driver: "d1", databaseName: "content-db" })(undefined, nuxt)

    await expect(callHook(hooks, "nitro:config", {
      cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_id: "other-id", database_name: "other-db" }] } },
      preset: "cloudflare_module",
    })).rejects.toThrow("needs `database.databaseId` or provision state")
  })

  it("uses provisioned D1 ids in Nuxt Cloudflare output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-provisioned-"))
    const definition = join(rootDir, "server/databases/default.ts")
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
        dev: false,
        nitro: { preset: "cloudflare_module" },
        rootDir,
        vite: {},
      })

      await hubDb({
        driver: "d1",
        databaseName: {
          default: "content-db",
          kind: "env-variable",
          source: { kind: "env", name: "VITEHUB_TEST_D1_NAME" },
        },
      })(undefined, nuxt)
      const nitroConfig = {}
      await callHook(hooks, "nitro:config", nitroConfig)

      expect(nitroConfig).toHaveProperty("cloudflare.wrangler.d1_databases.0", {
        binding: "DB",
        database_id: "provisioned-id",
        database_name: "content-db",
        migrations_dir: ".vitehub/database/migrations/DB",
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["absent", "unset environment"] as const)("uses provisioned D1 ids with an %s id in the hosted Vercel runtime", async (idSource) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-vercel-provisioned-"))
    const definition = join(rootDir, "server/databases/default.ts")
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
        dev: false,
        nitro: { preset: "vercel" },
        rootDir,
        vite: {},
      })

      await hubDb({
        driver: "d1",
        ...(idSource === "unset environment" ? {
          databaseId: {
            kind: "env-variable",
            source: { kind: "env", name: "VITEHUB_TEST_PROVISIONED_D1_ID" },
          },
        } : {}),
        databaseName: "content-db",
      })(undefined, nuxt)
      await callHook(hooks, "nitro:config", {})

      const module = await readFile(join(rootDir, ".vitehub/database/vercel-runtime.mjs"), "utf8")
      const expression = /db: createHostedDrizzleDb\((\{[\s\S]*?\}), relations_0\)/.exec(module)?.[1]
      expect(expression).toBeDefined()
      const config = Function("definition_0", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ schema: {} }, resolveRuntimeCloudflareConfig)
      expect(resolveConfigValue(config.cloudflare.databaseId)).toBe("provisioned-id")
      expect(config.cloudflare.databaseName).toBe("content-db")
      const viteOptions = getResolvedFeatureOptions<{ databaseId: Parameters<typeof resolveConfigValue>[0] }>(nuxt.options.vite as object, "database")!
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
    const definition = join(rootDir, "server/databases/default.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: {} })\n")

    try {
      const { hooks, nuxt } = createNuxt({
        dev: true,
        rootDir,
        vite: {},
      })
      await hubDb({
        binding: "CONTENT_DB",
        cloudflare: { http: { authToken: "proxy-token", url: "https://d1.example.com/raw" } },
        databaseId: "content-id",
        databaseName: "content-db",
        driver: "d1",
        migrationsTable: "__content_migrations",
        previewDatabaseId: "preview-id",
      })(undefined, nuxt)
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
        dev: false,
        rootDir,
        vite: {},
      })
      await hubDb({ driver: "d1", databaseName: "content-db" })(undefined, nuxt)

      await expect(callHook(hooks, "nitro:config", { preset: "cloudflare_module" })).rejects.toThrow(
        "needs `database.databaseId` or provision state",
      )
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("keeps an existing database Vite plugin", async () => {
    const existingPlugin = { name: "@vite-hub/database/vite" }
    const { nuxt } = createNuxt({
      rootDir: `${tmp}/vitehub-db-nuxt-existing-plugin`,
      vite: {
        plugins: [existingPlugin],
      },
    })

    await hubDb({
      driver: "d1",
      databaseId: "content-id",
      databaseName: "content-db",
    })(undefined, nuxt)

    expect(nuxt.options.vite).toMatchObject({
      plugins: [existingPlugin],
    })
  })

  it("selects the hosted definition runtime in production without a D1 bridge", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "vercel" },
      rootDir: `${tmp}/vitehub-db-nuxt-hosted`,
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
    const rootDir = `${tmp}/vitehub-db-nuxt-${provider}-runtime`
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
      "#vitehub/database/definition-runtime": expect.stringMatching(/\/runtime\/d1\.(?:js|ts)$/),
      "@vite-hub/database/drizzle": join(rootDir, `.vitehub/database/${provider}-runtime.mjs`),
    })
  })

  it.each([
    [true, "node-server", "local"],
    [false, "node-server", "local"],
    [false, "cloudflare-module", "cloudflare"],
    [false, "vercel", "vercel"],
  ] as const)("exports chunkParameters through the generated %s/%s runtime alias", async (dev, preset, provider) => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".nuxt-chunk-parameters-"))
    const definition = join(rootDir, "server/databases/default.ts")
    const consumer = join(rootDir, "consumer.ts")
    const output = join(rootDir, "consumer.mjs")
    const { hooks, nuxt } = createNuxt({ buildDir: join(rootDir, ".nuxt"), dev, nitro: { preset }, rootDir, vite: {} })
    try {
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(join(rootDir, "package.json"), '{"type":"module"}\n')
      await writeFile(definition, [
        'import { defineDatabase } from "@vite-hub/database"',
        'import { sqliteTable, text } from "drizzle-orm/sqlite-core"',
        'export default defineDatabase({ connection: { url: "libsql://db.example.com" }, schema: { notes: sqliteTable("notes", { id: text("id"), title: text("title") }) } })',
      ].join("\n"))
      await writeFile(consumer, [
        'import { chunkParameters, schema } from "@vite-hub/database/drizzle"',
        'export const chunks = chunkParameters(Array.from({ length: 205 }, (_, id) => id), { per: schema.notes, reserved: 2 })',
      ].join("\n"))
      await publishedHubDb()(undefined, nuxt)
      const nitroConfig = { alias: {} as Record<string, string>, preset }
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias["@vite-hub/database/drizzle"]).toContain(`${provider}-runtime.mjs`)
      await build({
        alias: nitroConfig.alias,
        bundle: true,
        entryPoints: [consumer],
        format: "esm",
        outfile: output,
        packages: "external",
        platform: "node",
      })
      // SAFETY: The fixture exports the numeric chunks from the public aliased import above.
      const { chunks } = await import(pathToFileURL(output).href) as { chunks: number[][] }
      expect(chunks.map(chunk => chunk.length)).toEqual([49, 49, 49, 49, 9])
      expect(chunks.flat()).toEqual(Array.from({ length: 205 }, (_, id) => id))
    }
    finally {
      await callHook(hooks, "close", {})
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("selects the hosted definition runtime for Deno deployments", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "deno-deploy" },
      rootDir: `${tmp}/vitehub-db-nuxt-deno`,
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = { exportConditions: ["deno"] }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.exportConditions).toEqual(["vitehub-hosted", "deno"])
  })

  it.each([undefined, "DB", "APP_DB"])("keeps Nuxt host and owned Definition resources separate with binding %s", async (binding) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-owned-binding-"))
    const definition = join(rootDir, "server/databases/default.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, `export default defineDatabase({ cloudflare: { ${binding ? `binding: ${JSON.stringify(binding)},` : ""} databaseId: 'application-id', databaseName: 'application-db' }, schema: {} })\n`)
    try {
      const { hooks, nuxt } = createNuxt({ dev: false, modules: ["@nuxt/content"], rootDir, vite: {} })
      await hubDb({ databaseId: "content-id", databaseName: "content-db", driver: "d1" })(undefined, nuxt)
      const nitroConfig = { cloudflare: { wrangler: { d1_databases: [] as unknown[] } }, output: { serverDir: join(rootDir, ".output/server") }, preset: "cloudflare_module" }
      if (binding !== "APP_DB") {
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_BINDING_CONFLICT" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ [VITEHUB_FEATURES]: { database: getResolvedFeatureOptions(nuxt.options.vite as object, "database") }, root: rootDir })
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
    const definition = join(rootDir, "server/databases/default.ts")
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
      expect(nitroConfig.cloudflare.wrangler.d1_databases).toEqual([{ binding: "DB", database_id: "content-id", database_name: "content-db", migrations_dir: ".vitehub/database/migrations/DB" }])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it.each(["env-id", "env-name", "provisioned-id", "separate-env"] as const)("shares the Nuxt host binding only for static identity with %s", async (identity) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-nuxt-static-identity-"))
    const definition = join(rootDir, "server/databases/default.ts")
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
        await expect(callHook(hooks, "nitro:config", nitroConfig)).rejects.toMatchObject({ code: "DATABASE_BINDING_CONFLICT" })
        await expect(readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        return
      }
      await callHook(hooks, "nitro:config", nitroConfig)
      const plugin = (nuxt.options.vite as { plugins: Array<Plugin & { nitro: { setup: (nitro: unknown) => void } }> }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ [VITEHUB_FEATURES]: { database: getResolvedFeatureOptions(nuxt.options.vite as object, "database") }, root: rootDir })
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
    const definition = join(rootDir, "server/databases/default.ts")
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
      for (const callback of watchHooks) await expect(callback("change", definition)).rejects.toMatchObject({ code: "DATABASE_BINDING_CONFLICT" })
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
      rootDir,
      vite: {},
    })

    try {
      await hubDb({
        binding: "CONTENT_DB",
        cloudflare: { http: true },
        databaseId: "content-id",
        databaseName: "content-db",
        driver: "d1",
        migrationsTable: "__content_migrations",
        previewDatabaseId: "preview-id",
      })(undefined, nuxt)

      const plugin = (nuxt.options.vite as { plugins: Plugin[] }).plugins[0]!
      await (plugin.configResolved as (config: unknown) => Promise<void>)({
        database: undefined,
        root: rootDir,
      })
      const id = await (plugin.resolveId as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler(
        "#vitehub/database/definition-defaults",
      )
      const code = await (plugin.load as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler(id!)

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
    const definition = join(projectRoot, "server", "databases", "default.ts")
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
        [VITEHUB_FEATURES]: { database: getResolvedFeatureOptions(nuxt.options.vite as object, "database") },
        root: join(rootDir, "app"),
      })

      expect(plugin.api.getConfig()?.rootDir).toBe(projectRoot)
      await expect(readFile(join(projectRoot, ".vitehub/types/database.d.ts"), "utf8"))
        .resolves.toContain('declare module "vite-hub/database/drizzle"')

      const nitroConfig = { alias: {}, modules: [], preset: "cloudflare_module" }
      await callHook(hooks, "nitro:config", nitroConfig)
      expect(nitroConfig.alias).toEqual({
        "#vitehub/database/definition-defaults": join(projectRoot, ".vitehub/database/definition-defaults.mjs"),
        "#vitehub/database/definition-runtime": expect.stringMatching(/\/runtime\/d1\.(?:js|ts)$/),
        "@vite-hub/database/drizzle": join(projectRoot, ".vitehub/database/cloudflare-runtime.mjs"),
      })
      expect(nitroConfig.modules).toHaveLength(3)
      // The last module tells `@vite-hub/bundle` that this D1 Worker never runs libSQL at startup.
      const rules: Array<{ owner: string, packages: string[] }> = []
      const bundleModule = (nitroConfig.modules as Array<(nitro: unknown) => void>).at(-1)!
      bundleModule({
        hooks: { hook: (name: string, callback: (value: typeof rules) => void) => { if (name === "vitehub:bundle:rules") callback(rules) } },
        options: { preset: "cloudflare_module" },
      })
      expect(rules).toMatchObject([{ owner: "@vite-hub/database", packages: expect.arrayContaining(["@libsql/client"]) }])
      if (resource === "inherited") return
      const defaultsFile = join(projectRoot, ".vitehub/database/definition-defaults.mjs")
      const { default: defaults } = await import(pathToFileURL(defaultsFile).href)
      expect(defaults.cloudflareProjections.default).toEqual({ binding: "APP_DB", provisionedId: "application-id", resource: "configured" })
      expect(plugin.api.getConfig()?.databases.default?.cloudflare?.databaseId).toBe("application-id")

      await rm(join(rootDir, "app", ".vitehub/provision.json"))
      await expect(callHook(hooks, "nitro:config", { alias: {}, modules: [], preset: "cloudflare_module" })).rejects.toMatchObject({ code: "DATABASE_MISSING_D1_RESOURCE" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("preserves the local definition runtime for production Node builds", async () => {
    const { hooks, nuxt } = createNuxt({
      dev: false,
      nitro: { preset: "node-server" },
      rootDir: `${tmp}/vitehub-db-nuxt-node`,
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const nitroConfig = { exportConditions: ["node"] }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.exportConditions).toEqual(["node"])
  })

  it("does nothing when its options are false", async () => {
    const { nuxt } = createNuxt({
      rootDir: `${tmp}/vitehub-db-nuxt-disabled`,
      vite: {},
    })

    await hubDb(false)(undefined, nuxt)

    expect(nuxt.options).toEqual({
      rootDir: `${tmp}/vitehub-db-nuxt-disabled`,
      vite: {},
    })
  })

  it.each([false, { binding: "TOP_LEVEL_DB", driver: "d1" }])("ignores a top-level Nuxt `database` key: %j", async (database) => {
    const { nuxt } = createNuxt({
      database,
      dev: false,
      rootDir: `${tmp}/vitehub-db-nuxt-top-level`,
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    const options = getResolvedFeatureOptions<Record<string, unknown>>(nuxt.options.vite as object, "database")
    expect(options).toMatchObject({ nuxtHostResource: true })
    expect(options).not.toHaveProperty("binding")
    expect(options).not.toHaveProperty("driver")
  })
})
