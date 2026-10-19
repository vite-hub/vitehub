import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { createProviderDeploymentOutputGenerationState, getProviderRuntimeModule, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"

import { resolveRuntimeCloudflareConfig } from "../src/internal/cloudflare.ts"
import { renderDatabaseConfigExpression } from "../src/internal/runtime-config-expression.ts"
import { supportsHostedDatabaseRuntime, writeHostedDatabaseRuntimeModules } from "../src/internal/vite-build.ts"
import { hubDb } from "../src/vite.ts"

import type { ResolvedDBViteConfig, RuntimeDrizzleDatabaseConfig } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  return rootDir
}

function createRuntimeConfig(rootDir: string, database: Pick<RuntimeDrizzleDatabaseConfig, "cloudflare" | "connection">): ResolvedDBViteConfig {
  const migrationsDir = "server/databases/primary/migrations"
  const generatedSchemaFile = join(rootDir, ".vitehub", "database", "primary-schema.ts")
  const handler = join(rootDir, "server", "databases", "primary", "config.ts")
  const cloudflare = database.cloudflare ? { binding: "DB_PRIMARY", ...database.cloudflare, migrationsDir } : undefined
  return {
    databaseNames: ["primary"],
    databases: {
      primary: {
        connection: {},
        dialect: "sqlite",
        drizzle: {},
        generatedSchemaFile,
        migrationsDir,
        mode: "named",
        name: "primary",
        orm: "drizzle",
        ...database,
        cloudflare,
      },
    },
    definitionDefaults: { cloudflareProjections: { primary: { resource: database.cloudflare ? "configured" : "inherited" } } },
    definitions: [{
      handler,
      mode: "named",
      name: "primary",
      schemaSources: [{ handler, tableNames: [] }],
      source: handler,
    }],
    generatedDrizzleConfigFile: join(rootDir, ".vitehub", "database", "drizzle.config.ts"),
    generatedDrizzleConfigFilesByDatabase: {},
    generatedSchemaFilesByDatabase: { primary: generatedSchemaFile },
    rootDir,
    tableContributionsByDatabase: {},
  }
}

describe("hosted Database runtime", () => {
  it("supports D1 HTTP on Cloudflare and Vercel", () => {
    const runtimeConfig = createRuntimeConfig("/tmp/vitehub-db-d1-http", {
      cloudflare: { binding: "DB_PRIMARY", databaseId: "primary-d1-id", databaseName: "primary", http: true },
    })

    expect(supportsHostedDatabaseRuntime("cloudflare", runtimeConfig, {})).toBe(true)
    expect(supportsHostedDatabaseRuntime("vercel", runtimeConfig, {})).toBe(true)
  })

  it("does not support a local-only database on a host", () => {
    const runtimeConfig = createRuntimeConfig("/tmp/vitehub-db-local", {})

    expect(supportsHostedDatabaseRuntime("cloudflare", runtimeConfig, {})).toBe(false)
    expect(supportsHostedDatabaseRuntime("vercel", runtimeConfig, {})).toBe(false)
  })

  it("does not support Cloudflare when a D1 database has an ID and no name", () => {
    const runtimeConfig = createRuntimeConfig("/tmp/vitehub-db-missing-name", {
      cloudflare: { binding: "DB_PRIMARY", databaseId: "primary-d1-id" },
    })

    expect(supportsHostedDatabaseRuntime("cloudflare", runtimeConfig, {})).toBe(false)
  })

  it("uses the Definition name when hosted defaults have an empty binding", async () => {
    const rootDir = await createTempDir("vitehub-db-definition-defaults-")
    const runtimeConfig = createRuntimeConfig(rootDir, {})
    runtimeConfig.databaseNames = ["analytics"]
    runtimeConfig.databases.analytics = runtimeConfig.databases.primary!
    delete runtimeConfig.databases.primary
    runtimeConfig.definitionDefaults = { cloudflare: { binding: "  " }, cloudflareProjections: {} }
    runtimeConfig.definitions[0]!.name = "analytics"
    runtimeConfig.generatedSchemaFilesByDatabase.analytics = runtimeConfig.generatedSchemaFilesByDatabase.primary!

    await writeHostedDatabaseRuntimeModules(join(rootDir, ".vitehub/database"), runtimeConfig)

    await expect(readFile(join(rootDir, ".vitehub/database/definition-defaults.mjs"), "utf8"))
      .resolves.toBe('export default {"cloudflare":{},"cloudflareProjections":{}}\n')
    const expression = renderDatabaseConfigExpression("analytics", runtimeConfig, "definition")
    const config = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ connection: undefined, drizzle: {}, schema: {} }, resolveRuntimeCloudflareConfig)
    expect(config.cloudflare?.binding).toBe("DB_ANALYTICS")
  })

  it("preserves inherited Nuxt D1 identifiers with the named Definition binding", () => {
    const runtimeConfig = createRuntimeConfig("/tmp/vitehub-d1-runtime-expression", {
      cloudflare: {
        binding: "NUXT_DB",
        databaseId: "nuxt-d1-id",
        databaseName: "nuxt-d1-name",
        previewDatabaseId: "nuxt-preview-id",
        migrationsTable: "__nuxt_migrations",
      },
    })
    runtimeConfig.definitionDefaults.cloudflareProjections.primary = { resource: "inherited" }
    const expression = renderDatabaseConfigExpression("primary", runtimeConfig, "definition")
    const config = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ cloudflare: {}, connection: undefined, drizzle: {}, schema: {} }, resolveRuntimeCloudflareConfig)

    expect(config.cloudflare).toMatchObject({
      binding: "DB_PRIMARY",
      databaseId: "nuxt-d1-id",
      databaseName: "nuxt-d1-name",
      migrationsTable: "__nuxt_migrations",
      previewDatabaseId: "nuxt-preview-id",
    })
  })

  it("gives sibling Vercel host functions the hosted Database runtime module", async () => {
    const rootDir = await createTempDir("vitehub-db-sibling-runtime-")
    const definition = join(rootDir, "server", "databases", "config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await Promise.all([
      writeFile(join(rootDir, "package.json"), "{}\n"),
      writeFile(definition, [
        "import { defineDatabase } from '@vite-hub/database'",
        "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
        "const notes = sqliteTable('notes', { title: text('title') })",
        "export default defineDatabase({ connection: { url: 'libsql://primary.example.turso.io' }, name: 'default', schema: { notes } })",
        "",
      ].join("\n")),
    ])
    const plugin = hubDb()
    const config = { build: { outDir: "dist" }, command: "build", nitro: { preset: "vercel" }, plugins: [{ name: "nitro:main" }], root: rootDir }
    // SAFETY: This test invokes hubDb's configResolved hook with the Vite fields used by this fixture.
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
    const context = { environment: {} }
    const sibling = createProviderDeploymentOutputGenerationState()
    const catalog = useProviderOutputCatalog(config)
    sibling.capture(context, catalog)
    // SAFETY: hubDb exposes buildStart as a callable Vite hook.
    await Reflect.apply(plugin.buildStart as () => void, context, [])
    // SAFETY: hubDb exposes buildEnd as a callable Vite hook.
    await Reflect.apply(plugin.buildEnd as () => Promise<void>, context, [])

    const generation = sibling.get(context)
    expect(getProviderRuntimeModule(catalog, "database", "vercel", generation)).toBe(join(rootDir, ".vitehub", "database", "vercel-runtime.mjs"))
    expect(getProviderRuntimeModule(catalog, "database", "vercel-definition-defaults", generation)).toBe(join(rootDir, ".vitehub", "database", "definition-defaults.mjs"))
    expect(getProviderRuntimeModule(catalog, "database", "cloudflare", generation)).toBeUndefined()
  })
})
