import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
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
  await mkdir(join(rootDir, "src/db/analytics/schema"), { recursive: true })
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubDb", () => {
  it("resolves config from the Vite layer", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")
    await writeFile(join(rootDir, "src/db/analytics/schema.ts"), "export const analytics = true\n")

    const plugin = hubDb({
      connection: {
        url: "file:.data/custom.db",
      },
      databases: {
        analytics: {},
      },
    })

    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ db: undefined, root: rootDir } as never)

    expect(plugin.api.getConfig()).toMatchObject({
      databaseNames: ["default", "analytics"],
      databases: {
        default: {
          connection: {
            url: "file:.data/custom.db",
          },
        },
        analytics: {
          connection: {
            url: "file:.data/db/analytics.sqlite.db",
          },
        },
      },
    })
  })

  it("lets top-level config override inline plugin options", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")

    const plugin = hubDb({
      connection: {
        url: "file:.data/inline.db",
      },
    })

    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({
      db: {
        connection: {
          url: "file:.data/top-level.db",
        },
      },
      root: rootDir,
    } as never)

    expect(plugin.api.getConfig()?.databases.default.connection?.url).toBe("file:.data/top-level.db")
  })

  it("exposes default schema and named databases through stable ViteHub import paths", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")
    await writeFile(join(rootDir, "src/db/analytics/schema.ts"), "export const analytics = true\n")

    const plugin = hubDb({
      databases: {
        analytics: {
          cloudflare: {
            databaseId: "analytics-d1-id",
          },
        },
      },
    })
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ root: rootDir } as never)

    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const resolvedDatabasesId = await resolveId(DB_VIRTUAL_DATABASES_ID)
    const schemaCode = await load(resolvedSchemaId!)
    const databasesCode = await load(resolvedDatabasesId!)

    expect(schemaCode).toContain("export default schema;")
    expect(schemaCode).toContain(join(rootDir, "src/db/schema.ts"))
    expect(databasesCode).toContain("\"analytics\"")
    expect(databasesCode).toContain("\"DB_ANALYTICS\"")
    expect(databasesCode).toContain(join(rootDir, "src/db/analytics/schema.ts"))
  })
  it("refreshes discovered schema paths during hot updates", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")
    await mkdir(join(rootDir, "src/db/schema"), { recursive: true })

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ root: rootDir } as never)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => void
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    await writeFile(join(rootDir, "src/db/schema/new-note.ts"), "export const newNote = true\n")
    handleHotUpdate({
      file: join(rootDir, "src/db/schema/new-note.ts"),
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

    const schemaCode = await load(`\0${DB_VIRTUAL_SCHEMA_ID}`)

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
    expect(schemaCode).toContain(join(rootDir, "src/db/schema/new-note.ts"))
  })

  it("normalizes schema paths before matching hot updates", async () => {
    const rootDir = await createTempProject()
    const schemaFile = join(rootDir, "src/db/schema.ts")
    await writeFile(schemaFile, "export const notes = true\n")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ root: rootDir } as never)

    const config = plugin.api.getConfig()!
    config.rootDir = config.rootDir.replaceAll("/", "\\")
    config.schemaPathsByDatabase.default = config.schemaPathsByDatabase.default.map((path: string) => path.replaceAll("/", "\\"))

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => void

    handleHotUpdate({
      file: schemaFile,
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
