import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

const schema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  }),
}

const runtimeState = {
  dbPath: "",
};

(vi.mock as any)("virtual:@vitehub/db/schema", () => ({
  ...schema,
  default: schema,
}), { virtual: true });

(vi.mock as any)("virtual:@vitehub/db/config", () => ({
  default: {
    db: {
      connection: {
        get url() {
          return runtimeState.dbPath
        },
      },
      drizzle: {},
    },
  },
}), { virtual: true });

let tempDir = ""

afterEach(async () => {
  runtimeState.dbPath = ""
  vi.resetModules()
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true })
    tempDir = ""
  }
})

describe("drizzle runtime", () => {
  it("creates a local sqlite database and serves the configured schema", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vitehub-db-runtime-"))
    runtimeState.dbPath = `file:${join(tempDir, "db.sqlite")}`

    const { db } = await import("../src/runtime/drizzle-runtime.ts")

    await db.run(sql`
      create table if not exists notes (
        id integer primary key autoincrement,
        title text not null
      )
    `)

    await db.insert(schema.notes).values({ title: "runtime note" })

    const rows = await db.select().from(schema.notes)
    expect(rows).toEqual([{ id: 1, title: "runtime note" }])
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
      orm: "drizzle",
    }, schema)

    expect(() => db.run).toThrow("Hosted DB outputs require a remote libSQL URL")
  })
})
