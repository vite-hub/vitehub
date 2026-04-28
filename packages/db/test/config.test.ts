import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { normalizeDBOptions, resolveDBViteConfig } from "../src/config.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-config-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src/db/schema"), { recursive: true })
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("normalizeDBOptions", () => {
  it("uses the local sqlite default when db config is omitted", () => {
    expect(normalizeDBOptions()).toEqual({
      connection: { authToken: undefined, url: "file:.data/db/sqlite.db" },
      dialect: "sqlite",
      drizzle: {
        casing: undefined,
        migrationsDirs: ["src/db/migrations"],
        schemaPaths: [],
      },
      orm: "drizzle",
    })
  })

  it("rejects unsupported orm values", () => {
    expect(() => normalizeDBOptions({ orm: "prisma" as never })).toThrow("`db.orm` must be `drizzle`.")
  })

  it("rejects empty auth tokens", () => {
    expect(() => normalizeDBOptions({ connection: { authToken: " " } })).toThrow("`db.connection.authToken`")
  })

  it("strips matching outer quotes from connection values", () => {
    expect(normalizeDBOptions({
      connection: {
        authToken: " 'quoted-token' ",
        url: " \"libsql://example.turso.io\" ",
      },
    })).toMatchObject({
      connection: {
        authToken: "quoted-token",
        url: "libsql://example.turso.io",
      },
    })
  })

  it("rejects unsupported dialect values", () => {
    expect(() => normalizeDBOptions({ dialect: "postgresql" as never })).toThrow("`db.dialect` must be `sqlite`")
  })
})

describe("resolveDBViteConfig", () => {
  it("discovers default schema files and merges explicit schemaPaths", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const rootSchema = true\n")
    await writeFile(join(rootDir, "src/db/schema/notes.ts"), "export const notesSchema = true\n")
    await writeFile(join(rootDir, "src/custom.ts"), "export const customSchema = true\n")

    const resolved = resolveDBViteConfig({
      drizzle: {
        schemaPaths: ["src/custom.ts"],
      },
    }, rootDir)

    expect(resolved?.schemaPaths).toEqual([
      join(rootDir, "src/custom.ts"),
      join(rootDir, "src/db/schema.ts"),
      join(rootDir, "src/db/schema/notes.ts"),
    ])
  })

  it("throws when an explicit schema path does not exist", async () => {
    const rootDir = await createTempProject()

    expect(() => resolveDBViteConfig({
      drizzle: {
        schemaPaths: ["src/missing.ts"],
      },
    }, rootDir)).toThrow("Drizzle schema path not found")
  })
})
