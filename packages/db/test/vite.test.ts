import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  DB_VIRTUAL_CONFIG_ID,
  DB_VIRTUAL_SCHEMA_ID,
  hubDb,
} from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-vite-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src/db"), { recursive: true })
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubDb", () => {
  it("resolves config from the Vite layer", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")

    const plugin = hubDb({
      connection: {
        url: "file:.data/custom.db",
      },
    })

    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ db: undefined, root: rootDir } as never)

    expect(plugin.api.getConfig()).toMatchObject({
      db: {
        connection: {
          url: "file:.data/custom.db",
        },
      },
      schemaPaths: [join(rootDir, "src/db/schema.ts")],
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

    expect(plugin.api.getConfig()?.db.connection.url).toBe("file:.data/top-level.db")
  })

  it("exposes resolved config and schema through Vite virtual modules", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const notes = true\n")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ db: {}, root: rootDir } as never)

    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const resolvedConfigId = await resolveId(DB_VIRTUAL_CONFIG_ID)
    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const configCode = await load(resolvedConfigId!)
    const schemaCode = await load(resolvedSchemaId!)

    expect(configCode).toContain("\"file:.data/db/sqlite.db\"")
    expect(schemaCode).toContain("export default schema;")
    expect(schemaCode).toContain(join(rootDir, "src/db/schema.ts"))
  })
})
