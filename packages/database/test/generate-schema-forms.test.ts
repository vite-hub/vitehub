import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { loadDatabaseTableNames } from "../src/internal/schema-tables.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const schemaModule = [
  "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
  "export const revisions = sqliteTable('revisions', { id: integer('id').primaryKey() })",
  "export const refs = sqliteTable('refs', { name: text('name').primaryKey() })",
  "export const historySchema = { revisions, refs }",
  "",
].join("\n")

const notesTable = "const notes = sqliteTable('notes', { title: text('title') })"

const forms: Record<string, { definition: string[], tables: string[] }> = {
  "literal": {
    definition: [
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "import { refs } from '../../schema.ts'",
      notesTable,
      "export default defineDatabase({ schema: { notes, refs } })",
    ],
    tables: ["notes", "refs"],
  },
  "imported identifier": {
    definition: [
      "import { historySchema } from '../../schema.ts'",
      "export default defineDatabase({ schema: historySchema })",
    ],
    tables: ["refs", "revisions"],
  },
  "spread": {
    definition: [
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "import { historySchema } from '../../schema.ts'",
      notesTable,
      "export default defineDatabase({ schema: { ...historySchema, notes } })",
    ],
    tables: ["notes", "refs", "revisions"],
  },
  "namespace shorthand": {
    definition: [
      "import * as schema from '../../schema.ts'",
      "export default defineDatabase({ schema })",
    ],
    tables: ["refs", "revisions"],
  },
}

async function createProject(definition: string[]) {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".generate-schema-forms-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "server/databases"), { recursive: true })
  await writeFile(join(rootDir, "schema.ts"), schemaModule)
  await writeFile(join(rootDir, "server/databases/config.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    ...definition,
    "",
  ].join("\n"))
  return rootDir
}

async function generateMigration(rootDir: string) {
  const config = resolveDBViteConfig(undefined, rootDir)!
  await writeGeneratedDatabaseArtifacts(config)
  await execFileAsync(process.execPath, [
    join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
    "generate",
    "--config",
    config.generatedDrizzleConfigFile,
  ], { cwd: rootDir })
  const migrationsDir = join(rootDir, "server/databases/migrations")
  const files = await readdir(migrationsDir).catch(() => [])
  const migration = files.find(file => file.endsWith(".sql"))
  return { sql: migration ? await readFile(join(migrationsDir, migration), "utf8") : "" }
}

describe("db generate schema forms", () => {
  for (const [form, { definition, tables }] of Object.entries(forms)) {
    it(`creates every table for a ${form} schema`, async () => {
      const rootDir = await createProject(definition)
      const { sql } = await generateMigration(rootDir)

      expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(tables.map(table => `CREATE TABLE \`${table}\``))
    }, 60_000)
  }
})

describe("Database table names", () => {
  it("exports every loaded table from the generated schema", async () => {
    const rootDir = await createProject(forms.spread!.definition)
    const config = resolveDBViteConfig(undefined, rootDir)!
    await writeGeneratedDatabaseArtifacts(config)

    const generated = await readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")
    expect(generated).toContain("export { table_0 as revisions }")
    expect(generated).toContain("export { table_2 as notes }")
  })

  it("marks imported and spread schemas in source-only inspection", async () => {
    const tables = async (form: string) => {
      const rootDir = await createProject(forms[form]!.definition)
      const [definition] = await inspectDatabaseDefinitions({ projectRoot: rootDir, rootDir })
      return definition!.fields.find(field => field.label === "Tables")?.value
    }

    await expect(tables("literal")).resolves.toBe("notes, refs")
    await expect(tables("spread")).resolves.toBe("notes, plus an imported or spread schema")
    await expect(tables("imported identifier")).resolves.toBe("Imported or spread schema")
    await expect(tables("namespace shorthand")).resolves.toBe("Imported or spread schema")
  })

  it("lists views and skips relations and other schema values", async () => {
    const rootDir = await createProject([
      "import { relations } from 'drizzle-orm'",
      "import { sqliteTable, sqliteView, text } from 'drizzle-orm/sqlite-core'",
      notesTable,
      "const noteTitles = sqliteView('note_titles').as(qb => qb.select({ title: notes.title }).from(notes))",
      "const notesRelations = relations(notes, () => ({}))",
      "export default defineDatabase({ schema: { notes, noteTitles, notesRelations } })",
    ])

    await expect(loadDatabaseTableNames(join(rootDir, "server/databases/config.ts"))).resolves.toEqual(["notes", "noteTitles"])
  })

  it("fails without a fallback when the Definition cannot load", async () => {
    const rootDir = await createProject([
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "import { missing } from '../../missing.ts'",
      notesTable,
      "export default defineDatabase({ schema: { notes, missing } })",
    ])
    const handler = join(rootDir, "server/databases/config.ts")

    await expect(loadDatabaseTableNames(handler)).rejects.toMatchObject({ code: "DATABASE_B0007" })

    const onFallback = vi.fn()
    await expect(loadDatabaseTableNames(handler, { onFallback })).resolves.toEqual(["notes", "missing"])
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("vitehub db generate` requires the Definition to load"))
  })

  it("requires a default export with a schema object", async () => {
    const rootDir = await createProject(["export const schema = {}", "export default defineDatabase"])

    await expect(loadDatabaseTableNames(join(rootDir, "server/databases/config.ts"))).rejects.toMatchObject({ code: "DATABASE_B0008" })
  })

  it("resolves host aliases while loading the Definition", async () => {
    const rootDir = await createProject([
      "import { historySchema } from '#db-schema'",
      "export default defineDatabase({ schema: historySchema })",
    ])

    await expect(loadDatabaseTableNames(join(rootDir, "server/databases/config.ts"), {
      alias: { "#db-schema": join(rootDir, "schema.ts") },
    })).resolves.toEqual(["revisions", "refs"])
  })

  it("rejects schema keys that collide with generated schema exports", async () => {
    const rootDir = await createProject([
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      notesTable,
      "export default defineDatabase({ schema: { schema: notes } })",
    ])

    await expect(writeGeneratedDatabaseArtifacts(resolveDBViteConfig(undefined, rootDir)!)).rejects.toMatchObject({ code: "DATABASE_B0009" })
  })
})
