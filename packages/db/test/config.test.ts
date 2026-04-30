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
  await mkdir(join(rootDir, "src/db/analytics/schema"), { recursive: true })
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
      name: "default",
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
  it("discovers default and named schema files with separate defaults", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const rootSchema = true\n")
    await writeFile(join(rootDir, "src/db/schema/notes.ts"), "export const notesSchema = true\n")
    await writeFile(join(rootDir, "src/db/analytics/schema.ts"), "export const analyticsSchema = true\n")
    await writeFile(join(rootDir, "src/db/analytics/schema/events.ts"), "export const analyticsEvents = true\n")

    const resolved = resolveDBViteConfig({
      databases: {
        analytics: {},
      },
    }, rootDir)

    expect(resolved?.databaseNames).toEqual(["default", "analytics"])
    expect(resolved?.databases.default.connection?.url).toBe("file:.data/db/sqlite.db")
    expect(resolved?.databases.analytics?.connection?.url).toBe("file:.data/db/analytics.sqlite.db")
    expect(resolved?.schemaPathsByDatabase.default).toEqual([
      join(rootDir, "src/db/schema.ts"),
      join(rootDir, "src/db/schema/notes.ts"),
    ])
    expect(resolved?.schemaPathsByDatabase.analytics).toEqual([
      join(rootDir, "src/db/analytics/schema.ts"),
      join(rootDir, "src/db/analytics/schema/events.ts"),
    ])
    expect(resolved?.databases.analytics?.drizzle.migrationsDirs).toEqual(["src/db/analytics/migrations"])
    expect(resolved?.databases.analytics?.cloudflare).toBeUndefined()
  })

  it("keeps cloudflare-only named databases D1-only until a fallback is configured", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const rootSchema = true\n")

    const resolved = resolveDBViteConfig({
      databases: {
        analytics: {
          cloudflare: {
            databaseId: "analytics-d1-id",
          },
        },
      },
    }, rootDir)

    expect(resolved?.databases.analytics).toMatchObject({
      cloudflare: {
        binding: "DB_ANALYTICS",
        databaseId: "analytics-d1-id",
        migrationsDir: "src/db/analytics/migrations",
      },
    })
    expect(resolved?.databases.analytics?.connection).toBeUndefined()
  })

  it("merges explicit schema paths into the matching database", async () => {
    const rootDir = await createTempProject()
    await writeFile(join(rootDir, "src/db/schema.ts"), "export const rootSchema = true\n")
    await writeFile(join(rootDir, "src/custom.ts"), "export const customSchema = true\n")

    const resolved = resolveDBViteConfig({
      drizzle: {
        schemaPaths: ["src/custom.ts"],
      },
    }, rootDir)

    expect(resolved?.schemaPathsByDatabase.default).toEqual([
      join(rootDir, "src/custom.ts"),
      join(rootDir, "src/db/schema.ts"),
    ])
  })

  it("throws when an explicit schema path does not exist", async () => {
    const rootDir = await createTempProject()

    expect(() => resolveDBViteConfig({
      drizzle: {
        schemaPaths: ["src/missing.ts"],
      },
    }, rootDir)).toThrow("Database \"default\" schema path not found")
  })

  it("rejects reserved default keys inside db.databases", async () => {
    const rootDir = await createTempProject()

    expect(() => resolveDBViteConfig({
      databases: {
        default: {},
      },
    } as never, rootDir)).toThrow("`db.databases.default` is reserved")
  })
})
