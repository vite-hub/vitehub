import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { setActiveCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

const defaultSchema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  }),
}

const analyticsSchema = {
  analyticsEvents: sqliteTable("analytics_events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  }),
}

const runtimeState = {
  analyticsDbPath: "",
  dbPath: "",
}

function createFakeD1Binding() {
  return {
    batch: async () => [],
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: [] }),
            raw: async () => [],
            run: async () => ({}),
          }
        },
      }
    },
  }
}

;(vi.mock as any)("virtual:@vitehub/db/schema", () => ({
  ...defaultSchema,
  default: defaultSchema,
}), { virtual: true })

function createRuntimeDatabaseEntries() {
  return {
    analytics: {
      config: {
        cloudflare: {
          binding: "DB_ANALYTICS",
        },
        connection: {
          get url() {
            return runtimeState.analyticsDbPath || undefined
          },
        },
        dialect: "sqlite",
        drizzle: {
          casing: undefined,
          migrationsDirs: ["src/db/analytics/migrations"],
          schemaPaths: [],
        },
        name: "analytics",
        orm: "drizzle",
      },
      schema: analyticsSchema,
    },
    default: {
      config: {
        connection: {
          get url() {
            return runtimeState.dbPath
          },
        },
        dialect: "sqlite",
        drizzle: {
          casing: undefined,
          migrationsDirs: ["src/db/migrations"],
          schemaPaths: [],
        },
        name: "default",
        orm: "drizzle",
      },
      schema: defaultSchema,
    },
  }
}

let runtimeDatabaseEntriesFactory: () => Record<string, unknown> = createRuntimeDatabaseEntries

beforeEach(() => {
  runtimeDatabaseEntriesFactory = createRuntimeDatabaseEntries
  ;(vi.doMock as any)("virtual:@vitehub/db/databases", () => ({
    default: runtimeDatabaseEntriesFactory(),
  }), { virtual: true })
})

let tempDir = ""

afterEach(async () => {
  runtimeState.analyticsDbPath = ""
  runtimeState.dbPath = ""
  setActiveCloudflareEnv(undefined)
  vi.resetModules()
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true })
    tempDir = ""
  }
})

describe("drizzle runtime", () => {
  it("provides a default fallback entry when the virtual database registry is empty", async () => {
    runtimeDatabaseEntriesFactory = () => ({})
    vi.resetModules()

    const { databases, db } = await import("../src/runtime/drizzle-runtime.ts")

    expect(db).toBe(databases.default.db)
    expect(databases.default.schema).toEqual({})
    expect(() => databases.default.db.run).toThrow("[vitehub] `@vitehub/db/drizzle` requires `hubDb()` and `db !== false`.")
  })

  it("keeps db as the default database alias and serves named schemas independently", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vitehub-db-runtime-"))
    runtimeState.dbPath = `file:${join(tempDir, "db.sqlite")}`
    runtimeState.analyticsDbPath = `file:${join(tempDir, "analytics.sqlite")}`

    const { databases, db } = await import("../src/drizzle.ts")

    expect(db).toBe(databases.default.db)

    await databases.default.db.run(sql`
      create table if not exists notes (
        id integer primary key autoincrement,
        title text not null
      )
    `)
    await databases.analytics.db.run(sql`
      create table if not exists analytics_events (
        id integer primary key autoincrement,
        name text not null
      )
    `)

    await databases.default.db.insert(defaultSchema.notes).values({ title: "runtime note" })
    await databases.analytics.db.insert(analyticsSchema.analyticsEvents).values({ name: "page-view" })

    expect(await databases.default.db.select().from(defaultSchema.notes)).toEqual([{ id: 1, title: "runtime note" }])
    expect(await databases.analytics.db.select().from(analyticsSchema.analyticsEvents)).toEqual([{ id: 1, name: "page-view" }])
  })

  it("prefers an active Cloudflare D1 binding over the configured fallback URL", async () => {
    runtimeState.analyticsDbPath = "file:.data/analytics.sqlite"
    const binding = createFakeD1Binding()
    setActiveCloudflareEnv({ DB_ANALYTICS: binding })

    const { databases } = await import("../src/runtime/drizzle-runtime.ts")

    expect((databases.analytics.db as { $client?: unknown }).$client).toBe(binding)
  })

  it("throws when a named database has neither an active binding nor a fallback URL", async () => {
    const { databases } = await import("../src/runtime/drizzle-runtime.ts")

    expect(() => databases.analytics.db.run).toThrow("Database \"analytics\" requires a Cloudflare D1 binding or `db.connection.url`.")
  })
})

describe("hosted drizzle runtime", () => {
  it("defers hosted URL validation until the database is used", async () => {
    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")

    const db = createHostedDrizzleDb({
      connection: {
        url: "file:.data/db.sqlite",
      },
      dialect: "sqlite",
      drizzle: {
        migrationsDirs: [],
        schemaPaths: [],
      },
      name: "default",
      orm: "drizzle",
    }, defaultSchema)

    expect(() => db.run).toThrow("Hosted DB \"default\" requires a Cloudflare D1 binding or a remote libSQL URL")
  })

  it("rejects non-libsql remote schemes in hosted mode", async () => {
    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")

    const db = createHostedDrizzleDb({
      connection: {
        url: "postgres://db.example.com/app",
      },
      dialect: "sqlite",
      drizzle: {
        migrationsDirs: [],
        schemaPaths: [],
      },
      name: "default",
      orm: "drizzle",
    }, defaultSchema)

    expect(() => db.run).toThrow("Hosted DB \"default\" requires a Cloudflare D1 binding or a remote libSQL URL")
  })

  it("uses the active Cloudflare binding when hosted outputs run on Cloudflare", async () => {
    const binding = createFakeD1Binding()
    setActiveCloudflareEnv({ DB_ANALYTICS: binding })

    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")
    const db = createHostedDrizzleDb({
      cloudflare: {
        binding: "DB_ANALYTICS",
        databaseId: "analytics-d1-id",
        migrationsDir: "src/db/analytics/migrations",
      },
      dialect: "sqlite",
      drizzle: {
        migrationsDirs: ["src/db/analytics/migrations"],
        schemaPaths: [],
      },
      name: "analytics",
      orm: "drizzle",
    }, analyticsSchema)

    expect((db as { $client?: unknown }).$client).toBe(binding)
  })
})
