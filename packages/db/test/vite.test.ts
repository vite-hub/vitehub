import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  DB_VIRTUAL_DATABASES_ID,
  DB_VIRTUAL_SCHEMA_ID,
  hubDb,
} from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, table = "notes") {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vitehub/db'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${table}', { title: text('title') })`,
    `export default defineDatabase({ tables: { ${table} } })`,
    "",
  ].join("\n"))
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubDb", () => {
  it("resolves discovered database definitions and writes generated artifacts", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: undefined, root: rootDir } as never)

    expect(plugin.api.getConfig()).toMatchObject({
      databaseNames: ["default"],
      databases: {
        default: {
          connection: { url: "file:.data/db/sqlite.db" },
          migrationsDir: "server/databases/migrations",
          mode: "default",
        },
      },
    })
    await expect(readFile(join(rootDir, ".vitehub/db/schema/default.ts"), "utf8")).resolves.toContain("export const notes")
    await expect(readFile(join(rootDir, ".vitehub/db/drizzle.config.ts"), "utf8")).resolves.toContain("server/databases/migrations")
    await expect(readFile(join(rootDir, ".vitehub/db/drizzle.config.ts"), "utf8")).resolves.toContain("dbCredentials")
    await expect(readFile(join(rootDir, ".vitehub/db/drizzle/default.config.ts"), "utf8")).resolves.toContain("file:.data/db/sqlite.db")
  })

  it("writes one Drizzle config per named database migrations directory", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    await writeDefinition(rootDir, "server/databases/primary/config.ts", "notes")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: undefined, root: rootDir } as never)

    const analyticsConfig = await readFile(join(rootDir, ".vitehub/db/drizzle/analytics.config.ts"), "utf8")
    const primaryConfig = await readFile(join(rootDir, ".vitehub/db/drizzle/primary.config.ts"), "utf8")

    expect(analyticsConfig).toContain("server/databases/analytics/migrations")
    expect(analyticsConfig).toContain("file:.data/db/analytics.sqlite.db")
    expect(primaryConfig).toContain("server/databases/primary/migrations")
    expect(primaryConfig).toContain("file:.data/db/primary.sqlite.db")
  })

  it("lets top-level config disable the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: false, root: rootDir } as never)

    expect(plugin.api.getConfig()).toBeUndefined()
  })

  it("exposes default schema and database registry through stable ViteHub import paths", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const resolvedDatabasesId = await resolveId(DB_VIRTUAL_DATABASES_ID)
    const schemaCode = await load(resolvedSchemaId!)
    const databasesCode = await load(resolvedDatabasesId!)

    expect(schemaCode).toContain("export { default, schema }")
    expect(schemaCode).toContain(join(rootDir, ".vitehub/db/schema/default.ts"))
    expect(databasesCode).toContain(definition)
    expect(databasesCode).toContain("\"default\"")
    expect(databasesCode).toContain("\"server/databases/migrations\"")
  })

  it("refreshes generated artifacts during definition hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await writeFile(definition, [
      "import { defineDatabase } from '@vitehub/db'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const tasks = sqliteTable('tasks', { title: text('title') })",
      "export default defineDatabase({ tables: { tasks } })",
      "",
    ].join("\n"))
    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
    await expect(readFile(join(rootDir, ".vitehub/db/schema/default.ts"), "utf8")).resolves.toContain("export const tasks")
  })

  it("normalizes definition paths before matching hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const config = plugin.api.getConfig()!
    config.definitions[0]!.handler = config.definitions[0]!.handler.replaceAll("/", "\\")

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
  })
})
