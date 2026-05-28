import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { discoverDatabaseDefinitions, resolveDBViteConfig } from "../src/config.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-config-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, tables = "notes", options: { connection?: string } = {}) {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vitehub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${tables} = sqliteTable('${tables}', { title: text('title') })`,
    "export default defineDatabase({",
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    `  tables: { ${tables} },`,
    "})",
    "",
  ].join("\n"))
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverDatabaseDefinitions", () => {
  it("discovers the Nitro default database definition", async () => {
    const rootDir = await createTempProject()
    const file = await writeDefinition(rootDir, "server/databases/config.ts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([{
      handler: file,
      mode: "default",
      name: "default",
      source: "nitro-server-database-default",
      tableNames: ["notes"],
    }])
  })

  it("discovers named Nitro database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    const tenant = await writeDefinition(rootDir, "server/databases/tenant/config.ts", "accounts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", tableNames: ["events"] }),
      expect.objectContaining({ handler: tenant, mode: "named", name: "tenant", tableNames: ["accounts"] }),
    ])
  })

  it("discovers Vite default and suffix database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "src/analytics.database.ts", "events")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", source: "vite-database-suffix" }),
    ])
  })

  it("rejects mixing the default database with named databases", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    expect(() => discoverDatabaseDefinitions(rootDir)).toThrow("either one default database or all named databases")
  })
})

describe("resolveDBViteConfig", () => {
  it("returns undefined when no database definition exists", async () => {
    const rootDir = await createTempProject()

    expect(resolveDBViteConfig(undefined, rootDir)).toBeUndefined()
  })

  it("resolves generated files, migrations, and local fallback connection", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databaseNames).toEqual(["default"])
    expect(resolved?.databases.default).toMatchObject({
      connection: { url: "file:.data/database/sqlite.db" },
      dialect: "sqlite",
      migrationsDir: "server/databases/migrations",
      mode: "default",
      name: "default",
      orm: "drizzle",
    })
    expect(resolved?.generatedDrizzleConfigFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/drizzle/default.config.ts"))
    expect(resolved?.generatedSchemaFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(resolved?.generatedDrizzleConfigFile).toBe(join(rootDir, ".vitehub/database/drizzle.config.ts"))
  })

  it("resolves named database defaults from definition locations", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databases.analytics).toMatchObject({
      connection: { url: "file:.data/database/analytics.sqlite.db" },
      migrationsDir: "server/databases/analytics/migrations",
      mode: "named",
    })
  })

  it("uses the local connection fallback when an env-only URL is unset", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_DATABASE_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.connection).toEqual({
        authToken: undefined,
        url: "file:.data/database/sqlite.db",
      })
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })
})
