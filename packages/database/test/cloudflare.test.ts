import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { createRuntimeEnvConfigValue } from "../src/config-value.ts"
import { mergeCloudflareD1Bindings, resolveCloudflareD1Binding, resolveCloudflareD1Bindings } from "../src/internal/cloudflare.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-cloudflare-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, name: string, cloudflare: string) {
  const file = join(rootDir, "server", "databases", name, "config.ts")
  const table = `${name.replace(/[^a-z0-9_]/gi, "_")}Items`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${name}_items', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    "  cloudflare: {",
    cloudflare,
    "  },",
    `  schema: { ${table} },`,
    "})",
    "",
  ].join("\n"))
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Cloudflare D1 binding projections", () => {
  it("resolves plain D1 binding projections without a ViteHub database definition", () => {
    expect(resolveCloudflareD1Binding({
      database: "content",
      databaseName: "content-db",
      databaseId: "content-id",
    })).toEqual({
      bindingName: "DB_CONTENT",
      d1Database: {
        binding: "DB_CONTENT",
        database_id: "content-id",
        database_name: "content-db",
      },
    })

    expect(resolveCloudflareD1Binding({
      database: "content",
      binding: "DB",
      databaseName: "content-db",
    })).toEqual({
      bindingName: "DB",
      unresolved: {
        binding: "DB",
        database: "content",
        databaseName: "content-db",
        reason: "missing-database-id",
      },
    })
  })

  it("resolves Wrangler D1 bindings from explicit IDs and Provision State fallback IDs", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "primary", [
      "    binding: 'DB_PRIMARY',",
      "    databaseName: 'primary-db',",
      "    databaseId: 'primary-id',",
      "    previewDatabaseId: 'primary-preview-id',",
      "    migrationsTable: 'custom_migrations',",
    ].join("\n"))
    await writeDefinition(rootDir, "analytics", [
      "    binding: 'DB_ANALYTICS',",
      "    databaseName: 'analytics-db',",
    ].join("\n"))

    const config = resolveDBViteConfig(undefined, rootDir)!
    const projection = resolveCloudflareD1Bindings(config, {
      provisionState: { cloudflare: { d1: { analytics: "analytics-id" } } },
    })

    expect(projection.unresolved).toEqual([])
    expect(projection.d1Databases).toEqual([
      {
        binding: "DB_ANALYTICS",
        database_id: "analytics-id",
        database_name: "analytics-db",
        migrations_dir: "server/databases/analytics/migrations",
      },
      {
        binding: "DB_PRIMARY",
        database_id: "primary-id",
        database_name: "primary-db",
        migrations_dir: "server/databases/primary/migrations",
        migrations_table: "custom_migrations",
        preview_database_id: "primary-preview-id",
      },
    ])
  })

  it.each([
    { field: "databaseId", form: "literal" },
    { field: "databaseName", form: "literal" },
    { field: "databaseId", form: "env" },
    { field: "databaseName", form: "env" },
  ] as const)("rejects a whitespace-only required D1 identity in $field from $form", ({ field, form }) => {
    vi.stubEnv("VITEHUB_TEST_REQUIRED_D1_IDENTITY", " \t\n")
    const value = form === "env" ? createRuntimeEnvConfigValue(["VITEHUB_TEST_REQUIRED_D1_IDENTITY"]) : " \t\n"
    const input = field === "databaseId"
      ? { databaseId: value, databaseName: "resource-db" }
      : { databaseId: "resource-id", databaseName: value }
    const result = resolveCloudflareD1Binding(input, { provisionState: { cloudflare: { d1: { default: "provisioned-id" } } } })

    expect(result.d1Database).toBeUndefined()
    expect(result.unresolved?.reason).toBe(field === "databaseId" ? "missing-database-id" : "missing-database-name")
    expect(result.unresolved?.databaseName).toBe(field === "databaseId" ? "resource-db" : undefined)
  })

  it("keeps nonblank required D1 identity bytes unchanged", () => {
    expect(resolveCloudflareD1Binding({ databaseId: " resource-id ", databaseName: " resource-db " }).d1Database).toMatchObject({
      database_id: " resource-id ",
      database_name: " resource-db ",
    })
  })

  it("uses a provisioned required D1 identity when its Env value is missing", () => {
    vi.stubEnv("VITEHUB_TEST_REQUIRED_D1_IDENTITY", undefined)
    const result = resolveCloudflareD1Binding({
      databaseId: createRuntimeEnvConfigValue(["VITEHUB_TEST_REQUIRED_D1_IDENTITY"]),
      databaseName: "resource-db",
    }, { provisionState: { cloudflare: { d1: { default: "provisioned-id" } } } })

    expect(result.d1Database).toMatchObject({ database_id: "provisioned-id", database_name: "resource-db" })
  })

  it("rejects a whitespace-only provisioned required D1 identity", () => {
    const result = resolveCloudflareD1Binding({ databaseName: "resource-db" }, {
      provisionState: { cloudflare: { d1: { default: " \t\n" } } },
    })

    expect(result.d1Database).toBeUndefined()
    expect(result.unresolved?.reason).toBe("missing-database-id")
  })

  it("reports unresolved bindings instead of emitting invalid Wrangler D1 config", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "draft", [
      "    binding: 'DB_DRAFT',",
      "    databaseName: 'draft-db',",
    ].join("\n"))
    await writeDefinition(rootDir, "unnamed", [
      "    binding: 'DB_UNNAMED',",
      "    databaseId: 'unnamed-id',",
    ].join("\n"))

    const config = resolveDBViteConfig(undefined, rootDir)!
    const projection = resolveCloudflareD1Bindings(config)

    expect(projection.d1Databases).toEqual([])
    expect(projection.unresolved).toEqual([
      {
        binding: "DB_DRAFT",
        database: "draft",
        databaseName: "draft-db",
        migrationsDir: "server/databases/draft/migrations",
        reason: "missing-database-id",
      },
      {
        binding: "DB_UNNAMED",
        database: "unnamed",
        migrationsDir: "server/databases/unnamed/migrations",
        reason: "missing-database-name",
      },
    ])
  })

  it("assigns per-name bindings to owned resources instead of the host binding", async () => {
    const rootDir = await createTempProject()
    for (const name of ["alpha", "beta"]) {
      await writeDefinition(rootDir, name, `databaseId: '${name}-id', databaseName: '${name}-db',`)
    }
    const config = resolveDBViteConfig({ driver: "d1", binding: "HOST_DB", databaseId: "host-id", databaseName: "host-db" }, rootDir)!

    expect(resolveCloudflareD1Bindings(config).d1Databases).toMatchObject([
      { binding: "DB_ALPHA", database_id: "alpha-id", database_name: "alpha-db" },
      { binding: "DB_BETA", database_id: "beta-id", database_name: "beta-db" },
    ])
  })

  it.each(["explicit", "explicit-equal", "normalized"] as const)("rejects duplicate generated native bindings from %s names", async (form) => {
    const rootDir = await createTempProject()
    const names = form === "normalized" ? ["alpha-beta", "alpha.beta"] : ["alpha", "beta"]
    for (const name of names) {
      const resource = form === "explicit-equal" ? "shared" : name
      await writeDefinition(rootDir, name, `${form === "normalized" ? "" : "binding: 'HOST_DB',"} databaseId: '${resource}-id', databaseName: '${resource}-db',`)
    }
    const config = resolveDBViteConfig(undefined, rootDir)!

    expect(() => resolveCloudflareD1Bindings(config)).toThrowError(expect.objectContaining({ code: "DATABASE_B0006" }))
  })

  it("replaces generated D1 bindings by binding name when merging with host config", () => {
    expect(mergeCloudflareD1Bindings([
      {
        binding: "BEFORE",
        database_id: "before-id",
        database_name: "before-db",
      },
      {
        binding: "DB",
        database_id: "old-id",
        database_name: "old-db",
        preview_database_id: "old-preview-id",
      },
      {
        binding: "DB",
        database_id: "duplicate-id",
        database_name: "duplicate-db",
      },
      {
        binding: "OTHER",
        database_id: "other-id",
        database_name: "other-db",
      },
    ], [
      {
        binding: "DB",
        database_id: "new-id",
        database_name: "new-db",
      },
    ])).toEqual([
      {
        binding: "BEFORE",
        database_id: "before-id",
        database_name: "before-db",
      },
      {
        binding: "DB",
        database_id: "new-id",
        database_name: "new-db",
      },
      {
        binding: "OTHER",
        database_id: "other-id",
        database_name: "other-db",
      },
    ])
  })
})
