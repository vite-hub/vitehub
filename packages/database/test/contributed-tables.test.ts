import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { createServer as createViteServer } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { collectDatabaseContributions, resolveDatabaseContributionTargets, resolveDefaultDatabase } from "../src/contributions.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { hubDb } from "../src/vite.ts"

import type { DatabaseContribution } from "../src/contributions.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

// The package fixture is plain ESM so drizzle-kit loads it from node_modules without a TypeScript transform.
const historyPackage = [
  "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
  "export const historyRefs = sqliteTable('history_refs', { workspace: text('workspace').primaryKey(), head: text('head') })",
  "export const historyRevisions = sqliteTable('history_revisions', { id: integer('id').primaryKey() })",
  "export const historySchema = { historyRefs, historyRevisions }",
  "export const legacySchema = { legacyRefs: sqliteTable('history_refs', { id: text('id') }) }",
  "",
].join("\n")

async function writeProjectFile(rootDir: string, path: string, contents: string) {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
  return file
}

async function createProject(definitions: Record<string, string[]> = { "server/databases/config.ts": ["export default defineDatabase({ schema: { notes } })"] }) {
  // Inside the package so the fixture resolves this package's drizzle-orm and drizzle-kit.
  const rootDir = await mkdtemp(join(import.meta.dirname, ".contributed-tables-"))
  tempDirs.push(rootDir)
  await writeProjectFile(rootDir, "node_modules/history-tables/package.json", JSON.stringify({ exports: { "./schema": "./schema.mjs" }, name: "history-tables", type: "module" }))
  await writeProjectFile(rootDir, "node_modules/history-tables/schema.mjs", historyPackage)
  for (const [path, body] of Object.entries(definitions)) {
    const name = /server\/databases\/([^/]+)\/config\.ts$/.exec(path)?.[1]
    await writeProjectFile(rootDir, path, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { title: text('title') })",
      ...(name ? body.map(line => line.replace("defineDatabase({", `defineDatabase({ name: ${JSON.stringify(name)},`)) : body),
      "",
    ].join("\n"))
  }
  return rootDir
}

function contributions(...entries: Array<DatabaseContribution & { contributor?: string }>) {
  return entries.map(entry => ({ contributor: "history-owner/vite", ...entry }))
}

const historyContribution = { export: "historySchema", module: "history-tables/schema" }

async function generate(rootDir: string, contributed = contributions(historyContribution)) {
  const config = resolveDBViteConfig(undefined, rootDir, { contributions: { tables: contributed } })!
  await writeGeneratedDatabaseArtifacts(config)
  return config
}

describe("resolveDefaultDatabase", () => {
  it("picks `default`, else the only Database", () => {
    expect(resolveDefaultDatabase(["analytics", "default"])).toEqual({ name: "default", reason: "default", status: "resolved" })
    expect(resolveDefaultDatabase(["analytics"])).toEqual({ name: "analytics", reason: "only", status: "resolved" })
    expect(resolveDefaultDatabase(["primary", "analytics"])).toEqual({ names: ["analytics", "primary"], status: "ambiguous" })
    expect(resolveDefaultDatabase([])).toEqual({ status: "none" })
  })
})

describe("collectDatabaseContributions", () => {
  const context = { rootDir: "/app" }

  it("reads arrays and factories from Vite plugins and keeps duplicates once", async () => {
    const factory = { name: "factory/vite", vitehub: { databases: async (input: typeof context) => [{ database: "default", module: `${input.rootDir}/tables.ts` }] } }
    const array = { name: "array/vite", vitehub: { databases: [historyContribution] } }

    await expect(collectDatabaseContributions([[array, factory], array, { name: "other" }, null], context)).resolves.toEqual({
      definitions: [],
      tables: [
        { contributor: "array/vite", ...historyContribution },
        { contributor: "factory/vite", database: "default", module: "/app/tables.ts" },
      ],
    })
  })

  it("separates Database Definition contributions from table contributions", async () => {
    const definition = { definition: "/app/.vitehub/content/database.ts", name: "default", reason: "Needed by the preset." }
    const plugin = { name: "content/vite", vitehub: { databases: [definition, historyContribution] } }

    await expect(collectDatabaseContributions([plugin, plugin], context)).resolves.toEqual({
      definitions: [{ contributor: "content/vite", ...definition }],
      tables: [{ contributor: "content/vite", ...historyContribution }],
    })
    await expect(collectDatabaseContributions([plugin, { name: "other/vite", vitehub: { databases: [{ ...definition, definition: "/app/other.ts" }] } }], context))
      .rejects.toMatchObject({ code: "DATABASE_B0013", message: expect.stringContaining("Database \"default\" is contributed more than once") })
  })

  it.each([
    [{ databases: {} }, "must be an array"],
    [{ databases: [{ module: "./tables.ts" }] }, "is relative"],
    [{ databases: [{ module: "" }] }, "`module` must be a non-empty string"],
    [{ databases: [{ export: "", module: "pkg" }] }, "`export`"],
    [{ databases: [{ database: " default ", module: "pkg" }] }, "`database`"],
    [{ databases: [{ definition: "/app/db.ts", name: " default" }] }, "`name`"],
    [{ databases: [{ definition: "./db.ts", name: "default" }] }, "absolute path"],
    [{ databases: [{ definition: "/app/db.ts", module: "pkg", name: "default" }] }, "Contribute them as two entries"],
  ])("rejects invalid contributions %#", async (vitehub, message) => {
    await expect(collectDatabaseContributions([{ name: "broken/vite", vitehub }], context)).rejects.toMatchObject({
      code: "DATABASE_B0012",
      message: expect.stringContaining(message),
    })
  })
})

describe("contribution targets", () => {
  it("targets the default or only Database when `database` is omitted", () => {
    expect(resolveDatabaseContributionTargets(["analytics", "default"], contributions(historyContribution)).default).toHaveLength(1)
    expect(resolveDatabaseContributionTargets(["analytics"], contributions(historyContribution)).analytics?.[0]?.database).toBe("analytics")
    expect(resolveDatabaseContributionTargets(["analytics", "primary"], contributions({ ...historyContribution, database: "primary" })).primary).toHaveLength(1)
  })

  it.each([
    [["analytics", "primary"], undefined, "none is named \"default\": \"analytics\", \"primary\""],
    [["default"], "primary", "target Database \"primary\", which has no Database Definition. Database Definitions: \"default\""],
    [[], undefined, "the app has no Database Definition"],
  ])("fails for %j with database %j", (names, database, message) => {
    expect(() => resolveDatabaseContributionTargets(names, contributions({ ...historyContribution, database }))).toThrow(expect.objectContaining({
      code: "DATABASE_B0011",
      message: expect.stringContaining(message),
    }))
  })

  it("fails config resolution when no Database Definition exists", async () => {
    const rootDir = await createProject({})

    expect(() => resolveDBViteConfig(undefined, rootDir, { contributions: { tables: contributions(historyContribution) } })).toThrow(expect.objectContaining({ code: "DATABASE_B0011" }))
    expect(resolveDBViteConfig(false, rootDir, { contributions: { tables: contributions(historyContribution) } })).toBeUndefined()
  })
})

describe("contributed Database Definitions", () => {
  async function contributedDefinition(rootDir: string, name = "default") {
    const file = join(rootDir, ".vitehub/content/database.ts")
    await writeProjectFile(rootDir, ".vitehub/content/database.ts", [
      "import { defineDatabase } from '@vite-hub/database'",
      `export default defineDatabase({ ${name === "default" ? "" : `name: ${JSON.stringify(name)}, `}schema: {} })`,
      "",
    ].join("\n"))
    return { contributor: "content/vite", definition: file, name, reason: "The preset needs a Database." }
  }

  it("adds a Database with the app's migrations directory, and tables can target it", async () => {
    const rootDir = await createProject({})
    const definition = await contributedDefinition(rootDir)
    const config = resolveDBViteConfig(undefined, rootDir, { contributions: { definitions: [definition], tables: contributions(historyContribution) } })!

    expect(config.databaseNames).toEqual(["default"])
    expect(config.definitions[0]).toMatchObject({ contributor: "content/vite", handler: definition.definition, mode: "default", reason: "The preset needs a Database.", source: "vite-plugin-contribution" })
    expect(config.databases.default?.migrationsDir).toBe("server/databases/migrations")
    expect(config.databases.default?.connection?.url).toBe("file:.vitehub/data/database/sqlite.db")
    expect(config.tableContributionsByDatabase.default).toHaveLength(1)

    await writeGeneratedDatabaseArtifacts(config)
    await execFileAsync(process.execPath, [join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"), "generate", "--config", config.generatedDrizzleConfigFile], { cwd: rootDir })
    const migrations = join(rootDir, "server/databases/migrations")
    const sql = await readFile(join(migrations, (await readdir(migrations)).find(file => file.endsWith(".sql"))!), "utf8")
    expect(sql).toContain("CREATE TABLE `history_refs`")
  }, 60_000)

  it("keeps named migrations beside where the app would define the Database", async () => {
    const rootDir = await createProject({})
    const definition = await contributedDefinition(rootDir, "content")
    const config = resolveDBViteConfig(undefined, rootDir, { contributions: { definitions: [definition] } })!

    expect(config.databases.content?.migrationsDir).toBe("server/databases/content/migrations")
  })

  it("fails when the app already defines the contributed Database", async () => {
    const rootDir = await createProject()
    const definition = await contributedDefinition(rootDir)

    expect(() => resolveDBViteConfig(undefined, rootDir, { contributions: { definitions: [definition] } })).toThrow(expect.objectContaining({
      code: "DATABASE_B0013",
      message: expect.stringContaining("is defined by the app in"),
    }))
  })

  it("shows the contributor and reason in inspection", async () => {
    const rootDir = await createProject({})
    const definition = await contributedDefinition(rootDir)
    const plugin = { name: "content/vite", vitehub: { databases: [{ definition: definition.definition, name: "default", reason: definition.reason }] } }

    const [summary] = await inspectDatabaseDefinitions({ plugins: [plugin], projectRoot: rootDir, rootDir })
    expect(summary).toMatchObject({ file: ".vitehub/content/database.ts", name: "default", source: "vite-plugin-contribution" })
    expect(summary?.fields).toEqual(expect.arrayContaining([
      { label: "Contributed by", value: "content/vite" },
      { label: "Reason", value: "The preset needs a Database." },
      { label: "Migrations", value: "server/databases/migrations" },
    ]))
  })
})

describe("contributed tables in generated artifacts", () => {
  it("adds contributed tables to the generated schema, types, and a real drizzle-kit migration", async () => {
    const rootDir = await createProject()
    const absolute = await writeProjectFile(rootDir, "vendor/audit.ts", [
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export default { auditLog: sqliteTable('audit_log', { id: text('id').primaryKey() }) }",
      "",
    ].join("\n"))
    const config = await generate(rootDir, contributions(historyContribution, { contributor: "audit/vite", module: absolute }))

    const generated = await readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")
    expect(generated).toContain("import { historySchema as contributedSchema_0 } from \"history-tables/schema\"")
    expect(generated).toContain("import contributedSchema_1 from \"../../../vendor/audit.ts\"")
    expect(generated).toContain("export { table_1 as historyRefs }")
    expect(generated).toContain("export { table_3 as auditLog }")
    expect(generated).toContain("export const schema = { ...databaseDefinition.schema, ...contributedSchema_0, ...contributedSchema_1 }")

    const types = await readFile(join(rootDir, ".vitehub/types/database.d.ts"), "utf8")
    expect(types).toContain("import type { historySchema as contribution_0_0 } from \"history-tables/schema\"")
    expect(types).toContain("schema: typeof database_0.schema & typeof contribution_0_0 & typeof contribution_0_1")

    await execFileAsync(process.execPath, [
      join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config",
      config.generatedDrizzleConfigFile,
    ], { cwd: rootDir })
    const migrationsDir = join(rootDir, "server/databases/migrations")
    const migration = (await readdir(migrationsDir)).find(file => file.endsWith(".sql"))!
    const sql = await readFile(join(migrationsDir, migration), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual([
      "CREATE TABLE `audit_log`",
      "CREATE TABLE `history_refs`",
      "CREATE TABLE `history_revisions`",
      "CREATE TABLE `notes`",
    ])
  }, 60_000)

  it("keeps the Definition schema object when nothing is contributed", async () => {
    const rootDir = await createProject()
    const config = await generate(rootDir, [])

    await expect(readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")).resolves.toContain("export const schema = databaseDefinition.schema\n")
  })

  it("adds tables only to the targeted named Database", async () => {
    const rootDir = await createProject({
      "server/databases/analytics/config.ts": ["export default defineDatabase({ schema: { notes } })"],
      "server/databases/history/config.ts": ["export default defineDatabase({ schema: {} })"],
    })
    const config = await generate(rootDir, contributions({ ...historyContribution, database: "history" }))

    await expect(readFile(config.generatedSchemaFilesByDatabase.history!, "utf8")).resolves.toContain("contributedSchema_0")
    await expect(readFile(config.generatedSchemaFilesByDatabase.analytics!, "utf8")).resolves.not.toContain("contributedSchema_0")
  })

  it.each([
    ["a key of the app schema", ["const historyRefs = sqliteTable('app_refs', { id: text('id') })", "export default defineDatabase({ schema: { notes, historyRefs } })"], [historyContribution], "key \"historyRefs\""],
    ["a SQL table name of the app schema", ["const refs = sqliteTable('history_refs', { id: text('id') })", "export default defineDatabase({ schema: { notes, refs } })"], [historyContribution], "named \"history_refs\""],
    ["another contribution", ["export default defineDatabase({ schema: { notes } })"], [historyContribution, { export: "legacySchema", module: "history-tables/schema" }], "named \"history_refs\""],
  ])("fails when contributed tables collide with %s", async (_, definition, entries, message) => {
    const rootDir = await createProject({ "server/databases/config.ts": definition })

    await expect(generate(rootDir, contributions(...entries))).rejects.toMatchObject({
      code: "DATABASE_B0010",
      message: expect.stringMatching(new RegExp(`${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*contributed by "history-owner/vite"`)),
    })
  })

  it("fails when the contributed export is missing or the module cannot load", async () => {
    const rootDir = await createProject()

    await expect(generate(rootDir, contributions({ export: "missing", module: "history-tables/schema" }))).rejects.toMatchObject({ code: "DATABASE_B0012" })
    await expect(generate(rootDir, contributions({ export: "historyRefs", module: "history-tables/schema" }))).rejects.toMatchObject({ code: "DATABASE_B0012" })
    await expect(generate(rootDir, contributions({ module: "history-tables/missing" }))).rejects.toMatchObject({ code: "DATABASE_B0007" })
  })

  it("marks contributed tables and their plugin in inspection", async () => {
    const rootDir = await createProject()
    const plugin = { name: "history-owner/vite", vitehub: { databases: [historyContribution] } }

    const [definition] = await inspectDatabaseDefinitions({ plugins: [plugin], projectRoot: rootDir, rootDir })
    expect(definition!.fields).toEqual([
      { label: "Mode", value: "Default" },
      { label: "Tables", value: "notes" },
      { label: "Contributed tables", value: "historyRefs, historyRevisions from history-tables/schema#historySchema (contributed by \"history-owner/vite\")" },
    ])
  })
})

describe("contributed tables at runtime", () => {
  it("adds contributed tables to `useDatabase().schema` and the Drizzle relational API", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".contributed-tables-runtime-"))
    tempDirs.push(rootDir)
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const tables = await writeProjectFile(rootDir, "vendor/history.ts", historyPackage)
    await writeProjectFile(rootDir, "server/databases/config.ts", [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { title: text('title') })",
      `export default defineDatabase({ connection: { url: ${JSON.stringify(`file:${join(rootDir, "runtime.db")}`)} }, schema: { notes } })`,
      "",
    ].join("\n"))
    const queryFile = await writeProjectFile(rootDir, "server/query.ts", [
      "import { sql } from 'drizzle-orm'",
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "export async function query() {",
      "  const { db, schema } = useDatabase('default')",
      "  await db.run(sql`create table if not exists history_refs (workspace text primary key, head text)`)",
      "  await db.insert(schema.historyRefs).values({ workspace: 'docs', head: 'r1' })",
      "  return { keys: Object.keys(schema).sort(), refs: await db.query.historyRefs.findMany() }",
      "}",
      "",
    ].join("\n"))
    const contributor = { name: "history-owner/vite", vitehub: { databases: [{ export: "historySchema", module: tables }] } }
    const server = await createViteServer({ configFile: false, logLevel: "silent", plugins: [hubDb(), contributor], root: rootDir, server: { middlewareMode: true, watch: null } })
    try {
      // SAFETY: This fixture writes the queried module before Vite loads it.
      const module = await server.ssrLoadModule(queryFile) as { query: () => Promise<{ keys: string[], refs: unknown[] }> }
      await expect(module.query()).resolves.toEqual({
        keys: ["historyRefs", "historyRevisions", "notes"],
        refs: [{ head: "r1", workspace: "docs" }],
      })
    }
    finally {
      await server.close()
    }
  }, 30_000)
})
